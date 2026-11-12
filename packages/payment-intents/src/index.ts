import {
  parseAllocation,
  parseBeneficiary,
  parseEvidenceManifest,
  parseObligation,
  parseOrganization,
  parsePaymentIntent,
  parsePrincipal,
  paymentIntentDigest,
  sha256Digest,
  validatePaymentReferenceBundle,
  type Allocation,
  type Beneficiary,
  type EvidenceManifest,
  type Obligation,
  type Organization,
  type PaymentIntent,
  type Principal,
} from "../../contracts/src/index.ts";
import {
  InMemoryTreasuryAccounting,
  type AccountingReservation,
} from "../../accounting/src/index.ts";

export type IntentState = "RESERVED" | "CANCELLED";

export interface PublishedPolicyReference {
  readonly organizationId: string;
  readonly policyVersion: string;
  readonly status: "published" | "revoked";
  readonly effectiveFrom: string;
  readonly effectiveUntil?: string;
}

export interface CreatePaymentIntentRequest {
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly sourceObligationId: string;
  readonly allocationId: string;
  readonly beneficiaryId: string;
  readonly policyVersion: string;
  readonly requestedExecutionWindow: { readonly notBefore: string; readonly expiresAt: string };
  readonly createdByPrincipalId: string;
  readonly requestedAt: string;
}

export interface PaymentIntentRecord {
  readonly intent: PaymentIntent;
  readonly intentDigest: string;
  readonly reservation: AccountingReservation;
  readonly state: IntentState;
  readonly createdAt: string;
  readonly cancelledAt?: string;
}

/** Resolves the current beneficiary record from a server-owned authority. */
export interface BeneficiaryAuthority {
  resolve(organizationId: string, beneficiaryId: string): Beneficiary;
}

export class IdempotencyConflictError extends Error {
  constructor(message: string) { super(message); this.name = "IdempotencyConflictError"; }
}
export class IntentStateError extends Error {
  constructor(message: string) { super(message); this.name = "IntentStateError"; }
}

/**
 * Server-side payment-intent boundary. Callers supply references only; the
 * economic and beneficiary fields are resolved from authoritative records.
 */
export class InMemoryPaymentIntentService {
  readonly #accounting: InMemoryTreasuryAccounting;
  readonly #beneficiaryAuthority: BeneficiaryAuthority | undefined;
  readonly #organizations = new Map<string, Organization>();
  readonly #principals = new Map<string, Principal>();
  readonly #obligations = new Map<string, Obligation>();
  readonly #allocations = new Map<string, Allocation>();
  readonly #beneficiaries = new Map<string, Beneficiary>();
  readonly #evidence = new Map<string, EvidenceManifest>();
  readonly #policies = new Map<string, PublishedPolicyReference>();
  readonly #records = new Map<string, PaymentIntentRecord>();
  readonly #idempotency = new Map<string, { readonly fingerprint: string; readonly intentId: string }>();

  constructor(accounting: InMemoryTreasuryAccounting, dependencies: { readonly beneficiaryAuthority?: BeneficiaryAuthority } = {}) {
    this.#accounting = accounting; this.#beneficiaryAuthority = dependencies.beneficiaryAuthority;
  }

  registerOrganization(input: Organization): Organization { const record = parseOrganization(input); return this.register(this.#organizations, record.organizationId, record, "organization"); }
  registerPrincipal(input: Principal): Principal { const record = parsePrincipal(input); return this.register(this.#principals, record.principalId, record, "principal"); }
  registerObligation(input: Obligation): Obligation { const record = parseObligation(input); return this.register(this.#obligations, record.obligationId, record, "obligation"); }
  registerAllocation(input: Allocation): Allocation { const record = parseAllocation(input); return this.register(this.#allocations, record.allocationId, record, "allocation"); }
  registerBeneficiary(input: Beneficiary): Beneficiary { const record = parseBeneficiary(input); return this.register(this.#beneficiaries, record.beneficiaryId, record, "beneficiary"); }
  registerEvidenceManifest(input: EvidenceManifest): EvidenceManifest { const record = parseEvidenceManifest(input); return this.register(this.#evidence, record.evidenceManifestId, record, "evidence manifest"); }

  registerPolicy(input: PublishedPolicyReference): PublishedPolicyReference {
    const policy = parsePolicy(input); const key = policyKey(policy.organizationId, policy.policyVersion);
    const existing = this.#policies.get(key); if (existing && stable(existing) !== stable(policy)) throw new IntentStateError("Published policy reference cannot be replaced.");
    this.#policies.set(key, frozen(policy)); return this.#policies.get(key)!;
  }

  create(request: CreatePaymentIntentRequest): PaymentIntentRecord {
    const normalized = parseRequest(request); const idempotencyKey = `${normalized.organizationId}:${normalized.idempotencyKey}`; const fingerprint = sha256Digest(normalized);
    const prior = this.#idempotency.get(idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new IdempotencyConflictError("idempotencyKey cannot be reused for a different intent request.");
      return this.#records.get(prior.intentId)!;
    }
    const organization = required(this.#organizations, normalized.organizationId, "organization");
    const principal = required(this.#principals, normalized.createdByPrincipalId, "principal");
    const obligation = required(this.#obligations, normalized.sourceObligationId, "obligation");
    const allocation = required(this.#allocations, normalized.allocationId, "allocation");
    const registeredBeneficiary = required(this.#beneficiaries, normalized.beneficiaryId, "beneficiary");
    const beneficiary = this.#beneficiaryAuthority === undefined ? registeredBeneficiary : parseBeneficiary(this.#beneficiaryAuthority.resolve(normalized.organizationId, normalized.beneficiaryId));
    const evidence = evidenceForObligation(this.#evidence, normalized.organizationId, normalized.sourceObligationId);
    const policy = required(this.#policies, policyKey(normalized.organizationId, normalized.policyVersion), "published policy");
    assertCurrent(organization, principal, obligation, allocation, beneficiary, evidence, policy, normalized);
    const intentId = `pi_${sha256Digest({ organizationId: normalized.organizationId, idempotencyKey: normalized.idempotencyKey }).slice(7, 39)}`;
    const intent = parsePaymentIntent({
      contractVersion: "1.0", intentId, organizationId: normalized.organizationId, idempotencyKey: normalized.idempotencyKey,
      sourceObligationId: obligation.obligationId, allocationId: allocation.allocationId, amount: obligation.amount, asset: obligation.asset,
      beneficiaryId: beneficiary.beneficiaryId, beneficiaryWalletVersion: beneficiary.walletVersion, purposeCode: obligation.purposeCode,
      evidenceManifestHash: evidence.manifestHash, policyVersion: policy.policyVersion, requestedExecutionWindow: normalized.requestedExecutionWindow,
      createdBy: { principalId: principal.principalId, actorType: principal.kind },
    });
    validatePaymentReferenceBundle({ organization, principal, obligation, allocation, beneficiary, evidenceManifest: evidence, paymentIntent: intent });
    const digest = paymentIntentDigest(intent); const reservation = this.#accounting.reserve({
      reservationId: `res_${sha256Digest({ intentId, digest }).slice(7, 39)}`, organizationId: intent.organizationId, allocationId: intent.allocationId,
      intentId, intentDigest: digest, asset: intent.asset, amount: intent.amount, reservedAt: normalized.requestedAt, expiresAt: intent.requestedExecutionWindow.expiresAt,
    });
    const record = frozen({ intent, intentDigest: digest, reservation, state: "RESERVED" as const, createdAt: normalized.requestedAt });
    this.#records.set(intentId, record); this.#idempotency.set(idempotencyKey, frozen({ fingerprint, intentId })); return record;
  }

  cancel(organizationId: string, intentId: string, cancelledAt: string): PaymentIntentRecord {
    requireIdentifier(organizationId, "organizationId", "org_"); requireIdentifier(intentId, "intentId", "pi_"); requireTime(cancelledAt, "cancelledAt");
    const current = required(this.#records, intentId, "payment intent"); if (current.intent.organizationId !== organizationId) throw new IntentStateError("Payment intent belongs to another organization.");
    if (current.state === "CANCELLED") return current;
    if (Date.parse(cancelledAt) < Date.parse(current.createdAt)) throw new IntentStateError("Intent cannot be cancelled before it exists.");
    const reservation = this.#accounting.release({ reservationId: current.reservation.reservationId, releasedAt: cancelledAt });
    const cancelled = frozen({ ...current, reservation, state: "CANCELLED" as const, cancelledAt }); this.#records.set(intentId, cancelled); return cancelled;
  }

  get(organizationId: string, intentId: string): PaymentIntentRecord {
    requireIdentifier(organizationId, "organizationId", "org_"); requireIdentifier(intentId, "intentId", "pi_"); const record = required(this.#records, intentId, "payment intent"); if (record.intent.organizationId !== organizationId) throw new IntentStateError("Payment intent belongs to another organization."); return record;
  }

  private register<T>(target: Map<string, T>, key: string, value: T, label: string): T {
    const existing = target.get(key); if (existing && stable(existing) !== stable(value)) throw new IntentStateError(`${label} cannot be replaced after registration.`); target.set(key, frozen(value)); return target.get(key)!;
  }
}

function assertCurrent(organization: Organization, principal: Principal, obligation: Obligation, allocation: Allocation, beneficiary: Beneficiary, evidence: EvidenceManifest, policy: PublishedPolicyReference, request: CreatePaymentIntentRequest): void {
  const now = Date.parse(request.requestedAt);
  if (organization.status !== "active") throw new IntentStateError("Organization is not active.");
  if (principal.organizationId !== request.organizationId || principal.status !== "active" || !["human", "agent"].includes(principal.kind)) throw new IntentStateError("Intent creator is not eligible.");
  if (obligation.status !== "open" || obligation.organizationId !== request.organizationId) throw new IntentStateError("Obligation is not eligible.");
  if (allocation.organizationId !== request.organizationId || allocation.status !== "active" || now < Date.parse(allocation.activeFrom) || now >= Date.parse(allocation.expiresAt)) throw new IntentStateError("Allocation is not eligible.");
  if (beneficiary.organizationId !== request.organizationId || beneficiary.status !== "approved") throw new IntentStateError("Beneficiary is not eligible.");
  if (evidence.organizationId !== request.organizationId || evidence.obligationId !== obligation.obligationId) throw new IntentStateError("Evidence is not eligible.");
  if (policy.status !== "published" || now < Date.parse(policy.effectiveFrom) || (policy.effectiveUntil && now >= Date.parse(policy.effectiveUntil))) throw new IntentStateError("Policy is not active.");
  if (Date.parse(request.requestedExecutionWindow.notBefore) < now || Date.parse(request.requestedExecutionWindow.expiresAt) <= now) throw new IntentStateError("Requested execution window is not live.");
}

function evidenceForObligation(store: Map<string, EvidenceManifest>, organizationId: string, obligationId: string): EvidenceManifest {
  const matches = [...store.values()].filter((value) => value.organizationId === organizationId && value.obligationId === obligationId);
  if (matches.length !== 1) throw new IntentStateError("Exactly one authoritative evidence manifest is required."); return matches[0];
}
function parsePolicy(input: PublishedPolicyReference): PublishedPolicyReference { const value = input as Record<string, unknown>; exact(value, ["organizationId", "policyVersion", "status", "effectiveFrom", "effectiveUntil"], ["effectiveUntil"], "policy"); requireIdentifier(input.organizationId, "organizationId", "org_"); requireIdentifier(input.policyVersion, "policyVersion", "policy_"); if (!input || !["published", "revoked"].includes(input.status)) throw new TypeError("policy status is invalid."); requireTime(input.effectiveFrom, "effectiveFrom"); if (input.effectiveUntil !== undefined) { requireTime(input.effectiveUntil, "effectiveUntil"); if (Date.parse(input.effectiveUntil) <= Date.parse(input.effectiveFrom)) throw new TypeError("policy effective window is invalid."); } return input; }
function parseRequest(input: CreatePaymentIntentRequest): CreatePaymentIntentRequest { const value = input as Record<string, unknown>; exact(value, ["organizationId", "idempotencyKey", "sourceObligationId", "allocationId", "beneficiaryId", "policyVersion", "requestedExecutionWindow", "createdByPrincipalId", "requestedAt"], [], "payment intent request"); requireIdentifier(input.organizationId, "organizationId", "org_"); if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) throw new TypeError("idempotencyKey is invalid."); requireIdentifier(input.sourceObligationId, "sourceObligationId", "obl_"); requireIdentifier(input.allocationId, "allocationId", "alloc_"); requireIdentifier(input.beneficiaryId, "beneficiaryId", "ben_"); requireIdentifier(input.policyVersion, "policyVersion", "policy_"); requireIdentifier(input.createdByPrincipalId, "createdByPrincipalId", "principal_"); requireTime(input.requestedAt, "requestedAt"); const window = input.requestedExecutionWindow as Record<string, unknown>; exact(window, ["notBefore", "expiresAt"], [], "requestedExecutionWindow"); requireTime(window.notBefore, "requestedExecutionWindow.notBefore"); requireTime(window.expiresAt, "requestedExecutionWindow.expiresAt"); if (Date.parse(window.expiresAt as string) <= Date.parse(window.notBefore as string)) throw new TypeError("requestedExecutionWindow is invalid."); return input; }
function required<T>(store: Map<string, T>, key: string, label: string): T { const value = store.get(key); if (!value) throw new IntentStateError(`Authoritative ${label} was not found.`); return value; }
function policyKey(organizationId: string, policyVersion: string): string { return `${organizationId}:${policyVersion}`; }
function requireIdentifier(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,199}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requireTime(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid.`); }
function exact(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[], label: string): void { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`); for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${label} has unsupported field ${key}.`); for (const key of keys) if (!(key in value) && !optional.includes(key)) throw new TypeError(`${label} is missing ${key}.`); }
function stable(value: unknown): string { return JSON.stringify(value); }
function frozen<T>(value: T): T { return Object.freeze(value); }
