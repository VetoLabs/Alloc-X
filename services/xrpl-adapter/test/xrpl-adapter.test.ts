import assert from "node:assert/strict";
import test from "node:test";

import { XrplAdapter, XrplAdapterError, type XrplClientLike, type XrplCodec } from "../src/index.ts";

const hash = "A".repeat(64);
const codec: XrplCodec = {
  xrpToDrops: (amount) => amount === "2.5" ? "2500000" : "0",
  isValidXRPAmount: (amount) => amount === "2.5",
  validate: () => undefined,
  encode: () => "DEADBEEF",
};

class FakeClient implements XrplClientLike {
  connected = false;
  disconnected = false;
  readonly networkId: number;
  readonly fee: string;
  readonly resultCode: string;
  signerCount?: number;
  constructor(options: { readonly networkId?: number; readonly fee?: string; readonly resultCode?: string } = {}) { this.networkId = options.networkId ?? 1; this.fee = options.fee ?? "12"; this.resultCode = options.resultCode ?? "tesSUCCESS"; }
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.disconnected = true; }
  async request(request: Record<string, unknown>): Promise<unknown> {
    if (request.command === "server_info") return { result: { info: { network_id: this.networkId, validated_ledger: { seq: 500 } } } };
    if (request.command === "account_info") return { result: { account_data: { Balance: "25000000", Sequence: 8, OwnerCount: 1 } } };
    if (request.command === "tx") return { result: { validated: true, hash, ledger_index: 502, meta: { TransactionResult: this.resultCode } } };
    throw new Error("Unexpected XRPL request");
  }
  async autofill(transaction: Record<string, unknown>, signerCount?: number): Promise<Record<string, unknown>> { this.signerCount = signerCount; return { ...transaction, Fee: this.fee, Sequence: transaction.Sequence ?? 8, LastLedgerSequence: 506 }; }
  async submit(): Promise<unknown> { return { result: { engine_result: "tesSUCCESS", tx_json: { hash } } }; }
}

function adapter(client: FakeClient) {
  return new XrplAdapter({ endpoint: "wss://s.altnet.rippletest.net:51233", network: "testnet", expectedNetworkId: 1, maxFeeDrops: "20", minimumLastLedgerOffset: 4, maximumLastLedgerOffset: 20, clientFactory: () => client, codec });
}
function input() { return { intentId: "pi_payment_001", intentDigest: `sha256:${"a".repeat(64)}`, organizationId: "org_meridian", account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", destination: "r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV", amountXrp: "2.5", mode: "sequence" as const }; }

test("reads validated account state and prepares a bounded serialized native payment", async () => {
  const client = new FakeClient(); const subject = adapter(client);
  const account = await subject.accountState(input().account);
  assert.deepEqual(account, { address: input().account, balanceDrops: "25000000", sequence: 8, ownerCount: 1, validatedLedgerIndex: 500 });
  const prepared = await subject.prepareNativePayment(input());
  assert.equal(prepared.transaction.Amount, "2500000");
  assert.equal(prepared.transaction.Fee, "12");
  assert.equal(prepared.transaction.LastLedgerSequence, 506);
  assert.equal(prepared.serializedTransaction, "DEADBEEF");
  assert.equal(client.signerCount, 2);
  assert.equal(client.disconnected, true);
});

test("rejects a wrong network, excessive fee, and unsafe ledger expiry before signing", async () => {
  await assert.rejects(() => adapter(new FakeClient({ networkId: 0 })).prepareNativePayment(input()), (error: unknown) => error instanceof XrplAdapterError && error.code === "NETWORK_MISMATCH");
  await assert.rejects(() => adapter(new FakeClient({ fee: "21" })).prepareNativePayment(input()), (error: unknown) => error instanceof XrplAdapterError && error.code === "FEE_LIMIT_EXCEEDED");
});

test("submits only a signed blob and confirms validated ledger success", async () => {
  const subject = adapter(new FakeClient()); const prepared = await subject.prepareNativePayment(input());
  const validated = await subject.submitSignedPayment({ prepared, signedTransactionBlob: "ABCDEF" });
  assert.deepEqual(validated, { transactionHash: hash, ledgerIndex: 502, validatedAt: validated.validatedAt, resultCode: "tesSUCCESS" });
  await assert.rejects(() => subject.submitSignedPayment({ prepared, signedTransactionBlob: "not-a-blob" }), (error: unknown) => error instanceof XrplAdapterError && error.code === "INVALID_TRANSACTION");
  const rejected = adapter(new FakeClient({ resultCode: "tecPATH_DRY" })); const rejectedPrepared = await rejected.prepareNativePayment(input());
  await assert.rejects(() => rejected.submitSignedPayment({ prepared: rejectedPrepared, signedTransactionBlob: "ABCDEF" }), (error: unknown) => error instanceof XrplAdapterError && error.code === "VALIDATION_FAILED");
});

test("looks up a validated transaction for crash recovery before replaying a submission", async () => {
  const subject = adapter(new FakeClient());
  const recovered = await subject.lookupValidatedPayment(hash);
  assert.equal(recovered?.transactionHash, hash);
  await assert.rejects(() => subject.lookupValidatedPayment("invalid"), (error: unknown) => error instanceof XrplAdapterError && error.code === "INVALID_TRANSACTION");
});

test("requires a live independent activation gate before using XRPL Mainnet", async () => {
  const client = new FakeClient({ networkId: 0 });
  assert.throws(() => new XrplAdapter({ endpoint: "wss://primary.example.org", network: "mainnet", expectedNetworkId: 0, maxFeeDrops: "20", minimumLastLedgerOffset: 4, maximumLastLedgerOffset: 20, clientFactory: () => client, codec }), /activation gate/i);
  let checks = 0;
  const subject = new XrplAdapter({ endpoint: "wss://primary.example.org", network: "mainnet", expectedNetworkId: 0, maxFeeDrops: "20", minimumLastLedgerOffset: 4, maximumLastLedgerOffset: 20, mainnetGate: { assertAdapterEnabled(value) { checks += 1; assert.equal(value.networkId, 0); } }, clientFactory: () => client, codec });
  const prepared = await subject.prepareNativePayment(input());
  assert.equal(prepared.network, "mainnet");
  assert.equal(prepared.networkId, 0);
  assert.equal(checks, 1);
});
