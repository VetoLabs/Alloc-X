import assert from "node:assert/strict";
import test from "node:test";

import { paymentIntentDigest, type PaymentIntent } from "../../../packages/contracts/src/index.ts";
import { type PaymentIntentRecord } from "../../../packages/payment-intents/src/index.ts";
import { InMemoryLedgerMonitorStore, LedgerMonitor, type ReadOnlyLedgerSource } from "../../ledger-monitor/src/index.ts";
import { type PaymentJob, type PaymentJobRequest } from "../../payment-orchestrator/src/index.ts";
import { AutonomousPaymentPath, type PaymentExecutionWorker, type PaymentSecurityGateway } from "../src/index.ts";

const now = "2026-11-07T13:00:00.000Z";
const organizationId = "org_acme";
const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const destination = "r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV";
const hash = "A".repeat(64);
const intent: PaymentIntent = { contractVersion: "1.0", intentId: "pi_017", organizationId, idempotencyKey: "org_acme/017", sourceObligationId: "obl_017", allocationId: "alloc_ops", amount: "1", asset: "XRP", beneficiaryId: "ben_vendor", beneficiaryWalletVersion: 1, purposeCode: "operations", evidenceManifestHash: `sha256:${"a".repeat(64)}`, policyVersion: "policy_2026", requestedExecutionWindow: { notBefore: "2026-11-07T12:00:00.000Z", expiresAt: "2026-11-07T14:00:00.000Z" }, createdBy: { principalId: "principal_agent", actorType: "agent" } };
const digest = paymentIntentDigest(intent);
const record: PaymentIntentRecord = { intent, intentDigest: digest, reservation: { reservationId: "res_017", organizationId, allocationId: "alloc_ops", intentId: intent.intentId, intentDigest: digest, asset: "XRP", amount: "1", status: "active", reservedAt: now, expiresAt: intent.requestedExecutionWindow.expiresAt }, state: "RESERVED", createdAt: now };

function security(outcome: "ALLOW" | "REVIEW" | "DENY"): PaymentSecurityGateway { return { async evaluate() { return { signedDecision: { decision: { intentId: intent.intentId, intentDigest: digest, outcome } } } as unknown as Awaited<ReturnType<PaymentSecurityGateway["evaluate"]>>; } }; }
function worker(): { readonly worker: PaymentExecutionWorker; readonly requests: PaymentJobRequest[] } { const requests: PaymentJobRequest[] = []; const job = { contractVersion: "1.0", jobId: "job_017", organizationId, intent, intentDigest: digest, signedDecision: { decision: { outcome: "ALLOW" } }, instruction: { account, destination, mode: "sequence" }, state: "VALIDATED", attemptCount: 1, transactionHash: hash, validatedTransaction: { transactionHash: hash, ledgerIndex: 99, validatedAt: now, resultCode: "tesSUCCESS" }, updatedAt: now } as unknown as PaymentJob; return { requests, worker: { async enqueue(request) { requests.push(request); return job; }, async run() { return job; } } }; }
function monitor(): LedgerMonitor { const source: ReadOnlyLedgerSource = { async readValidatedPayments() { return { transactions: [{ transactionHash: hash, ledgerIndex: 99, account, destination, amountDrops: "1000000", resultCode: "tesSUCCESS", validatedAt: now }] }; } }; return new LedgerMonitor({ source, store: new InMemoryLedgerMonitorStore(), accounting: { settle: ({ reservationId, transactionHash }) => { assert.equal(reservationId, "res_017"); assert.equal(transactionHash, hash); } } }); }

test("takes an allowed canonical intent through validation and independent reconciliation", async () => {
  const execution = worker(); const path = new AutonomousPaymentPath({ security: security("ALLOW"), orchestrator: execution.worker, monitor: monitor(), beneficiaries: { resolve: () => ({ address: destination, walletVersion: 1 }) } });
  const result = await path.execute({ record, securityRequest: { ignored: true }, treasuryAccount: account, workerId: "worker_017", now });
  assert.equal(result.state, "RECONCILED"); assert.equal(result.reconciliation?.transactionHash, hash);
  assert.equal(execution.requests.length, 1); assert.equal(execution.requests[0].instruction.destination, destination);
});

test("does not enqueue a review decision", async () => {
  const execution = worker(); const path = new AutonomousPaymentPath({ security: security("REVIEW"), orchestrator: execution.worker, monitor: monitor(), beneficiaries: { resolve: () => ({ address: destination, walletVersion: 1 }) } });
  const result = await path.execute({ record, securityRequest: {}, treasuryAccount: account, workerId: "worker_017", now });
  assert.equal(result.state, "REVIEW_REQUIRED"); assert.equal(execution.requests.length, 0);
});

test("stops before enqueue when the authoritative beneficiary wallet version changed", async () => {
  const execution = worker(); const path = new AutonomousPaymentPath({ security: security("ALLOW"), orchestrator: execution.worker, monitor: monitor(), beneficiaries: { resolve: () => ({ address: destination, walletVersion: 2 }) } });
  await assert.rejects(() => path.execute({ record, securityRequest: {}, treasuryAccount: account, workerId: "worker_017", now }), /wallet version changed/);
  assert.equal(execution.requests.length, 0);
});

test("does not enqueue a denied decision", async () => {
  const execution = worker(); const path = new AutonomousPaymentPath({ security: security("DENY"), orchestrator: execution.worker, monitor: monitor(), beneficiaries: { resolve: () => ({ address: destination, walletVersion: 1 }) } });
  const result = await path.execute({ record, securityRequest: {}, treasuryAccount: account, workerId: "worker_017", now });
  assert.equal(result.state, "BLOCKED"); assert.equal(execution.requests.length, 0);
});
