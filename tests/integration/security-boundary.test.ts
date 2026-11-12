import assert from "node:assert/strict";
import test from "node:test";

import { parsePaymentIntent } from "../../packages/contracts/src/index.ts";
import {
  evaluatePaymentIntent,
  type EvaluationContext,
  type PolicyBundle,
} from "../../packages/policy-engine/src/index.ts";

const intent = parsePaymentIntent({
  contractVersion: "1.0",
  intentId: "pi_integration_001",
  organizationId: "org_integration",
  idempotencyKey: "org_integration/obligation-1/v1",
  sourceObligationId: "obl_integration_1",
  allocationId: "alloc_integration",
  amount: "250",
  asset: "XRP",
  beneficiaryId: "ben_integration_vendor",
  beneficiaryWalletVersion: 1,
  purposeCode: "approved-operations",
  evidenceManifestHash: `sha256:${"c".repeat(64)}`,
  policyVersion: "policy_integration_1",
  requestedExecutionWindow: {
    notBefore: "2026-11-07T08:00:00.000Z",
    expiresAt: "2026-11-07T10:00:00.000Z",
  },
  createdBy: {
    principalId: "principal_integration_agent",
    actorType: "agent",
  },
});

const policy: PolicyBundle = {
  policyVersion: "policy_integration_1",
  organizationId: "org_integration",
  status: "published",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  allowedPurposeCodes: ["approved-operations"],
  allowedAssets: ["XRP"],
  maxPaymentAmount: "1000",
  reserveFloor: "500",
  requiredEvidenceByPurpose: { "approved-operations": ["invoice"] },
  approvalRules: [],
  beneficiaryChangeCoolingPeriodHours: 24,
  velocity: { maxPaymentCount24Hours: 5, maxPaymentAmount24Hours: "2000" },
  risk: { reviewAtScore: 60, denyAtScore: 85 },
  decisionTtlSeconds: 300,
};

function context(): EvaluationContext {
  return {
    now: "2026-11-07T09:00:00.000Z",
    availableTreasuryBalance: "5000",
    availableAllocationBalance: "1000",
    beneficiary: {
      beneficiaryId: "ben_integration_vendor",
      walletVersion: 1,
      status: "approved",
      lastWalletChangeAt: "2026-11-01T00:00:00.000Z",
    },
    evidence: {
      manifestHash: `sha256:${"c".repeat(64)}`,
      evidenceTypes: ["invoice"],
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
  };
}

test("passes a canonical intent across the contract and policy boundaries", () => {
  assert.equal(evaluatePaymentIntent(intent, policy, context()).outcome, "ALLOW");
});

test("fails closed across boundaries when the beneficiary registry is unavailable", () => {
  const baseline = context();
  const unavailable: EvaluationContext = {
    ...baseline,
    securityDependencies: {
      ...baseline.securityDependencies,
      beneficiaryRegistry: "unavailable",
    },
  };
  const decision = evaluatePaymentIntent(intent, policy, unavailable);

  assert.equal(decision.outcome, "DENY");
  assert.ok(decision.reasonCodes.includes("SECURITY_DEPENDENCY_UNAVAILABLE"));
});

test("detects a destination-version substitution before signing can begin", () => {
  const baseline = context();
  const substituted: EvaluationContext = {
    ...baseline,
    beneficiary: {
      ...baseline.beneficiary,
      walletVersion: 2,
    },
  };
  const decision = evaluatePaymentIntent(intent, policy, substituted);

  assert.equal(decision.outcome, "DENY");
  assert.ok(decision.reasonCodes.includes("BENEFICIARY_VERSION_MISMATCH"));
});
