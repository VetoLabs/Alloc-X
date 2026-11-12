import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConsoleServer } from "../server.ts";

test("console exposes server-owned payment references and records a signed decision", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "alloc-x-console-"));
  const testnetAddress = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
  const server = await createConsoleServer({ runtimeDirectory, testnetAccountReader: async (account) => ({ account, balanceDrops: "24500000", balanceXrp: "24.5", ledgerIndex: 987654, observedAt: "2026-11-11T17:00:00.000Z" }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const bootstrap = await (await fetch(`${baseUrl}/api/bootstrap`)).json() as { paymentReferences: { obligations: readonly { obligationId: string; beneficiaryId: string }[]; allocations: readonly { allocationId: string }[] }; capabilities: { canSettle: boolean }; cashForecast: { assumptions: readonly string[]; scenarios: readonly { scenario: string; endingSpendable: string }[] }; operations: { health: string; metrics: readonly unknown[]; alerts: readonly unknown[] }; mainnetActivation: { phase: string; allowed: boolean; blockers: readonly string[] }; offlineTrust: { status: string; synchronizationAllowed: boolean; pendingOperations: number }; offlineWorkflows: { connectivity: string; preparedPayments: number; capability: string }; offlineSynchronization: { status: string; serverOrderedOperations: number; openConflicts: number }; offlineRevalidation: { status: string; signingEligible: number }; organizationCapabilities: { organizationType: string; policyPack: string; status: string }; commercialPolicyPack: { status: string; departmentBudgets: number }; nonprofitPolicyPack: { status: string; programAllocations: number }; publicSectorPolicyPack: { status: string; appropriations: number } };
    assert.equal(bootstrap.capabilities.canSettle, false);
    assert.equal(bootstrap.paymentReferences.obligations.length, 2);
    assert.equal(bootstrap.cashForecast.scenarios.length, 3);
    assert.equal(bootstrap.cashForecast.scenarios[1]!.scenario, "expected");
    assert.match(bootstrap.cashForecast.assumptions[0]!, /cannot alter authoritative/i);
    assert.equal(bootstrap.operations.health, "HEALTHY");
    assert.equal(bootstrap.operations.metrics.length, 9);
    assert.equal(bootstrap.mainnetActivation.phase, "BLOCKED");
    assert.equal(bootstrap.mainnetActivation.allowed, false);
    assert.ok(bootstrap.mainnetActivation.blockers.includes("INDEPENDENT_ASSESSMENT_INCOMPLETE"));
    assert.equal(bootstrap.offlineTrust.status, "NOT_ENROLLED");
    assert.equal(bootstrap.offlineTrust.synchronizationAllowed, false);
    assert.equal(bootstrap.offlineTrust.pendingOperations, 0);
    assert.equal(bootstrap.offlineWorkflows.connectivity, "ONLINE");
    assert.equal(bootstrap.offlineWorkflows.preparedPayments, 0);
    assert.equal(bootstrap.offlineWorkflows.capability, "DEVICE_ENROLLMENT_REQUIRED");
    assert.equal(bootstrap.offlineSynchronization.status, "NO_ENROLLED_DEVICE");
    assert.equal(bootstrap.offlineSynchronization.openConflicts, 0);
    assert.equal(bootstrap.offlineRevalidation.status, "ONLINE_REVALIDATION_REQUIRED");
    assert.equal(bootstrap.offlineRevalidation.signingEligible, 0);
    assert.equal(bootstrap.organizationCapabilities.organizationType, "nonprofit");
    assert.equal(bootstrap.organizationCapabilities.status, "CONFIGURATION_REQUIRED");
    assert.equal(bootstrap.commercialPolicyPack.status, "NOT_CONFIGURED");
    assert.equal(bootstrap.nonprofitPolicyPack.status, "NOT_CONFIGURED");
    assert.equal(bootstrap.publicSectorPolicyPack.status, "NOT_CONFIGURED");
    const beneficiaryResponse = await fetch(`${baseUrl}/api/beneficiaries`);
    assert.equal(beneficiaryResponse.status, 200);
    const beneficiaryBody = await beneficiaryResponse.json() as { beneficiaries: readonly { beneficiary: { status: string }; ownership: { status: string } }[] };
    assert.equal(beneficiaryBody.beneficiaries.length, 2);
    assert.equal(beneficiaryBody.beneficiaries[0]!.beneficiary.status, "approved");
    assert.equal(beneficiaryBody.beneficiaries[0]!.ownership.status, "verified");
    const logoResponse = await fetch(`${baseUrl}/alloc-x-logo.svg`);
    assert.equal(logoResponse.status, 200);
    assert.match(logoResponse.headers.get("content-type") ?? "", /^image\/svg\+xml/);

    const sidebarLogoResponse = await fetch(`${baseUrl}/alloc-x-logo.jpg`);
    assert.equal(sidebarLogoResponse.status, 200);
    assert.match(sidebarLogoResponse.headers.get("content-type") ?? "", /^image\/jpeg/);
    const xrplBrowserBundle = await fetch(`${baseUrl}/vendor/xrpl.js`);
    assert.equal(xrplBrowserBundle.status, 200);
    assert.match(xrplBrowserBundle.headers.get("content-type") ?? "", /^text\/javascript/);
    const walletBrowserBundle = await fetch(`${baseUrl}/vendor/xrpl-connect.js`);
    assert.equal(walletBrowserBundle.status, 200);
    assert.match(walletBrowserBundle.headers.get("content-type") ?? "", /^text\/javascript/);
    const walletBalanceResponse = await fetch(`${baseUrl}/api/xrpl/testnet/accounts/${testnetAddress}`);
    assert.equal(walletBalanceResponse.status, 200);
    const walletBalance = await walletBalanceResponse.json() as { account: string; balanceXrp: string; ledgerIndex: number; network: string; validated: boolean };
    assert.deepEqual(walletBalance, { account: testnetAddress, balanceXrp: "24.5", ledgerIndex: 987654, network: "testnet", validated: true, balanceDrops: "24500000", observedAt: "2026-11-11T17:00:00.000Z" });
    const invalidWalletResponse = await fetch(`${baseUrl}/api/xrpl/testnet/accounts/not-an-address`);
    assert.equal(invalidWalletResponse.status, 400);
    const appScript = await (await fetch(`${baseUrl}/app.js`)).text();
    assert.match(appScript, /reducedMotion \? 650 : 1700/);
    assert.doesNotMatch(appScript, /reducedMotion \? 0 : 1700/);
    assert.match(appScript, /new sdk\.MetaMaskSnapAdapter\(\)/);
    assert.match(appScript, /wallets="metamask-snap,crossmark,gemwallet"/);
    assert.match(appScript, /recognition\.continuous = true/);
    assert.match(appScript, /startVoiceSegment\(session\)/);
    assert.match(appScript, /state\.mobileMenuOpen/);
    assert.match(appScript, /data-action="mobile-menu"/);
    assert.doesNotMatch(appScript, /No Testnet treasury connected/);
    assert.doesNotMatch(appScript, /Wallet needs attention/);
    const stylesheet = await (await fetch(`${baseUrl}/styles.css`)).text();
    assert.match(stylesheet, /launch-film\.reduced-motion\{display:grid\}/);
    assert.doesNotMatch(stylesheet, /\.launch-film\{display:none\}/);
    assert.match(stylesheet, /max-width: 1100px/);
    assert.match(stylesheet, /\.shell\.nav-open \.sidebar/);
    assert.match(stylesheet, /\.voice-live-transcript/);
    const first = bootstrap.paymentReferences.obligations[0]!;
    const paymentResponse = await fetch(`${baseUrl}/api/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ obligationId: first.obligationId, allocationId: bootstrap.paymentReferences.allocations[0]!.allocationId, beneficiaryId: first.beneficiaryId }),
    });
    assert.equal(paymentResponse.status, 201, JSON.stringify(await paymentResponse.clone().json()));
    const created = await paymentResponse.json() as { payment: { paymentId: string; receiptId: string; intent: { amount: string; beneficiaryId: string }; decision: { decision: { outcome: string } } } };
    assert.equal(created.payment.intent.amount, "1350");
    assert.equal(created.payment.intent.beneficiaryId, first.beneficiaryId);
    assert.equal(created.payment.decision.decision.outcome, "ALLOW");
    const receipt = await fetch(`${baseUrl}/api/receipts/${created.payment.receiptId}`);
    assert.equal(receipt.status, 200, JSON.stringify(await receipt.clone().json()));
    assert.equal((await receipt.json() as { valid: boolean }).valid, true);
    const recoveryResponse = await fetch(`${baseUrl}/api/payments/${created.payment.paymentId}/recover`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(recoveryResponse.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("console rejects client-supplied economic fields", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "alloc-x-console-"));
  const server = await createConsoleServer({ runtimeDirectory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ obligationId: "obl_clinic_refrigeration", allocationId: "alloc_clinic", beneficiaryId: "ben_medtech", amount: "1" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.match(body.error, /unsupported fields/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("console exposes a bounded allocation agent without settlement authority", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "alloc-x-console-"));
  const server = await createConsoleServer({ runtimeDirectory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${baseUrl}/api/agent/sessions/agent_console_operator/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "pay 1350 XRP to MedTech Supplies for operations-supplies" }),
    });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const body = await response.json() as { session: { state: string; draftIntentId?: string; actions: readonly { name: string }[] }; message: string };
    assert.equal(body.session.state, "DRAFTED");
    assert.ok(body.session.draftIntentId);
    assert.deepEqual(body.session.actions.map((action) => action.name), ["beneficiary.resolve", "policy.explain", "payment.draft"]);
    assert.match(body.message, /not been signed|protected payment workflow/i);
    const payments = await (await fetch(`${baseUrl}/api/payments`)).json() as { payments: readonly unknown[] };
    assert.equal(payments.payments.length, 0, "agent drafting must not create or settle a payment");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("console requires a reviewed voice transcript before it reaches the bounded agent", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "alloc-x-console-"));
  const server = await createConsoleServer({ runtimeDirectory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const transcript = "Alloc-X, pay 1350 XRP to MedTech Supplies for operations-supplies";
  try {
    const preparedResponse = await fetch(`${baseUrl}/api/voice/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "agent_console_operator", transcript, recognition: { engine: "browser-native", locale: "en-NG", confidence: 0.96 } }) });
    assert.equal(preparedResponse.status, 201, JSON.stringify(await preparedResponse.clone().json()));
    const prepared = await preparedResponse.json() as { instruction: { voiceInstructionId: string; state: string } };
    assert.equal(prepared.instruction.state, "PREPARED");
    const untouchedPayments = await (await fetch(`${baseUrl}/api/payments`)).json() as { payments: readonly unknown[] };
    assert.equal(untouchedPayments.payments.length, 0, "preparing a transcript must not create a payment");
    const changed = await fetch(`${baseUrl}/api/voice/instructions/${prepared.instruction.voiceInstructionId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript: "pay 1 XRP to MedTech Supplies for operations-supplies" }) });
    assert.equal(changed.status, 400, "changed transcript must require a new review");
    const confirmed = await fetch(`${baseUrl}/api/voice/instructions/${prepared.instruction.voiceInstructionId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript }) });
    assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.clone().json()));
    const body = await confirmed.json() as { instruction: { state: string }; session: { state: string; draftIntentId?: string } };
    assert.equal(body.instruction.state, "CONFIRMED");
    assert.equal(body.session.state, "DRAFTED");
    assert.ok(body.session.draftIntentId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("console emergency freeze is durable and blocks payment creation before an intent is made", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "alloc-x-console-"));
  const server = await createConsoleServer({ runtimeDirectory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const frozen = await fetch(`${baseUrl}/api/security/freeze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: { kind: "organization" }, reason: "Unexpected payment pattern requires review" }) });
    assert.equal(frozen.status, 201, JSON.stringify(await frozen.clone().json()));
    const freeze = await frozen.json() as { freeze: { freezeId: string; status: string } };
    assert.equal(freeze.freeze.status, "ACTIVE");
    const blocked = await fetch(`${baseUrl}/api/payments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ obligationId: "obl_clinic_refrigeration", allocationId: "alloc_clinic", beneficiaryId: "ben_medtech" }) });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json() as { error: string }).error, /frozen/i);
    const released = await fetch(`${baseUrl}/api/security/freeze/${freeze.freeze.freezeId}/release`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "Independent review completed and release approved" }) });
    assert.equal(released.status, 200, JSON.stringify(await released.clone().json()));
    const controls = await (await fetch(`${baseUrl}/api/security/controls`)).json() as { controls: { freezes: readonly { status: string }[] } };
    assert.equal(controls.controls.freezes[0]!.status, "RELEASED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
