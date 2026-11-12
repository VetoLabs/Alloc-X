import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { InMemoryAuditChain } from "../../../packages/audit-chain/src/index.ts";
import {
  createEd25519DecisionSigner,
  createEd25519DecisionVerifier,
  DecisionJournalConflictError,
  DurableSecurityDecisionService,
  FileSecurityDecisionJournal,
  ApprovalLayerService,
} from "../src/index.ts";

const now = "2026-11-07T13:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;

function input(correlationId = "corr_001", riskScore = 10) {
  return {
    organizationId: "org_acme", correlationId, rawCredentials: "valid",
    intent: { contractVersion: "1.0", intentId: "pi_001", organizationId: "org_acme", idempotencyKey: "org_acme/invoice-42/v1", sourceObligationId: "obl_42", allocationId: "alloc_operations", amount: "400", asset: "XRP", beneficiaryId: "ben_vendor_7", beneficiaryWalletVersion: 3, purposeCode: "operations-supplies", evidenceManifestHash: hash, policyVersion: "policy_2026_01", requestedExecutionWindow: { notBefore: "2026-11-07T12:00:00.000Z", expiresAt: "2026-11-07T14:00:00.000Z" }, createdBy: { principalId: "principal_alloc_agent", actorType: "agent" } },
    policy: { policyVersion: "policy_2026_01", organizationId: "org_acme", status: "published", effectiveFrom: "2026-01-01T00:00:00.000Z", allowedPurposeCodes: ["operations-supplies"], allowedAssets: ["XRP"], maxPaymentAmount: "5000", reserveFloor: "1000", requiredEvidenceByPurpose: { "operations-supplies": ["invoice"] }, approvalRules: [], beneficiaryChangeCoolingPeriodHours: 24, velocity: { maxPaymentCount24Hours: 10, maxPaymentAmount24Hours: "10000" }, risk: { reviewAtScore: 60, denyAtScore: 85 }, decisionTtlSeconds: 300 },
    context: { now, availableTreasuryBalance: "10000", availableAllocationBalance: "3000", beneficiary: { beneficiaryId: "ben_vendor_7", walletVersion: 3, status: "approved", lastWalletChangeAt: "2026-11-01T00:00:00.000Z" }, evidence: { manifestHash: hash, evidenceTypes: ["invoice"], duplicateStatus: "clear", procurementStatus: "verified", integrityStatus: "verified" }, approvals: [], recentPayments: [], seenIntentDigests: [], riskScore, securityDependencies: { policyStore: "available", beneficiaryRegistry: "available", evidenceStore: "available", riskEngine: "available" } },
  };
}
function service() {
  const keys = generateKeyPairSync("ed25519");
  const provider = { issuer: "alloc-x-test", async verify(raw: unknown) { if (raw !== "valid") throw new Error("invalid credentials"); return { issuer: "alloc-x-test", audience: "approval-layer", subjectId: "principal_approval-layer", organizationId: "org_acme", subjectKind: "service" as const, sessionId: "session_1234567890", authenticatedAt: now, methods: ["service-mtls"] as const }; } };
  const veto = new ApprovalLayerService({ authenticationProvider: provider, servicePrincipal: { contractVersion: "1.0", principalId: "principal_approval-layer", organizationId: "org_acme", kind: "service", status: "active", roles: ["approval-layer-service"], createdAt: "2026-01-01T00:00:00.000Z" }, signer: createEd25519DecisionSigner("approval-layer-test-key", keys.privateKey), auditChain: new InMemoryAuditChain() });
  return { veto, verifier: createEd25519DecisionVerifier("approval-layer-test-key", keys.publicKey) };
}

test("persists a signed decision and recovers it after a new service process instance", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alloc-x-security-")); const path = join(folder, "decisions.ndjson"); const { veto, verifier } = service();
  const durable = new DurableSecurityDecisionService(veto, new FileSecurityDecisionJournal(path));
  const issued = await durable.evaluate(input());
  const restarted = new DurableSecurityDecisionService(veto, new FileSecurityDecisionJournal(path));
  const recovered = await restarted.recoverForSettlement({ organizationId: "org_acme", decisionId: issued.signedDecision.decision.decisionId, intent: input().intent, now, verifier });
  assert.equal(recovered.recordHash, issued.storedDecision.recordHash);
  assert.deepEqual(await new FileSecurityDecisionJournal(path).verifyIntegrity(), { valid: true, checkedRecords: 1, failures: [] });
});

test("makes correlation replay idempotent and detects a conflicting retry", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alloc-x-security-")); const path = join(folder, "decisions.ndjson"); const { veto } = service();
  const durable = new DurableSecurityDecisionService(veto, new FileSecurityDecisionJournal(path));
  const first = await durable.evaluate(input()); const replay = await durable.evaluate(input());
  assert.equal(replay.storedDecision.recordHash, first.storedDecision.recordHash);
  await assert.rejects(() => durable.evaluate(input("corr_001", 90)), DecisionJournalConflictError);
});

test("detects durable journal tampering during integrity verification", async () => {
  const folder = await mkdtemp(join(tmpdir(), "alloc-x-security-")); const path = join(folder, "decisions.ndjson"); const { veto } = service();
  const durable = new DurableSecurityDecisionService(veto, new FileSecurityDecisionJournal(path));
  await durable.evaluate(input());
  await writeFile(path, "{malformed}\n", "utf8");
  const integrity = await new FileSecurityDecisionJournal(path).verifyIntegrity();
  assert.equal(integrity.valid, false); assert.ok(integrity.failures.includes("MALFORMED_RECORD"));
});

test("does not release an evaluation result when durable recording fails", async () => {
  const { veto } = service();
  const unavailableJournal = {
    async append() { throw new Error("journal unavailable"); },
    async get() { return undefined; },
    async verifyIntegrity() { return { valid: false, checkedRecords: 0, failures: ["MALFORMED_RECORD"] as const }; },
  };
  const durable = new DurableSecurityDecisionService(veto, unavailableJournal);
  await assert.rejects(() => durable.evaluate(input()), /journal unavailable/);
});
