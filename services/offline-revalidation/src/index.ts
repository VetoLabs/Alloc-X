import { paymentIntentDigest, type PaymentIntent } from "../../../packages/contracts/src/index.ts";
import { assertSettlementAuthorized, type DecisionSignatureVerifier, type SignedSecurityDecision } from "../../approval-layer/src/index.ts";
import { type PreparedOfflinePayment } from "../../offline-workflows/src/index.ts";

export interface FreshAuthentication { readonly principalId: string; readonly organizationId: string; readonly authenticatedAt: string; readonly expiresAt: string; readonly stepUpSatisfied: boolean; }
export interface CurrentRevalidationState {
  readonly policyVersion: string;
  readonly beneficiary: { readonly beneficiaryId: string; readonly beneficiaryVersion: string; readonly destinationVersion: string; readonly active: boolean };
  readonly balances: { readonly treasuryAvailable: string; readonly allocationAvailable: string; readonly observedAt: string };
  readonly risk: { readonly available: boolean; readonly observedAt: string };
  readonly ledger: { readonly available: boolean; readonly observedAt: string; readonly network: "testnet" | "devnet" | "mainnet" };
}
export interface ApprovalEvaluation { readonly signedDecision: SignedSecurityDecision; }
export interface OnlineApprovalEvaluator { evaluate(input: { readonly intent: PaymentIntent; readonly correlationId: string; readonly now: string }): Promise<ApprovalEvaluation>; }
export interface RevalidationResult { readonly preparedPaymentId: string; readonly intentId: string; readonly intentDigest: string; readonly decisionDigest: string; readonly state: "READY_FOR_SIGNING" | "REVIEW_REQUIRED" | "DENIED"; readonly reasonCodes: readonly string[]; }

/**
 * The only bridge from offline preparation to signing. Every input is current
 * server data; no cached approval or offline data can satisfy this gate.
 */
export class OfflineRevalidationGate {
  readonly #approval: OnlineApprovalEvaluator; readonly #verifier: DecisionSignatureVerifier; readonly #maximumFreshnessMs: number;
  constructor(input: { readonly approval: OnlineApprovalEvaluator; readonly decisionVerifier: DecisionSignatureVerifier; readonly maximumFreshnessMs?: number }) { this.#approval = input.approval; this.#verifier = input.decisionVerifier; this.#maximumFreshnessMs = input.maximumFreshnessMs ?? 5 * 60 * 1_000; if (!Number.isSafeInteger(this.#maximumFreshnessMs) || this.#maximumFreshnessMs < 1_000) throw new TypeError("Revalidation freshness window is invalid."); }

  async revalidate(input: { readonly prepared: PreparedOfflinePayment; readonly intent: PaymentIntent; readonly authentication: FreshAuthentication; readonly current: CurrentRevalidationState; readonly correlationId: string; readonly now: string }): Promise<RevalidationResult> {
    timestamp(input.now); validateAuthentication(input.authentication, input.now); validateCurrent(input.current, input.now, this.#maximumFreshnessMs); validateBinding(input.prepared, input.intent, input.authentication, input.current);
    const evaluation = await this.#approval.evaluate({ intent: input.intent, correlationId: input.correlationId, now: input.now });
    const decision = evaluation.signedDecision;
    const digest = paymentIntentDigest(input.intent);
    if (decision.organizationId !== input.intent.organizationId || decision.decision.intentId !== input.intent.intentId || decision.decision.intentDigest !== digest) throw new OfflineRevalidationError("APPROVAL_BINDING_INVALID", "Fresh Approval Layer result is not bound to this current payment intent.");
    if (decision.decision.outcome === "REVIEW") return frozen({ preparedPaymentId: input.prepared.preparedPaymentId, intentId: input.intent.intentId, intentDigest: digest, decisionDigest: decision.decisionDigest, state: "REVIEW_REQUIRED", reasonCodes: frozen([...decision.decision.reasonCodes]) });
    if (decision.decision.outcome !== "ALLOW") return frozen({ preparedPaymentId: input.prepared.preparedPaymentId, intentId: input.intent.intentId, intentDigest: digest, decisionDigest: decision.decisionDigest, state: "DENIED", reasonCodes: frozen([...decision.decision.reasonCodes]) });
    assertSettlementAuthorized({ signedDecision: decision, organizationId: input.intent.organizationId, intent: input.intent, now: input.now, verifier: this.#verifier });
    return frozen({ preparedPaymentId: input.prepared.preparedPaymentId, intentId: input.intent.intentId, intentDigest: digest, decisionDigest: decision.decisionDigest, state: "READY_FOR_SIGNING", reasonCodes: frozen([...decision.decision.reasonCodes]) });
  }
}

export class OfflineRevalidationError extends Error { readonly code: "AUTHENTICATION_STALE" | "CURRENT_STATE_STALE" | "PREPARED_BINDING_INVALID" | "APPROVAL_BINDING_INVALID"; constructor(code: OfflineRevalidationError["code"], message: string) { super(message); this.name = "OfflineRevalidationError"; this.code = code; } }

function validateAuthentication(value: FreshAuthentication, now: string): void { id(value.principalId, "principal_"); id(value.organizationId, "org_"); timestamp(value.authenticatedAt); timestamp(value.expiresAt); if (!value.stepUpSatisfied || Date.parse(value.authenticatedAt) > Date.parse(now) || Date.parse(value.expiresAt) <= Date.parse(now)) throw new OfflineRevalidationError("AUTHENTICATION_STALE", "Fresh, step-up authenticated user context is required."); }
function validateCurrent(value: CurrentRevalidationState, now: string, maxAge: number): void { nonEmpty(value.policyVersion); id(value.beneficiary.beneficiaryId, "ben_"); nonEmpty(value.beneficiary.beneficiaryVersion); nonEmpty(value.beneficiary.destinationVersion); if (!value.beneficiary.active) throw new OfflineRevalidationError("CURRENT_STATE_STALE", "Beneficiary is no longer active."); for (const observed of [value.balances.observedAt, value.risk.observedAt, value.ledger.observedAt]) { timestamp(observed); if (Date.parse(now) - Date.parse(observed) > maxAge || Date.parse(observed) > Date.parse(now)) throw new OfflineRevalidationError("CURRENT_STATE_STALE", "Required online state is stale or unavailable."); } if (!value.risk.available || !value.ledger.available) throw new OfflineRevalidationError("CURRENT_STATE_STALE", "Risk and ledger state must be available for revalidation."); positive(value.balances.treasuryAvailable); positive(value.balances.allocationAvailable); }
function validateBinding(prepared: PreparedOfflinePayment, intent: PaymentIntent, authentication: FreshAuthentication, current: CurrentRevalidationState): void { if (prepared.state !== "PREPARED_OFFLINE" || prepared.settlementStatus !== "NOT_SUBMITTED" || prepared.requiresOnlineRevalidation !== true) throw new OfflineRevalidationError("PREPARED_BINDING_INVALID", "Only a non-submitted offline preparation can be revalidated."); if (authentication.organizationId !== intent.organizationId || prepared.obligationId !== intent.sourceObligationId || prepared.allocationId !== intent.allocationId || prepared.beneficiaryId !== intent.beneficiaryId || prepared.requestedAmount !== intent.amount || prepared.asset !== intent.asset || prepared.policyVersion !== intent.policyVersion || current.policyVersion !== intent.policyVersion || current.beneficiary.beneficiaryId !== intent.beneficiaryId || current.beneficiary.beneficiaryVersion !== prepared.beneficiaryVersion || current.beneficiary.destinationVersion !== prepared.beneficiaryDestinationVersion) throw new OfflineRevalidationError("PREPARED_BINDING_INVALID", "Offline preparation does not match the current payment intent and authoritative references."); }
function positive(value: string): void { if (!/^\d+(?:\.\d{1,6})?$/.test(value) || Number(value) < 0) throw new OfflineRevalidationError("CURRENT_STATE_STALE", "Current balance is invalid."); }
function timestamp(value: string): void { if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new OfflineRevalidationError("CURRENT_STATE_STALE", "Timestamp is invalid."); }
function id(value: string, prefix: string): void { if (!value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new OfflineRevalidationError("PREPARED_BINDING_INVALID", "Identifier is invalid."); }
function nonEmpty(value: string): void { if (typeof value !== "string" || !value.trim()) throw new OfflineRevalidationError("CURRENT_STATE_STALE", "Current reference is invalid."); }
function frozen<T>(value: T): T { return Object.freeze(value); }
