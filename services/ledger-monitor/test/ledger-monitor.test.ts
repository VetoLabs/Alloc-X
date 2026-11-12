import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileLedgerMonitorStore, InMemoryLedgerMonitorStore, LedgerMonitor, XrplReadOnlyLedgerSource, type ReadOnlyLedgerSource, type ValidatedTreasuryTransaction, type XrplReadClient } from "../src/index.ts";

const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const destination = "r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV";
const hash = "A".repeat(64);
const now = "2026-11-07T13:00:00.000Z";

class Source implements ReadOnlyLedgerSource {
  pages: { transactions: readonly ValidatedTreasuryTransaction[]; cursor?: string }[] = [];
  calls = 0;
  async readValidatedPayments(): Promise<{ transactions: readonly ValidatedTreasuryTransaction[]; cursor?: string }> { return this.pages[this.calls++] ?? { transactions: [] }; }
}
function transaction(overrides: Partial<ValidatedTreasuryTransaction> = {}): ValidatedTreasuryTransaction { return { transactionHash: hash, ledgerIndex: 100, account, destination, amountDrops: "1000000", resultCode: "tesSUCCESS", validatedAt: now, ...overrides }; }
function expected(transactionHash = hash) { return { jobId: "job_016", organizationId: "org_acme", reservationId: "res_016", transactionHash, account, destination, amountDrops: "1000000" }; }

test("reconciles an expected validated outflow once and finalizes accounting before marking it seen", async () => {
  const source = new Source(); source.pages = [{ transactions: [transaction()], cursor: "100" }, { transactions: [transaction()] }];
  const finalized: string[] = [];
  const store = new InMemoryLedgerMonitorStore();
  const monitor = new LedgerMonitor({ source, store, accounting: { settle: ({ reservationId, transactionHash }) => { finalized.push(`${reservationId}:${transactionHash}`); } } });
  await monitor.registerExpectedSettlement(expected());
  assert.equal((await monitor.poll({ account, now })).reconciled.length, 1);
  assert.equal((await monitor.poll({ account, now })).reconciled.length, 0);
  assert.deepEqual(finalized, [`res_016:${hash}`]);
  assert.equal(store.reconciliations().length, 1);
});

test("raises an independent alert for unknown or mismatched treasury outflows", async () => {
  const source = new Source(); source.pages = [{ transactions: [transaction({ transactionHash: "B".repeat(64) })] }];
  const monitor = new LedgerMonitor({ source, store: new InMemoryLedgerMonitorStore() });
  const result = await monitor.poll({ account, now });
  assert.equal(result.alerts[0].code, "UNKNOWN_TREASURY_OUTFLOW");
});

test("does not advance a monitor after a temporary source failure, then catches up without duplicate reconciliation", async () => {
  let fail = true;
  const source: ReadOnlyLedgerSource = { async readValidatedPayments() { if (fail) { fail = false; throw new Error("Temporary outage"); } return { transactions: [transaction()], cursor: "101" }; } };
  const store = new InMemoryLedgerMonitorStore(); const monitor = new LedgerMonitor({ source, store });
  await monitor.registerExpectedSettlement(expected());
  await assert.rejects(() => monitor.poll({ account, now }));
  const recovered = await monitor.poll({ account, now });
  assert.equal(recovered.reconciled.length, 1); assert.equal(store.cursor(account), "101");
});

test("restores expected settlement, observed transaction, and cursor after a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alloc-x-ledger-monitor-")); const path = join(directory, "monitor.jsonl");
  const firstSource = new Source(); firstSource.pages = [{ transactions: [transaction()], cursor: "102" }];
  const firstStore = new FileLedgerMonitorStore(path); const first = new LedgerMonitor({ source: firstSource, store: firstStore });
  await first.registerExpectedSettlement(expected()); await first.poll({ account, now });
  const secondSource = new Source(); secondSource.pages = [{ transactions: [transaction()], cursor: "103" }];
  const secondStore = new FileLedgerMonitorStore(path); const second = new LedgerMonitor({ source: secondSource, store: secondStore });
  assert.equal((await second.poll({ account, now })).reconciled.length, 0);
  assert.equal((await secondStore.reconciliations()).length, 1);
  assert.equal((await secondStore.verifyIntegrity()).valid, true);
});

test("fails closed when the durable monitor journal is changed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alloc-x-ledger-monitor-")); const path = join(directory, "monitor.jsonl");
  const store = new FileLedgerMonitorStore(path);
  await store.registerExpected(expected());
  await writeFile(path, `${(await readFile(path, "utf8")).replace("org_acme", "org_other")}`);
  await assert.rejects(() => store.expected(hash), /integrity/);
});

test("XRPL source accepts only validated successful native payments from its configured network", async () => {
  const requests: Record<string, unknown>[] = [];
  const client: XrplReadClient = { connect: async () => undefined, disconnect: async () => undefined, request: async (request) => { requests.push(request); if (request.command === "server_info") return { result: { info: { network_id: 1 } } }; return { result: { validated: true, transactions: [{ validated: true, tx_json: { TransactionType: "Payment", Account: account, Destination: destination, DeliverMax: "1000000", date: 847_371_600 }, hash, meta: { TransactionResult: "tesSUCCESS" }, ledger_index: 123 }, { validated: true, tx: { TransactionType: "Payment", Account: account, Destination: destination, Amount: { currency: "USD" }, hash: "B".repeat(64), date: 847_371_600 }, meta: { TransactionResult: "tesSUCCESS" }, ledger_index: 124 }] } }; } };
  const source = new XrplReadOnlyLedgerSource({ endpoint: "wss://example.test", expectedNetworkId: 1, clientFactory: () => client });
  const page = await source.readValidatedPayments({ account });
  assert.equal(page.transactions.length, 1); assert.equal(page.transactions[0].ledgerIndex, 123);
  assert.deepEqual(requests.map((request) => request.command), ["server_info", "account_tx"]);
});
