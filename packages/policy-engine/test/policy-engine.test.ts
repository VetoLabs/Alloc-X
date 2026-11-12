import assert from "node:assert/strict";
import test from "node:test";

import { parsePaymentIntent, paymentIntentDigest } from "../../contracts/src/index.ts";
import {
  evaluatePaymentIntent,
  type EvaluationContext,
  type PolicyBundle,
} from "../src/index.ts";

function intent(overrides: Record<string, unknown> = {}) {
  return parsePaymentIntent({
    contractVersion: "1.0",
    intentId: "pi_001",
    organizationId: "org_acme",
    idempotencyKey: "org_acme/invoice-42/v1",
    sourceObligationId: "obl_42",
    allocationId: "alloc_operations",
    amount: "400",
    asset: "XRP",
    beneficiaryId: "ben_vendor_7",
    beneficiaryWalletVersion: 3,
    purposeCode: "operations-supplies",
    evidenceManifestHash: `sha256:${"a".repeat(64)}`,
    policyVersion: "policy_2026_01",
    requestedExecutionWindow: {
      notBefore: "2026-11-06T12:00:00.000Z",
      expiresAt: "2026-11-06T14:00:00.000Z",
    },
    createdBy: {
      principalId: "principal_alloc_agent",
      actorType: "agent",
    },
    ...overrides,
  });
}

function policy(overrides: Partial<PolicyBundle> = {}): PolicyBundle {
  return {
    policyVersion: "policy_2026_01",
    organizationId: "org_acme",
    status: "published",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    allowedPurposeCodes: ["operations-supplies"],
    allowedAssets: ["XRP"],
    maxPaymentAmount: "5000",
    reserveFloor: "1000",
    requiredEvidenceByPurpose: {
      "operations-supplies": ["invoice", "purchase-order", "delivery-note"],
    },
    approvalRules: [
      {
        atOrAboveAmount: "1000",
        requiredRoles: ["finance-approver"],
        minimumApprovals: 1,
      },
    ],
    beneficiaryChangeCoolingPeriodHours: 24,
    velocity: {
      maxPaymentCount24Hours: 10,
      maxPaymentAmount24Hours: "10000",
    },
    risk: {
      reviewAtScore: 60,
      denyAtScore: 85,
    },
    decisionTtlSeconds: 300,
    ...overrides,
  };
}

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    now: "2026-11-06T13:00:00.000Z",
    availableTreasuryBalance: "10000",
    availableAllocationBalance: "3000",
    beneficiary: {
      beneficiaryId: "ben_vendor_7",
      walletVersion: 3,
      status: "approved",
      lastWalletChangeAt: "2026-11-01T00:00:00.000Z",
    },
    evidence: {
      manifestHash: `sha256:${"a".repeat(64)}`,
      evidenceTypes: ["invoice", "purchase-order", "delivery-note"],
      duplicateStatus: "clear",
      procurementStatus: "verified",
      integrityStatus: "verified",
    },
    approvals: [],
    recentPayments: [],
    seenIntentDigests: [],
    riskScore: 10,
    securityDependencies: {
      policyStore: "available",
      beneficiaryRegistry: "available",
      evidenceStore: "available",
      riskEngine: "available",
    },
    ...overrides,
  };
}

test("allows a payment only when every mandatory control passes", () => {
  const result = evaluatePaymentIntent(intent(), policy(), context());
  assert.equal(result.outcome, "ALLOW");
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.expiresAt, "2026-11-06T13:05:00.000Z");
});

test("is deterministic for identical authoritative input", () => {
  const first = evaluatePaymentIntent(intent(), policy(), context());
  const second = evaluatePaymentIntent(intent(), policy(), context());
  assert.deepEqual(first, second);
});

test("fails closed when a security dependency is stale or unavailable", () => {
  for (const status of ["stale", "unavailable"] as const) {
    const result = evaluatePaymentIntent(
      intent(),
      policy(),
      context({
        securityDependencies: {
          policyStore: "available",
          beneficiaryRegistry: status,
          evidenceStore: "available",
          riskEngine: "available",
        },
      }),
    );
    assert.equal(result.outcome, "DENY");
    assert.ok(result.reasonCodes.includes("SECURITY_DEPENDENCY_UNAVAILABLE"));
  }
});

test("denies organization, policy, purpose, asset, and amount violations", () => {
  const result = evaluatePaymentIntent(
    intent({ organizationId: "org_attacker", purposeCode: "unapproved", asset: "USD", amount: "6000" }),
    policy(),
    context(),
  );

  assert.equal(result.outcome, "DENY");
  assert.ok(result.reasonCodes.includes("POLICY_ORGANIZATION_MISMATCH"));
  assert.ok(result.reasonCodes.includes("POLICY_PURPOSE_NOT_ALLOWED"));
  assert.ok(result.reasonCodes.includes("POLICY_ASSET_NOT_ALLOWED"));
  assert.ok(result.reasonCodes.includes("POLICY_AMOUNT_LIMIT"));
});

test("denies reserve and allocation breaches", () => {
  const result = evaluatePaymentIntent(
    intent({ amount: "1200" }),
    policy(),
    context({ availableTreasuryBalance: "2000", availableAllocationBalance: "1000" }),
  );

  assert.equal(result.outcome, "DENY");
  assert.ok(result.reasonCodes.includes("TREASURY_RESERVE_BREACH"));
  assert.ok(result.reasonCodes.includes("TREASURY_ALLOCATION_EXHAUSTED"));
});

test("denies beneficiary substitution, version changes, and cooling periods", () => {
  const result = evaluatePaymentIntent(
    intent(),
    policy(),
    context({
      beneficiary: {
        beneficiaryId: "ben_substituted",
        walletVersion: 4,
        status: "approved",
        lastWalletChangeAt: "2026-11-06T12:30:00.000Z",
      },
    }),
  );

  assert.equal(result.outcome, "DENY");
  assert.ok(result.reasonCodes.includes("BENEFICIARY_NOT_APPROVED"));
  assert.ok(result.reasonCodes.includes("BENEFICIARY_VERSION_MISMATCH"));
  assert.ok(result.reasonCodes.includes("BENEFICIARY_CHANGE_COOLING_PERIOD"));
});

test("denies altered, exact duplicate, or insufficient evidence", () => {
  const result = evaluatePaymentIntent(
    intent(),
    policy(),
    context({
      evidence: {
        manifestHash: `sha256:${"b".repeat(64)}`,
        evidenceTypes: ["invoice"],
        duplicateStatus: "exact",
        procurementStatus: "mismatch",
        integrityStatus: "mismatch",
      },
    }),
  );

  assert.equal(result.outcome, "DENY");
  assert.ok(result.reasonCodes.includes("EVIDENCE_MISMATCH"));
  assert.ok(result.reasonCodes.includes("EVIDENCE_DUPLICATE"));
  assert.ok(result.reasonCodes.includes("EVIDENCE_PROCUREMENT_MISMATCH"));
  assert.ok(result.reasonCodes.includes("POLICY_EVIDENCE_MISSING"));
});

test("fails closed for missing procurement evidence and routes uncertain matching to review", () => {
  const missing = evaluatePaymentIntent(intent(), policy(), context({ evidence: { ...context().evidence, procurementStatus: "missing" } }));
  assert.equal(missing.outcome, "DENY"); assert.ok(missing.reasonCodes.includes("EVIDENCE_PROCUREMENT_MISSING"));
  const review = evaluatePaymentIntent(intent(), policy(), context({ evidence: { ...context().evidence, procurementStatus: "review" } }));
  assert.equal(review.outcome, "REVIEW"); assert.ok(review.reasonCodes.includes("EVIDENCE_PROCUREMENT_REVIEW"));
});

test("requires approvals bound to the exact intent digest", () => {
  const highValueIntent = intent({ amount: "1200" });
  const wrongDigestResult = evaluatePaymentIntent(
    highValueIntent,
    policy(),
    context({
      approvals: [
        {
          principalId: "principal_cfo",
          role: "finance-approver",
          intentDigest: paymentIntentDigest(intent()),
          expiresAt: "2026-11-06T13:30:00.000Z",
        },
      ],
    }),
  );
  assert.ok(wrongDigestResult.reasonCodes.includes("AUTH_APPROVAL_MISSING"));

  const allowed = evaluatePaymentIntent(
    highValueIntent,
    policy(),
    context({
      approvals: [
        {
          principalId: "principal_cfo",
          role: "finance-approver",
          intentDigest: paymentIntentDigest(highValueIntent),
          expiresAt: "2026-11-06T13:30:00.000Z",
        },
      ],
    }),
  );
  assert.equal(allowed.outcome, "ALLOW");
});

test("denies approval by the initiating principal", () => {
  const highValueIntent = intent({ amount: "1200" });
  const result = evaluatePaymentIntent(
    highValueIntent,
    policy(),
    context({
      approvals: [
        {
          principalId: highValueIntent.createdBy.principalId,
          role: "finance-approver",
          intentDigest: paymentIntentDigest(highValueIntent),
          expiresAt: "2026-11-06T13:30:00.000Z",
        },
      ],
    }),
  );
  assert.equal(result.outcome, "DENY");
  assert.ok(result.reasonCodes.includes("AUTH_SEGREGATION_OF_DUTIES"));
});

test("denies replay and rolling velocity breaches", () => {
  const paymentIntent = intent();
  const result = evaluatePaymentIntent(
    paymentIntent,
    policy({
      velocity: { maxPaymentCount24Hours: 2, maxPaymentAmount24Hours: "1000" },
    }),
    context({
      seenIntentDigests: [paymentIntentDigest(paymentIntent)],
      recentPayments: [
        { amount: "400", settledAt: "2026-11-06T11:00:00.000Z" },
        { amount: "300", settledAt: "2026-11-06T12:00:00.000Z" },
      ],
    }),
  );
  assert.equal(result.outcome, "DENY");
  assert.ok(result.reasonCodes.includes("INTENT_REPLAY_DETECTED"));
  assert.ok(result.reasonCodes.includes("RISK_VELOCITY_EXCEEDED"));
});

test("routes anomalous risk to review and high risk to denial", () => {
  const review = evaluatePaymentIntent(intent(), policy(), context({ riskScore: 60 }));
  assert.equal(review.outcome, "REVIEW");
  assert.ok(review.reasonCodes.includes("RISK_ANOMALOUS_PAYMENT"));

  const deny = evaluatePaymentIntent(intent(), policy(), context({ riskScore: 90 }));
  assert.equal(deny.outcome, "DENY");
  assert.ok(deny.reasonCodes.includes("RISK_PAYMENT_DENIED"));
});

test("never lets a review signal override a deterministic denial", () => {
  const result = evaluatePaymentIntent(
    intent({ amount: "6000" }),
    policy(),
    context({ riskScore: 60 }),
  );
  assert.equal(result.outcome, "DENY");
  assert.ok(result.reasonCodes.includes("POLICY_AMOUNT_LIMIT"));
  assert.ok(result.reasonCodes.includes("RISK_ANOMALOUS_PAYMENT"));
});
