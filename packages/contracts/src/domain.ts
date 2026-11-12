import { createHash, timingSafeEqual } from "node:crypto";

import { compareDecimal } from "./money.ts";
import type { PaymentIntent } from "./payment-intent.ts";
import { SECURITY_OUTCOMES, SECURITY_REASON_CODES, type SecurityOutcome, type SecurityReasonCode } from "./security-decision.ts";
import {
  CONTRACT_VERSION,
  ContractValidationError,
  asRecord,
  deepFreeze,
  readBoundedString,
  readContractVersion,
  readDigest,
  readEnum,
  readIdentifier,
  readOptionalDestinationTag,
  readPositiveAmount,
  readPositiveSafeInteger,
  readString,
  readStringArray,
  readTimestamp,
  rejectUnknownKeys,
  throwIfIssues,
} from "./validation.ts";

export type OrganizationStatus = "active" | "suspended";
export type PrincipalKind = "human" | "service" | "agent";
export type PrincipalStatus = "active" | "suspended";
export type ObligationStatus = "open" | "cancelled" | "fulfilled";
export type AllocationStatus = "active" | "suspended" | "expired";
export type BeneficiaryStatus = "approved" | "pending" | "disabled";
export type EvidenceStatus = "verified" | "pending" | "quarantined";
export type EvidenceType = "invoice" | "purchase-order" | "delivery-note" | "contract" | "payroll-record" | "other";
export type ApprovalOutcome = "approved" | "rejected";
export type LedgerNetwork = "devnet" | "testnet" | "mainnet";
export type LedgerResultOutcome = "validated" | "failed";
export type SettlementStatus = "not-submitted" | "validated" | "failed";

export interface Organization {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly organizationId: string;
  readonly displayName: string;
  readonly status: OrganizationStatus;
  readonly createdAt: string;
}

export interface Principal {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly principalId: string;
  readonly organizationId: string;
  readonly kind: PrincipalKind;
  readonly status: PrincipalStatus;
  readonly roles: readonly string[];
  readonly createdAt: string;
}

export interface Obligation {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly obligationId: string;
  readonly organizationId: string;
  readonly beneficiaryId: string;
  readonly amount: string;
  readonly asset: string;
  readonly purposeCode: string;
  readonly evidenceManifestHash: string;
  readonly dueAt: string;
  readonly status: ObligationStatus;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
}

export interface Allocation {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly allocationId: string;
  readonly organizationId: string;
  readonly displayName: string;
  readonly asset: string;
  readonly authorizedAmount: string;
  readonly allowedPurposeCodes: readonly string[];
  readonly activeFrom: string;
  readonly expiresAt: string;
  readonly status: AllocationStatus;
}

export interface Beneficiary {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly beneficiaryId: string;
  readonly organizationId: string;
  readonly status: BeneficiaryStatus;
  readonly wallet: {
    readonly network: "xrpl-classic";
    readonly address: string;
    readonly destinationTag?: number;
  };
  readonly walletVersion: number;
  readonly lastWalletChangeAt: string;
  readonly createdAt: string;
}

export interface EvidenceManifest {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly evidenceManifestId: string;
  readonly organizationId: string;
  readonly obligationId: string;
  readonly manifestHash: string;
  readonly items: readonly EvidenceItem[];
  readonly createdAt: string;
}

export interface EvidenceItem {
  readonly evidenceId: string;
  readonly type: EvidenceType;
  readonly contentHash: string;
  readonly sourceSystem: string;
  readonly status: EvidenceStatus;
  readonly observedAt: string;
}

export interface Approval {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly approvalId: string;
  readonly organizationId: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly principalId: string;
  readonly role: string;
  readonly outcome: ApprovalOutcome;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface LedgerTransactionResult {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly ledgerResultId: string;
  readonly organizationId: string;
  readonly intentId: string;
  readonly transactionDigest: string;
  readonly network: LedgerNetwork;
  readonly outcome: LedgerResultOutcome;
  readonly transactionHash: string;
  readonly ledgerIndex: number;
  readonly validatedAt: string;
}

export interface DecisionReceipt {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly receiptId: string;
  readonly organizationId: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly decisionId: string;
  readonly policyVersion: string;
  readonly evidenceManifestHash: string;
  readonly securityOutcome: SecurityOutcome;
  readonly reasonCodes: readonly SecurityReasonCode[];
  readonly settlement: {
    readonly status: SettlementStatus;
    readonly transactionHash?: string;
  };
  readonly receiptHash: string;
  readonly generatedAt: string;
}

export interface PaymentReferenceBundle {
  readonly organization: Organization;
  readonly principal: Principal;
  readonly obligation: Obligation;
  readonly allocation: Allocation;
  readonly beneficiary: Beneficiary;
  readonly evidenceManifest: EvidenceManifest;
  readonly paymentIntent: PaymentIntent;
}

const ORGANIZATION_KEYS = new Set(["contractVersion", "organizationId", "displayName", "status", "createdAt"]);
const PRINCIPAL_KEYS = new Set(["contractVersion", "principalId", "organizationId", "kind", "status", "roles", "createdAt"]);
const OBLIGATION_KEYS = new Set([
  "contractVersion",
  "obligationId",
  "organizationId",
  "beneficiaryId",
  "amount",
  "asset",
  "purposeCode",
  "evidenceManifestHash",
  "dueAt",
  "status",
  "createdByPrincipalId",
  "createdAt",
]);
const ALLOCATION_KEYS = new Set([
  "contractVersion",
  "allocationId",
  "organizationId",
  "displayName",
  "asset",
  "authorizedAmount",
  "allowedPurposeCodes",
  "activeFrom",
  "expiresAt",
  "status",
]);
const BENEFICIARY_KEYS = new Set([
  "contractVersion",
  "beneficiaryId",
  "organizationId",
  "status",
  "wallet",
  "walletVersion",
  "lastWalletChangeAt",
  "createdAt",
]);
const EVIDENCE_MANIFEST_KEYS = new Set([
  "contractVersion",
  "evidenceManifestId",
  "organizationId",
  "obligationId",
  "manifestHash",
  "items",
  "createdAt",
]);
const EVIDENCE_ITEM_KEYS = new Set(["evidenceId", "type", "contentHash", "sourceSystem", "status", "observedAt"]);
const APPROVAL_KEYS = new Set([
  "contractVersion",
  "approvalId",
  "organizationId",
  "intentId",
  "intentDigest",
  "principalId",
  "role",
  "outcome",
  "createdAt",
  "expiresAt",
]);
const LEDGER_RESULT_KEYS = new Set([
  "contractVersion",
  "ledgerResultId",
  "organizationId",
  "intentId",
  "transactionDigest",
  "network",
  "outcome",
  "transactionHash",
  "ledgerIndex",
  "validatedAt",
]);
const RECEIPT_KEYS = new Set([
  "contractVersion",
  "receiptId",
  "organizationId",
  "intentId",
  "intentDigest",
  "decisionId",
  "policyVersion",
  "evidenceManifestHash",
  "securityOutcome",
  "reasonCodes",
  "settlement",
  "receiptHash",
  "generatedAt",
]);

export function parseOrganization(input: unknown): Organization {
  const issues: string[] = [];
  const value = asRecord(input, "organization", issues);
  rejectUnknownKeys(value, ORGANIZATION_KEYS, "organization", issues);
  const result: Organization = {
    contractVersion: readContractVersion(value.contractVersion, issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    displayName: readBoundedString(value.displayName, "displayName", 1, 160, issues),
    status: readEnum(value.status, "status", ["active", "suspended"] as const, issues),
    createdAt: readTimestamp(value.createdAt, "createdAt", issues),
  };
  throwIfIssues(issues);
  return deepFreeze(result);
}

export function parsePrincipal(input: unknown): Principal {
  const issues: string[] = [];
  const value = asRecord(input, "principal", issues);
  rejectUnknownKeys(value, PRINCIPAL_KEYS, "principal", issues);
  const result: Principal = {
    contractVersion: readContractVersion(value.contractVersion, issues),
    principalId: readIdentifier(value.principalId, "principalId", "principal_", issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    kind: readEnum(value.kind, "kind", ["human", "service", "agent"] as const, issues),
    status: readEnum(value.status, "status", ["active", "suspended"] as const, issues),
    roles: readStringArray(value.roles, "roles", 30, issues),
    createdAt: readTimestamp(value.createdAt, "createdAt", issues),
  };
  throwIfIssues(issues);
  return deepFreeze(result);
}

export function parseObligation(input: unknown): Obligation {
  const issues: string[] = [];
  const value = asRecord(input, "obligation", issues);
  rejectUnknownKeys(value, OBLIGATION_KEYS, "obligation", issues);
  const result: Obligation = {
    contractVersion: readContractVersion(value.contractVersion, issues),
    obligationId: readIdentifier(value.obligationId, "obligationId", "obl_", issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    beneficiaryId: readIdentifier(value.beneficiaryId, "beneficiaryId", "ben_", issues),
    amount: readPositiveAmount(value.amount, "amount", issues),
    asset: readBoundedString(value.asset, "asset", 1, 80, issues),
    purposeCode: readBoundedString(value.purposeCode, "purposeCode", 1, 100, issues),
    evidenceManifestHash: readDigest(value.evidenceManifestHash, "evidenceManifestHash", issues),
    dueAt: readTimestamp(value.dueAt, "dueAt", issues),
    status: readEnum(value.status, "status", ["open", "cancelled", "fulfilled"] as const, issues),
    createdByPrincipalId: readIdentifier(value.createdByPrincipalId, "createdByPrincipalId", "principal_", issues),
    createdAt: readTimestamp(value.createdAt, "createdAt", issues),
  };
  if (Date.parse(result.dueAt) < Date.parse(result.createdAt)) issues.push("dueAt must not be before createdAt");
  throwIfIssues(issues);
  return deepFreeze(result);
}

export function parseAllocation(input: unknown): Allocation {
  const issues: string[] = [];
  const value = asRecord(input, "allocation", issues);
  rejectUnknownKeys(value, ALLOCATION_KEYS, "allocation", issues);
  const result: Allocation = {
    contractVersion: readContractVersion(value.contractVersion, issues),
    allocationId: readIdentifier(value.allocationId, "allocationId", "alloc_", issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    displayName: readBoundedString(value.displayName, "displayName", 1, 160, issues),
    asset: readBoundedString(value.asset, "asset", 1, 80, issues),
    authorizedAmount: readPositiveAmount(value.authorizedAmount, "authorizedAmount", issues),
    allowedPurposeCodes: readStringArray(value.allowedPurposeCodes, "allowedPurposeCodes", 100, issues),
    activeFrom: readTimestamp(value.activeFrom, "activeFrom", issues),
    expiresAt: readTimestamp(value.expiresAt, "expiresAt", issues),
    status: readEnum(value.status, "status", ["active", "suspended", "expired"] as const, issues),
  };
  if (Date.parse(result.activeFrom) >= Date.parse(result.expiresAt)) {
    issues.push("expiresAt must be after activeFrom");
  }
  throwIfIssues(issues);
  return deepFreeze(result);
}

export function parseBeneficiary(input: unknown): Beneficiary {
  const issues: string[] = [];
  const value = asRecord(input, "beneficiary", issues);
  rejectUnknownKeys(value, BENEFICIARY_KEYS, "beneficiary", issues);
  const wallet = asRecord(value.wallet, "wallet", issues);
  rejectUnknownKeys(wallet, new Set(["network", "address", "destinationTag"]), "wallet", issues);
  const address = readString(wallet.address, "wallet.address", issues);
  if (readEnum(wallet.network, "wallet.network", ["xrpl-classic"] as const, issues) === "xrpl-classic" && !isValidXrplClassicAddress(address)) {
    issues.push("wallet.address must be a valid checksummed XRPL classic address");
  }
  const result: Beneficiary = {
    contractVersion: readContractVersion(value.contractVersion, issues),
    beneficiaryId: readIdentifier(value.beneficiaryId, "beneficiaryId", "ben_", issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    status: readEnum(value.status, "status", ["approved", "pending", "disabled"] as const, issues),
    wallet: {
      network: "xrpl-classic",
      address,
      ...(readOptionalDestinationTag(wallet.destinationTag, "wallet.destinationTag", issues) === undefined
        ? {}
        : { destinationTag: readOptionalDestinationTag(wallet.destinationTag, "wallet.destinationTag", issues) }),
    },
    walletVersion: readPositiveSafeInteger(value.walletVersion, "walletVersion", issues),
    lastWalletChangeAt: readTimestamp(value.lastWalletChangeAt, "lastWalletChangeAt", issues),
    createdAt: readTimestamp(value.createdAt, "createdAt", issues),
  };
  if (Date.parse(result.lastWalletChangeAt) < Date.parse(result.createdAt)) {
    issues.push("lastWalletChangeAt must not be before createdAt");
  }
  throwIfIssues(issues);
  return deepFreeze(result);
}

export function parseEvidenceManifest(input: unknown): EvidenceManifest {
  const issues: string[] = [];
  const value = asRecord(input, "evidenceManifest", issues);
  rejectUnknownKeys(value, EVIDENCE_MANIFEST_KEYS, "evidenceManifest", issues);
  const itemValues = value.items;
  if (!Array.isArray(itemValues) || itemValues.length === 0 || itemValues.length > 100) {
    issues.push("items must contain between 1 and 100 items");
  }
  const items = (Array.isArray(itemValues) ? itemValues : []).map((item, index) => parseEvidenceItem(item, `items[${index}]`, issues));
  if (new Set(items.map((item) => item.evidenceId)).size !== items.length) issues.push("items must not repeat evidenceId");
  const result: EvidenceManifest = {
    contractVersion: readContractVersion(value.contractVersion, issues),
    evidenceManifestId: readIdentifier(value.evidenceManifestId, "evidenceManifestId", "evidence_", issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    obligationId: readIdentifier(value.obligationId, "obligationId", "obl_", issues),
    manifestHash: readDigest(value.manifestHash, "manifestHash", issues),
    items,
    createdAt: readTimestamp(value.createdAt, "createdAt", issues),
  };
  throwIfIssues(issues);
  return deepFreeze(result);
}

export function parseApproval(input: unknown): Approval {
  const issues: string[] = [];
  const value = asRecord(input, "approval", issues);
  rejectUnknownKeys(value, APPROVAL_KEYS, "approval", issues);
  const result: Approval = {
    contractVersion: readContractVersion(value.contractVersion, issues),
    approvalId: readIdentifier(value.approvalId, "approvalId", "apr_", issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    intentId: readIdentifier(value.intentId, "intentId", "pi_", issues),
    intentDigest: readDigest(value.intentDigest, "intentDigest", issues),
    principalId: readIdentifier(value.principalId, "principalId", "principal_", issues),
    role: readBoundedString(value.role, "role", 1, 100, issues),
    outcome: readEnum(value.outcome, "outcome", ["approved", "rejected"] as const, issues),
    createdAt: readTimestamp(value.createdAt, "createdAt", issues),
    expiresAt: readTimestamp(value.expiresAt, "expiresAt", issues),
  };
  if (Date.parse(result.expiresAt) <= Date.parse(result.createdAt)) {
    issues.push("expiresAt must be after createdAt");
  }
  throwIfIssues(issues);
  return deepFreeze(result);
}

export function parseLedgerTransactionResult(input: unknown): LedgerTransactionResult {
  const issues: string[] = [];
  const value = asRecord(input, "ledgerTransactionResult", issues);
  rejectUnknownKeys(value, LEDGER_RESULT_KEYS, "ledgerTransactionResult", issues);
  const transactionHash = readString(value.transactionHash, "transactionHash", issues);
  if (!/^[A-F0-9]{64}$/.test(transactionHash)) {
    issues.push("transactionHash must be a 64-character uppercase hexadecimal hash");
  }
  const result: LedgerTransactionResult = {
    contractVersion: readContractVersion(value.contractVersion, issues),
    ledgerResultId: readIdentifier(value.ledgerResultId, "ledgerResultId", "ltr_", issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    intentId: readIdentifier(value.intentId, "intentId", "pi_", issues),
    transactionDigest: readDigest(value.transactionDigest, "transactionDigest", issues),
    network: readEnum(value.network, "network", ["devnet", "testnet", "mainnet"] as const, issues),
    outcome: readEnum(value.outcome, "outcome", ["validated", "failed"] as const, issues),
    transactionHash,
    ledgerIndex: readPositiveSafeInteger(value.ledgerIndex, "ledgerIndex", issues),
    validatedAt: readTimestamp(value.validatedAt, "validatedAt", issues),
  };
  throwIfIssues(issues);
  return deepFreeze(result);
}

export function parseDecisionReceipt(input: unknown): DecisionReceipt {
  const issues: string[] = [];
  const value = asRecord(input, "decisionReceipt", issues);
  rejectUnknownKeys(value, RECEIPT_KEYS, "decisionReceipt", issues);
  const settlement = asRecord(value.settlement, "settlement", issues);
  rejectUnknownKeys(settlement, new Set(["status", "transactionHash"]), "settlement", issues);
  const status = readEnum(settlement.status, "settlement.status", ["not-submitted", "validated", "failed"] as const, issues);
  const transactionHash = settlement.transactionHash === undefined ? undefined : readString(settlement.transactionHash, "settlement.transactionHash", issues);
  if (status === "validated" && (!transactionHash || !/^[A-F0-9]{64}$/.test(transactionHash))) {
    issues.push("validated settlement requires a 64-character uppercase transactionHash");
  }
  if (status === "not-submitted" && transactionHash !== undefined) {
    issues.push("not-submitted settlement must not include transactionHash");
  }
  const rawReasonCodes = readStringArray(value.reasonCodes, "reasonCodes", 100, issues);
  const reasonCodes: SecurityReasonCode[] = [];
  for (const code of rawReasonCodes) {
    if (!SECURITY_REASON_CODES.includes(code as SecurityReasonCode)) {
      issues.push(`reasonCodes contains unsupported value: ${code}`);
    } else {
      reasonCodes.push(code as SecurityReasonCode);
    }
  }
  const securityOutcome = readEnum(value.securityOutcome, "securityOutcome", SECURITY_OUTCOMES, issues);
  if (securityOutcome === "ALLOW" && reasonCodes.length > 0) {
    issues.push("ALLOW receipt must not contain reasonCodes");
  }
  const result: DecisionReceipt = {
    contractVersion: readContractVersion(value.contractVersion, issues),
    receiptId: readIdentifier(value.receiptId, "receiptId", "receipt_", issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    intentId: readIdentifier(value.intentId, "intentId", "pi_", issues),
    intentDigest: readDigest(value.intentDigest, "intentDigest", issues),
    decisionId: readIdentifier(value.decisionId, "decisionId", "sec_", issues),
    policyVersion: readIdentifier(value.policyVersion, "policyVersion", "policy_", issues),
    evidenceManifestHash: readDigest(value.evidenceManifestHash, "evidenceManifestHash", issues),
    securityOutcome,
    reasonCodes,
    settlement: transactionHash === undefined ? { status } : { status, transactionHash },
    receiptHash: readDigest(value.receiptHash, "receiptHash", issues),
    generatedAt: readTimestamp(value.generatedAt, "generatedAt", issues),
  };
  throwIfIssues(issues);
  return deepFreeze(result);
}

export function validatePaymentReferenceBundle(bundle: PaymentReferenceBundle): Readonly<PaymentReferenceBundle> {
  const issues: string[] = [];
  const organizationId = bundle.organization.organizationId;
  const scopedRecords: readonly [string, string][] = [
    ["principal.organizationId", bundle.principal.organizationId],
    ["obligation.organizationId", bundle.obligation.organizationId],
    ["allocation.organizationId", bundle.allocation.organizationId],
    ["beneficiary.organizationId", bundle.beneficiary.organizationId],
    ["evidenceManifest.organizationId", bundle.evidenceManifest.organizationId],
    ["paymentIntent.organizationId", bundle.paymentIntent.organizationId],
  ];
  for (const [path, value] of scopedRecords) {
    if (value !== organizationId) issues.push(`${path} does not match organization.organizationId`);
  }

  if (bundle.paymentIntent.sourceObligationId !== bundle.obligation.obligationId) {
    issues.push("paymentIntent.sourceObligationId does not match obligation.obligationId");
  }
  if (bundle.paymentIntent.allocationId !== bundle.allocation.allocationId) {
    issues.push("paymentIntent.allocationId does not match allocation.allocationId");
  }
  if (bundle.paymentIntent.beneficiaryId !== bundle.beneficiary.beneficiaryId) {
    issues.push("paymentIntent.beneficiaryId does not match beneficiary.beneficiaryId");
  }
  if (bundle.paymentIntent.beneficiaryWalletVersion !== bundle.beneficiary.walletVersion) {
    issues.push("paymentIntent.beneficiaryWalletVersion does not match beneficiary.walletVersion");
  }
  if (bundle.paymentIntent.evidenceManifestHash !== bundle.evidenceManifest.manifestHash) {
    issues.push("paymentIntent.evidenceManifestHash does not match evidenceManifest.manifestHash");
  }
  if (bundle.evidenceManifest.obligationId !== bundle.obligation.obligationId) {
    issues.push("evidenceManifest.obligationId does not match obligation.obligationId");
  }
  if (bundle.paymentIntent.createdBy.principalId !== bundle.principal.principalId) {
    issues.push("paymentIntent.createdBy.principalId does not match principal.principalId");
  }
  if (bundle.obligation.beneficiaryId !== bundle.beneficiary.beneficiaryId) {
    issues.push("obligation.beneficiaryId does not match beneficiary.beneficiaryId");
  }
  if (bundle.obligation.evidenceManifestHash !== bundle.evidenceManifest.manifestHash) {
    issues.push("obligation.evidenceManifestHash does not match evidenceManifest.manifestHash");
  }
  if (bundle.paymentIntent.amount !== bundle.obligation.amount || bundle.paymentIntent.asset !== bundle.obligation.asset) {
    issues.push("payment intent amount and asset must match obligation");
  }
  if (bundle.paymentIntent.purposeCode !== bundle.obligation.purposeCode) {
    issues.push("payment intent purposeCode must match obligation");
  }
  if (bundle.paymentIntent.asset !== bundle.allocation.asset) {
    issues.push("payment intent asset must match allocation asset");
  }
  if (!bundle.allocation.allowedPurposeCodes.includes(bundle.paymentIntent.purposeCode)) {
    issues.push("payment intent purposeCode is not allowed by allocation");
  }
  if (compareDecimal(bundle.paymentIntent.amount, bundle.allocation.authorizedAmount) > 0) {
    issues.push("payment intent amount exceeds allocation authorizedAmount");
  }
  if (bundle.organization.status !== "active") issues.push("organization must be active");
  if (bundle.principal.status !== "active") issues.push("principal must be active");
  if (bundle.beneficiary.status !== "approved") issues.push("beneficiary must be approved");
  if (bundle.obligation.status !== "open") issues.push("obligation must be open");
  if (bundle.allocation.status !== "active") issues.push("allocation must be active");

  throwIfIssues(issues);
  return deepFreeze(bundle);
}

export function assertApprovalActiveAt(approval: Approval, evaluatedAt: string): void {
  const timestamp = Date.parse(evaluatedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== evaluatedAt) {
    throw new ContractValidationError(["evaluatedAt must be a canonical UTC RFC3339 timestamp"]);
  }
  if (Date.parse(approval.expiresAt) <= timestamp) {
    throw new ContractValidationError(["approval has expired at evaluatedAt"]);
  }
}

export function isValidXrplClassicAddress(address: string): boolean {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) return false;
  try {
    const decoded = decodeRippleBase58(address);
    if (decoded.length !== 25 || decoded[0] !== 0) return false;
    const payload = decoded.subarray(0, 21);
    const checksum = decoded.subarray(21);
    const first = createHash("sha256").update(payload).digest();
    const expected = createHash("sha256").update(first).digest().subarray(0, 4);
    return timingSafeEqual(checksum, expected);
  } catch {
    return false;
  }
}

function parseEvidenceItem(input: unknown, path: string, issues: string[]): EvidenceItem {
  const value = asRecord(input, path, issues);
  rejectUnknownKeys(value, EVIDENCE_ITEM_KEYS, path, issues);
  return {
    evidenceId: readIdentifier(value.evidenceId, `${path}.evidenceId`, "evi_", issues),
    type: readEnum(
      value.type,
      `${path}.type`,
      ["invoice", "purchase-order", "delivery-note", "contract", "payroll-record", "other"] as const,
      issues,
    ),
    contentHash: readDigest(value.contentHash, `${path}.contentHash`, issues),
    sourceSystem: readBoundedString(value.sourceSystem, `${path}.sourceSystem`, 1, 100, issues),
    status: readEnum(value.status, `${path}.status`, ["verified", "pending", "quarantined"] as const, issues),
    observedAt: readTimestamp(value.observedAt, `${path}.observedAt`, issues),
  };
}

function decodeRippleBase58(value: string): Buffer {
  const alphabet = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
  let number = 0n;
  for (const character of value) {
    const position = alphabet.indexOf(character);
    if (position < 0) throw new TypeError("Address includes a non-base58 character");
    number = number * 58n + BigInt(position);
  }
  let encoded = number === 0n ? Buffer.alloc(0) : Buffer.from(number.toString(16).padStart(number.toString(16).length + (number.toString(16).length % 2), "0"), "hex");
  let leadingZeros = 0;
  for (const character of value) {
    if (character !== alphabet[0]) break;
    leadingZeros += 1;
  }
  if (leadingZeros > 0) encoded = Buffer.concat([Buffer.alloc(leadingZeros), encoded]);
  return encoded;
}
