import assert from "node:assert/strict";
import test from "node:test";

import { parsePaymentIntent, paymentIntentDigest } from "../../contracts/src/index.ts";
import {
  evaluatePaymentIntent,
  evaluatePaymentIntentWithTrace,
  parsePolicyBundle,
  policyBundleDigest,
} from "../src/index.ts";

const hash = `sha256:${"a".repeat(64)}`;

function intent(overrides: Record<string, unknown> = {}) {
  return parsePaymentIntent({
    contractVersion: "1.0", intentId: "pi_boundary", organizationId: "org_acme",
    idempotencyKey: "org_acme/boundary/v1", sourceObligationId: "obl_boundary",
    allocationId: "alloc_operations", amount: "400", asset: "XRP", beneficiaryId: "ben_vendor_7",
    beneficiaryWalletVersion: 3, purposeCode: "operations-supplies", evidenceManifestHash: hash,
    policyVersion: "policy_2026_01",
    requestedExecutionWindow: { notBefore: "2026-11-06T12:00:00.000Z", expiresAt: "2026-11-06T14:00:00.000Z" },
    createdBy: { principalId: "principal_alloc_agent", actorType: "agent" },
    ...overrides,
  });
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    policyVersion: "policy_2026_01", organizationId: "org_acme", status: "published",
    effectiveFrom: "2026-01-01T00:00:00.000Z", allowedPurposeCodes: ["operations-supplies"],
    allowedAssets: ["XRP"], maxPaymentAmount: "500", reserveFloor: "1000",
    requiredEvidenceByPurpose: { "operations-supplies": ["invoice"] }, approvalRules: [],
    beneficiaryChangeCoolingPeriodHours: 24,
    velocity: { maxPaymentCount24Hours: 2, maxPaymentAmount24Hours: "1000" },
    risk: { reviewAtScore: 60, denyAtScore: 85 }, decisionTtlSeconds: 300,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    now: "2026-11-06T13:00:00.000Z", availableTreasuryBalance: "1500", availableAllocationBalance: "1000",
    beneficiary: { beneficiaryId: "ben_vendor_7", walletVersion: 3, status: "approved", lastWalletChangeAt: "2026-11-01T00:00:00.000Z" },
    evidence: { manifestHash: hash, evidenceTypes: ["invoice"], duplicateStatus: "clear", procurementStatus: "verified", integrityStatus: "verified" },
    approvals: [], recentPayments: [], seenIntentDigests: [], riskScore: 10,
    securityDependencies: { policyStore: "available", beneficiaryRegistry: "available", evidenceStore: "available", riskEngine: "available" },
    ...overrides,
  };
}

test("accepts exact policy limits and denies the next representable decimal amount", () => {
  const exact = evaluatePaymentIntent(intent({ amount: "500" }), policy(), context({ availableTreasuryBalance: "1500", availableAllocationBalance: "500" }));
  const over = evaluatePaymentIntent(intent({ amount: "500.000000000000000001" }), policy(), context({ availableTreasuryBalance: "1500", availableAllocationBalance: "500.000000000000000001" }));
  assert.equal(exact.outcome, "ALLOW");
  assert.equal(over.outcome, "DENY");
  assert.ok(over.reasonCodes.includes("POLICY_AMOUNT_LIMIT"));
});

test("enforces reserve, time, and velocity edges with inclusive/exclusive semantics", () => {
  const reserveExact = evaluatePaymentIntent(intent({ amount: "500" }), policy(), context({ availableTreasuryBalance: "1500", availableAllocationBalance: "500" }));
  const reserveBelow = evaluatePaymentIntent(intent({ amount: "500.000000000000000001" }), policy({ maxPaymentAmount: "1000" }), context({ availableTreasuryBalance: "1500", availableAllocationBalance: "1000" }));
  const beforeExpiry = evaluatePaymentIntent(intent(), policy(), context({ now: "2026-11-06T13:59:59.999Z" }));
  const atExpiry = evaluatePaymentIntent(intent(), policy(), context({ now: "2026-11-06T14:00:00.000Z" }));
  const atVelocity = evaluatePaymentIntent(intent(), policy(), context({ recentPayments: [{ amount: "300", settledAt: "2026-11-06T12:00:00.000Z" }] }));
  const overVelocity = evaluatePaymentIntent(intent(), policy(), context({ recentPayments: [{ amount: "300", settledAt: "2026-11-06T12:00:00.000Z" }, { amount: "200", settledAt: "2026-11-06T11:00:00.000Z" }] }));
  assert.equal(reserveExact.outcome, "ALLOW");
  assert.ok(reserveBelow.reasonCodes.includes("TREASURY_RESERVE_BREACH"));
  assert.equal(beforeExpiry.outcome, "ALLOW");
  assert.ok(atExpiry.reasonCodes.includes("POLICY_TIME_WINDOW"));
  assert.equal(atVelocity.outcome, "ALLOW");
  assert.ok(overVelocity.reasonCodes.includes("RISK_VELOCITY_EXCEEDED"));
});

test("policy digest is canonical and invalid external input fails closed with a control trace", () => {
  const first = parsePolicyBundle(policy());
  const reordered = parsePolicyBundle({ ...policy(), allowedAssets: ["XRP"], allowedPurposeCodes: ["operations-supplies"] });
  assert.equal(policyBundleDigest(first), policyBundleDigest(reordered));
  const result = evaluatePaymentIntentWithTrace(intent(), { ...policy(), decisionTtlSeconds: 0 }, context());
  assert.equal(result.decision.outcome, "DENY");
  assert.deepEqual(result.decision.reasonCodes, ["POLICY_EVALUATION_INPUT_INVALID"]);
  assert.deepEqual(result.checks.find((check) => check.control === "dependencies"), {
    control: "dependencies", outcome: "DENY", reasonCodes: ["POLICY_EVALUATION_INPUT_INVALID"],
  });
});

test("replay input remains bound to the exact canonical payment intent", () => {
  const payment = intent();
  const result = evaluatePaymentIntent(payment, policy(), context({ seenIntentDigests: [paymentIntentDigest(payment)] }));
  assert.equal(result.outcome, "DENY");
  assert.ok(result.reasonCodes.includes("INTENT_REPLAY_DETECTED"));
});
