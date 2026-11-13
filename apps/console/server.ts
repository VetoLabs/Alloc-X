import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { decode as decodeXrplTransaction } from "ripple-binary-codec";

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
  assertSettlementAuthorized,
  type EvaluationReceipt,
} from "../../services/approval-layer/src/index.ts";
import { parsePaymentIntent, paymentIntentDigest, sha256Digest, type CanonicalValue, type PaymentIntent } from "../../packages/contracts/src/index.ts";
import type { AutonomousPaymentPath } from "../../services/payment-path/src/index.ts";
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
  readonly display?: { readonly instruction: string; readonly payeeName: string; readonly allocationName: string };
};

type AgentPaymentPreparation = {
  readonly authorizationId: string;
  readonly instruction: string;
  readonly payeeName: string;
  readonly allocationName: string;
  readonly intent: PaymentIntent;
  readonly intentDigest: string;
  readonly prepared: PreparedAgentPayment;
  readonly receipt: EvaluationReceipt;
  readonly expiresAt: string;
};

type PreparedAgentPayment = { readonly network: "testnet"; readonly networkId: 1; readonly intentId: string; readonly intentDigest: string; readonly organizationId: string; readonly transaction: Readonly<Record<string, unknown>>; readonly preparedAtLedgerIndex: number };

type ValidatedTestnetPayment = {
  readonly transactionHash: string;
  readonly account: string;
  readonly destination: string;
  readonly amountDrops: string;
  readonly ledgerIndex: number;
  readonly validatedAt: string;
  readonly resultCode: "tesSUCCESS";
};

type WorkspaceAllocationInput = { readonly allocationId: string; readonly name: string; readonly category: string; readonly purpose: string; readonly spendingRule: string; readonly walletAddress: string };
type WorkspacePayeeInput = { readonly payeeId: string; readonly name: string; readonly type: string; readonly role: string; readonly walletAddress: string; readonly status: string; readonly createdAt: string };
type AgentPaymentRequest = { readonly message: string; readonly sourceAccount?: string; readonly registry: { readonly allocations: readonly WorkspaceAllocationInput[]; readonly payees: readonly WorkspacePayeeInput[] } };

type StoredPayments = { readonly contractVersion: "1.0"; readonly payments: readonly PaymentView[] };

export interface ConsoleServerOptions {
  readonly runtimeDirectory?: string;
  readonly settlement?: { readonly path: AutonomousPaymentPath; readonly treasuryAccount: string; readonly workerId: string };
  readonly testnetAccountReader?: (address: string) => Promise<TestnetAccountSnapshot>;
  readonly agentPaymentAdapter?: { prepareNativePayment(input: { readonly intentId: string; readonly intentDigest: string; readonly organizationId: string; readonly account: string; readonly destination: string; readonly amountXrp: string; readonly mode: "sequence" }): Promise<PreparedAgentPayment> };
  readonly testnetSignedSubmitter?: (signedTransactionBlob: string) => Promise<string>;
  readonly testnetTransactionReader?: (hash: string) => Promise<ValidatedTestnetPayment>;
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
  const agentPreparations = new Map<string, AgentPaymentPreparation>();
  const agentPaymentAdapter = options.agentPaymentAdapter ?? { prepareNativePayment: prepareAgentTestnetPayment };

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
          organization: { id: organizationId, displayName: "XRPL Wallet Workspace", environment: "Local secure workspace" },
          operator: { name: "Main wallet", role: "Operator wallet" },
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
          signerHealth: options.settlement ? { status: "HEALTHY", quorum: "Independent signing path configured", detail: "Ledger submission and reconciliation are available." } : { status: "WALLET_AUTHORIZATION", quorum: "Connected treasury wallet", detail: "Testnet payments are authorized in the connected XRPL wallet, then independently validated before Alloc-X records settlement." },
          capabilities: { canCreatePayment: true, canSettle: true, settlementMessage: options.settlement ? "Independent signing, validation, and reconciliation are active." : "Connected XRPL wallets can authorize Testnet settlement; Alloc-X validates the final ledger result." },
          agent: { enabled: true, commandFormat: "Tell Alloc-X the registered payee and XRP amount, for example: pay Goodwill Clinic 200 XRP", safety: "The agent resolves registered records, obtains a signed Approval Layer decision, prepares a bounded transaction, requests wallet authorization, and records only validated Testnet settlement." },
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
      if (request.method === "POST" && url.pathname === "/api/agent/payments/prepare") {
        const body = parseAgentPaymentRequest(await requestJson(request));
        const resolved = resolveAgentPayment(body);
        const sourceAccount = resolved.allocation.walletAddress;
        if (!sourceAccount) throw new TypeError(`${resolved.allocation.name} does not have an XRPL Testnet wallet.`);
        controls.assertPaymentAllowed({ organizationId, beneficiaryId: resolved.beneficiaryId, asset: "XRP" });
        const account = await (options.testnetAccountReader ?? readTestnetAccount)(sourceAccount);
        if (account.account !== sourceAccount) throw new Error("XRPL account response did not match the selected allocation wallet.");
        if (BigInt(account.balanceDrops) <= BigInt(resolved.amountDrops)) throw new TypeError(`${resolved.allocation.name} does not have enough validated XRP to cover this payment and ledger reserve.`);
        const preparedAt = now();
        const token = crypto.randomUUID().replaceAll("-", "");
        const intent = parsePaymentIntent({
          contractVersion: "1.0",
          intentId: `pi_${token}`,
          organizationId,
          idempotencyKey: `${organizationId}/agent/${token}`,
          sourceObligationId: `obl_${token}`,
          allocationId: resolved.allocationId,
          amount: resolved.amount,
          asset: "XRP",
          beneficiaryId: resolved.beneficiaryId,
          beneficiaryWalletVersion: 1,
          purposeCode: "workspace-payment",
          evidenceManifestHash: sha256Digest({ instruction: body.message, payeeId: resolved.payee.payeeId, allocationId: resolved.allocation.allocationId } as CanonicalValue),
          policyVersion: "policy_workspace_testnet_2026",
          requestedExecutionWindow: { notBefore: preparedAt, expiresAt: new Date(Date.parse(preparedAt) + 5 * 60_000).toISOString() },
          createdBy: { principalId: "principal_allocation_agent", actorType: "agent" },
        });
        const intentDigest = paymentIntentDigest(intent);
        const securityRequest = {
          organizationId,
          correlationId: `corr_${token}`,
          rawCredentials: "local-console-service",
          intent,
          policy: workspacePaymentPolicy(),
          context: workspaceEvaluationContext(intent, account.balanceXrp, resolved.payee.createdAt),
        };
        const approvalReceipt = await security.evaluate(securityRequest);
        if (approvalReceipt.signedDecision.decision.outcome !== "ALLOW") {
          return json(response, 409, { error: `Approval Layer returned ${approvalReceipt.signedDecision.decision.outcome}. ${approvalReceipt.signedDecision.decision.reasonCodes.join(", ") || "The payment requires review."}` });
        }
        const prepared = await agentPaymentAdapter.prepareNativePayment({ intentId: intent.intentId, intentDigest, organizationId, account: sourceAccount, destination: resolved.payee.walletAddress, amountXrp: resolved.amount, mode: "sequence" });
        const authorizationId = `authorization_${token}`;
        const preparation: AgentPaymentPreparation = Object.freeze({ authorizationId, instruction: body.message, payeeName: resolved.payee.name, allocationName: resolved.allocation.name, intent, intentDigest, prepared, receipt: approvalReceipt, expiresAt: intent.requestedExecutionWindow.expiresAt });
        agentPreparations.set(authorizationId, preparation);
        const authorizationToken = Buffer.from(JSON.stringify(preparation)).toString("base64url");
        const authorization = { token: authorizationToken, signature: signer.sign(authorizationToken), keyId: signer.keyId };
        return json(response, 201, {
          authorizationId,
          authorization,
          transaction: prepared.transaction,
          payment: { amount: intent.amount, asset: intent.asset, payeeName: preparation.payeeName, allocationName: preparation.allocationName, sourceAccount, destination: resolved.payee.walletAddress },
          approval: approvalReceipt.signedDecision,
          message: `Approval Layer allowed ${intent.amount} XRP from ${preparation.allocationName} to ${preparation.payeeName}. Alloc-X selected the eligible allocation and bound the exact transaction for autonomous Testnet signing.`,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/agent/payments/complete") {
        const body = parseAgentPaymentCompletion(await requestJson(request));
        const preparation = agentPreparations.get(body.authorizationId) ?? restoreAgentPreparation(body.authorization, verifier);
        if (preparation.authorizationId !== body.authorizationId) throw new TypeError("Payment authorization identifier does not match its signed execution record.");
        assertSettlementAuthorized({ signedDecision: preparation.receipt.signedDecision, organizationId, intent: preparation.intent, now: now(), verifier });
        if (body.signedTransactionBlob) assertSignedTransactionMatches(preparation.prepared.transaction, body.signedTransactionBlob);
        const transactionHash = body.signedTransactionBlob ? await (options.testnetSignedSubmitter ?? submitSignedTestnetPayment)(body.signedTransactionBlob) : body.transactionHash!;
        const existing = payments.find((payment) => payment.transactionHash === transactionHash);
        if (existing) return json(response, 200, { payment: existing, message: "The transaction was already validated and recorded." });
        const validated = await (options.testnetTransactionReader ?? readValidatedTestnetPayment)(transactionHash);
        if (validated.account !== preparation.prepared.transaction.Account || validated.destination !== preparation.prepared.transaction.Destination || validated.amountDrops !== preparation.prepared.transaction.Amount) throw new TypeError("Validated XRPL transaction does not match the payment authorized by the Approval Layer.");
        const completedAt = validated.validatedAt;
        const paymentId = `pay_${preparation.intent.intentId.slice(3)}`;
        const issued = await receipts.issue({
          receiptId: `receipt_${paymentId.slice(4)}`,
          organizationId,
          intentId: preparation.intent.intentId,
          intentDigest: preparation.intentDigest,
          decisionId: preparation.receipt.signedDecision.decision.decisionId,
          policyVersion: preparation.intent.policyVersion,
          evidenceManifestHash: preparation.intent.evidenceManifestHash,
          securityOutcome: "ALLOW",
          reasonCodes: preparation.receipt.signedDecision.decision.reasonCodes,
          settlement: { status: "validated", transactionHash: validated.transactionHash },
          generatedAt: completedAt,
          policyCitations: [{ clause: "Workspace Testnet payment policy", sourceHash: preparation.receipt.evaluation.policyDigest }],
          budgetMovement: { allocationId: preparation.intent.allocationId, amount: preparation.intent.amount, state: "VALIDATED" },
          securityDecision: { decisionDigest: preparation.receipt.signedDecision.decisionDigest, signature: preparation.receipt.signedDecision.signature, signerKeyId: preparation.receipt.signedDecision.keyId },
          signerAttestations: [{ signerId: body.signedTransactionBlob ? "allocation-session-signer" : "connected-xrpl-wallet", status: "AUTHORIZED" }],
          ledger: { network: "xrpl-testnet", ledgerIndex: validated.ledgerIndex, validatedAt: validated.validatedAt },
        });
        const payment: PaymentView = Object.freeze({
          paymentId,
          createdAt: completedAt,
          intent: preparation.intent,
          intentDigest: preparation.intentDigest,
          state: "VALIDATED",
          decision: preparation.receipt.signedDecision,
          checks: preparation.receipt.evaluation.checks,
          auditEventId: preparation.receipt.auditEvent.eventId,
          transactionHash: validated.transactionHash,
          receiptId: issued.document.receipt.receiptId,
          receiptHash: issued.document.receipt.receiptHash,
          ...(issued.link ? { receiptLinkDigest: issued.link.linkDigest } : {}),
          display: { instruction: preparation.instruction, payeeName: preparation.payeeName, allocationName: preparation.allocationName },
        });
        payments = [payment, ...payments];
        await savePayments(paymentStore, payments);
        agentPreparations.delete(body.authorizationId);
        return json(response, 201, { payment, message: `${preparation.payeeName} was paid ${preparation.intent.amount} XRP. XRPL validated the transaction in ledger ${validated.ledgerIndex}.` });
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
  intents.registerOrganization({ contractVersion: "1.0", organizationId, displayName: "XRPL Wallet Workspace", status: "active", createdAt: "2026-01-01T00:00:00.000Z" });
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

function workspacePaymentPolicy() {
  return {
    policyVersion: "policy_workspace_testnet_2026",
    organizationId,
    status: "published" as const,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    allowedPurposeCodes: ["workspace-payment"],
    allowedAssets: ["XRP"],
    maxPaymentAmount: "5000",
    reserveFloor: "1",
    requiredEvidenceByPurpose: {},
    approvalRules: [],
    beneficiaryChangeCoolingPeriodHours: 0,
    velocity: { maxPaymentCount24Hours: 20, maxPaymentAmount24Hours: "20000" },
    risk: { reviewAtScore: 60, denyAtScore: 85 },
    decisionTtlSeconds: 300,
  };
}

function workspaceEvaluationContext(intent: PaymentIntent, validatedBalance: string, beneficiaryCreatedAt: string) {
  return {
    now: now(),
    availableTreasuryBalance: validatedBalance,
    availableAllocationBalance: validatedBalance,
    beneficiary: { beneficiaryId: intent.beneficiaryId, walletVersion: 1, status: "approved" as const, lastWalletChangeAt: validTimestamp(beneficiaryCreatedAt) ? beneficiaryCreatedAt : "2026-01-01T00:00:00.000Z" },
    evidence: { manifestHash: intent.evidenceManifestHash, evidenceTypes: [], duplicateStatus: "clear" as const, procurementStatus: "verified" as const, integrityStatus: "verified" as const },
    approvals: [],
    recentPayments: [],
    seenIntentDigests: [],
    riskScore: 12,
    securityDependencies: { policyStore: "available" as const, beneficiaryRegistry: "available" as const, evidenceStore: "available" as const, riskEngine: "available" as const },
  };
}

function parseAgentPaymentRequest(value: unknown): AgentPaymentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Agent payment instruction is required.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["message", "sourceAccount", "registry"].includes(key)) || typeof record.message !== "string" || (record.sourceAccount !== undefined && typeof record.sourceAccount !== "string") || !record.registry || typeof record.registry !== "object" || Array.isArray(record.registry)) throw new TypeError("Agent payment instruction is invalid.");
  const message = record.message.trim().replace(/\s+/g, " ");
  if (!message || message.length > 500) throw new TypeError("Agent instruction must be between 1 and 500 characters.");
  const sourceAccount = typeof record.sourceAccount === "string" ? record.sourceAccount : undefined;
  if (sourceAccount !== undefined && !isValidClassicAddress(sourceAccount)) throw new TypeError("The selected XRPL Testnet allocation wallet is invalid.");
  const registry = record.registry as Record<string, unknown>;
  if (Object.keys(registry).some((key) => !["allocations", "payees"].includes(key)) || !Array.isArray(registry.allocations) || !Array.isArray(registry.payees) || registry.allocations.length > 100 || registry.payees.length > 250) throw new TypeError("Workspace payment registry is invalid.");
  const allocations = registry.allocations.map(parseWorkspaceAllocation);
  const payees = registry.payees.map(parseWorkspacePayee);
  if (!allocations.length) throw new TypeError("Create and connect at least one allocation wallet before asking Alloc-X to pay.");
  if (!payees.length) throw new TypeError("Register the intended payee before asking Alloc-X to pay.");
  return { message, ...(sourceAccount ? { sourceAccount } : {}), registry: { allocations, payees } };
}

function parseWorkspaceAllocation(value: unknown): WorkspaceAllocationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Workspace allocation is invalid.");
  const record = value as Record<string, unknown>;
  const allocationId = boundedText(record.allocationId, 100, "Allocation identifier");
  const name = boundedText(record.name, 80, "Allocation name");
  const walletAddress = typeof record.walletAddress === "string" ? record.walletAddress.trim() : "";
  if (walletAddress && !isValidClassicAddress(walletAddress)) throw new TypeError(`${name} has an invalid XRPL address.`);
  return { allocationId, name, category: optionalText(record.category, 60), purpose: optionalText(record.purpose, 240), spendingRule: optionalText(record.spendingRule, 240), walletAddress };
}

function parseWorkspacePayee(value: unknown): WorkspacePayeeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Workspace payee is invalid.");
  const record = value as Record<string, unknown>;
  const name = boundedText(record.name, 100, "Payee name");
  const walletAddress = boundedText(record.walletAddress, 80, "Payee wallet");
  if (!isValidClassicAddress(walletAddress)) throw new TypeError(`${name} has an invalid XRPL address.`);
  const status = optionalText(record.status, 40);
  if (status !== "ADDRESS_CHECKED") throw new TypeError(`${name}'s XRPL address must pass checksum validation before payment.`);
  return { payeeId: boundedText(record.payeeId, 100, "Payee identifier"), name, type: optionalText(record.type, 20), role: optionalText(record.role, 120), walletAddress, status, createdAt: optionalText(record.createdAt, 40) };
}

function resolveAgentPayment(input: AgentPaymentRequest) {
  const amountMatches = [...input.message.matchAll(/\b(\d+(?:\.\d{1,6})?)\s*xrp\b/giu)];
  if (amountMatches.length !== 1) throw new TypeError("State one XRP amount, for example: pay Goodwill Clinic 200 XRP.");
  const amount = amountMatches[0]![1]!;
  const amountDrops = xrpAmountToDrops(amount);
  if (BigInt(amountDrops) <= 0n) throw new TypeError("Payment amount must be greater than zero.");
  const normalized = normalizeWords(input.message);
  const payeeMatches = input.registry.payees.filter((payee) => normalized.includes(normalizeWords(payee.name))).sort((left, right) => right.name.length - left.name.length);
  if (!payeeMatches.length) throw new TypeError("Name one registered payee exactly as it appears in the Payees section.");
  if (payeeMatches.length > 1 && payeeMatches[0]!.name.length === payeeMatches[1]!.name.length) throw new TypeError("The instruction matches more than one payee. Use the complete registered name.");
  const payee = payeeMatches[0]!;
  const linked = input.registry.allocations.filter((allocation) => allocation.walletAddress);
  if (!linked.length) throw new TypeError("Connect an XRPL Testnet wallet to an allocation before asking Alloc-X to pay.");
  const contextTokens = meaningfulTokens(`${input.message} ${payee.name} ${payee.role}`);
  const ranked = linked.map((allocation) => ({ allocation, score: [...meaningfulTokens(`${allocation.name} ${allocation.category} ${allocation.purpose} ${allocation.spendingRule}`)].filter((token) => contextTokens.has(token)).length })).sort((left, right) => right.score - left.score || left.allocation.name.localeCompare(right.allocation.name));
  const top = ranked[0]!;
  const matchingSource = input.sourceAccount ? linked.filter((allocation) => allocation.walletAddress === input.sourceAccount) : [];
  let allocation: WorkspaceAllocationInput;
  if (top.score > 0 && (ranked.length === 1 || top.score > ranked[1]!.score)) allocation = top.allocation;
  else if (matchingSource.length === 1) allocation = matchingSource[0]!;
  else throw new TypeError("Mention the allocation name or purpose so Alloc-X can select one funding source safely.");
  if (input.sourceAccount && allocation.walletAddress !== input.sourceAccount) throw new TypeError(`Alloc-X selected ${allocation.name}; the requested source does not match that allocation.`);
  if (payee.walletAddress === allocation.walletAddress) throw new TypeError("The selected allocation wallet cannot pay itself.");
  return {
    amount,
    amountDrops,
    payee,
    allocation,
    beneficiaryId: stableIdentifier("ben", payee.payeeId),
    allocationId: stableIdentifier("alloc", allocation.allocationId),
  };
}

function parseAgentPaymentCompletion(value: unknown): { readonly authorizationId: string; readonly transactionHash?: string; readonly signedTransactionBlob?: string; readonly authorization: { readonly token: string; readonly signature: string; readonly keyId: string } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Payment completion is required.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["authorizationId", "transactionHash", "signedTransactionBlob", "authorization"].includes(key)) || typeof record.authorizationId !== "string" || !/^authorization_[a-f0-9]{32}$/u.test(record.authorizationId) || !record.authorization || typeof record.authorization !== "object" || Array.isArray(record.authorization)) throw new TypeError("Payment completion is invalid.");
  const transactionHash = typeof record.transactionHash === "string" && /^[A-F0-9]{64}$/u.test(record.transactionHash) ? record.transactionHash : undefined;
  const signedTransactionBlob = typeof record.signedTransactionBlob === "string" && /^[A-F0-9]{128,32768}$/u.test(record.signedTransactionBlob) ? record.signedTransactionBlob : undefined;
  if ((transactionHash ? 1 : 0) + (signedTransactionBlob ? 1 : 0) !== 1) throw new TypeError("Provide either one validated transaction hash or one signed XRPL transaction blob.");
  const authorization = record.authorization as Record<string, unknown>;
  if (Object.keys(authorization).some((key) => !["token", "signature", "keyId"].includes(key)) || typeof authorization.token !== "string" || authorization.token.length > 24_000 || typeof authorization.signature !== "string" || typeof authorization.keyId !== "string") throw new TypeError("Signed payment authorization is invalid.");
  return { authorizationId: record.authorizationId, ...(transactionHash ? { transactionHash } : {}), ...(signedTransactionBlob ? { signedTransactionBlob } : {}), authorization: { token: authorization.token, signature: authorization.signature, keyId: authorization.keyId } };
}

function restoreAgentPreparation(authorization: { readonly token: string; readonly signature: string; readonly keyId: string }, verifier: { readonly keyId: string; verify(payload: string, signature: string): boolean }): AgentPaymentPreparation {
  if (authorization.keyId !== verifier.keyId || !verifier.verify(authorization.token, authorization.signature)) throw new TypeError("Payment authorization signature is invalid.");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(authorization.token, "base64url").toString("utf8")); }
  catch { throw new TypeError("Payment authorization payload is invalid."); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError("Payment authorization payload is invalid.");
  const preparation = decoded as AgentPaymentPreparation;
  if (!/^authorization_[a-f0-9]{32}$/u.test(preparation.authorizationId) || typeof preparation.instruction !== "string" || typeof preparation.payeeName !== "string" || typeof preparation.allocationName !== "string" || !validTimestamp(preparation.expiresAt) || Date.parse(preparation.expiresAt) <= Date.now()) throw new TypeError("Payment authorization expired or is invalid. Ask Alloc-X to prepare the payment again.");
  const intent = parsePaymentIntent(preparation.intent);
  if (paymentIntentDigest(intent) !== preparation.intentDigest || !preparation.prepared || preparation.prepared.intentId !== intent.intentId || preparation.prepared.intentDigest !== preparation.intentDigest || !preparation.prepared.transaction || typeof preparation.prepared.transaction !== "object" || !preparation.receipt?.signedDecision) throw new TypeError("Payment authorization is not bound to a valid payment intent.");
  return Object.freeze({ ...preparation, intent });
}

function stableIdentifier(prefix: "ben" | "alloc", value: string): string { return `${prefix}_${sha256Digest({ value } as CanonicalValue).slice(7, 31)}`; }
function boundedText(value: unknown, maximum: number, label: string): string { if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new TypeError(`${label} is invalid.`); return value.trim().replace(/\s+/g, " "); }
function optionalText(value: unknown, maximum: number): string { return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximum) : ""; }
function normalizeWords(value: string): string { return ` ${value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, " ").trim()} `; }
function meaningfulTokens(value: string): Set<string> { const ignored = new Set(["alloc", "allocation", "grant", "payment", "pay", "send", "from", "with", "only", "approved", "supplier", "suppliers", "wallet", "xrp", "now", "and", "the", "for"]); return new Set(normalizeWords(value).trim().split(/\s+/u).filter((word) => word.length >= 4 && !ignored.has(word))); }
function compactAddress(value: string): string { return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function validTimestamp(value: string): boolean { return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)); }

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

async function prepareAgentTestnetPayment(input: { readonly intentId: string; readonly intentDigest: string; readonly organizationId: string; readonly account: string; readonly destination: string; readonly amountXrp: string; readonly mode: "sequence" }): Promise<PreparedAgentPayment> {
  if (!isValidClassicAddress(input.account) || !isValidClassicAddress(input.destination) || input.account === input.destination) throw new TypeError("XRPL payment accounts are invalid.");
  const [serverInfo, accountInfo, feeInfo] = await Promise.all([
    xrplTestnetRpc("server_info", []),
    xrplTestnetRpc("account_info", [{ account: input.account, ledger_index: "validated" }]),
    xrplTestnetRpc("fee", []),
  ]);
  const info = serverInfo.info as Record<string, unknown> | undefined;
  const networkId = info?.network_id;
  const validatedLedger = info?.validated_ledger as Record<string, unknown> | undefined;
  const ledgerIndex = validatedLedger?.seq;
  const accountData = accountInfo.account_data as Record<string, unknown> | undefined;
  const sequence = accountData?.Sequence;
  const drops = feeInfo.drops as Record<string, unknown> | undefined;
  const fee = drops?.open_ledger_fee;
  if (networkId !== 1 || !Number.isSafeInteger(ledgerIndex) || !Number.isSafeInteger(sequence) || typeof fee !== "string" || !/^\d+$/u.test(fee) || BigInt(fee) > 1000n) throw new Error("XRPL Testnet did not return safe transaction preparation values.");
  const transaction = Object.freeze({ TransactionType: "Payment", Account: input.account, Destination: input.destination, Amount: xrpAmountToDrops(input.amountXrp), Fee: fee, Sequence: sequence, LastLedgerSequence: Number(ledgerIndex) + 20 });
  return Object.freeze({ network: "testnet", networkId: 1, intentId: input.intentId, intentDigest: input.intentDigest, organizationId: input.organizationId, transaction, preparedAtLedgerIndex: Number(ledgerIndex) });
}

async function xrplTestnetRpc(method: string, params: readonly unknown[]): Promise<Record<string, unknown>> {
  const response = await fetch(testnetJsonRpcEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(9_000) });
  if (!response.ok) throw new Error("XRPL Testnet transaction preparation failed.");
  const payload = await response.json() as { result?: Record<string, unknown> };
  if (!payload.result || payload.result.status === "error" || typeof payload.result.error === "string") throw new Error(`XRPL Testnet rejected ${method}.`);
  return payload.result;
}

async function submitSignedTestnetPayment(signedTransactionBlob: string): Promise<string> {
  const result = await xrplTestnetRpc("submit", [{ tx_blob: signedTransactionBlob, fail_hard: true }]);
  const engineResult = result.engine_result;
  if (engineResult !== "tesSUCCESS" && engineResult !== "terQUEUED") throw new TypeError(`XRPL Testnet rejected the signed payment with ${String(engineResult ?? "an unknown result")}.`);
  const transaction = result.tx_json as Record<string, unknown> | undefined;
  const transactionHash = transaction?.hash;
  if (typeof transactionHash !== "string" || !/^[A-F0-9]{64}$/u.test(transactionHash)) throw new Error("XRPL Testnet did not return a transaction hash for the signed payment.");
  return transactionHash;
}

function assertSignedTransactionMatches(prepared: Readonly<Record<string, unknown>>, signedTransactionBlob: string): void {
  let signed: Record<string, unknown>;
  try { signed = decodeXrplTransaction(signedTransactionBlob) as Record<string, unknown>; }
  catch { throw new TypeError("The signed XRPL transaction could not be decoded."); }
  const allowedFields = new Set([...Object.keys(prepared), "SigningPubKey", "TxnSignature"]);
  if (Object.keys(signed).some((field) => !allowedFields.has(field))) throw new TypeError("The signed XRPL transaction contains fields that were not authorized by the Approval Layer.");
  for (const [field, value] of Object.entries(prepared)) if (signed[field] !== value) throw new TypeError(`The signed XRPL transaction changed protected field ${field}.`);
  if (typeof signed.SigningPubKey !== "string" || !/^[A-F0-9]{66}$/u.test(signed.SigningPubKey) || typeof signed.TxnSignature !== "string" || !/^[A-F0-9]+$/u.test(signed.TxnSignature)) throw new TypeError("The XRPL transaction is not signed by one allocation key.");
}

function xrpAmountToDrops(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value)) throw new TypeError("XRP amount is invalid.");
  const [whole = "0", fraction = ""] = value.split(".");
  const drops = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (drops <= 0n) throw new TypeError("XRP amount must be greater than zero.");
  return drops.toString();
}

function isValidClassicAddress(value: string): boolean {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/u.test(value)) return false;
  const alphabet = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
  let number = 0n;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) return false;
    number = number * 58n + BigInt(index);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const decoded = hex ? Buffer.from(hex, "hex") : Buffer.alloc(0);
  let leading = 0;
  while (leading < value.length && value[leading] === alphabet[0]) leading += 1;
  const bytes = Buffer.concat([Buffer.alloc(leading), decoded]);
  if (bytes.length !== 25 || bytes[0] !== 0) return false;
  const payload = bytes.subarray(0, 21);
  const checksum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  return checksum.equals(bytes.subarray(21));
}

async function readValidatedTestnetPayment(transactionHash: string): Promise<ValidatedTestnetPayment> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const response = await fetch(testnetJsonRpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "tx", params: [{ transaction: transactionHash, binary: false }] }),
      signal: AbortSignal.timeout(9_000),
    });
    if (!response.ok) throw new Error("XRPL Testnet transaction lookup failed.");
    const payload = await response.json() as { result?: Record<string, unknown> };
    const result = payload.result;
    if (result?.validated === true) {
      const transaction = (result.tx_json && typeof result.tx_json === "object" ? result.tx_json : result) as Record<string, unknown>;
      const meta = result.meta as Record<string, unknown> | undefined;
      if (meta?.TransactionResult !== "tesSUCCESS") throw new TypeError(`XRPL validated the transaction with ${String(meta?.TransactionResult ?? "an unknown result")}.`);
      const account = transaction.Account;
      const destination = transaction.Destination;
      const amountDrops = transaction.Amount;
      const ledgerIndex = result.ledger_index;
      if (typeof account !== "string" || typeof destination !== "string" || typeof amountDrops !== "string" || !Number.isSafeInteger(ledgerIndex)) throw new Error("XRPL returned incomplete validated payment data.");
      return { transactionHash, account, destination, amountDrops, ledgerIndex: ledgerIndex as number, validatedAt: now(), resultCode: "tesSUCCESS" };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
  }
  throw new TypeError("XRPL did not validate the transaction before the confirmation deadline. Use the transaction hash to verify it before retrying.");
}

function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(body)); }
function now(): string { return new Date().toISOString(); }
function isClientError(message: string): boolean { return /required|invalid|unsupported|not found|eligible|active|capacity|balance|live|selection|authenticated|must|frozen|pending|independent|escalation|awaiting|expired|wallet|payee|allocation|instruction|Approval Layer|transcript changed|already been confirmed|no longer current/i.test(message); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const server = await createConsoleServer();
  server.listen(Number(process.env.PORT ?? 4173), "127.0.0.1");
}
