import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "xrpl";

import { XrplAdapter } from "../src/index.ts";

const shouldRun = process.env.XRPL_RUN_INTEGRATION === "1";
const endpoint = process.env.XRPL_TESTNET_URL ?? "wss://s.altnet.rippletest.net:51233";

test("submits and validates a native XRP payment on the configured non-production XRPL network", { skip: !shouldRun, timeout: 90_000 }, async () => {
  const fundingClient = new Client(endpoint);
  await fundingClient.connect();
  try {
    const sender = (await fundingClient.fundWallet()).wallet;
    const recipient = (await fundingClient.fundWallet()).wallet;
    const adapter = new XrplAdapter({ endpoint, network: "testnet", expectedNetworkId: 1, maxFeeDrops: "200", minimumLastLedgerOffset: 4, maximumLastLedgerOffset: 30 });
    const prepared = await adapter.prepareNativePayment({ intentId: "pi_xrpl_integration_001", intentDigest: `sha256:${"b".repeat(64)}`, organizationId: "org_meridian", account: sender.classicAddress, destination: recipient.classicAddress, amountXrp: "1", mode: "sequence" });
    const signed = sender.sign(prepared.transaction as Parameters<typeof sender.sign>[0]);
    const validated = await adapter.submitSignedPayment({ prepared, signedTransactionBlob: signed.tx_blob });
    assert.equal(validated.resultCode, "tesSUCCESS");
    assert.match(validated.transactionHash, /^[A-F0-9]{64}$/);
  } finally {
    await fundingClient.disconnect();
  }
});
