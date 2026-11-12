import assert from "node:assert/strict";
import test from "node:test";
import { RiskDriftMonitor, scoreFraudRisk } from "../src/index.ts";

const config = { modelVersion: "rules-2026-01", featureVersion: "features-2026-01", amountRatioReview: "3", amountRatioDeny: "8", velocityReviewCount: 4, velocityDenyCount: 10 };
function input(overrides: Partial<Parameters<typeof scoreFraudRisk>[0]> = {}) { return { organizationId: "org_meridian", paymentAmount: "500", averagePaymentAmount30Days: "250", paymentsLastHour: 1, localHour: 11, beneficiaryAgeHours: 720, beneficiaryConcentrationPercent: 10, operatorNewToBeneficiary: false, operatorFailedAuthorizations24Hours: 0, treasuryDrainPercent: 5, knownFraudBeneficiary: false, observedAt: "2026-11-09T12:00:00.000Z", ...overrides }; }

test("produces a versioned, explainable score from payment features", () => {
  const score = scoreFraudRisk(input({ paymentAmount: "1000", paymentsLastHour: 4, beneficiaryAgeHours: 12, treasuryDrainPercent: 45 }), config);
  assert.equal(score.score, 52); assert.equal(score.hardDeny, false); assert.deepEqual(score.contributions.map((item) => item.feature), ["amount", "velocity", "beneficiary-age", "treasury-drain"]);
});
test("a confirmed fraud beneficiary deterministically produces denial-level score", () => {
  const score = scoreFraudRisk(input({ knownFraudBeneficiary: true }), config);
  assert.equal(score.score, 100); assert.equal(score.hardDeny, true); assert.equal(score.contributions.at(-1)?.feature, "known-fraud");
});
test("drift monitoring reports aggregate score movement without payment details", () => {
  const monitor = new RiskDriftMonitor({ baselineMeanScore: 10 });
  monitor.observe(scoreFraudRisk(input({ paymentAmount: "1000", paymentsLastHour: 4, beneficiaryAgeHours: 12, treasuryDrainPercent: 45 }), config));
  monitor.observe(scoreFraudRisk(input({ knownFraudBeneficiary: true }), config));
  const metrics = monitor.snapshot();
  assert.equal(metrics.observations, 2); assert.equal(metrics.averageScore, 76); assert.equal(metrics.driftStatus, "watch"); assert.equal(metrics.highRiskRatePercent, 50);
});
