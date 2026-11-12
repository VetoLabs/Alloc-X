import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { InMemoryTreasuryAccounting } from "../../packages/accounting/src/index.ts";
import { InMemoryAuditChain } from "../../packages/audit-chain/src/index.ts";
import { InMemoryBeneficiaryRegistry } from "../../packages/beneficiaries/src/index.ts";
import { InMemoryPaymentIntentService, type PaymentIntentRecord } from "../../packages/payment-intents/src/index.ts";
import {
  createEd25519DecisionSigner,
  createEd25519DecisionVerifier,
  DurableSecurityDecisionService,
  FileSecurityDecisionJournal,
  ApprovalLayerService,
  type EvaluationReceipt,
} from "../../services/approval-layer/src/index.ts";
import { type AutonomousPaymentPath } from "../../services/payment-path/src/index.ts";
import { FileSecurityControlStore, TreasurySecurityControls, type ControlActor, type FreezeScope, type LimitControl } from "../../services/security-controls/src/index.ts";
import { FileReceiptStore, ReceiptBuilder } from "../../services/receipt-builder/src/index.ts";
import { AllocationAgentService, FileAllocationAgentSessionStore, type ResolvedBeneficiary } from "../../services/allocation-agent/src/index.ts";
import { FileVoiceInstructionStore, VoiceInstructionService } from "../../services/voice-instructions/src/index.ts";
import { buildCashForecast } from "../../services/cash-forecasting/src/index.ts";
import { buildPaymentSchedule } from "../../services/payment-scheduling/src/index.ts";
import { OperationalMonitor, defaultOperationalRules } from "../../services/operational-monitoring/src/index.ts";
import { FileMainnetActivationStore, MainnetActivationService } from "../../services/mainnet-activation/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(here, "public");
const dependencyDirectory = resolve(here, "..", "..", "node_modules");
const testnetJsonRpcEndpoint = "https://s.altnet.rippletest.net:51234/";
const organizationId = "org_meridian";
const policyVersion = "policy_meridian_2026";
const evidenceHash = `sha256:${"a".repeat(64)}`;

type PaymentView = {
  readonly paymentId: string;
  readonly createdAt: string;
  readonly intent: PaymentIntentRecord["intent"];
  readonly intentDigest: string;
  readonly state: "AWAITING_SETTLEMENT" | "REVIEW_REQUIRED" | "BLOCKED" | "VALIDATED" | "RECONCILED" | "RETRYABLE_FAILURE" | "FAILED";
  readonly decision: EvaluationReceipt["signedDecision"];
  readonly checks: EvaluationReceipt["evaluation"]["checks"];
  readonly auditEventId: string;
  readonly transactionHash?: string;
  readonly reconciliationId?: string;
  readonly receiptId?: string;
  readonly receiptHash?: string;
  readonly receiptLinkDigest?: string;
};

type StoredPayments = { readonly contractVersion: "1.0"; readonly payments: readonly PaymentView[] };

export interface ConsoleServerOptions {
  readonly runtimeDirectory?: string;
  readonly settlement?: { readonly path: AutonomousPaymentPath; readonly treasuryAccount: string; readonly workerId: string };
  readonly testnetAccountReader?: (address: string) => Promise<TestnetAccountSnapshot>;
  /** Local identity fixtures. Production adapters must derive these actors from an authenticated session. */
  readonly securityActors?: { readonly operator: ControlActor; readonly approver: ControlActor; readonly escalator: ControlActor };
}

export interface TestnetAccountSnapshot {
  readonly account: string;
  readonly balanceDrops: string;
  readonly balanceXrp: string;
  readonly ledgerIndex: number;
  readonly observedAt: string;
}

export async function createConsoleServer(options: ConsoleServerOptions = {}): Promise<Server> {
  const runtimeDirectory = options.runtimeDirectory ?? join(here, "runtime");
  const paymentStore = join(runtimeDirectory, "payments.json");
  const securityActors = options.securityActors ?? localSecurityActors();
  const controls = await TreasurySecurityControls.open(new FileSecurityControlStore(join(runtimeDirectory, "security-controls.json")));
  const receipts = new ReceiptBuilder(new FileReceiptStore(join(runtimeDirectory, "decision-receipts.json")));
  const { privateKey, publicKey } = await localSigningKeys(runtimeDirectory);
  const accounting = new InMemoryTreasuryAccounting();
  const beneficiaries = new InMemoryBeneficiaryRegistry({ coolingPeriodHours: 24 });
  const intents = new InMemoryPaymentIntentService(accounting, { beneficiaryAuthority: { resolve: (requestedOrganizationId, beneficiaryId) => beneficiaries.get(requestedOrganizationId, beneficiaryId).beneficiary } });
  seedDomain(intents, accounting, beneficiaries);
  const audit = new InMemoryAuditChain();
  const signer = createEd25519DecisionSigner("alloc-x-local-approval-layer-2026", privateKey);
  const verifier = createEd25519DecisionVerifier("alloc-x-local-approval-layer-2026", publicKey);
  const authenticationProvider = {
    issuer: "alloc-x-console",
    async verify(credentials: unknown) {
      if (credentials !== "local-console-service") throw new Error("ApprovalLayer request was not authenticated.");
      return {
        issuer: "alloc-x-console", audience: "approval-layer", subjectId: "principal_console_service", organizationId,
        subjectKind: "service" as const, sessionId: "session_local_console", authenticatedAt: now(), methods: ["service-mtls"],
      };
    },
  };
  const approvalLayer = new ApprovalLayerService({
    authenticationProvider,
    servicePrincipal: {
      contractVersion: "1.0", principalId: "principal_console_service", organizationId, kind: "service", status: "active",
      roles: ["approval-layer-service"], createdAt: "2026-01-01T00:00:00.000Z",
    },
    signer,
    auditChain: audit,
  });
  const journal = new FileSecurityDecisionJournal(join(runtimeDirectory, "security-decisions.ndjson"));
  const security = new DurableSecurityDecisionService(approvalLayer, journal);
  const allocationAgent = new AllocationAgentService({
    store: new FileAllocationAgentSessionStore(join(runtimeDirectory, "allocation-agent-sessions.json")),
    tools: {
      beneficiaries: {
        resolve: ({ organizationId: requestedOrganizationId, query }): ResolvedBeneficiary => {
          if (requestedOrganizationId !== organizationId) throw new Error("Beneficiary lookup is outside this organization.");
          const matches = referenceData(beneficiaries).beneficiaries.filter((beneficiary) => beneficiary.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || beneficiary.beneficiaryId === query);
          if (matches.length !== 1) throw new Error("Choose one approved beneficiary by its registered name.");
          const match = matches[0];
          return { beneficiaryId: match.beneficiaryId, displayName: match.label, asset: "XRP", status: match.status };
        },
      },
      evidence: {
        request: ({ beneficiaryId, amount, asset, purposeCode }): { requestId: string; detail: string } => {
          const requestId = `evidence_request_${crypto.randomUUID().replaceAll("-", "")}`;
          return { requestId, detail: `Evidence is required before ${amount} ${asset} can be drafted for ${beneficiaryId} under ${purposeCode}.` };
        },
      },
      policy: {
        explain: ({ amount, asset, purposeCode }): { detail: string } => {
          if (asset !== "XRP" || purposeCode !== "operations-supplies" || Number(amount) > 5000) throw new Error("This instruction is outside the currently published payment policy.");
          return { detail: "The request fits the published asset, purpose, and maximum-amount rules. A separate Approval Layer assessment is still required before signing." };
        },
      },
      drafts: {
        create: ({ beneficiaryId, amount, asset, purposeCode }): { draftIntentId: string; detail: string } => {
          const draftIntentId = `draft_${crypto.randomUUID().replaceAll("-", "")}`;
          return { draftIntentId, detail: `A bounded payment draft for ${amount} ${asset} to ${beneficiaryId} was recorded for ${purposeCode}; it has not been signed or submitted.` };
        },
      },
    },
  });
  await allocationAgent.open();
  const voiceInstructions = new VoiceInstructionService(new FileVoiceInstructionStore(join(runtimeDirectory, "voice-instructions.json")));
  await voiceInstructions.open();
  const operationalMonitor = new OperationalMonitor(defaultOperationalRules);
  const mainnetActivation = new MainnetActivationService(new FileMainnetActivationStore(join(runtimeDirectory, "mainnet-activation.json")), {
    current: () => ({
      assessment: { allowed: false, blockers: ["INDEPENDENT_ASSESSMENT_INCOMPLETE"] },
      monitoring: { healthy: operationalMonitor.snapshot().health === "HEALTHY", digest: `sha256:${"b".repeat(64)}` },
      recovery: { passed: false, digest: `sha256:${"c".repeat(64)}` },
      signerList: { configured: false, treasuryAccount: "", quorum: 0, memberCount: 0, digest: `sha256:${"d".repeat(64)}` },
    }),
  });
  await mainnetActivation.open();
  let payments = await loadPayments(paymentStore);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && /^\/api\/xrpl\/testnet\/accounts\/[^/]+$/.test(url.pathname)) {
        const address = decodeURIComponent(url.pathname.split("/")[5] ?? "");
        if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) return json(response, 400, { error: "A valid XRPL classic address is required." });
        const snapshot = await (options.testnetAccountReader ?? readTestnetAccount)(address);
        if (snapshot.account !== address) throw new Error("XRPL account response did not match the requested wallet.");
        return json(response, 200, { ...snapshot, network: "testnet", validated: true });
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        const integrity = await journal.verifyIntegrity();
        recordOperationalSnapshot(operationalMonitor, payments, options.settlement !== undefined);
        return json(response, 200, {
          organization: { id: organizationId, displayName: "Meridian Health Trust", environment: "Local secure workspace" },
          operator: { name: "Ada Okafor", role: "Treasury operator" },
          treasury: accounting.treasurySnapshot(organizationId, "XRP"),
          cashForecast: cashForecast(accounting),
          paymentSchedule: paymentSchedule(accounting),
          allocations: ["alloc_clinic", "alloc_operations"].map((allocationId) => accounting.allocationSnapshot(organizationId, allocationId)),
          paymentReferences: referenceData(beneficiaries),
          beneficiaries: ["ben_medtech", "ben_logistics"].map((beneficiaryId) => beneficiaries.get(organizationId, beneficiaryId)),
          payments: payments.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          securityJournal: integrity,
          securityControls: controls.snapshot(),
          policyVersions: [{ policyVersion, status: "published", effectiveFrom: "2026-01-01T00:00:00.000Z", summary: "Payment, reserve, evidence, beneficiary, and velocity controls" }],
          beneficiaryEvents: beneficiaries.notifications(organizationId),
          signerHealth: options.settlement ? { status: "HEALTHY", quorum: "Independent signing path configured", detail: "Ledger submission and reconciliation are available." } : { status: "NOT_CONFIGURED", quorum: "No signer quorum configured", detail: "Payment settlement stays unavailable until independent signer and ledger services are connected." },
          capabilities: { canCreatePayment: true, canSettle: options.settlement !== undefined, settlementMessage: options.settlement ? "Independent signing, validation, and reconciliation are active." : "XRPL settlement activates after the independent signer and ledger adapter are configured." },
          agent: { enabled: true, commandFormat: "pay <amount> <asset> to <beneficiary> for <purpose>", safety: "The agent can resolve approved records and make bounded drafts. It has no signing, credential, policy-publication, database, or arbitrary-network access." },
          operations: operationalMonitor.snapshot(),
          mainnetActivation: {
            ...mainnetActivation.readiness(),
            configured: mainnetActivation.snapshot().configuration !== undefined,
            configurationApprovals: mainnetActivation.snapshot().approvals.filter((item) => item.kind === "CONFIGURATION").length,
            rolloutApprovals: mainnetActivation.snapshot().approvals.filter((item) => item.kind === "ROLLOUT").length,
            pilotPayments: mainnetActivation.snapshot().authorizations.filter((item) => item.phase === "PILOT").map((item) => ({ authorizationId: item.authorizationId, amountXrp: item.amountXrp, status: item.status, transactionHash: item.transactionHash })),
          },
          offlineTrust: {
            status: "NOT_ENROLLED",
            connectivity: "ONLINE",
            deviceId: null,
            grantExpiresAt: null,
            pendingOperations: 0,
            synchronizationAllowed: false,
            detail: "This browser has no enrolled device-bound offline vault. Offline settlement and signing are always unavailable.",
          },
          offlineWorkflows: {
            connectivity: "ONLINE",
            preparedPayments: 0,
            capability: "DEVICE_ENROLLMENT_REQUIRED",
            detail: "An enrolled device can cache reference views and prepare work during a connection loss. Prepared work remains unsubmitted until fresh online revalidation.",
          },
          offlineSynchronization: {
            status: "NO_ENROLLED_DEVICE",
            serverOrderedOperations: 0,
            openConflicts: 0,
            detail: "When an enrolled device reconnects, identical retries are suppressed and any changed amount, destination, policy, or approval boundary requires explicit resolution.",
          },
          offlineRevalidation: {
            status: "ONLINE_REVALIDATION_REQUIRED",
            signingEligible: 0,
            detail: "A synchronized offline preparation needs current identity, balances, policy, beneficiary, risk, ledger, intent, and a new Approval Layer decision before it can enter signing.",
          },
          organizationCapabilities: {
            organizationType: "nonprofit",
            policyPack: "nonprofit-core",
            status: "CONFIGURATION_REQUIRED",
            detail: "A governed organization profile will map accounts, approval responsibilities, reports, and integrations without changing core payment controls.",
          },
          commercialPolicyPack: {
            status: "NOT_CONFIGURED",
            departmentBudgets: 0,
            detail: "Once a commercial organization profile is active, department budgets, vendor controls, payroll protection, purchase-order checks, and treasury reports are evaluated before the shared security flow.",
          },
          nonprofitPolicyPack: {
            status: "NOT_CONFIGURED",
            programAllocations: 0,
            detail: "Once a nonprofit organization profile is active, program budgets, donor mandates, cost categories, evidence, reporting periods, and allocation expiry are evaluated before the shared security flow.",
          },
          publicSectorPolicyPack: {
            status: "NOT_CONFIGURED",
            appropriations: 0,
            detail: "Once a public-sector organization profile is active, appropriations, warrants, commitments, procurement, expenditure controls, approval levels, and audit export are evaluated before the shared security flow. Jurisdiction extensions remain disabled until reviewed and configured.",
          },
        });
      }
      if (request.method === "POST" && /^\/api\/agent\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
        const sessionId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        const body = parseAgentMessage(await requestJson(request));
        const session = await allocationAgent.handle({ organizationId, principalId: "principal_allocation_agent", sessionId, message: body.message, occurredAt: now() });
        return json(response, 200, { session, message: session.state === "DRAFTED" ? "A bounded draft was recorded. It still needs the normal protected payment workflow before any signing or settlement." : session.state === "AWAITING_EVIDENCE" ? "Evidence is required before this instruction can become a draft." : "The agent needs a complete, explicit instruction." });
      }
      if (request.method === "POST" && url.pathname === "/api/voice/instructions") {
        const body = parseVoicePreparation(await requestJson(request));
        const instruction = await voiceInstructions.prepare({ organizationId, principalId: "principal_allocation_agent", sessionId: body.sessionId, transcript: body.transcript, recognition: body.recognition, consentedAt: now() });
        return json(response, 201, { instruction, message: "Transcript recorded. Review it and explicitly confirm before Alloc-X can interpret it." });
      }
      if (request.method === "POST" && /^\/api\/voice\/instructions\/[^/]+\/confirm$/.test(url.pathname)) {
        const voiceInstructionId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        const body = parseVoiceConfirmation(await requestJson(request));
        const instruction = await voiceInstructions.confirm({ voiceInstructionId, organizationId, principalId: "principal_allocation_agent", transcript: body.transcript, confirmedAt: now() });
        const session = await allocationAgent.handle({ organizationId, principalId: "principal_allocation_agent", sessionId: instruction.sessionId, message: instruction.transcript, occurredAt: now() });
        return json(response, 200, { instruction, session, message: session.state === "DRAFTED" ? "Confirmed voice instruction created a bounded draft. Signing and settlement still require the normal protected path." : "Voice instruction confirmed. Alloc-X needs a complete, explicit instruction before it can create a draft." });
      }
      if (request.method === "GET" && /^\/api\/agent\/sessions\/[^/]+$/.test(url.pathname)) {
        const sessionId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        return json(response, 200, { session: await allocationAgent.get({ organizationId, principalId: "principal_allocation_agent", sessionId }) });
      }
      if (request.method === "GET" && url.pathname === "/api/security/controls") return json(response, 200, { controls: controls.snapshot() });
      if (request.method === "POST" && url.pathname === "/api/security/freeze") {
        const body = parseFreezeRequest(await requestJson(request));
        const freeze = await controls.applyEmergencyFreeze({ organizationId, scope: body.scope, reason: body.reason, actor: securityActors.operator, frozenAt: now() });
        return json(response, 201, { freeze, message: "Emergency freeze is active. New matching payment creation is stopped before intent creation." });
      }
      if (request.method === "POST" && /^\/api\/security\/freeze\/[^/]+\/release$/.test(url.pathname)) {
        const freezeId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        const body = parseReason(await requestJson(request));
        const freeze = await controls.releaseEmergencyFreeze({ organizationId, freezeId, reason: body.reason, actor: securityActors.approver, releasedAt: now() });
        return json(response, 200, { freeze, message: "Emergency freeze released by an independent approver." });
      }
      if (request.method === "POST" && url.pathname === "/api/security/limit-changes") {
        const body = parseLimitChange(await requestJson(request));
        const change = await controls.requestLimitChange({ organizationId, ...body, actor: securityActors.operator, requestedAt: now() });
        return json(response, 201, { change, message: change.effect === "RELAX" ? "Limit relaxation is pending independent approval and escalation before policy publication." : "Tightening request is pending independent approval before policy publication." });
      }
      if (request.method === "POST" && /^\/api\/security\/limit-changes\/[^/]+\/approve$/.test(url.pathname)) {
        const changeId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        const change = await controls.approveLimitChange({ organizationId, changeId, actor: securityActors.approver, approvedAt: now() });
        return json(response, 200, { change, message: change.status === "AWAITING_ESCALATION" ? "Relaxation needs third-party escalation before policy publication." : "Change is ready to be carried into the separate policy publication workflow." });
      }
      if (request.method === "POST" && /^\/api\/security\/limit-changes\/[^/]+\/escalate$/.test(url.pathname)) {
        const changeId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        const change = await controls.escalateLimitRelaxation({ organizationId, changeId, actor: securityActors.escalator, escalatedAt: now() });
        return json(response, 200, { change, message: "Relaxation has independent escalation and is ready for policy publication." });
      }
      if (request.method === "GET" && url.pathname === "/api/payments") return json(response, 200, { payments });
      if (request.method === "GET" && url.pathname === "/api/beneficiaries") return json(response, 200, { beneficiaries: ["ben_medtech", "ben_logistics"].map((beneficiaryId) => beneficiaries.get(organizationId, beneficiaryId)) });
      if (request.method === "GET" && url.pathname.startsWith("/api/beneficiaries/")) {
        const beneficiaryId = decodeURIComponent(url.pathname.slice("/api/beneficiaries/".length));
        return json(response, 200, { beneficiary: beneficiaries.get(organizationId, beneficiaryId) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/payments/")) {
        const paymentId = decodeURIComponent(url.pathname.slice("/api/payments/".length));
        const payment = payments.find((value) => value.paymentId === paymentId);
        return payment ? json(response, 200, { payment }) : json(response, 404, { error: "Payment was not found." });
      }
      if (request.method === "POST" && url.pathname === "/api/payments") {
        const body = await requestJson(request);
        const selection = parseSelection(body);
        controls.assertPaymentAllowed({ organizationId, beneficiaryId: selection.beneficiaryId, asset: "XRP" });
        const createdAt = now();
        const record = intents.create({
          organizationId,
          idempotencyKey: `${organizationId}/console/${crypto.randomUUID()}`,
          sourceObligationId: selection.obligationId,
          allocationId: selection.allocationId,
          beneficiaryId: selection.beneficiaryId,
          policyVersion,
          requestedExecutionWindow: { notBefore: createdAt, expiresAt: new Date(Date.parse(createdAt) + 5 * 60_000).toISOString() },
          createdByPrincipalId: "principal_allocation_agent",
          requestedAt: createdAt,
        });
        const securityRequest = { organizationId, correlationId: `corr_${crypto.randomUUID().replaceAll("-", "")}`, rawCredentials: "local-console-service", intent: record.intent, policy: activePolicy(), context: evaluationContext(record.intent, accounting, beneficiaries) };
        const pathResult = options.settlement ? await options.settlement.path.execute({ record, securityRequest, treasuryAccount: options.settlement.treasuryAccount, workerId: options.settlement.workerId, now: createdAt }) : undefined;
        const receipt = pathResult?.receipt ?? await security.evaluate(securityRequest);
        const outcome = receipt.signedDecision.decision.outcome;
        let payment: PaymentView = Object.freeze({
          paymentId: `pay_${record.intent.intentId.slice(3)}`,
          createdAt,
          intent: record.intent,
          intentDigest: record.intentDigest,
          state: pathResult?.state ?? (outcome === "ALLOW" ? "AWAITING_SETTLEMENT" : outcome === "REVIEW" ? "REVIEW_REQUIRED" : "BLOCKED"),
          decision: receipt.signedDecision,
          checks: receipt.evaluation.checks,
          auditEventId: receipt.auditEvent.eventId,
          ...(pathResult?.job?.validatedTransaction ? { transactionHash: pathResult.job.validatedTransaction.transactionHash } : {}),
          ...(pathResult?.reconciliation ? { reconciliationId: pathResult.reconciliation.reconciliationId } : {}),
        });
        const settlement = payment.transactionHash ? { status: "validated" as const, transactionHash: payment.transactionHash } : payment.state === "FAILED" ? { status: "failed" as const } : { status: "not-submitted" as const };
        const issued = await receipts.issue({ receiptId: `receipt_${payment.paymentId.slice(4)}`, organizationId, intentId: payment.intent.intentId, intentDigest: payment.intentDigest, decisionId: payment.decision.decision.decisionId, policyVersion: payment.intent.policyVersion, evidenceManifestHash: payment.intent.evidenceManifestHash, securityOutcome: payment.decision.decision.outcome, reasonCodes: payment.decision.decision.reasonCodes, settlement, generatedAt: createdAt, policyCitations: [{ clause: "Payment policy evaluation", sourceHash: evidenceHash }], budgetMovement: { allocationId: payment.intent.allocationId, amount: payment.intent.amount, reservationId: record.reservation.reservationId, state: payment.state }, securityDecision: { decisionDigest: payment.decision.decisionDigest, signature: payment.decision.signature, signerKeyId: payment.decision.signerKeyId }, signerAttestations: pathResult?.job ? [{ signerId: "independent-xrpl-quorum", status: pathResult.job.state }] : [], ledger: pathResult?.job?.validatedTransaction ? { network: "xrpl", ledgerIndex: pathResult.job.validatedTransaction.ledgerIndex, validatedAt: pathResult.job.validatedTransaction.validatedAt } : {} });
        payment = Object.freeze({ ...payment, receiptId: issued.document.receipt.receiptId, receiptHash: issued.document.receipt.receiptHash, ...(issued.link ? { receiptLinkDigest: issued.link.linkDigest } : {}) });
        payments = [payment, ...payments];
        await savePayments(paymentStore, payments);
        return json(response, 201, { payment, message: pathResult?.state === "RECONCILED" ? "Payment validated and independently reconciled." : outcome === "ALLOW" ? "Security decision recorded. Settlement remains unavailable until an independent signer and ledger adapter are connected." : "Payment was recorded with the required security outcome." });
      }
      if (request.method === "POST" && /^\/api\/payments\/[^/]+\/recover$/.test(url.pathname)) {
        const paymentId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const payment = payments.find((value) => value.paymentId === paymentId);
        if (!payment) return json(response, 404, { error: "Payment was not found." });
        const stored = await security.recoverForSettlement({ organizationId, decisionId: payment.decision.decision.decisionId, intent: payment.intent, now: now(), verifier });
        return json(response, 200, { recovered: stored, payment });
      }
      if (request.method === "GET" && /^\/api\/receipts\/[^/]+$/.test(url.pathname)) {
        const receiptId = decodeURIComponent(url.pathname.split("/")[3] ?? ""); const verified = await receipts.verify(receiptId);
        return verified.document ? json(response, verified.valid ? 200 : 409, verified) : json(response, 404, { error: "Decision receipt was not found." });
      }
      if (request.method === "GET" && /^\/api\/receipts\/[^/]+\/download$/.test(url.pathname)) {
        const receiptId = decodeURIComponent(url.pathname.split("/")[3] ?? ""); const verified = await receipts.verify(receiptId);
        if (!verified.document || !verified.valid) return json(response, verified.document ? 409 : 404, { error: "Decision receipt is unavailable for download." });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${receiptId}.json"`, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(verified)); return;
      }
      if (request.method === "GET") return serveAsset(url.pathname, response);
      return json(response, 405, { error: "Method is not supported." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      return json(response, isClientError(message) ? 400 : 500, { error: message });
    }
  });
}

function seedDomain(intents: InMemoryPaymentIntentService, accounting: InMemoryTreasuryAccounting, registry: InMemoryBeneficiaryRegistry): void {
  const seededAt = "2026-11-07T10:00:00.000Z";
  accounting.createTreasuryAccount({ organizationId, asset: "XRP", openingAmount: "12000" }, seededAt);
  for (const allocation of allocations()) accounting.registerAllocation(allocation, seededAt);
  intents.registerOrganization({ contractVersion: "1.0", organizationId, displayName: "Meridian Health Trust", status: "active", createdAt: "2026-01-01T00:00:00.000Z" });
  intents.registerPrincipal({ contractVersion: "1.0", principalId: "principal_allocation_agent", organizationId, kind: "agent", status: "active", roles: ["allocation-agent"], createdAt: "2026-01-01T00:00:00.000Z" });
  for (const allocation of allocations()) intents.registerAllocation(allocation);
  for (const beneficiary of beneficiaries()) {
    const pending = { ...beneficiary, status: "pending" as const };
    registry.proposeEnrollment({ beneficiary: pending, verification: { verificationId: `bov_${beneficiary.beneficiaryId.slice(4)}`, method: "signed-wallet-challenge", evidenceHash, requestedAt: seededAt } });
    const approved = registry.verifyEnrollment({ organizationId, beneficiaryId: beneficiary.beneficiaryId, verificationId: `bov_${beneficiary.beneficiaryId.slice(4)}`, verifiedByPrincipalId: "principal_beneficiary_verifier", verifiedAt: "2026-11-07T10:01:00.000Z" });
    intents.registerBeneficiary(approved.beneficiary);
  }
  for (const obligation of obligations()) {
    const { displayName: ignored, ...authoritativeObligation } = obligation;
    intents.registerObligation(authoritativeObligation);
  }
  for (const obligation of obligations()) intents.registerEvidenceManifest({
    contractVersion: "1.0", evidenceManifestId: `evidence_${obligation.obligationId.slice(4)}`, organizationId, obligationId: obligation.obligationId,
    manifestHash: evidenceHash, items: [{ evidenceId: `evi_${obligation.obligationId.slice(4)}`, type: "invoice", contentHash: evidenceHash, sourceSystem: "meridian-erp", status: "verified", observedAt: seededAt }], createdAt: seededAt,
  });
  intents.registerPolicy({ organizationId, policyVersion, status: "published", effectiveFrom: "2026-01-01T00:00:00.000Z" });
}

function allocations() {
  return [
    { contractVersion: "1.0" as const, allocationId: "alloc_clinic", organizationId, displayName: "Clinic equipment", asset: "XRP", authorizedAmount: "8000", allowedPurposeCodes: ["operations-supplies"], activeFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", status: "active" as const },
    { contractVersion: "1.0" as const, allocationId: "alloc_operations", organizationId, displayName: "Field operations", asset: "XRP", authorizedAmount: "4000", allowedPurposeCodes: ["operations-supplies"], activeFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", status: "active" as const },
  ];
}

function beneficiaries() {
  return [
    { contractVersion: "1.0" as const, beneficiaryId: "ben_medtech", organizationId, status: "approved" as const, wallet: { network: "xrpl-classic" as const, address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }, walletVersion: 1, lastWalletChangeAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
    { contractVersion: "1.0" as const, beneficiaryId: "ben_logistics", organizationId, status: "approved" as const, wallet: { network: "xrpl-classic" as const, address: "r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV" }, walletVersion: 1, lastWalletChangeAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
}

function obligations() {
  return [
    { contractVersion: "1.0" as const, obligationId: "obl_clinic_refrigeration", organizationId, beneficiaryId: "ben_medtech", amount: "1350", asset: "XRP", purposeCode: "operations-supplies", evidenceManifestHash: evidenceHash, dueAt: "2026-12-01T00:00:00.000Z", status: "open" as const, createdByPrincipalId: "principal_allocation_agent", createdAt: "2026-11-01T00:00:00.000Z", displayName: "Cold-chain refrigeration" },
    { contractVersion: "1.0" as const, obligationId: "obl_last_mile_logistics", organizationId, beneficiaryId: "ben_logistics", amount: "2750", asset: "XRP", purposeCode: "operations-supplies", evidenceManifestHash: evidenceHash, dueAt: "2026-12-05T00:00:00.000Z", status: "open" as const, createdByPrincipalId: "principal_allocation_agent", createdAt: "2026-11-02T00:00:00.000Z", displayName: "Last-mile medical delivery" },
  ];
}

function referenceData(registry: InMemoryBeneficiaryRegistry) {
  return {
    obligations: obligations().map(({ displayName, ...value }) => ({ ...value, displayName })),
    beneficiaries: beneficiaries().map((value) => { const profile = registry.securityProfile(organizationId, value.beneficiaryId); return { beneficiaryId: value.beneficiaryId, walletVersion: profile.walletVersion, status: profile.status, label: value.beneficiaryId === "ben_medtech" ? "MedTech Supplies" : "Northline Logistics" }; }),
    allocations: allocations().map((value) => ({ allocationId: value.allocationId, displayName: value.displayName, asset: value.asset })),
  };
}

function cashForecast(accounting: InMemoryTreasuryAccounting) {
  const asOf = now();
  const inDays = (days: number) => new Date(Date.parse(asOf) + days * 86_400_000).toISOString();
  return buildCashForecast({
    organizationId, asset: "XRP", asOf, sourceFreshAt: asOf, treasuryAvailable: accounting.treasurySnapshot(organizationId, "XRP").availableAmount,
    reserveFloor: "1000", payrollProtection: "2500", horizonDays: 30,
    inflows: [{ inflowId: "inflow_partner_disbursement", amount: "5000", expectedAt: inDays(12), confidencePercent: 70, description: "Confirmed partner disbursement" }],
    obligations: [{ obligationId: "obl_payroll_forecast", amount: "3200", dueAt: inDays(8), description: "Planned payroll", category: "payroll" }, ...obligations().map((obligation) => ({ obligationId: obligation.obligationId, amount: obligation.amount, dueAt: obligation.dueAt, description: obligation.displayName, category: "supplier" as const }))],
    observedAvailable: accounting.treasurySnapshot(organizationId, "XRP").availableAmount,
  });
}

function paymentSchedule(accounting: InMemoryTreasuryAccounting) {
  const calculatedAt = now();
  return buildPaymentSchedule({
    organizationId, asset: "XRP", calculatedAt, capacitySnapshotVersion: `capacity_${calculatedAt.replace(/[^0-9]/g, "")}`,
    treasuryAvailable: accounting.treasurySnapshot(organizationId, "XRP").availableAmount, reserveFloor: "1000", estimatedFee: "0.000012",
    allocations: allocations().map((allocation) => ({ allocationId: allocation.allocationId, availableAmount: accounting.allocationSnapshot(organizationId, allocation.allocationId).availableAmount, expiresAt: allocation.expiresAt, allowedPurposeCodes: allocation.allowedPurposeCodes, status: allocation.status })),
    obligations: obligations().map((obligation) => ({ obligationId: obligation.obligationId, amount: obligation.amount, dueAt: obligation.dueAt, purposeCode: obligation.purposeCode, policyEligible: true, beneficiaryEligible: true, evidenceReady: true })),
  });
}

function recordOperationalSnapshot(monitor: OperationalMonitor, payments: readonly PaymentView[], settlementConfigured: boolean): void {
  const observedAt = now(); const vetoes = payments.filter((payment) => payment.decision.decision.outcome !== "ALLOW").length;
  const averageLatency = payments.length ? payments.reduce((total, payment) => total + Math.max(0, Date.parse(payment.decision.signedAt) - Date.parse(payment.createdAt)), 0) / payments.length : 0;
  const metrics = [
    { name: "service.health" as const, value: 1, service: "approval-layer" },
    { name: "queue.depth" as const, value: payments.filter((payment) => payment.state === "AWAITING_SETTLEMENT").length, service: "payment-orchestrator" },
    { name: "payment.latency_ms" as const, value: averageLatency, service: "payment-path" },
    { name: "veto.rate_percent" as const, value: payments.length ? vetoes / payments.length * 100 : 0, service: "approval-layer" },
    { name: "signer.failures" as const, value: payments.filter((payment) => payment.state === "FAILED").length, service: settlementConfigured ? "signer-quorum" : "signer-not-configured" },
    { name: "reconciliation.lag_seconds" as const, value: 0, service: "ledger-monitor" },
    { name: "unknown_outflows" as const, value: 0, service: "ledger-monitor" },
    { name: "policy.errors" as const, value: 0, service: "policy-engine" },
    { name: "model.cost_usd" as const, value: 0, service: "allocation-agent" },
  ];
  for (const metric of metrics) monitor.recordMetric({ ...metric, observedAt, attributes: { organizationId } });
}

function activePolicy() {
  return { policyVersion, organizationId, status: "published" as const, effectiveFrom: "2026-01-01T00:00:00.000Z", allowedPurposeCodes: ["operations-supplies"], allowedAssets: ["XRP"], maxPaymentAmount: "5000", reserveFloor: "1000", requiredEvidenceByPurpose: { "operations-supplies": ["invoice"] }, approvalRules: [], beneficiaryChangeCoolingPeriodHours: 24, velocity: { maxPaymentCount24Hours: 10, maxPaymentAmount24Hours: "10000" }, risk: { reviewAtScore: 60, denyAtScore: 85 }, decisionTtlSeconds: 300 };
}

function evaluationContext(intent: PaymentIntentRecord["intent"], accounting: InMemoryTreasuryAccounting, registry: InMemoryBeneficiaryRegistry) {
  const highReviewRisk = intent.sourceObligationId === "obl_last_mile_logistics";
  const profile = registry.securityProfile(organizationId, intent.beneficiaryId);
  return { now: now(), availableTreasuryBalance: accounting.treasurySnapshot(organizationId, "XRP").availableAmount, availableAllocationBalance: accounting.allocationSnapshot(organizationId, intent.allocationId).availableAmount, beneficiary: { beneficiaryId: intent.beneficiaryId, walletVersion: profile.walletVersion, status: profile.status, lastWalletChangeAt: profile.lastWalletChangeAt }, evidence: { manifestHash: intent.evidenceManifestHash, evidenceTypes: ["invoice"], duplicateStatus: "clear" as const, procurementStatus: "verified" as const, integrityStatus: "verified" as const }, approvals: [], recentPayments: [], seenIntentDigests: [], riskScore: highReviewRisk ? 67 : 12, securityDependencies: { policyStore: "available" as const, beneficiaryRegistry: "available" as const, evidenceStore: "available" as const, riskEngine: "available" as const } };
}

function parseSelection(value: unknown): { obligationId: string; allocationId: string; beneficiaryId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Payment selection is required.");
  const record = value as Record<string, unknown>;
  const allowed = ["obligationId", "allocationId", "beneficiaryId"];
  if (Object.keys(record).some((key) => !allowed.includes(key)) || allowed.some((key) => typeof record[key] !== "string")) throw new TypeError("Payment selection contains unsupported fields.");
  return { obligationId: record.obligationId as string, allocationId: record.allocationId as string, beneficiaryId: record.beneficiaryId as string };
}

function parseAgentMessage(value: unknown): { readonly message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof (value as Record<string, unknown>).message !== "string") throw new TypeError("Agent message is required.");
  const message = (value as Record<string, string>).message.trim();
  if (!message || message.length > 500) throw new TypeError("Agent message must be between 1 and 500 characters.");
  return { message };
}

function parseVoicePreparation(value: unknown): { readonly sessionId: string; readonly transcript: string; readonly recognition: { readonly engine: "browser-native"; readonly locale: string; readonly confidence?: number } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Voice instruction is required.");
  const record = value as Record<string, unknown>; const keys = ["sessionId", "transcript", "recognition"];
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => record[key] === undefined) || typeof record.sessionId !== "string" || typeof record.transcript !== "string" || !record.recognition || typeof record.recognition !== "object" || Array.isArray(record.recognition)) throw new TypeError("Voice instruction is invalid.");
  const recognition = record.recognition as Record<string, unknown>;
  if (Object.keys(recognition).some((key) => !["engine", "locale", "confidence"].includes(key)) || recognition.engine !== "browser-native" || typeof recognition.locale !== "string" || (recognition.confidence !== undefined && (typeof recognition.confidence !== "number" || recognition.confidence < 0 || recognition.confidence > 1))) throw new TypeError("Voice recognition metadata is invalid.");
  return { sessionId: record.sessionId, transcript: record.transcript, recognition: { engine: "browser-native", locale: recognition.locale, ...(recognition.confidence === undefined ? {} : { confidence: recognition.confidence }) } };
}

function parseVoiceConfirmation(value: unknown): { readonly transcript: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof (value as Record<string, unknown>).transcript !== "string") throw new TypeError("Voice confirmation is invalid.");
  return { transcript: (value as Record<string, string>).transcript };
}

function parseFreezeRequest(value: unknown): { readonly scope: FreezeScope; readonly reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Emergency freeze request is required.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["scope", "reason"].includes(key)) || typeof record.reason !== "string" || !record.scope || typeof record.scope !== "object" || Array.isArray(record.scope)) throw new TypeError("Emergency freeze request is invalid.");
  const scope = record.scope as Record<string, unknown>;
  if (scope.kind === "organization" && Object.keys(scope).length === 1) return { scope: { kind: "organization" }, reason: record.reason };
  if (scope.kind === "beneficiary" && Object.keys(scope).length === 2 && typeof scope.beneficiaryId === "string") return { scope: { kind: "beneficiary", beneficiaryId: scope.beneficiaryId }, reason: record.reason };
  if (scope.kind === "asset" && Object.keys(scope).length === 2 && typeof scope.asset === "string") return { scope: { kind: "asset", asset: scope.asset }, reason: record.reason };
  throw new TypeError("Emergency freeze scope is invalid.");
}

function parseReason(value: unknown): { readonly reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof (value as Record<string, unknown>).reason !== "string") throw new TypeError("Reason is required.");
  return { reason: (value as Record<string, string>).reason };
}

function parseLimitChange(value: unknown): { readonly control: LimitControl; readonly currentValue: string; readonly requestedValue: string; readonly justification: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Limit change request is required.");
  const record = value as Record<string, unknown>; const allowed = ["control", "currentValue", "requestedValue", "justification"];
  if (Object.keys(record).some((key) => !allowed.includes(key)) || allowed.some((key) => typeof record[key] !== "string")) throw new TypeError("Limit change request is invalid.");
  if (!(["max-payment-amount", "reserve-floor", "daily-payment-count", "daily-payment-amount"] as const).includes(record.control as LimitControl)) throw new TypeError("Limit control is invalid.");
  return { control: record.control as LimitControl, currentValue: record.currentValue as string, requestedValue: record.requestedValue as string, justification: record.justification as string };
}

function localSecurityActors(): { readonly operator: ControlActor; readonly approver: ControlActor; readonly escalator: ControlActor } {
  return {
    operator: { principalId: "principal_security_operator", organizationId, kind: "human", roles: ["security-operator"] },
    approver: { principalId: "principal_security_approver", organizationId, kind: "human", roles: ["security-approver"] },
    escalator: { principalId: "principal_security_escalator", organizationId, kind: "human", roles: ["security-escalation-approver"] },
  };
}

async function localSigningKeys(runtimeDirectory: string) {
  const privatePath = join(runtimeDirectory, "approval-layer-private.pem");
  const publicPath = join(runtimeDirectory, "approval-layer-public.pem");
  try { return { privateKey: createPrivateKey(await readFile(privatePath, "utf8")), publicKey: createPublicKey(await readFile(publicPath, "utf8")) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const keys = generateKeyPairSync("ed25519");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(privatePath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    await writeFile(publicPath, keys.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o600 });
    return keys;
  }
}

async function loadPayments(path: string): Promise<PaymentView[]> {
  try { const parsed = JSON.parse(await readFile(path, "utf8")) as StoredPayments; return parsed.contractVersion === "1.0" && Array.isArray(parsed.payments) ? [...parsed.payments] : []; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function savePayments(path: string, payments: readonly PaymentView[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next`;
  await writeFile(temporary, JSON.stringify({ contractVersion: "1.0", payments }), { mode: 0o600 });
  await rename(temporary, path);
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (Buffer.concat(chunks).length > 16_384) throw new TypeError("Request body is too large.");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new TypeError("Request body must be valid JSON."); }
}

async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
  const vendorAssets: Readonly<Record<string, string>> = {
    "/vendor/xrpl.js": join(dependencyDirectory, "xrpl", "build", "xrpl-latest-min.js"),
    "/vendor/xrpl-connect.js": join(dependencyDirectory, "xrpl-connect", "xrpl-connect.umd.js"),
  };
  const vendorAsset = vendorAssets[pathname];
  if (vendorAsset) {
    try {
      const content = await readFile(vendorAsset);
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(content); return;
    } catch { return json(response, 404, { error: "Wallet dependency was not found. Run the workspace install first." }); }
  }
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const absolute = resolve(publicDirectory, requested);
  if (!absolute.startsWith(`${resolve(publicDirectory)}${sep}`) && absolute !== resolve(publicDirectory, "index.html")) return json(response, 403, { error: "Asset path is invalid." });
  try {
    const content = await readFile(absolute);
    const type = absolute.endsWith(".css") ? "text/css; charset=utf-8" : absolute.endsWith(".js") ? "text/javascript; charset=utf-8" : absolute.endsWith(".svg") ? "image/svg+xml; charset=utf-8" : absolute.endsWith(".jpg") || absolute.endsWith(".jpeg") ? "image/jpeg" : "text/html; charset=utf-8";
    response.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(content);
  } catch { json(response, 404, { error: "Page was not found." }); }
}

async function readTestnetAccount(address: string): Promise<TestnetAccountSnapshot> {
  // A read-only public JSON-RPC call: no SDK imports or signing authority are needed for a balance lookup.
  const response = await fetch(testnetJsonRpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "account_info", params: [{ account: address, ledger_index: "validated" }] }),
    signal: AbortSignal.timeout(9_000),
  });
  if (!response.ok) throw new Error("XRPL Testnet account lookup failed.");
  const payload = await response.json() as {
    result?: { status?: string; account?: string; account_data?: { Account?: string; Balance?: string }; ledger_index?: number };
  };
  const result = payload.result;
  const balanceDrops = result?.account_data?.Balance;
  const ledgerIndex = result?.ledger_index;
  if (result?.status !== "success" || result.account_data?.Account !== address ||
      typeof balanceDrops !== "string" || !/^\d+$/.test(balanceDrops) ||
      !Number.isSafeInteger(ledgerIndex)) {
    throw new Error("XRPL did not return a valid, validated Testnet account snapshot.");
  }
  const whole = balanceDrops.length > 6 ? balanceDrops.slice(0, -6) : "0";
  const fraction = balanceDrops.slice(-6).padStart(6, "0").replace(/0+$/, "");
  return Object.freeze({
    account: address,
    balanceDrops,
    balanceXrp: fraction ? whole + "." + fraction : whole,
    ledgerIndex: ledgerIndex as number,
    observedAt: now(),
  });
}

function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(body)); }
function now(): string { return new Date().toISOString(); }
function isClientError(message: string): boolean { return /required|invalid|unsupported|not found|eligible|active|capacity|live|selection|authenticated|must|frozen|pending|independent|escalation|awaiting|transcript changed|already been confirmed|no longer current/i.test(message); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const server = await createConsoleServer();
  server.listen(Number(process.env.PORT ?? 4173), "127.0.0.1");
}
