import {
  CONTRACT_VERSION,
  asRecord,
  deepFreeze,
  readBoundedString,
  readContractVersion,
  readDigest,
  readEnum,
  readIdentifier,
  readStringArray,
  readTimestamp,
  rejectUnknownKeys,
  throwIfIssues,
} from "./validation.ts";

export const SECURITY_OUTCOMES = ["ALLOW", "REVIEW", "DENY"] as const;
export type SecurityOutcome = (typeof SECURITY_OUTCOMES)[number];

export const SECURITY_REASON_CODES = [
  "AUTH_PRINCIPAL_NOT_ALLOWED",
  "AUTH_APPROVAL_MISSING",
  "AUTH_SEGREGATION_OF_DUTIES",
  "POLICY_NOT_ACTIVE",
  "POLICY_ORGANIZATION_MISMATCH",
  "POLICY_VERSION_MISMATCH",
  "POLICY_PURPOSE_NOT_ALLOWED",
  "POLICY_ASSET_NOT_ALLOWED",
  "POLICY_AMOUNT_LIMIT",
  "POLICY_TIME_WINDOW",
  "POLICY_EVIDENCE_MISSING",
  "TREASURY_RESERVE_BREACH",
  "TREASURY_ALLOCATION_EXHAUSTED",
  "BENEFICIARY_NOT_APPROVED",
  "BENEFICIARY_VERSION_MISMATCH",
  "BENEFICIARY_CHANGE_COOLING_PERIOD",
  "EVIDENCE_DUPLICATE",
  "EVIDENCE_MISMATCH",
  "EVIDENCE_PROCUREMENT_MISSING",
  "EVIDENCE_PROCUREMENT_MISMATCH",
  "EVIDENCE_PROCUREMENT_REVIEW",
  "RISK_VELOCITY_EXCEEDED",
  "RISK_ANOMALOUS_PAYMENT",
  "RISK_PAYMENT_DENIED",
  "INTENT_REPLAY_DETECTED",
  "TRANSACTION_DIGEST_MISMATCH",
  "LEDGER_PREFLIGHT_FAILED",
  "SECURITY_DEPENDENCY_UNAVAILABLE",
  "POLICY_EVALUATION_INPUT_INVALID",
] as const;

export type SecurityReasonCode = (typeof SECURITY_REASON_CODES)[number];

export interface SecurityDecision {
  readonly contractVersion: "1.0";
  readonly decisionId: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly outcome: SecurityOutcome;
  readonly reasonCodes: readonly SecurityReasonCode[];
  readonly requiredApprovalRoles: readonly string[];
  readonly riskScore: number;
  readonly policyVersion: string;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
}

const SECURITY_DECISION_KEYS = new Set([
  "contractVersion",
  "decisionId",
  "intentId",
  "intentDigest",
  "outcome",
  "reasonCodes",
  "requiredApprovalRoles",
  "riskScore",
  "policyVersion",
  "evaluatedAt",
  "expiresAt",
]);

export function parseSecurityDecision(input: unknown): SecurityDecision {
  const issues: string[] = [];
  const value = asRecord(input, "securityDecision", issues);
  rejectUnknownKeys(value, SECURITY_DECISION_KEYS, "securityDecision", issues);
  const rawReasonCodes = readStringArray(value.reasonCodes, "reasonCodes", 100, issues);
  const reasonCodes: SecurityReasonCode[] = [];
  for (const code of rawReasonCodes) {
    if (!SECURITY_REASON_CODES.includes(code as SecurityReasonCode)) {
      issues.push(`reasonCodes contains unsupported value: ${code}`);
    } else {
      reasonCodes.push(code as SecurityReasonCode);
    }
  }

  const riskScore = value.riskScore;
  if (typeof riskScore !== "number" || !Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
    issues.push("riskScore must be a finite number from 0 through 100");
  }

  const result: SecurityDecision = {
    contractVersion: readContractVersion(value.contractVersion, issues),
    decisionId: readIdentifier(value.decisionId, "decisionId", "sec_", issues),
    intentId: readIdentifier(value.intentId, "intentId", "pi_", issues),
    intentDigest: readDigest(value.intentDigest, "intentDigest", issues),
    outcome: readEnum(value.outcome, "outcome", SECURITY_OUTCOMES, issues),
    reasonCodes,
    requiredApprovalRoles: readStringArray(value.requiredApprovalRoles, "requiredApprovalRoles", 30, issues),
    riskScore: typeof riskScore === "number" ? riskScore : 0,
    policyVersion: readIdentifier(value.policyVersion, "policyVersion", "policy_", issues),
    evaluatedAt: readTimestamp(value.evaluatedAt, "evaluatedAt", issues),
    expiresAt: readTimestamp(value.expiresAt, "expiresAt", issues),
  };

  if (Date.parse(result.expiresAt) <= Date.parse(result.evaluatedAt)) {
    issues.push("expiresAt must be after evaluatedAt");
  }
  if (result.outcome === "ALLOW" && result.reasonCodes.length > 0) {
    issues.push("ALLOW decisions must not contain reasonCodes");
  }
  throwIfIssues(issues);
  return deepFreeze(result);
}
