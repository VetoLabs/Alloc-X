import type { CanonicalValue } from "./canonical.ts";
import { sha256Digest } from "./canonical.ts";
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
  readPositiveAmount,
  readPositiveSafeInteger,
  readTimestamp,
  rejectUnknownKeys,
  throwIfIssues,
} from "./validation.ts";

export const PAYMENT_INTENT_CONTRACT_VERSION = CONTRACT_VERSION;

export type ActorType = "human" | "agent";

export interface PaymentIntent {
  readonly contractVersion: typeof PAYMENT_INTENT_CONTRACT_VERSION;
  readonly intentId: string;
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly sourceObligationId: string;
  readonly allocationId: string;
  readonly amount: string;
  readonly asset: string;
  readonly beneficiaryId: string;
  readonly beneficiaryWalletVersion: number;
  readonly purposeCode: string;
  readonly evidenceManifestHash: string;
  readonly policyVersion: string;
  readonly requestedExecutionWindow: {
    readonly notBefore: string;
    readonly expiresAt: string;
  };
  readonly createdBy: {
    readonly principalId: string;
    readonly actorType: ActorType;
  };
}

export { ContractValidationError } from "./validation.ts";

const ROOT_KEYS = new Set([
  "contractVersion",
  "intentId",
  "organizationId",
  "idempotencyKey",
  "sourceObligationId",
  "allocationId",
  "amount",
  "asset",
  "beneficiaryId",
  "beneficiaryWalletVersion",
  "purposeCode",
  "evidenceManifestHash",
  "policyVersion",
  "requestedExecutionWindow",
  "createdBy",
]);

export function parsePaymentIntent(input: unknown): PaymentIntent {
  const issues: string[] = [];
  const value = asRecord(input, "intent", issues);
  rejectUnknownKeys(value, ROOT_KEYS, "intent", issues);

  const executionWindow = asRecord(
    value.requestedExecutionWindow,
    "requestedExecutionWindow",
    issues,
  );
  rejectUnknownKeys(
    executionWindow,
    new Set(["notBefore", "expiresAt"]),
    "requestedExecutionWindow",
    issues,
  );

  const createdBy = asRecord(value.createdBy, "createdBy", issues);
  rejectUnknownKeys(
    createdBy,
    new Set(["principalId", "actorType"]),
    "createdBy",
    issues,
  );

  const normalizedAmount = readPositiveAmount(value.amount, "amount", issues);

  const notBefore = readTimestamp(executionWindow.notBefore, "notBefore", issues);
  const expiresAt = readTimestamp(executionWindow.expiresAt, "expiresAt", issues);
  if (notBefore && expiresAt && Date.parse(notBefore) >= Date.parse(expiresAt)) {
    issues.push("requestedExecutionWindow.expiresAt must be after notBefore");
  }

  const walletVersion = readPositiveSafeInteger(value.beneficiaryWalletVersion, "beneficiaryWalletVersion", issues);

  const actorType = readEnum(createdBy.actorType, "createdBy.actorType", ["human", "agent"] as const, issues);

  readContractVersion(value.contractVersion, issues);

  const evidenceManifestHash = readDigest(value.evidenceManifestHash, "evidenceManifestHash", issues);

  const result: PaymentIntent = {
    contractVersion: PAYMENT_INTENT_CONTRACT_VERSION,
    intentId: readIdentifier(value.intentId, "intentId", "pi_", issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    idempotencyKey: readBoundedString(value.idempotencyKey, "idempotencyKey", 1, 200, issues),
    sourceObligationId: readIdentifier(
      value.sourceObligationId,
      "sourceObligationId",
      "obl_",
      issues,
    ),
    allocationId: readIdentifier(value.allocationId, "allocationId", "alloc_", issues),
    amount: normalizedAmount,
    asset: readBoundedString(value.asset, "asset", 1, 80, issues),
    beneficiaryId: readIdentifier(value.beneficiaryId, "beneficiaryId", "ben_", issues),
    beneficiaryWalletVersion: walletVersion,
    purposeCode: readBoundedString(value.purposeCode, "purposeCode", 1, 100, issues),
    evidenceManifestHash,
    policyVersion: readIdentifier(value.policyVersion, "policyVersion", "policy_", issues),
    requestedExecutionWindow: { notBefore, expiresAt },
    createdBy: {
      principalId: readIdentifier(createdBy.principalId, "createdBy.principalId", "principal_", issues),
      actorType,
    },
  };

  throwIfIssues(issues);

  return deepFreeze(result);
}

export function paymentIntentDigest(intent: PaymentIntent): string {
  return sha256Digest(intent as unknown as CanonicalValue);
}

export function assertPaymentIntentActiveAt(intent: PaymentIntent, evaluatedAt: string): void {
  const timestamp = Date.parse(evaluatedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== evaluatedAt) {
    throw new ContractValidationError(["evaluatedAt must be a canonical UTC RFC3339 timestamp"]);
  }
  if (timestamp < Date.parse(intent.requestedExecutionWindow.notBefore)) {
    throw new ContractValidationError(["payment intent is not active at evaluatedAt"]);
  }
  if (timestamp >= Date.parse(intent.requestedExecutionWindow.expiresAt)) {
    throw new ContractValidationError(["payment intent has expired at evaluatedAt"]);
  }
}
