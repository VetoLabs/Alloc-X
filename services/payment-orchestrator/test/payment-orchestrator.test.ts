import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hashes, Wallet } from "xrpl";

import { InMemoryAuditChain } from "../../../packages/audit-chain/src/index.ts";
import { createEd25519DecisionSigner, createEd25519DecisionVerifier, ApprovalLayerService } from "../../approval-layer/src/index.ts";
import { createLocalDevelopmentKeyProvider, createSignerListConfiguration, IndependentSignerService } from "../../signers/src/index.ts";
import { FilePaymentJobStore, PaymentOrchestrator, type SettlementLedger } from "../src/index.ts";

const now = "2026-11-07T13:00:00.000Z";
const evidenceHash = `sha256:${"a".repeat(64)}`;

function intent(overrides: Record<string, unknown> = {}) {
  return { contractVersion: "1.0", intentId: "pi_015", organizationId: "org_acme", idempotencyKey: "org_acme/invoice-15/v1", sourceObligationId: "obl_15", allocationId: "alloc_ops", amount: "1", asset: "XRP", beneficiaryId: "ben_vendor", beneficiaryWalletVersion: 1, purposeCode: "operations", evidenceManifestHash: evidenceHash, policyVersion: "policy_2026", requestedExecutionWindow: { notBefore: "2026-11-07T12:00:00.000Z", expiresAt: "2026-11-07T14:00:00.000Z" }, createdBy: { principalId: "principal_agent", actorType: "agent" }, ...overrides };
}
function policy() { return { policyVersion: "policy_2026", organizationId: "org_acme", status: "published", effectiveFrom: "2026-01-01T00:00:00.000Z", allowedPurposeCodes: ["operations"], allowedAssets: ["XRP"], maxPaymentAmount: "5", reserveFloor: "1", requiredEvidenceByPurpose: { operations: ["invoice"] }, approvalRules: [], beneficiaryChangeCoolingPeriodHours: 24, velocity: { maxPaymentCount24Hours: 10, maxPaymentAmount24Hours: "10" }, risk: { reviewAtScore: 60, denyAtScore: 85 }, decisionTtlSeconds: 3_600 } }
function context() { return { now, availableTreasuryBalance: "10", availableAllocationBalance: "10", beneficiary: { beneficiaryId: "ben_vendor", walletVersion: 1, status: "approved", lastWalletChangeAt: "2026-11-01T00:00:00.000Z" }, evidence: { manifestHash: evidenceHash, evidenceTypes: ["invoice"], duplicateStatus: "clear", procurementStatus: "verified", integrityStatus: "verified" }, approvals: [], recentPayments: [], seenIntentDigests: [], riskScore: 0, securityDependencies: { policyStore: "available", beneficiaryRegistry: "available", evidenceStore: "available", riskEngine: "available" } } }

async function setup(root: string) {
  const keys = generateKeyPairSync("ed25519"); const service = new ApprovalLayerService({ authenticationProvider: { issuer: "alloc-x-test", async verify(value: unknown) { if (value !== "valid") throw new Error("Invalid credentials."); return { issuer: "alloc-x-test", audience: "approval-layer", subjectId: "principal_veto", organizationId: "org_acme", subjectKind: "service", sessionId: "session_1234567890", authenticatedAt: now, methods: ["service-mtls"] }; } }, servicePrincipal: { contractVersion: "1.0", principalId: "principal_veto", organizationId: "org_acme", kind: "service", status: "active", roles: ["approval-layer-service"], createdAt: "2026-01-01T00:00:00.000Z" }, signer: createEd25519DecisionSigner("veto-test-key", keys.privateKey), auditChain: new InMemoryAuditChain() });
  const decision = (await service.evaluate({ organizationId: "org_acme", correlationId: "corr_015", rawCredentials: "valid", intent: intent(), policy: policy(), context: context() })).signedDecision;
  const treasury = Wallet.generate(); const executionWallet = Wallet.generate(); const policyWallet = Wallet.generate(); const recoveryWallet = Wallet.generate();
  const signerList = createSignerListConfiguration({ treasuryAccount: treasury.classicAddress, quorum: 2, members: [{ classicAddress: executionWallet.classicAddress, weight: 1, role: "execution" }, { classicAddress: policyWallet.classicAddress, weight: 1, role: "policy" }, { classicAddress: recoveryWallet.classicAddress, weight: 2, role: "recovery" }] });
  const expiry = { minimumLastLedgerOffset: 4, maximumLastLedgerOffset: 30 };
  const executionSigner = new IndependentSignerService({ signerId: "signer_execution_015", role: "execution", keyProvider: createLocalDevelopmentKeyProvider(executionWallet, "local:execution:015"), allowedNetworks: { testnet: 1, devnet: 2 }, ...expiry });
  const policySigner = new IndependentSignerService({ signerId: "signer_policy_015", role: "policy", keyProvider: createLocalDevelopmentKeyProvider(policyWallet, "local:policy:015"), allowedNetworks: { testnet: 1, devnet: 2 }, ...expiry });
  const ledger = new FakeLedger(); const store = new FilePaymentJobStore(join(root, "jobs.ndjson")); const orchestrator = new PaymentOrchestrator({ store, ledger, decisionVerifier: createEd25519DecisionVerifier("veto-test-key", keys.publicKey), executionSigner, policySigner, signerList });
  const request = { jobId: "job_payment_015", organizationId: "org_acme", intent: intent(), signedDecision: decision, instruction: { account: treasury.classicAddress, destination: Wallet.generate().classicAddress, mode: "sequence" as const }, enqueuedAt: now };
  return { store, ledger, orchestrator, request, verifier: createEd25519DecisionVerifier("veto-test-key", keys.publicKey), executionSigner, policySigner, signerList };
}

class FakeLedger implements SettlementLedger {
  submissions = 0; submissionAttempts = 0; failNextSubmission = false; readonly validated = new Map<string, { transactionHash: string; ledgerIndex: number; validatedAt: string; resultCode: string }>();
  async prepareNativePayment(input: Parameters<SettlementLedger["prepareNativePayment"]>[0]) { return { network: "testnet" as const, networkId: 1, intentId: input.intentId, intentDigest: input.intentDigest, organizationId: input.organizationId, transaction: { TransactionType: "Payment", Account: input.account, Destination: input.destination, Amount: "1000000", Fee: "36", Sequence: 7, LastLedgerSequence: 110 }, serializedTransaction: "DEADBEEF", preparedAtLedgerIndex: 100 }; }
  async submitSignedPayment(input: { readonly prepared: unknown; readonly signedTransactionBlob: string }) { this.submissionAttempts += 1; if (this.failNextSubmission) { this.failNextSubmission = false; throw new Error("Temporary XRPL connection failure."); } this.submissions += 1; const transactionHash = hashes.hashSignedTx(input.signedTransactionBlob); const result = { transactionHash, ledgerIndex: 101, validatedAt: now, resultCode: "tesSUCCESS" }; this.validated.set(transactionHash, result); return result; }
  async lookupValidatedPayment(transactionHash: string) { return this.validated.get(transactionHash); }
}

test("durably signs, plans, submits, and validates one exact payment job", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-orchestrator-"));
  try { const { orchestrator, ledger, store, request } = await setup(root); await orchestrator.enqueue(request); const settled = await orchestrator.run(request.jobId, "worker_primary", now); assert.equal(settled.state, "VALIDATED"); assert.equal(ledger.submissions, 1); assert.equal(settled.intentDigest.startsWith("sha256:"), true); assert.equal((await store.verifyIntegrity()).valid, true); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("restart recovery does not construct another payment after a durable submission plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-orchestrator-"));
  try {
    const { ledger, store, request, verifier, executionSigner, policySigner, signerList } = await setup(root); const orchestrator = new PaymentOrchestrator({ store, ledger, decisionVerifier: verifier, executionSigner, policySigner, signerList }); await orchestrator.enqueue(request); await store.acquireLease({ jobId: request.jobId, workerId: "worker_primary", now, leaseExpiresAt: "2026-11-07T13:00:30.000Z", maxAttempts: 3 });
    const transactionHash = "A".repeat(64); ledger.validated.set(transactionHash, { transactionHash, ledgerIndex: 101, validatedAt: now, resultCode: "tesSUCCESS" }); await store.recordSubmissionPlan({ jobId: request.jobId, workerId: "worker_primary", now, signedTransactionBlob: "ABCD", transactionHash });
    const recovered = new PaymentOrchestrator({ store: new FilePaymentJobStore(join(root, "jobs.ndjson")), ledger, decisionVerifier: verifier, executionSigner, policySigner, signerList });
    const settled = await recovered.run(request.jobId, "worker_recovery", "2026-11-07T13:01:00.000Z"); assert.equal(settled.state, "VALIDATED"); assert.equal(ledger.submissions, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a retry after an ambiguous submission reuses the exact signed blob and settles once", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-orchestrator-"));
  try {
    const { orchestrator, ledger, request } = await setup(root); ledger.failNextSubmission = true; await orchestrator.enqueue(request);
    const first = await orchestrator.run(request.jobId, "worker_primary", now); assert.equal(first.state, "RETRYABLE_FAILURE"); const plannedBlob = first.signedTransactionBlob;
    const second = await orchestrator.run(request.jobId, "worker_retry", "2026-11-07T13:00:31.000Z"); assert.equal(second.state, "VALIDATED"); assert.equal(second.signedTransactionBlob, plannedBlob); assert.equal(ledger.submissions, 1); assert.equal(ledger.submissionAttempts, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
