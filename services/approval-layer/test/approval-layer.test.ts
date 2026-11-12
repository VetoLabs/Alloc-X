import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { InMemoryAuditChain } from "../../../packages/audit-chain/src/index.ts";
import {
  assertSettlementAuthorized,
  createEd25519DecisionSigner,
  createEd25519DecisionVerifier,
  SettlementDeniedError,
  ApprovalLayerService,
} from "../src/index.ts";

const hash = `sha256:${"a".repeat(64)}`;
const now = "2026-11-07T13:00:00.000Z";

function intent(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "1.0", intentId: "pi_001", organizationId: "org_acme", idempotencyKey: "org_acme/invoice-42/v1",
    sourceObligationId: "obl_42", allocationId: "alloc_operations", amount: "400", asset: "XRP", beneficiaryId: "ben_vendor_7",
    beneficiaryWalletVersion: 3, purposeCode: "operations-supplies", evidenceManifestHash: hash, policyVersion: "policy_2026_01",
    requestedExecutionWindow: { notBefore: "2026-11-07T12:00:00.000Z", expiresAt: "2026-11-07T14:00:00.000Z" },
    createdBy: { principalId: "principal_alloc_agent", actorType: "agent" }, ...overrides,
  };
}
function policy() {
  return { policyVersion: "policy_2026_01", organizationId: "org_acme", status: "published", effectiveFrom: "2026-01-01T00:00:00.000Z", allowedPurposeCodes: ["operations-supplies"], allowedAssets: ["XRP"], maxPaymentAmount: "5000", reserveFloor: "1000", requiredEvidenceByPurpose: { "operations-supplies": ["invoice"] }, approvalRules: [], beneficiaryChangeCoolingPeriodHours: 24, velocity: { maxPaymentCount24Hours: 10, maxPaymentAmount24Hours: "10000" }, risk: { reviewAtScore: 60, denyAtScore: 85 }, decisionTtlSeconds: 300 };
}
function context(overrides: Record<string, unknown> = {}) {
  return { now, availableTreasuryBalance: "10000", availableAllocationBalance: "3000", beneficiary: { beneficiaryId: "ben_vendor_7", walletVersion: 3, status: "approved", lastWalletChangeAt: "2026-11-01T00:00:00.000Z" }, evidence: { manifestHash: hash, evidenceTypes: ["invoice"], duplicateStatus: "clear", procurementStatus: "verified", integrityStatus: "verified" }, approvals: [], recentPayments: [], seenIntentDigests: [], riskScore: 10, securityDependencies: { policyStore: "available", beneficiaryRegistry: "available", evidenceStore: "available", riskEngine: "available" }, ...overrides };
}
function setup() {
  const keys = generateKeyPairSync("ed25519"); const audit = new InMemoryAuditChain();
  const credentials = { issuer: "alloc-x-test", audience: "approval-layer", subjectId: "principal_approval-layer", organizationId: "org_acme", subjectKind: "service", sessionId: "session_1234567890", authenticatedAt: now, methods: ["service-mtls"] };
  const provider = { issuer: "alloc-x-test", async verify(raw: unknown) { if (raw !== "valid") throw new Error("invalid credentials"); return credentials; } };
  const service = new ApprovalLayerService({ authenticationProvider: provider, servicePrincipal: { contractVersion: "1.0", principalId: "principal_approval-layer", organizationId: "org_acme", kind: "service", status: "active", roles: ["approval-layer-service"], createdAt: "2026-01-01T00:00:00.000Z" }, signer: createEd25519DecisionSigner("approval-layer-test-key", keys.privateKey), auditChain: audit });
  return { audit, service, verifier: createEd25519DecisionVerifier("approval-layer-test-key", keys.publicKey) };
}

test("authenticates ApprovalLayer, evaluates ordered controls, audits, and signs an allow decision", async () => {
  const { service, verifier } = setup();
  const receipt = await service.evaluate({ organizationId: "org_acme", correlationId: "corr_001", rawCredentials: "valid", intent: intent(), policy: policy(), context: context() });
  assert.equal(receipt.signedDecision.decision.outcome, "ALLOW");
  assert.equal(receipt.auditEvent.eventType, "security-decision-issued");
  const accepted = assertSettlementAuthorized({ signedDecision: receipt.signedDecision, organizationId: "org_acme", intent: intent(), now, verifier });
  assert.equal(accepted.decision.intentId, "pi_001");
});

test("rejects unauthenticated evaluation and never releases a signed decision", async () => {
  const { service } = setup();
  await assert.rejects(() => service.evaluate({ organizationId: "org_acme", correlationId: "corr_002", rawCredentials: "invalid", intent: intent(), policy: policy(), context: context() }));
});

test("signs denials for evidence and risk outcomes but settlement refuses them", async () => {
  const { service, verifier } = setup();
  const denied = await service.evaluate({ organizationId: "org_acme", correlationId: "corr_003", rawCredentials: "valid", intent: intent(), policy: policy(), context: context({ riskScore: 90 }) });
  assert.equal(denied.signedDecision.decision.outcome, "DENY");
  assert.ok(denied.signedDecision.decision.reasonCodes.includes("RISK_PAYMENT_DENIED"));
  assert.throws(() => assertSettlementAuthorized({ signedDecision: denied.signedDecision, organizationId: "org_acme", intent: intent(), now, verifier }), SettlementDeniedError);
});

test("settlement verification rejects altered, expired, or cross-organization decisions", async () => {
  const { service, verifier } = setup();
  const receipt = await service.evaluate({ organizationId: "org_acme", correlationId: "corr_004", rawCredentials: "valid", intent: intent(), policy: policy(), context: context() });
  const altered = { ...receipt.signedDecision, signature: `${receipt.signedDecision.signature[0] === "A" ? "B" : "A"}${receipt.signedDecision.signature.slice(1)}` };
  assert.throws(() => assertSettlementAuthorized({ signedDecision: altered, organizationId: "org_acme", intent: intent(), now, verifier }), SettlementDeniedError);
  assert.throws(() => assertSettlementAuthorized({ signedDecision: receipt.signedDecision, organizationId: "org_acme", intent: intent(), now: "2026-11-07T13:05:00.000Z", verifier }), SettlementDeniedError);
  assert.throws(() => assertSettlementAuthorized({ signedDecision: receipt.signedDecision, organizationId: "org_other", intent: intent(), now, verifier }), SettlementDeniedError);
});
