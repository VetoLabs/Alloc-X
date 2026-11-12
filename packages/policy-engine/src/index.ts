import {
  addDecimal,
  compareDecimal,
  parseDecimal,
  parsePaymentIntent,
  paymentIntentDigest,
  sha256Digest,
  subtractDecimal,
  type CanonicalValue,
  type PaymentIntent,
  type SecurityDecision,
  type SecurityReasonCode,
} from "../../contracts/src/index.ts";

const dependencyNames = ["policyStore", "beneficiaryRegistry", "evidenceStore", "riskEngine"] as const;
const controls = ["dependencies", "policy", "purpose-asset", "amount", "time", "treasury", "beneficiary", "evidence", "approval", "replay", "velocity", "risk"] as const;

export interface PolicyBundle {
  readonly policyVersion: string;
  readonly organizationId: string;
  readonly status: "published" | "revoked";
  readonly effectiveFrom: string;
  readonly effectiveUntil?: string;
  readonly allowedPurposeCodes: readonly string[];
  readonly allowedAssets: readonly string[];
  readonly maxPaymentAmount: string;
  readonly reserveFloor: string;
  readonly requiredEvidenceByPurpose: Readonly<Record<string, readonly string[]>>;
  readonly approvalRules: readonly ApprovalRule[];
  readonly beneficiaryChangeCoolingPeriodHours: number;
  readonly velocity: { readonly maxPaymentCount24Hours: number; readonly maxPaymentAmount24Hours: string };
  readonly risk: { readonly reviewAtScore: number; readonly denyAtScore: number };
  readonly decisionTtlSeconds: number;
}
export interface ApprovalRule { readonly atOrAboveAmount: string; readonly requiredRoles: readonly string[]; readonly minimumApprovals: number }
export interface BeneficiarySnapshot { readonly beneficiaryId: string; readonly walletVersion: number; readonly status: "approved" | "pending" | "disabled"; readonly lastWalletChangeAt?: string }
export interface EvidenceSnapshot { readonly manifestHash: string; readonly evidenceTypes: readonly string[]; readonly duplicateStatus: "clear" | "exact" | "possible"; readonly procurementStatus: "verified" | "review" | "mismatch" | "missing"; readonly integrityStatus: "verified" | "mismatch" | "pending" }
export interface ApprovalSnapshot { readonly principalId: string; readonly role: string; readonly intentDigest: string; readonly expiresAt: string }
export interface RecentPayment { readonly amount: string; readonly settledAt: string }
export interface EvaluationContext {
  readonly now: string; readonly availableTreasuryBalance: string; readonly availableAllocationBalance: string;
  readonly beneficiary: BeneficiarySnapshot; readonly evidence: EvidenceSnapshot; readonly approvals: readonly ApprovalSnapshot[];
  readonly recentPayments: readonly RecentPayment[]; readonly seenIntentDigests: readonly string[]; readonly riskScore: number;
  readonly securityDependencies: Readonly<Record<(typeof dependencyNames)[number], "available" | "unavailable" | "stale">>;
}
export interface PolicyCheck { readonly control: (typeof controls)[number]; readonly outcome: "PASS" | "REVIEW" | "DENY"; readonly reasonCodes: readonly SecurityReasonCode[] }
export interface PolicyEvaluation { readonly decision: SecurityDecision; readonly policyDigest: string; readonly checks: readonly PolicyCheck[] }

/** Parses an exact policy bundle. Unknown fields and invalid constraints are rejected. */
export function parsePolicyBundle(input: unknown): PolicyBundle {
  const v = object(input, "policy");
  exact(v, ["policyVersion", "organizationId", "status", "effectiveFrom", "effectiveUntil", "allowedPurposeCodes", "allowedAssets", "maxPaymentAmount", "reserveFloor", "requiredEvidenceByPurpose", "approvalRules", "beneficiaryChangeCoolingPeriodHours", "velocity", "risk", "decisionTtlSeconds"], ["effectiveUntil"], "policy");
  const requiredEvidenceByPurpose: Record<string, readonly string[]> = {};
  for (const [purpose, evidence] of Object.entries(object(v.requiredEvidenceByPurpose, "requiredEvidenceByPurpose"))) {
    code(purpose, "requiredEvidenceByPurpose key"); requiredEvidenceByPurpose[purpose] = strings(evidence, `requiredEvidenceByPurpose.${purpose}`, 30);
  }
  const approvalRules = array(v.approvalRules, "approvalRules", 30).map((entry, index) => {
    const rule = object(entry, `approvalRules[${index}]`); exact(rule, ["atOrAboveAmount", "requiredRoles", "minimumApprovals"], [], `approvalRules[${index}]`);
    const requiredRoles = strings(rule.requiredRoles, `approvalRules[${index}].requiredRoles`, 20);
    return frozen({ atOrAboveAmount: money(rule.atOrAboveAmount, `approvalRules[${index}].atOrAboveAmount`, true), requiredRoles, minimumApprovals: integer(rule.minimumApprovals, `approvalRules[${index}].minimumApprovals`, 1, requiredRoles.length) });
  });
  for (let i = 1; i < approvalRules.length; i += 1) if (compareDecimal(approvalRules[i - 1].atOrAboveAmount, approvalRules[i].atOrAboveAmount) >= 0) fail("approvalRules must be strictly ascending by amount");
  const velocity = object(v.velocity, "velocity"); exact(velocity, ["maxPaymentCount24Hours", "maxPaymentAmount24Hours"], [], "velocity");
  const risk = object(v.risk, "risk"); exact(risk, ["reviewAtScore", "denyAtScore"], [], "risk");
  const reviewAtScore = integer(risk.reviewAtScore, "reviewAtScore", 0, 100); const denyAtScore = integer(risk.denyAtScore, "denyAtScore", 0, 100);
  if (reviewAtScore > denyAtScore) fail("reviewAtScore must not exceed denyAtScore");
  const result: PolicyBundle = {
    policyVersion: prefixed(v.policyVersion, "policyVersion", "policy_"), organizationId: prefixed(v.organizationId, "organizationId", "org_"),
    status: oneOf(v.status, ["published", "revoked"], "status"), effectiveFrom: time(v.effectiveFrom, "effectiveFrom"),
    ...(v.effectiveUntil === undefined ? {} : { effectiveUntil: time(v.effectiveUntil, "effectiveUntil") }),
    allowedPurposeCodes: strings(v.allowedPurposeCodes, "allowedPurposeCodes", 100), allowedAssets: assetStrings(v.allowedAssets, "allowedAssets", 30),
    maxPaymentAmount: money(v.maxPaymentAmount, "maxPaymentAmount", true), reserveFloor: money(v.reserveFloor, "reserveFloor"), requiredEvidenceByPurpose: frozen(requiredEvidenceByPurpose), approvalRules: frozen(approvalRules),
    beneficiaryChangeCoolingPeriodHours: integer(v.beneficiaryChangeCoolingPeriodHours, "beneficiaryChangeCoolingPeriodHours", 0, 720),
    velocity: frozen({ maxPaymentCount24Hours: integer(velocity.maxPaymentCount24Hours, "maxPaymentCount24Hours", 1, 1_000_000), maxPaymentAmount24Hours: money(velocity.maxPaymentAmount24Hours, "maxPaymentAmount24Hours", true) }),
    risk: frozen({ reviewAtScore, denyAtScore }), decisionTtlSeconds: integer(v.decisionTtlSeconds, "decisionTtlSeconds", 30, 3600),
  };
  if (result.effectiveUntil && Date.parse(result.effectiveUntil) <= Date.parse(result.effectiveFrom)) fail("effectiveUntil must be after effectiveFrom");
  return frozen(result);
}

export function policyBundleDigest(policy: PolicyBundle): string { return sha256Digest(policy as unknown as CanonicalValue); }

/** Fail closed: untrusted input is parsed before any rule is evaluated. */
export function evaluatePaymentIntentWithTrace(intentInput: unknown, policyInput: unknown, contextInput: unknown): PolicyEvaluation {
  try { return evaluate(parsePaymentIntent(intentInput), parsePolicyBundle(policyInput), parseContext(contextInput)); }
  catch { return invalidResult(intentInput, policyInput, contextInput); }
}

export function evaluatePaymentIntent(intentInput: unknown, policyInput: unknown, contextInput: unknown): SecurityDecision {
  return evaluatePaymentIntentWithTrace(intentInput, policyInput, contextInput).decision;
}

function evaluate(intent: PaymentIntent, policy: PolicyBundle, context: EvaluationContext): PolicyEvaluation {
  const deny = new Set<SecurityReasonCode>(); const review = new Set<SecurityReasonCode>(); const approvalRoles = new Set<string>();
  const digest = paymentIntentDigest(intent); const now = Date.parse(context.now);
  if (Object.values(context.securityDependencies).some((state) => state !== "available")) deny.add("SECURITY_DEPENDENCY_UNAVAILABLE");
  if (policy.status !== "published" || now < Date.parse(policy.effectiveFrom) || (policy.effectiveUntil && now >= Date.parse(policy.effectiveUntil))) deny.add("POLICY_NOT_ACTIVE");
  if (policy.organizationId !== intent.organizationId) deny.add("POLICY_ORGANIZATION_MISMATCH");
  if (policy.policyVersion !== intent.policyVersion) deny.add("POLICY_VERSION_MISMATCH");
  if (!policy.allowedPurposeCodes.includes(intent.purposeCode)) deny.add("POLICY_PURPOSE_NOT_ALLOWED");
  if (!policy.allowedAssets.includes(intent.asset)) deny.add("POLICY_ASSET_NOT_ALLOWED");
  if (compareDecimal(intent.amount, policy.maxPaymentAmount) > 0) deny.add("POLICY_AMOUNT_LIMIT");
  if (now < Date.parse(intent.requestedExecutionWindow.notBefore) || now >= Date.parse(intent.requestedExecutionWindow.expiresAt)) deny.add("POLICY_TIME_WINDOW");
  if (compareDecimal(intent.amount, context.availableAllocationBalance) > 0) deny.add("TREASURY_ALLOCATION_EXHAUSTED");
  if (compareDecimal(intent.amount, context.availableTreasuryBalance) > 0 || compareDecimal(subtractSafely(context.availableTreasuryBalance, intent.amount), policy.reserveFloor) < 0) deny.add("TREASURY_RESERVE_BREACH");
  if (context.beneficiary.beneficiaryId !== intent.beneficiaryId || context.beneficiary.status !== "approved") deny.add("BENEFICIARY_NOT_APPROVED");
  if (context.beneficiary.walletVersion !== intent.beneficiaryWalletVersion) deny.add("BENEFICIARY_VERSION_MISMATCH");
  if (context.beneficiary.lastWalletChangeAt && now < Date.parse(context.beneficiary.lastWalletChangeAt) + policy.beneficiaryChangeCoolingPeriodHours * 3_600_000) deny.add("BENEFICIARY_CHANGE_COOLING_PERIOD");
  if (context.evidence.manifestHash !== intent.evidenceManifestHash || context.evidence.integrityStatus !== "verified") deny.add("EVIDENCE_MISMATCH");
  if (context.evidence.duplicateStatus === "exact") deny.add("EVIDENCE_DUPLICATE"); else if (context.evidence.duplicateStatus === "possible") review.add("EVIDENCE_DUPLICATE");
  if (context.evidence.procurementStatus === "missing") deny.add("EVIDENCE_PROCUREMENT_MISSING"); else if (context.evidence.procurementStatus === "mismatch") deny.add("EVIDENCE_PROCUREMENT_MISMATCH"); else if (context.evidence.procurementStatus === "review") review.add("EVIDENCE_PROCUREMENT_REVIEW");
  if ((policy.requiredEvidenceByPurpose[intent.purposeCode] ?? []).some((item) => !context.evidence.evidenceTypes.includes(item))) deny.add("POLICY_EVIDENCE_MISSING");
  const rule = selectRule(intent.amount, policy.approvalRules);
  if (rule) { for (const role of rule.requiredRoles) approvalRoles.add(role); const approvals = validApprovals(context.approvals, digest, now, rule.requiredRoles, intent.createdBy.principalId); if (approvals.self) deny.add("AUTH_SEGREGATION_OF_DUTIES"); if (approvals.principals.size < rule.minimumApprovals) deny.add("AUTH_APPROVAL_MISSING"); }
  if (context.seenIntentDigests.includes(digest)) deny.add("INTENT_REPLAY_DETECTED");
  const recent = context.recentPayments.filter((payment) => Date.parse(payment.settledAt) >= now - 86_400_000);
  if (recent.length + 1 > policy.velocity.maxPaymentCount24Hours || compareDecimal(recent.reduce((total, payment) => addDecimal(total, payment.amount), intent.amount), policy.velocity.maxPaymentAmount24Hours) > 0) deny.add("RISK_VELOCITY_EXCEEDED");
  if (context.riskScore >= policy.risk.denyAtScore) deny.add("RISK_PAYMENT_DENIED"); else if (context.riskScore >= policy.risk.reviewAtScore) review.add("RISK_ANOMALOUS_PAYMENT");
  const reasonCodes = frozen([...deny, ...review].sort()); const outcome = deny.size ? "DENY" : review.size ? "REVIEW" : "ALLOW";
  const evaluatedAt = new Date(now).toISOString();
  const decision = frozen({ contractVersion: "1.0" as const, decisionId: decisionId(digest, policy.policyVersion, evaluatedAt, outcome, reasonCodes), intentId: intent.intentId, intentDigest: digest, outcome, reasonCodes, requiredApprovalRoles: frozen([...approvalRoles].sort()), riskScore: context.riskScore, policyVersion: policy.policyVersion, evaluatedAt, expiresAt: new Date(now + policy.decisionTtlSeconds * 1000).toISOString() });
  return frozen({ decision, policyDigest: policyBundleDigest(policy), checks: checks(reasonCodes) });
}

function parseContext(input: unknown): EvaluationContext {
  const v = object(input, "context"); exact(v, ["now", "availableTreasuryBalance", "availableAllocationBalance", "beneficiary", "evidence", "approvals", "recentPayments", "seenIntentDigests", "riskScore", "securityDependencies"], [], "context");
  const beneficiary = object(v.beneficiary, "beneficiary"); exact(beneficiary, ["beneficiaryId", "walletVersion", "status", "lastWalletChangeAt"], ["lastWalletChangeAt"], "beneficiary");
  const evidence = object(v.evidence, "evidence"); exact(evidence, ["manifestHash", "evidenceTypes", "duplicateStatus", "procurementStatus", "integrityStatus"], [], "evidence");
  const dependencies = object(v.securityDependencies, "securityDependencies"); exact(dependencies, dependencyNames, [], "securityDependencies");
  const score = v.riskScore; if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) fail("riskScore must be 0 through 100");
  return frozen({ now: time(v.now, "now"), availableTreasuryBalance: money(v.availableTreasuryBalance, "availableTreasuryBalance"), availableAllocationBalance: money(v.availableAllocationBalance, "availableAllocationBalance"),
    beneficiary: frozen({ beneficiaryId: prefixed(beneficiary.beneficiaryId, "beneficiaryId", "ben_"), walletVersion: integer(beneficiary.walletVersion, "walletVersion", 1, Number.MAX_SAFE_INTEGER), status: oneOf(beneficiary.status, ["approved", "pending", "disabled"], "beneficiary.status"), ...(beneficiary.lastWalletChangeAt === undefined ? {} : { lastWalletChangeAt: time(beneficiary.lastWalletChangeAt, "lastWalletChangeAt") }) }),
    evidence: frozen({ manifestHash: digest(evidence.manifestHash, "manifestHash"), evidenceTypes: strings(evidence.evidenceTypes, "evidenceTypes", 100), duplicateStatus: oneOf(evidence.duplicateStatus, ["clear", "exact", "possible"], "duplicateStatus"), procurementStatus: oneOf(evidence.procurementStatus, ["verified", "review", "mismatch", "missing"], "procurementStatus"), integrityStatus: oneOf(evidence.integrityStatus, ["verified", "mismatch", "pending"], "integrityStatus") }),
    approvals: frozen(array(v.approvals, "approvals", 100).map((entry, index) => snapshot(entry, index))), recentPayments: frozen(array(v.recentPayments, "recentPayments", 10_000).map((entry, index) => payment(entry, index))), seenIntentDigests: digestList(v.seenIntentDigests), riskScore: score,
    securityDependencies: frozen({ policyStore: oneOf(dependencies.policyStore, ["available", "unavailable", "stale"], "policyStore"), beneficiaryRegistry: oneOf(dependencies.beneficiaryRegistry, ["available", "unavailable", "stale"], "beneficiaryRegistry"), evidenceStore: oneOf(dependencies.evidenceStore, ["available", "unavailable", "stale"], "evidenceStore"), riskEngine: oneOf(dependencies.riskEngine, ["available", "unavailable", "stale"], "riskEngine") }),
  });
}

function invalidResult(intent: unknown, policy: unknown, context: unknown): PolicyEvaluation {
  const evaluatedAt = safeTime(context) ?? "1970-01-01T00:00:00.000Z"; const intentId = safePrefixed(intent, "intentId", "pi_") ?? "pi_invalid"; const policyVersion = safePrefixed(policy, "policyVersion", "policy_") ?? "policy_invalid";
  const intentDigest = sha256Digest({ invalid: stable(intent) } as CanonicalValue); const reasonCodes: readonly SecurityReasonCode[] = ["POLICY_EVALUATION_INPUT_INVALID"];
  const decision = frozen({ contractVersion: "1.0" as const, decisionId: decisionId(intentDigest, policyVersion, evaluatedAt, "DENY", reasonCodes), intentId, intentDigest, outcome: "DENY" as const, reasonCodes, requiredApprovalRoles: frozen([]), riskScore: 0, policyVersion, evaluatedAt, expiresAt: new Date(Date.parse(evaluatedAt) + 30_000).toISOString() });
  return frozen({ decision, policyDigest: sha256Digest({ invalid: stable(policy) } as CanonicalValue), checks: checks(reasonCodes) });
}

function checks(reasons: readonly SecurityReasonCode[]): readonly PolicyCheck[] {
  const map: Readonly<Record<(typeof controls)[number], readonly SecurityReasonCode[]>> = { dependencies: ["SECURITY_DEPENDENCY_UNAVAILABLE", "POLICY_EVALUATION_INPUT_INVALID"], policy: ["POLICY_NOT_ACTIVE", "POLICY_ORGANIZATION_MISMATCH", "POLICY_VERSION_MISMATCH"], "purpose-asset": ["POLICY_PURPOSE_NOT_ALLOWED", "POLICY_ASSET_NOT_ALLOWED"], amount: ["POLICY_AMOUNT_LIMIT"], time: ["POLICY_TIME_WINDOW"], treasury: ["TREASURY_RESERVE_BREACH", "TREASURY_ALLOCATION_EXHAUSTED"], beneficiary: ["BENEFICIARY_NOT_APPROVED", "BENEFICIARY_VERSION_MISMATCH", "BENEFICIARY_CHANGE_COOLING_PERIOD"], evidence: ["EVIDENCE_DUPLICATE", "EVIDENCE_MISMATCH", "EVIDENCE_PROCUREMENT_MISSING", "EVIDENCE_PROCUREMENT_MISMATCH", "EVIDENCE_PROCUREMENT_REVIEW", "POLICY_EVIDENCE_MISSING"], approval: ["AUTH_APPROVAL_MISSING", "AUTH_SEGREGATION_OF_DUTIES"], replay: ["INTENT_REPLAY_DETECTED"], velocity: ["RISK_VELOCITY_EXCEEDED"], risk: ["RISK_ANOMALOUS_PAYMENT", "RISK_PAYMENT_DENIED"] };
  return frozen(controls.map((control) => { const matched = frozen(map[control].filter((code) => reasons.includes(code))); const outcome = matched.some((code) => code !== "RISK_ANOMALOUS_PAYMENT" && code !== "EVIDENCE_DUPLICATE" && code !== "EVIDENCE_PROCUREMENT_REVIEW") ? "DENY" : matched.length ? "REVIEW" : "PASS"; return frozen({ control, outcome, reasonCodes: matched }); }));
}

function snapshot(input: unknown, index: number): ApprovalSnapshot { const v = object(input, `approvals[${index}]`); exact(v, ["principalId", "role", "intentDigest", "expiresAt"], [], `approvals[${index}]`); return frozen({ principalId: prefixed(v.principalId, "principalId", "principal_"), role: code(v.role, "role"), intentDigest: digest(v.intentDigest, "intentDigest"), expiresAt: time(v.expiresAt, "expiresAt") }); }
function payment(input: unknown, index: number): RecentPayment { const v = object(input, `recentPayments[${index}]`); exact(v, ["amount", "settledAt"], [], `recentPayments[${index}]`); return frozen({ amount: money(v.amount, "amount", true), settledAt: time(v.settledAt, "settledAt") }); }
function selectRule(amount: string, rules: readonly ApprovalRule[]): ApprovalRule | undefined { return [...rules].filter((rule) => compareDecimal(amount, rule.atOrAboveAmount) >= 0).sort((a, b) => compareDecimal(b.atOrAboveAmount, a.atOrAboveAmount))[0]; }
function validApprovals(approvals: readonly ApprovalSnapshot[], intentDigest: string, now: number, roles: readonly string[], initiator: string): { principals: ReadonlySet<string>; self: boolean } { const principals = new Set<string>(); let self = false; for (const approval of approvals) { if (approval.intentDigest !== intentDigest || Date.parse(approval.expiresAt) <= now || !roles.includes(approval.role)) continue; if (approval.principalId === initiator) self = true; else principals.add(approval.principalId); } return { principals, self }; }
function subtractSafely(left: string, right: string): string { return compareDecimal(left, right) >= 0 ? subtractDecimal(left, right) : "0"; }
function decisionId(intentDigest: string, policyVersion: string, evaluatedAt: string, outcome: string, reasonCodes: readonly SecurityReasonCode[]): string { return `sec_${sha256Digest({ intentDigest, policyVersion, evaluatedAt, outcome, reasonCodes } as unknown as CanonicalValue).slice(7, 39)}`; }
function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[], name: string): void { for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${name} has unsupported field ${key}`); for (const key of keys) if (!(key in value) && !optional.includes(key)) fail(`${name} is missing ${key}`); }
function array(value: unknown, name: string, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) fail(`${name} must be an array with at most ${maximum} entries`); return value; }
function prefixed(value: unknown, name: string, prefix: string): string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) fail(`${name} must be a valid ${prefix} identifier`); return value; }
function code(value: unknown, name: string): string { if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,79}$/.test(value)) fail(`${name} must be a lowercase code`); return value; }
function strings(value: unknown, name: string, maximum: number): readonly string[] { const result = array(value, name, maximum).map((item) => code(item, name)); if (new Set(result).size !== result.length) fail(`${name} must not include duplicates`); return frozen(result); }
function assetStrings(value: unknown, name: string, maximum: number): readonly string[] { const result = array(value, name, maximum).map((item) => { if (typeof item !== "string" || !/^[A-Za-z0-9-]{3,80}$/.test(item)) fail(`${name} must contain asset codes`); return item; }); if (new Set(result).size !== result.length) fail(`${name} must not include duplicates`); return frozen(result); }
function money(value: unknown, name: string, positive = false): string { if (typeof value !== "string") fail(`${name} must be a decimal string`); try { const parsed = parseDecimal(value); if (positive && parsed.coefficient <= 0n) fail(`${name} must be greater than zero`); } catch { fail(`${name} must be a valid decimal string`); } return value; }
function integer(value: unknown, name: string, minimum: number, maximum: number): number { if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) fail(`${name} must be an integer from ${minimum} through ${maximum}`); return value; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T { if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${name} has unsupported value`); return value as T; }
function digest(value: unknown, name: string): string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) fail(`${name} must be a sha256 digest`); return value; }
function digestList(value: unknown): readonly string[] { const result = array(value, "seenIntentDigests", 10_000).map((item) => digest(item, "seenIntentDigests item")); if (new Set(result).size !== result.length) fail("seenIntentDigests must not include duplicates"); return frozen(result); }
function time(value: unknown, name: string): string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${name} must be an ISO UTC timestamp`); return value; }
function frozen<T>(value: T): T { return Object.freeze(value); }
function fail(message: string): never { throw new TypeError(message); }
function safeTime(input: unknown): string | undefined { try { return time(object(input, "context").now, "now"); } catch { return undefined; } }
function safePrefixed(input: unknown, key: string, prefix: string): string | undefined { try { return prefixed(object(input, "input")[key], key, prefix); } catch { return undefined; } }
function stable(value: unknown): string { try { return JSON.stringify(value) ?? "undefined"; } catch { return "unserializable"; } }
