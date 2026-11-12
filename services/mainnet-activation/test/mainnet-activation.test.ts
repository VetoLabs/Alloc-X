import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileMainnetActivationStore, MainnetActivationError, MainnetActivationService, type ActivationActor, type ExternalReadiness } from "../src/index.ts";

const sha = (character: string) => `sha256:${character.repeat(64).slice(0, 64)}`;
const address = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const actors = {
  operator: { principalId: "principal_platform_operator", duty: "platform-operator" },
  security: { principalId: "principal_security_approver", duty: "security-approver" },
  finance: { principalId: "principal_finance_approver", duty: "finance-approver" },
  monitor: { principalId: "principal_independent_monitor", duty: "independent-monitor" },
  settlement: { principalId: "principal_payment_orchestrator", duty: "settlement-service" },
  agent: { principalId: "principal_allocation_agent", duty: "allocation-agent" },
} as const satisfies Record<string, ActivationActor>;

function ready(): ExternalReadiness { return { assessment: { allowed: true, blockers: [], digest: sha("a") }, monitoring: { healthy: true, digest: sha("b") }, recovery: { passed: true, digest: sha("c") }, signerList: { configured: true, treasuryAccount: address, quorum: 2, memberCount: 3, digest: sha("d") } }; }
function configuration() { return { configurationId: "configuration_mainnet_001", organizationId: "org_meridian", network: "mainnet" as const, networkId: 0 as const, treasuryAccount: address, signerListDigest: sha("d"), signerQuorum: 2, signerMemberCount: 3, allowlistedAssets: ["XRP"] as ["XRP"], perPaymentLimitXrp: "10", dailyAmountLimitXrp: "20", dailyPaymentCountLimit: 3, pilotPaymentLimitXrp: "1", pilotPaymentCountLimit: 1 as const, maxFeeDrops: "200", lastLedgerOffset: 4 as const, submissionEndpoint: "wss://primary.example.org", monitoringEndpoint: "wss://monitor.example.org", rollbackPlanDigest: sha("e"), configuredAt: "2026-11-10T12:00:00.000Z" }; }
async function configuredService(root: string, current = ready()) { const service = new MainnetActivationService(new FileMainnetActivationStore(join(root, "activation.json")), { current: () => current }); await service.configure({ ...configuration(), actor: actors.operator }); await service.approveConfiguration({ approvalId: "approval_security_config", actor: actors.security, evidenceDigest: sha("f"), approvedAt: "2026-11-10T12:05:00.000Z" }); await service.approveConfiguration({ approvalId: "approval_finance_config", actor: actors.finance, evidenceDigest: sha("1"), approvedAt: "2026-11-10T12:06:00.000Z" }); return service; }

test("remains blocked while the independent assessment is incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-mainnet-")); try { const status = ready(); status.assessment = { allowed: false, blockers: ["INDEPENDENT_ASSESSMENT_INCOMPLETE"] }; const service = await configuredService(root, status); assert.deepEqual(service.readiness().blockers, ["INDEPENDENT_ASSESSMENT_INCOMPLETE"]); await assert.rejects(() => service.beginPilot({ actor: actors.operator, startedAt: "2026-11-10T12:10:00.000Z" }), /assessment_incomplete/i); } finally { await rm(root, { recursive: true, force: true }); }
});

test("executes a bounded pilot, exact independent validation, reconciliation, and dual-approved rollout", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-mainnet-")); try {
    const service = await configuredService(root); await service.beginPilot({ actor: actors.operator, startedAt: "2026-11-10T12:10:00.000Z" }); service.assertAdapterEnabled({ endpoint: "wss://primary.example.org", networkId: 0, maxFeeDrops: "100" });
    const authorization = await service.authorizeSettlement({ authorizationId: "authorization_pilot_001", organizationId: "org_meridian", intentId: "pi_pilot_001", intentDigest: sha("2"), securityDecisionDigest: sha("3"), transactionDigest: sha("4"), asset: "XRP", amountXrp: "0.5", actor: actors.settlement, requestedAt: "2026-11-10T12:11:00.000Z" }); assert.equal(authorization.phase, "PILOT");
    await assert.rejects(() => service.recordIndependentValidation({ authorizationId: authorization.authorizationId, transactionDigest: sha("5"), transactionHash: "A".repeat(64), ledgerIndex: 100, resultCode: "tesSUCCESS", validated: true, actor: actors.monitor, monitoringEvidenceDigest: sha("6"), validatedAt: "2026-11-10T12:12:00.000Z" }), (error: unknown) => error instanceof MainnetActivationError && error.code === "VALIDATION_MISMATCH");
    const validated = await service.recordIndependentValidation({ authorizationId: authorization.authorizationId, transactionDigest: sha("4"), transactionHash: "A".repeat(64), ledgerIndex: 100, resultCode: "tesSUCCESS", validated: true, actor: actors.monitor, monitoringEvidenceDigest: sha("6"), validatedAt: "2026-11-10T12:12:00.000Z" }); assert.equal(validated.status, "VALIDATED");
    const reconciled = await service.recordFinanceReconciliation({ authorizationId: authorization.authorizationId, transactionDigest: sha("4"), transactionHash: "A".repeat(64), actor: actors.finance, reconciliationDigest: sha("7"), reconciledAt: "2026-11-10T12:13:00.000Z" }); assert.equal(reconciled.status, "RECONCILED");
    await service.approveRollout({ approvalId: "approval_security_rollout", actor: actors.security, evidenceDigest: sha("8"), approvedAt: "2026-11-10T12:14:00.000Z" }); await service.approveRollout({ approvalId: "approval_finance_rollout", actor: actors.finance, evidenceDigest: sha("9"), approvedAt: "2026-11-10T12:15:00.000Z" }); await service.activate({ actor: actors.operator, activatedAt: "2026-11-10T12:16:00.000Z" }); assert.equal(service.snapshot().phase, "ACTIVE");
    const recovered = new MainnetActivationService(new FileMainnetActivationStore(join(root, "activation.json")), { current: ready }); await recovered.open(); assert.equal(recovered.snapshot().phase, "ACTIVE"); assert.equal(recovered.snapshot().authorizations[0]?.status, "RECONCILED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("keeps limits and activation authority outside the allocation agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-mainnet-")); try { const service = await configuredService(root); await assert.rejects(() => service.beginPilot({ actor: actors.agent, startedAt: "2026-11-10T12:10:00.000Z" }), /platform-operator authority/i); await service.beginPilot({ actor: actors.operator, startedAt: "2026-11-10T12:10:00.000Z" }); await assert.rejects(() => service.authorizeSettlement({ authorizationId: "authorization_agent_001", organizationId: "org_meridian", intentId: "pi_agent_001", intentDigest: sha("2"), securityDecisionDigest: sha("3"), transactionDigest: sha("4"), asset: "XRP", amountXrp: "0.5", actor: actors.agent, requestedAt: "2026-11-10T12:11:00.000Z" }), /settlement-service authority/i); await assert.rejects(() => service.authorizeSettlement({ authorizationId: "authorization_large_001", organizationId: "org_meridian", intentId: "pi_large_001", intentDigest: sha("2"), securityDecisionDigest: sha("3"), transactionDigest: sha("4"), asset: "XRP", amountXrp: "1.000001", actor: actors.settlement, requestedAt: "2026-11-10T12:11:00.000Z" }), (error: unknown) => error instanceof MainnetActivationError && error.code === "LIMIT_EXCEEDED"); } finally { await rm(root, { recursive: true, force: true }); }
});

test("freeze is immediate and a tampered activation journal fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-mainnet-")); const path = join(root, "activation.json"); try { const service = await configuredService(root); await service.beginPilot({ actor: actors.operator, startedAt: "2026-11-10T12:10:00.000Z" }); await service.freeze({ actor: actors.security, reasonDigest: sha("a"), frozenAt: "2026-11-10T12:11:00.000Z" }); assert.equal(service.snapshot().phase, "FROZEN"); assert.throws(() => service.assertAdapterEnabled({ endpoint: "wss://primary.example.org", networkId: 0, maxFeeDrops: "100" }), /disabled/i); const state = JSON.parse(await readFile(path, "utf8")) as { events: { subjectDigest: string }[] }; state.events[0]!.subjectDigest = sha("0"); await writeFile(path, JSON.stringify(state)); const recovered = new MainnetActivationService(new FileMainnetActivationStore(path), { current: ready }); await assert.rejects(() => recovered.open(), (error: unknown) => error instanceof MainnetActivationError && error.code === "STATE_TAMPERED"); } finally { await rm(root, { recursive: true, force: true }); }
});
