import { sign as signDetached, verify as verifyDetached, type KeyObject } from "node:crypto";
import {
  canonicalJson,
  parsePaymentIntent,
  parsePrincipal,
  parseSecurityDecision,
  paymentIntentDigest,
  sha256Digest,
  type CanonicalValue,
  type Principal,
  type SecurityDecision,
} from "../../../packages/contracts/src/index.ts";
import { assertAuthorized, authenticate, type AuthenticationProvider } from "../../../packages/authorization/src/index.ts";
import { InMemoryAuditChain, type AuditEvent } from "../../../packages/audit-chain/src/index.ts";
import { evaluatePaymentIntentWithTrace, type PolicyEvaluation } from "../../../packages/policy-engine/src/index.ts";

export interface DecisionSigner { readonly keyId: string; sign(payload: string): string }
export interface DecisionSignatureVerifier { readonly keyId: string; verify(payload: string, signature: string): boolean }
export interface SignedSecurityDecision {
  readonly contractVersion: "1.0";
  readonly organizationId: string;
  readonly decision: SecurityDecision;
  readonly decisionDigest: string;
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly signature: string;
  readonly signedAt: string;
}
export interface EvaluateSecurityRequest { readonly organizationId: string; readonly correlationId: string; readonly rawCredentials: unknown; readonly intent: unknown; readonly policy: unknown; readonly context: unknown }
export interface EvaluationReceipt { readonly signedDecision: SignedSecurityDecision; readonly evaluation: PolicyEvaluation; readonly auditEvent: AuditEvent }
export class SettlementDeniedError extends Error { constructor(message: string) { super(message); this.name = "SettlementDeniedError"; } }
export class ApprovalLayerInfrastructureError extends Error { constructor(message: string) { super(message); this.name = "ApprovalLayerInfrastructureError"; } }

/** Creates a signer backed by an injected Ed25519 key object. */
export function createEd25519DecisionSigner(keyId: string, privateKey: KeyObject): DecisionSigner {
  requireKeyId(keyId);
  return frozen({ keyId, sign: (payload: string) => signDetached(null, Buffer.from(payload), privateKey).toString("base64url") });
}
export function createEd25519DecisionVerifier(keyId: string, publicKey: KeyObject): DecisionSignatureVerifier {
  requireKeyId(keyId);
  return frozen({ keyId, verify: (payload: string, signature: string) => {
    try { return verifyDetached(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url")); } catch { return false; }
  } });
}

export class ApprovalLayerService {
  readonly #provider: AuthenticationProvider;
  readonly #servicePrincipal: Principal;
  readonly #signer: DecisionSigner;
  readonly #audit: InMemoryAuditChain;

  constructor(options: { readonly authenticationProvider: AuthenticationProvider; readonly servicePrincipal: Principal; readonly signer: DecisionSigner; readonly auditChain: InMemoryAuditChain }) {
    this.#provider = options.authenticationProvider; this.#servicePrincipal = parsePrincipal(options.servicePrincipal);
    if (this.#servicePrincipal.kind !== "service" || !this.#servicePrincipal.roles.includes("approval-layer-service")) throw new TypeError("ApprovalLayer requires a dedicated approval-layer-service principal.");
    this.#signer = options.signer; this.#audit = options.auditChain;
  }

  async evaluate(request: EvaluateSecurityRequest): Promise<EvaluationReceipt> {
    requireIdentifier(request.organizationId, "organizationId", "org_"); requireIdentifier(request.correlationId, "correlationId", "corr_");
    const identity = await authenticate(this.#provider, request.rawCredentials); const evaluatedAt = contextNow(request.context);
    assertAuthorized({ identity, principal: this.#servicePrincipal, action: "security:evaluate", target: { organizationId: request.organizationId, resourceType: "payment-intent", resourceId: intentIdOrFallback(request.intent) }, evaluatedAt });
    const evaluation = evaluatePaymentIntentWithTrace(request.intent, request.policy, request.context);
    const intent = parsePaymentIntent(request.intent);
    if (intent.organizationId !== request.organizationId) throw new SettlementDeniedError("Intent organization does not match the ApprovalLayer request.");
    const decision = parseSecurityDecision(evaluation.decision); const digest = decisionDigest(request.organizationId, decision);
    let auditEvent: AuditEvent;
    try {
      auditEvent = this.#audit.append({ organizationId: request.organizationId, eventId: `audit_${decision.decisionId.slice(4)}`, occurredAt: evaluatedAt, correlationId: request.correlationId, actor: { principalId: this.#servicePrincipal.principalId, kind: "service" }, eventType: "security-decision-issued", subject: { type: "payment-intent", id: intent.intentId }, payload: { decisionId: decision.decisionId, decisionDigest: digest, outcome: decision.outcome, reasonCodes: decision.reasonCodes, policyDigest: evaluation.policyDigest, checks: evaluation.checks.map((check) => ({ control: check.control, outcome: check.outcome, reasonCodes: check.reasonCodes })) } });
    } catch (error) {
      throw new ApprovalLayerInfrastructureError(`Decision was not released because audit recording failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return frozen({ signedDecision: signDecision(request.organizationId, decision, this.#signer, evaluatedAt), evaluation, auditEvent });
  }
}

/** Settlement-side guard. A worker must call this before transaction construction or signing. */
export function assertSettlementAuthorized(input: { readonly signedDecision: unknown; readonly organizationId: string; readonly intent: unknown; readonly now: string; readonly verifier: DecisionSignatureVerifier }): SignedSecurityDecision {
  const signed = parseSignedDecision(input.signedDecision); requireIdentifier(input.organizationId, "organizationId", "org_"); requireTimestamp(input.now, "now");
  const intent = parsePaymentIntent(input.intent);
  if (signed.organizationId !== input.organizationId || intent.organizationId !== input.organizationId) throw new SettlementDeniedError("Decision and intent must belong to the settlement organization.");
  if (signed.keyId !== input.verifier.keyId || !input.verifier.verify(signingPayload(signed.organizationId, signed.decision, signed.decisionDigest, signed.keyId, signed.signedAt), signed.signature)) throw new SettlementDeniedError("ApprovalLayer signature is invalid.");
  if (signed.decisionDigest !== decisionDigest(signed.organizationId, signed.decision)) throw new SettlementDeniedError("Security decision digest is invalid.");
  if (signed.decision.intentId !== intent.intentId || signed.decision.intentDigest !== paymentIntentDigest(intent)) throw new SettlementDeniedError("Security decision is not bound to this payment intent.");
  if (signed.decision.outcome !== "ALLOW") throw new SettlementDeniedError("Only an ALLOW decision can proceed to settlement.");
  if (Date.parse(input.now) >= Date.parse(signed.decision.expiresAt)) throw new SettlementDeniedError("Security decision has expired.");
  return signed;
}

function signDecision(organizationId: string, rawDecision: SecurityDecision, signer: DecisionSigner, signedAt: string): SignedSecurityDecision {
  const decision = parseSecurityDecision(rawDecision); const digest = decisionDigest(organizationId, decision); const payload = signingPayload(organizationId, decision, digest, signer.keyId, signedAt);
  return frozen({ contractVersion: "1.0", organizationId, decision, decisionDigest: digest, algorithm: "ed25519", keyId: signer.keyId, signature: signer.sign(payload), signedAt });
}
function parseSignedDecision(input: unknown): SignedSecurityDecision {
  const value = record(input, "signedDecision"); exact(value, ["contractVersion", "organizationId", "decision", "decisionDigest", "algorithm", "keyId", "signature", "signedAt"], "signedDecision");
  if (value.contractVersion !== "1.0") throw new TypeError("signedDecision contractVersion is invalid."); requireIdentifier(value.organizationId, "organizationId", "org_"); const decision = parseSecurityDecision(value.decision); requireDigest(value.decisionDigest, "decisionDigest"); if (value.algorithm !== "ed25519") throw new TypeError("signedDecision algorithm is invalid."); requireKeyId(value.keyId); if (typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{32,200}$/.test(value.signature)) throw new TypeError("signedDecision signature is invalid."); requireTimestamp(value.signedAt, "signedAt");
  return frozen({ contractVersion: "1.0", organizationId: value.organizationId as string, decision, decisionDigest: value.decisionDigest as string, algorithm: "ed25519", keyId: value.keyId as string, signature: value.signature as string, signedAt: value.signedAt as string });
}
function decisionDigest(organizationId: string, decision: SecurityDecision): string { return sha256Digest({ organizationId, decision } as unknown as CanonicalValue); }
function signingPayload(organizationId: string, decision: SecurityDecision, digest: string, keyId: string, signedAt: string): string { return canonicalJson({ contractVersion: "1.0", organizationId, decision, decisionDigest: digest, algorithm: "ed25519", keyId, signedAt } as unknown as CanonicalValue); }
function contextNow(input: unknown): string { const value = record(input, "evaluation context"); requireTimestamp(value.now, "context.now"); return value.now as string; }
function intentIdOrFallback(input: unknown): string { try { return parsePaymentIntent(input).intentId; } catch { return "pi_invalid"; } }
function record(input: unknown, name: string): Record<string, unknown> { if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${name} must be an object.`); return input as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name} has unsupported field ${key}.`); for (const key of keys) if (!(key in value)) throw new TypeError(`${name} is missing ${key}.`); }
function requireIdentifier(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requireKeyId(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-z][a-z0-9-]{3,80}$/.test(value)) throw new TypeError("keyId is invalid."); }
function requireDigest(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requireTimestamp(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
