import assert from "node:assert/strict";
import test from "node:test";

import { parsePaymentIntent } from "../../../packages/contracts/src/index.ts";
import { type EvaluationContext, type PolicyBundle } from "../../../packages/policy-engine/src/index.ts";
import { PolicySimulator, PolicySimulatorError, simulationPublicationGate } from "../src/index.ts";

function policy(version: string, maxPaymentAmount: string): PolicyBundle { return { policyVersion: version, organizationId: "org_meridian", status: "published", effectiveFrom: "2026-01-01T00:00:00.000Z", allowedPurposeCodes: ["clinic-supplies"], allowedAssets: ["XRP"], maxPaymentAmount, reserveFloor: "100", requiredEvidenceByPurpose: { "clinic-supplies": ["invoice"] }, approvalRules: [], beneficiaryChangeCoolingPeriodHours: 24, velocity: { maxPaymentCount24Hours: 10, maxPaymentAmount24Hours: "10000" }, risk: { reviewAtScore: 60, denyAtScore: 85 }, decisionTtlSeconds: 300 }; }
function intent(id: string, amount: string) { return parsePaymentIntent({ contractVersion: "1.0", intentId: id, organizationId: "org_meridian", idempotencyKey: `org_meridian/${id}`, sourceObligationId: "obl_clinic", allocationId: "alloc_clinic", amount, asset: "XRP", beneficiaryId: "ben_vendor", beneficiaryWalletVersion: 1, purposeCode: "clinic-supplies", evidenceManifestHash: `sha256:${"a".repeat(64)}`, policyVersion: "policy_baseline", requestedExecutionWindow: { notBefore: "2026-11-08T12:00:00.000Z", expiresAt: "2026-11-08T14:00:00.000Z" }, createdBy: { principalId: "principal_agent", actorType: "agent" } }); }
const context: EvaluationContext = { now: "2026-11-08T13:00:00.000Z", availableTreasuryBalance: "1000", availableAllocationBalance: "1000", beneficiary: { beneficiaryId: "ben_vendor", walletVersion: 1, status: "approved", lastWalletChangeAt: "2026-10-01T00:00:00.000Z" }, evidence: { manifestHash: `sha256:${"a".repeat(64)}`, evidenceTypes: ["invoice"], duplicateStatus: "clear", procurementStatus: "verified", integrityStatus: "verified" }, approvals: [], recentPayments: [], seenIntentDigests: [], riskScore: 10, securityDependencies: { policyStore: "available", beneficiaryRegistry: "available", evidenceStore: "available", riskEngine: "available" } };

test("compares historical and synthetic decisions with autonomy, exposure, and reserve metrics", () => {
  const simulator = new PolicySimulator(); const report = simulator.run({ baseline: policy("policy_baseline", "500"), candidate: policy("policy_candidate", "300"), simulatedAt: "2026-11-08T13:10:00.000Z", scenarios: [
    { scenarioId: "psc_historical_001", source: "historical", intent: intent("pi_historical_001", "400"), context, expectedCandidateOutcome: "DENY" },
    { scenarioId: "psc_synthetic_001", source: "synthetic", intent: intent("pi_synthetic_001", "200"), context },
  ] });
  assert.equal(report.comparisons[0].baseline.outcome, "ALLOW"); assert.equal(report.comparisons[0].candidate.outcome, "DENY"); assert.equal(report.comparisons[0].unexpected, false); assert.equal(report.metrics.autonomyRatePercent, 50); assert.equal(report.metrics.candidateAllowedExposure, "200"); assert.equal(report.metrics.maximumAllowedPayment, "200"); assert.equal(report.metrics.minimumReserveAfterAllowedPayment, "800");
  const assessment = simulator.assess(report, { minimumAutonomyRatePercent: 50, maximumAllowedExposure: "200", maximumUnexpectedChanges: 0 }); assert.equal(assessment.passed, true); assert.equal(simulationPublicationGate({ report, assessment }).assertCanPublish({ policy: policy("policy_candidate", "300") }), undefined);
});

test("flags unexpected decision changes and blocks the associated publication gate", () => {
  const simulator = new PolicySimulator(); const report = simulator.run({ baseline: policy("policy_baseline", "500"), candidate: policy("policy_candidate", "300"), simulatedAt: "2026-11-08T13:10:00.000Z", scenarios: [{ scenarioId: "psc_regression_001", source: "historical", intent: intent("pi_regression_001", "400"), context }] });
  const assessment = simulator.assess(report, { minimumAutonomyRatePercent: 0, maximumAllowedExposure: "1000", maximumUnexpectedChanges: 0 }); assert.deepEqual(assessment, { passed: false, failures: ["UNEXPECTED_DECISIONS_ABOVE_THRESHOLD"] });
  assert.throws(() => simulationPublicationGate({ report, assessment }).assertCanPublish({ policy: policy("policy_candidate", "300") }), (error: unknown) => error instanceof PolicySimulatorError && /did not pass/.test(error.message));
});
