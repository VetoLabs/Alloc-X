import {
  isValidXrplClassicAddress,
  parseBeneficiary,
  type Beneficiary,
} from "../../contracts/src/index.ts";

export type BeneficiaryLifecycle = "enabled" | "frozen" | "disabled";
export type OwnershipVerificationStatus = "pending" | "verified" | "rejected";
export type WalletChangeStatus = "proposed" | "approved" | "verification-pending" | "cooling" | "active" | "rejected" | "cancelled";
export type BeneficiaryNotificationType = "beneficiary-enrolled" | "wallet-change-proposed" | "wallet-change-approved" | "wallet-change-active" | "beneficiary-frozen" | "beneficiary-disabled";

export interface BeneficiaryOwnershipVerification {
  readonly verificationId: string;
  readonly status: OwnershipVerificationStatus;
  readonly method: "signed-wallet-challenge" | "manual-document-review" | "bank-account-match";
  readonly evidenceHash: string;
  readonly requestedAt: string;
  readonly verifiedAt?: string;
  readonly verifiedByPrincipalId?: string;
  readonly rejectionReason?: string;
}

export interface BeneficiaryWalletVersion {
  readonly version: number;
  readonly wallet: Beneficiary["wallet"];
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly sourceChangeId?: string;
}

export interface WalletChangeRequest {
  readonly changeId: string;
  readonly organizationId: string;
  readonly beneficiaryId: string;
  readonly requestedWallet: Beneficiary["wallet"];
  readonly requestedByPrincipalId: string;
  readonly requestedAt: string;
  readonly justification: string;
  readonly status: WalletChangeStatus;
  readonly approvedByPrincipalId?: string;
  readonly approvedAt?: string;
  readonly verification?: BeneficiaryOwnershipVerification;
  readonly coolingEndsAt?: string;
  readonly activatedAt?: string;
}

export interface BeneficiaryRegistryRecord {
  readonly beneficiary: Beneficiary;
  readonly lifecycle: BeneficiaryLifecycle;
  readonly ownership: BeneficiaryOwnershipVerification;
  readonly walletHistory: readonly BeneficiaryWalletVersion[];
  readonly changes: readonly WalletChangeRequest[];
}

export interface BeneficiarySecurityProfile {
  readonly beneficiaryId: string;
  readonly organizationId: string;
  readonly status: Beneficiary["status"];
  readonly walletVersion: number;
  readonly lastWalletChangeAt: string;
  readonly lifecycle: BeneficiaryLifecycle;
}

export interface BeneficiaryNotification {
  readonly notificationId: string;
  readonly organizationId: string;
  readonly beneficiaryId: string;
  readonly type: BeneficiaryNotificationType;
  readonly occurredAt: string;
  readonly relatedChangeId?: string;
}

export class BeneficiaryRegistryError extends Error {
  constructor(message: string) { super(message); this.name = "BeneficiaryRegistryError"; }
}

/**
 * Server-side beneficiary authority for local operation. Mutations return
 * immutable snapshots; a production adapter must persist each transition and
 * its notification outbox in one transaction.
 */
export class InMemoryBeneficiaryRegistry {
  readonly #records = new Map<string, BeneficiaryRegistryRecord>();
  readonly #notifications: BeneficiaryNotification[] = [];
  readonly #coolingPeriodMs: number;

  constructor(options: { readonly coolingPeriodHours: number }) {
    if (!Number.isSafeInteger(options.coolingPeriodHours) || options.coolingPeriodHours < 1 || options.coolingPeriodHours > 8_760) throw new TypeError("coolingPeriodHours is invalid.");
    this.#coolingPeriodMs = options.coolingPeriodHours * 60 * 60 * 1_000;
  }

  proposeEnrollment(input: { readonly beneficiary: Beneficiary; readonly verification: Omit<BeneficiaryOwnershipVerification, "status" | "verifiedAt" | "verifiedByPrincipalId" | "rejectionReason"> }): BeneficiaryRegistryRecord {
    const beneficiary = parseBeneficiary(input.beneficiary);
    if (beneficiary.status !== "pending") throw new BeneficiaryRegistryError("New beneficiary enrollment must begin in pending status.");
    if (this.#records.has(beneficiary.beneficiaryId)) throw new BeneficiaryRegistryError("Beneficiary is already enrolled.");
    const verification = parseVerification(input.verification, beneficiary.organizationId, beneficiary.beneficiaryId, beneficiary.createdAt);
    const record = frozen({ beneficiary, lifecycle: "enabled" as const, ownership: verification, walletHistory: frozen([{ version: beneficiary.walletVersion, wallet: beneficiary.wallet, createdAt: beneficiary.createdAt }]), changes: frozen([]) });
    this.#records.set(beneficiary.beneficiaryId, record);
    this.notify(record, "beneficiary-enrolled", beneficiary.createdAt);
    return record;
  }

  verifyEnrollment(input: { readonly organizationId: string; readonly beneficiaryId: string; readonly verificationId: string; readonly verifiedByPrincipalId: string; readonly verifiedAt: string }): BeneficiaryRegistryRecord {
    const record = this.required(input.organizationId, input.beneficiaryId);
    if (record.ownership.verificationId !== input.verificationId || record.ownership.status !== "pending") throw new BeneficiaryRegistryError("Enrollment verification is not pending.");
    requirePrincipal(input.verifiedByPrincipalId, "verifiedByPrincipalId"); requireTimestamp(input.verifiedAt, "verifiedAt");
    if (Date.parse(input.verifiedAt) < Date.parse(record.ownership.requestedAt)) throw new BeneficiaryRegistryError("Verification cannot predate its request.");
    const ownership = frozen({ ...record.ownership, status: "verified" as const, verifiedAt: input.verifiedAt, verifiedByPrincipalId: input.verifiedByPrincipalId });
    const beneficiary = frozen({ ...record.beneficiary, status: "approved" as const });
    return this.store(frozen({ ...record, beneficiary, ownership }));
  }

  proposeWalletChange(input: { readonly changeId: string; readonly organizationId: string; readonly beneficiaryId: string; readonly requestedWallet: Beneficiary["wallet"]; readonly requestedByPrincipalId: string; readonly requestedAt: string; readonly justification: string }): BeneficiaryRegistryRecord {
    const record = this.required(input.organizationId, input.beneficiaryId);
    this.assertOperable(record);
    requireIdentifier(input.changeId, "changeId", "bwc_"); requirePrincipal(input.requestedByPrincipalId, "requestedByPrincipalId"); requireTimestamp(input.requestedAt, "requestedAt"); requireBounded(input.justification, "justification", 5, 500); validateWallet(input.requestedWallet);
    if (sameWallet(record.beneficiary.wallet, input.requestedWallet)) throw new BeneficiaryRegistryError("Requested wallet must differ from the active wallet.");
    if (record.changes.some((change) => change.changeId === input.changeId)) throw new BeneficiaryRegistryError("changeId is already used.");
    if (record.changes.some((change) => ["proposed", "approved", "verification-pending", "cooling"].includes(change.status))) throw new BeneficiaryRegistryError("Beneficiary already has an active wallet-change request.");
    const change = frozen({ ...input, requestedWallet: frozen({ ...input.requestedWallet }), status: "proposed" as const });
    const next = this.store(frozen({ ...record, changes: frozen([...record.changes, change]) }));
    this.notify(next, "wallet-change-proposed", input.requestedAt, input.changeId);
    return next;
  }

  approveWalletChange(input: { readonly organizationId: string; readonly beneficiaryId: string; readonly changeId: string; readonly approvedByPrincipalId: string; readonly approvedAt: string }): BeneficiaryRegistryRecord {
    const record = this.required(input.organizationId, input.beneficiaryId); const change = this.change(record, input.changeId);
    if (change.status !== "proposed") throw new BeneficiaryRegistryError("Wallet change is not awaiting approval.");
    requirePrincipal(input.approvedByPrincipalId, "approvedByPrincipalId"); requireTimestamp(input.approvedAt, "approvedAt");
    if (input.approvedByPrincipalId === change.requestedByPrincipalId) throw new BeneficiaryRegistryError("Wallet-change requester cannot approve the same change.");
    if (Date.parse(input.approvedAt) < Date.parse(change.requestedAt)) throw new BeneficiaryRegistryError("Approval cannot predate the wallet-change request.");
    const updated = frozen({ ...change, status: "approved" as const, approvedByPrincipalId: input.approvedByPrincipalId, approvedAt: input.approvedAt });
    const next = this.store(frozen({ ...record, changes: replaceChange(record.changes, updated) }));
    this.notify(next, "wallet-change-approved", input.approvedAt, change.changeId);
    return next;
  }

  beginWalletOwnershipVerification(input: { readonly organizationId: string; readonly beneficiaryId: string; readonly changeId: string; readonly verification: Omit<BeneficiaryOwnershipVerification, "status" | "verifiedAt" | "verifiedByPrincipalId" | "rejectionReason"> }): BeneficiaryRegistryRecord {
    const record = this.required(input.organizationId, input.beneficiaryId); const change = this.change(record, input.changeId);
    if (change.status !== "approved") throw new BeneficiaryRegistryError("Wallet change requires independent approval before verification.");
    const verification = parseVerification(input.verification, input.organizationId, input.beneficiaryId, change.approvedAt!);
    const updated = frozen({ ...change, status: "verification-pending" as const, verification });
    return this.store(frozen({ ...record, changes: replaceChange(record.changes, updated) }));
  }

  verifyWalletChange(input: { readonly organizationId: string; readonly beneficiaryId: string; readonly changeId: string; readonly verificationId: string; readonly verifiedByPrincipalId: string; readonly verifiedAt: string }): BeneficiaryRegistryRecord {
    const record = this.required(input.organizationId, input.beneficiaryId); const change = this.change(record, input.changeId);
    if (change.status !== "verification-pending" || !change.verification || change.verification.verificationId !== input.verificationId) throw new BeneficiaryRegistryError("Wallet ownership verification is not pending.");
    requirePrincipal(input.verifiedByPrincipalId, "verifiedByPrincipalId"); requireTimestamp(input.verifiedAt, "verifiedAt");
    if (input.verifiedByPrincipalId === change.requestedByPrincipalId || input.verifiedByPrincipalId === change.approvedByPrincipalId) throw new BeneficiaryRegistryError("Wallet ownership verifier must be independent of requester and approver.");
    if (Date.parse(input.verifiedAt) < Date.parse(change.verification.requestedAt)) throw new BeneficiaryRegistryError("Verification cannot predate its request.");
    const verification = frozen({ ...change.verification, status: "verified" as const, verifiedAt: input.verifiedAt, verifiedByPrincipalId: input.verifiedByPrincipalId });
    const coolingEndsAt = new Date(Date.parse(input.verifiedAt) + this.#coolingPeriodMs).toISOString();
    const beneficiary = frozen({ ...record.beneficiary, status: "pending" as const, lastWalletChangeAt: input.verifiedAt, wallet: change.requestedWallet, walletVersion: record.beneficiary.walletVersion + 1 });
    const updated = frozen({ ...change, status: "cooling" as const, verification, coolingEndsAt });
    const next = this.store(frozen({ ...record, beneficiary, changes: replaceChange(record.changes, updated) }));
    return next;
  }

  activateWalletChange(input: { readonly organizationId: string; readonly beneficiaryId: string; readonly changeId: string; readonly activatedAt: string }): BeneficiaryRegistryRecord {
    const record = this.required(input.organizationId, input.beneficiaryId); const change = this.change(record, input.changeId);
    if (change.status !== "cooling" || !change.coolingEndsAt) throw new BeneficiaryRegistryError("Wallet change is not in its cooling period.");
    requireTimestamp(input.activatedAt, "activatedAt");
    if (Date.parse(input.activatedAt) < Date.parse(change.coolingEndsAt)) throw new BeneficiaryRegistryError("Wallet-change cooling period has not elapsed.");
    const beneficiary = frozen({ ...record.beneficiary, status: "approved" as const, lastWalletChangeAt: input.activatedAt });
    const updated = frozen({ ...change, status: "active" as const, activatedAt: input.activatedAt });
    const history = frozen([...record.walletHistory, frozen({ version: beneficiary.walletVersion, wallet: beneficiary.wallet, createdAt: change.requestedAt, activatedAt: input.activatedAt, sourceChangeId: change.changeId })]);
    const next = this.store(frozen({ ...record, beneficiary, walletHistory: history, changes: replaceChange(record.changes, updated) }));
    this.notify(next, "wallet-change-active", input.activatedAt, change.changeId);
    return next;
  }

  freeze(input: { readonly organizationId: string; readonly beneficiaryId: string; readonly frozenByPrincipalId: string; readonly frozenAt: string; readonly reason: string }): BeneficiaryRegistryRecord {
    const record = this.required(input.organizationId, input.beneficiaryId); requirePrincipal(input.frozenByPrincipalId, "frozenByPrincipalId"); requireTimestamp(input.frozenAt, "frozenAt"); requireBounded(input.reason, "reason", 3, 500);
    const next = this.store(frozen({ ...record, lifecycle: "frozen" as const, beneficiary: frozen({ ...record.beneficiary, status: "disabled" as const }) }));
    this.notify(next, "beneficiary-frozen", input.frozenAt); return next;
  }

  disable(input: { readonly organizationId: string; readonly beneficiaryId: string; readonly disabledByPrincipalId: string; readonly disabledAt: string; readonly reason: string }): BeneficiaryRegistryRecord {
    const record = this.required(input.organizationId, input.beneficiaryId); requirePrincipal(input.disabledByPrincipalId, "disabledByPrincipalId"); requireTimestamp(input.disabledAt, "disabledAt"); requireBounded(input.reason, "reason", 3, 500);
    const next = this.store(frozen({ ...record, lifecycle: "disabled" as const, beneficiary: frozen({ ...record.beneficiary, status: "disabled" as const }) }));
    this.notify(next, "beneficiary-disabled", input.disabledAt); return next;
  }

  get(organizationId: string, beneficiaryId: string): BeneficiaryRegistryRecord { return this.required(organizationId, beneficiaryId); }
  securityProfile(organizationId: string, beneficiaryId: string): BeneficiarySecurityProfile { const record = this.required(organizationId, beneficiaryId); return frozen({ beneficiaryId, organizationId, status: record.beneficiary.status, walletVersion: record.beneficiary.walletVersion, lastWalletChangeAt: record.beneficiary.lastWalletChangeAt, lifecycle: record.lifecycle }); }
  history(organizationId: string, beneficiaryId: string): readonly BeneficiaryWalletVersion[] { return this.required(organizationId, beneficiaryId).walletHistory; }
  notifications(organizationId: string): readonly BeneficiaryNotification[] { requireIdentifier(organizationId, "organizationId", "org_"); return frozen(this.#notifications.filter((notification) => notification.organizationId === organizationId)); }

  private required(organizationId: string, beneficiaryId: string): BeneficiaryRegistryRecord { requireIdentifier(organizationId, "organizationId", "org_"); requireIdentifier(beneficiaryId, "beneficiaryId", "ben_"); const record = this.#records.get(beneficiaryId); if (!record || record.beneficiary.organizationId !== organizationId) throw new BeneficiaryRegistryError("Beneficiary was not found in this organization."); return record; }
  private change(record: BeneficiaryRegistryRecord, changeId: string): WalletChangeRequest { requireIdentifier(changeId, "changeId", "bwc_"); const change = record.changes.find((candidate) => candidate.changeId === changeId); if (!change) throw new BeneficiaryRegistryError("Wallet-change request was not found."); return change; }
  private assertOperable(record: BeneficiaryRegistryRecord): void { if (record.lifecycle !== "enabled" || record.beneficiary.status !== "approved" || record.ownership.status !== "verified") throw new BeneficiaryRegistryError("Beneficiary is not eligible for a wallet change."); }
  private store(record: BeneficiaryRegistryRecord): BeneficiaryRegistryRecord { const frozenRecord = frozen(record); this.#records.set(record.beneficiary.beneficiaryId, frozenRecord); return frozenRecord; }
  private notify(record: BeneficiaryRegistryRecord, type: BeneficiaryNotificationType, occurredAt: string, relatedChangeId?: string): void { const notification = { notificationId: `ben_notice_${record.beneficiary.beneficiaryId.slice(4)}_${this.#notifications.length + 1}`, organizationId: record.beneficiary.organizationId, beneficiaryId: record.beneficiary.beneficiaryId, type, occurredAt, ...(relatedChangeId === undefined ? {} : { relatedChangeId }) }; this.#notifications.push(frozen(notification)); }
}

function parseVerification(input: Omit<BeneficiaryOwnershipVerification, "status" | "verifiedAt" | "verifiedByPrincipalId" | "rejectionReason">, organizationId: string, beneficiaryId: string, minimumTime: string): BeneficiaryOwnershipVerification {
  const value = input as Record<string, unknown>; const allowed = ["verificationId", "method", "evidenceHash", "requestedAt"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in value))) throw new TypeError("Beneficiary verification fields are invalid.");
  requireIdentifier(value.verificationId, "verificationId", "bov_"); requireTimestamp(value.requestedAt, "requestedAt"); if (Date.parse(value.requestedAt) < Date.parse(minimumTime)) throw new BeneficiaryRegistryError("Verification request cannot predate the controlled action.");
  if (typeof value.evidenceHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.evidenceHash)) throw new TypeError("verification evidenceHash is invalid.");
  if (!(["signed-wallet-challenge", "manual-document-review", "bank-account-match"] as const).includes(value.method as BeneficiaryOwnershipVerification["method"])) throw new TypeError("verification method is invalid.");
  return frozen({ verificationId: value.verificationId, status: "pending" as const, method: value.method as BeneficiaryOwnershipVerification["method"], evidenceHash: value.evidenceHash, requestedAt: value.requestedAt });
}
function replaceChange(changes: readonly WalletChangeRequest[], updated: WalletChangeRequest): readonly WalletChangeRequest[] { return frozen(changes.map((change) => change.changeId === updated.changeId ? updated : change)); }
function validateWallet(wallet: Beneficiary["wallet"]): void { if (!wallet || wallet.network !== "xrpl-classic" || !isValidXrplClassicAddress(wallet.address) || (wallet.destinationTag !== undefined && (!Number.isSafeInteger(wallet.destinationTag) || wallet.destinationTag < 0 || wallet.destinationTag > 4_294_967_295))) throw new TypeError("Requested wallet is invalid."); }
function sameWallet(left: Beneficiary["wallet"], right: Beneficiary["wallet"]): boolean { return left.network === right.network && left.address === right.address && left.destinationTag === right.destinationTag; }
function requireIdentifier(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requirePrincipal(value: unknown, name: string): asserts value is string { requireIdentifier(value, name, "principal_"); }
function requireTimestamp(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid.`); }
function requireBounded(value: unknown, name: string, min: number, max: number): asserts value is string { if (typeof value !== "string" || value.trim().length < min || value.length > max) throw new TypeError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
