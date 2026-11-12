import { compareDecimal, parseDecimal } from "../../../packages/contracts/src/index.ts";

export type RiskFeatureName = "amount" | "velocity" | "timing" | "beneficiary-age" | "concentration" | "operator-behavior" | "treasury-drain" | "known-fraud";
export interface FraudFeatureInput {
  readonly organizationId: string;
  readonly paymentAmount: string;
  readonly averagePaymentAmount30Days: string;
  readonly paymentsLastHour: number;
  readonly localHour: number;
  readonly beneficiaryAgeHours: number;
  readonly beneficiaryConcentrationPercent: number;
  readonly operatorNewToBeneficiary: boolean;
  readonly operatorFailedAuthorizations24Hours: number;
  readonly treasuryDrainPercent: number;
  readonly knownFraudBeneficiary: boolean;
  readonly observedAt: string;
}
export interface FraudModelConfig { readonly modelVersion: string; readonly featureVersion: string; readonly amountRatioReview: string; readonly amountRatioDeny: string; readonly velocityReviewCount: number; readonly velocityDenyCount: number; }
export interface RiskContribution { readonly feature: RiskFeatureName; readonly points: number; readonly explanation: string; }
export interface FraudRiskScore { readonly modelVersion: string; readonly featureVersion: string; readonly score: number; readonly hardDeny: boolean; readonly contributions: readonly RiskContribution[]; readonly assessedAt: string; }
export interface RiskDriftMetrics { readonly modelVersion: string; readonly featureVersion: string; readonly observations: number; readonly averageScore: number; readonly reviewOrDenyRatePercent: number; readonly highRiskRatePercent: number; readonly meanScoreShift: number; readonly driftStatus: "stable" | "watch"; }

/** Deterministic, explainable scoring. No machine learning output is accepted from an untrusted caller. */
export function scoreFraudRisk(input: FraudFeatureInput, config: FraudModelConfig): FraudRiskScore {
  validateInput(input); validateConfig(config);
  const contributions: RiskContribution[] = [];
  const add = (feature: RiskFeatureName, points: number, explanation: string) => { if (points > 0) contributions.push(frozen({ feature, points, explanation })); };
  const ratio = decimalRatioAtLeast(input.paymentAmount, input.averagePaymentAmount30Days, config.amountRatioDeny) ? "deny" : decimalRatioAtLeast(input.paymentAmount, input.averagePaymentAmount30Days, config.amountRatioReview) ? "review" : "normal";
  if (ratio === "deny") add("amount", 30, "Payment amount is materially above the recent organization baseline."); else if (ratio === "review") add("amount", 15, "Payment amount is above the recent organization baseline.");
  if (input.paymentsLastHour >= config.velocityDenyCount) add("velocity", 25, "Payment count is materially above the configured hourly pattern."); else if (input.paymentsLastHour >= config.velocityReviewCount) add("velocity", 12, "Payment count is above the configured hourly pattern.");
  if (input.localHour < 5) add("timing", 8, "Payment was requested during an unusual local operating hour.");
  if (input.beneficiaryAgeHours < 24) add("beneficiary-age", 15, "Beneficiary is less than 24 hours old."); else if (input.beneficiaryAgeHours < 168) add("beneficiary-age", 7, "Beneficiary is less than seven days old.");
  if (input.beneficiaryConcentrationPercent >= 80) add("concentration", 18, "Beneficiary concentration is exceptionally high."); else if (input.beneficiaryConcentrationPercent >= 50) add("concentration", 9, "Beneficiary concentration is elevated.");
  if (input.operatorNewToBeneficiary) add("operator-behavior", 6, "Operator has no prior history with this beneficiary."); if (input.operatorFailedAuthorizations24Hours >= 5) add("operator-behavior", 12, "Operator has repeated failed authorization attempts."); else if (input.operatorFailedAuthorizations24Hours >= 2) add("operator-behavior", 6, "Operator has recent failed authorization attempts.");
  if (input.treasuryDrainPercent >= 70) add("treasury-drain", 22, "Payment would consume an unusually large share of available treasury."); else if (input.treasuryDrainPercent >= 40) add("treasury-drain", 10, "Payment would consume a material share of available treasury.");
  if (input.knownFraudBeneficiary) add("known-fraud", 100, "Beneficiary appears on the organizationâ€™s confirmed fraud blocklist.");
  const hardDeny = input.knownFraudBeneficiary; const score = hardDeny ? 100 : Math.min(100, contributions.reduce((total, contribution) => total + contribution.points, 0));
  return frozen({ modelVersion: config.modelVersion, featureVersion: config.featureVersion, score, hardDeny, contributions: frozen(contributions), assessedAt: input.observedAt });
}

/** Keeps bounded monitoring data so drift can be inspected without exposing payment records. */
export class RiskDriftMonitor {
  readonly #baselineMeanScore: number; readonly #observations: FraudRiskScore[] = [];
  constructor(input: { readonly baselineMeanScore: number }) { if (!Number.isFinite(input.baselineMeanScore) || input.baselineMeanScore < 0 || input.baselineMeanScore > 100) throw new FraudScoringError("baselineMeanScore is invalid."); this.#baselineMeanScore = input.baselineMeanScore; }
  observe(score: FraudRiskScore): void { validateScore(score); this.#observations.push(score); if (this.#observations.length > 10_000) this.#observations.shift(); }
  snapshot(): RiskDriftMetrics {
    const count = this.#observations.length; const mean = count ? this.#observations.reduce((total, value) => total + value.score, 0) / count : 0; const interventionCount = this.#observations.filter((value) => value.score >= 60).length; const highRiskCount = this.#observations.filter((value) => value.score >= 85).length; const shift = Math.round((mean - this.#baselineMeanScore) * 100) / 100; const latest = this.#observations.at(-1);
    return frozen({ modelVersion: latest?.modelVersion ?? "unobserved", featureVersion: latest?.featureVersion ?? "unobserved", observations: count, averageScore: Math.round(mean * 100) / 100, reviewOrDenyRatePercent: percent(interventionCount, count), highRiskRatePercent: percent(highRiskCount, count), meanScoreShift: shift, driftStatus: Math.abs(shift) >= 15 ? "watch" : "stable" });
  }
}

export function policyRiskScore(value: FraudRiskScore): number { validateScore(value); return value.score; }
export class FraudScoringError extends Error { constructor(message: string) { super(message); this.name = "FraudScoringError"; } }

function decimalRatioAtLeast(amount: string, baseline: string, multiple: string): boolean { const value = parseDecimal(amount); const average = parseDecimal(baseline); const factor = parseDecimal(multiple); const scale = Math.max(value.scale, average.scale + factor.scale); const left = value.coefficient * 10n ** BigInt(scale - value.scale); const right = average.coefficient * factor.coefficient * 10n ** BigInt(scale - average.scale - factor.scale); return left >= right; }
function validateInput(value: FraudFeatureInput): void { requireId(value.organizationId, "organizationId", "org_"); positive(value.paymentAmount, "paymentAmount"); positive(value.averagePaymentAmount30Days, "averagePaymentAmount30Days"); integer(value.paymentsLastHour, "paymentsLastHour", 0, 1_000_000); integer(value.localHour, "localHour", 0, 23); integer(value.beneficiaryAgeHours, "beneficiaryAgeHours", 0, 876_000); percentValue(value.beneficiaryConcentrationPercent, "beneficiaryConcentrationPercent"); percentValue(value.treasuryDrainPercent, "treasuryDrainPercent"); integer(value.operatorFailedAuthorizations24Hours, "operatorFailedAuthorizations24Hours", 0, 1_000_000); if (typeof value.operatorNewToBeneficiary !== "boolean" || typeof value.knownFraudBeneficiary !== "boolean") throw new FraudScoringError("Boolean feature is invalid."); timestamp(value.observedAt, "observedAt"); }
function validateConfig(value: FraudModelConfig): void { text(value.modelVersion, "modelVersion"); text(value.featureVersion, "featureVersion"); positive(value.amountRatioReview, "amountRatioReview"); positive(value.amountRatioDeny, "amountRatioDeny"); if (compareDecimal(value.amountRatioDeny, value.amountRatioReview) < 0) throw new FraudScoringError("amountRatioDeny must not be lower than amountRatioReview."); integer(value.velocityReviewCount, "velocityReviewCount", 1, 1_000_000); integer(value.velocityDenyCount, "velocityDenyCount", value.velocityReviewCount, 1_000_000); }
function validateScore(value: FraudRiskScore): void { text(value.modelVersion, "modelVersion"); text(value.featureVersion, "featureVersion"); if (!Number.isInteger(value.score) || value.score < 0 || value.score > 100 || typeof value.hardDeny !== "boolean") throw new FraudScoringError("Risk score is invalid."); timestamp(value.assessedAt, "assessedAt"); }
function positive(value: unknown, name: string): asserts value is string { try { if (typeof value !== "string" || parseDecimal(value).coefficient <= 0n) throw new Error(); } catch { throw new FraudScoringError(`${name} is invalid.`); } }
function integer(value: unknown, name: string, min: number, max: number): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new FraudScoringError(`${name} is invalid.`); }
function percentValue(value: unknown, name: string): asserts value is number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new FraudScoringError(`${name} is invalid.`); }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/u.test(value)) throw new FraudScoringError(`${name} is invalid.`); }
function text(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,80}$/u.test(value)) throw new FraudScoringError(`${name} is invalid.`); }
function timestamp(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new FraudScoringError(`${name} is invalid.`); }
function percent(part: number, total: number): number { return total === 0 ? 0 : Math.round(part / total * 10_000) / 100; }
function frozen<T>(value: T): T { return Object.freeze(value); }
