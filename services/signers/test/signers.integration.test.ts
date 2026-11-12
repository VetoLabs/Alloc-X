import assert from "node:assert/strict";
import test from "node:test";

import { Client, Wallet } from "xrpl";

import { createLocalDevelopmentKeyProvider, createSignerListConfiguration, createSigningEnvelope, IndependentSignerService, signerListSetTransaction, assembleQuorumSignature } from "../src/index.ts";

const shouldRun = process.env.XRPL_RUN_INTEGRATION === "1";
const endpoint = process.env.XRPL_TESTNET_URL ?? "wss://s.altnet.rippletest.net:51233";

test("configures a signer list and validates a 2-of-3 multi-signed testnet payment", { skip: !shouldRun, timeout: 120_000 }, async () => {
  const client = new Client(endpoint, { connectionTimeout: 30_000, timeout: 30_000 }); await client.connect();
  try {
    const treasury = (await client.fundWallet()).wallet; const recipient = (await client.fundWallet()).wallet;
    const executionWallet = Wallet.generate(); const policyWallet = Wallet.generate(); const recoveryWallet = Wallet.generate();
    const configuration = createSignerListConfiguration({ treasuryAccount: treasury.classicAddress, quorum: 2, members: [{ classicAddress: executionWallet.classicAddress, weight: 1, role: "execution" }, { classicAddress: policyWallet.classicAddress, weight: 1, role: "policy" }, { classicAddress: recoveryWallet.classicAddress, weight: 2, role: "recovery" }] });
    const listResult = await client.submitAndWait(signerListSetTransaction(configuration) as Parameters<typeof client.submitAndWait>[0], { wallet: treasury, autofill: true });
    assert.equal((listResult.result.meta as { TransactionResult: string }).TransactionResult, "tesSUCCESS");
    // Testnet relays can be slow. Fix a deliberately generous expiry before
    // collecting signatures; production preparation keeps a much tighter bound.
    const currentLedger = await client.getLedgerIndex();
    const prepared = await client.autofill({ TransactionType: "Payment", Account: treasury.classicAddress, Destination: recipient.classicAddress, Amount: "1000000", SigningPubKey: "", LastLedgerSequence: currentLedger + 100 }, 2);
    const payment = { network: "testnet" as const, networkId: 1, intentId: "pi_multisign_001", intentDigest: `sha256:${"c".repeat(64)}`, organizationId: "org_meridian", transaction: prepared, serializedTransaction: "DEADBEEF", preparedAtLedgerIndex: currentLedger };
    const envelope = createSigningEnvelope({ prepared: payment, securityDecisionDigest: `sha256:${"d".repeat(64)}`, expiresAt: "2030-01-01T00:00:00.000Z" });
    const integrationExpiryWindow = { minimumLastLedgerOffset: 4, maximumLastLedgerOffset: 120 };
    const execution = new IndependentSignerService({ signerId: "signer_execution_001", role: "execution", keyProvider: createLocalDevelopmentKeyProvider(executionWallet, "local:execution:key-001"), allowedNetworks: { testnet: 1, devnet: 2 }, ...integrationExpiryWindow });
    const policy = new IndependentSignerService({ signerId: "signer_policy_001", role: "policy", keyProvider: createLocalDevelopmentKeyProvider(policyWallet, "local:policy:key-001"), allowedNetworks: { testnet: 1, devnet: 2 }, ...integrationExpiryWindow });
    const now = "2029-12-31T23:00:00.000Z"; const signed = assembleQuorumSignature({ envelope, configuration, signatures: [await execution.sign(envelope, envelope.protectedTransaction, now), await policy.sign(envelope, envelope.protectedTransaction, now)] });
    const submitted = await client.submit(signed, { failHard: true });
    assert.equal(submitted.result.engine_result, "tesSUCCESS");
    assert.match(submitted.result.tx_json.hash, /^[A-F0-9]{64}$/);
    const validated = await waitForValidation(client, submitted.result.tx_json.hash);
    assert.equal((validated.meta as { TransactionResult: string }).TransactionResult, "tesSUCCESS");
  } finally { await client.disconnect(); }
});

async function waitForValidation(client: Client, hash: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await client.request({ command: "tx", transaction: hash });
      if (response.result.validated === true) return response.result as unknown as Record<string, unknown>;
    } catch { /* submitted transactions can be absent until the next validated ledger */ }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Quorum-signed testnet transaction did not validate before the polling deadline.");
}
