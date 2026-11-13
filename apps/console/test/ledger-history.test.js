import assert from "node:assert/strict";
import test from "node:test";

import { outgoingNativePayments } from "../public/ledger-history.js";

const source = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const destination = "r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV";
const hash = "A".repeat(64);

test("ledger history keeps only validated successful outgoing native XRP transfers", () => {
  const make = (overrides = {}) => ({
    validated: true, hash, ledger_index: 120, close_time_iso: "2026-11-13T12:00:00Z",
    meta: { TransactionResult: "tesSUCCESS" },
    tx_json: { TransactionType: "Payment", Account: source, Destination: destination, Amount: "20000000" },
    ...overrides,
  });
  const rows = outgoingNativePayments([
    make(),
    make({ validated: false }),
    make({ meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } }),
    make({ tx_json: { TransactionType: "Payment", Account: destination, Destination: source, Amount: "20000000" } }),
    make({ tx_json: { TransactionType: "Payment", Account: source, Destination: destination, Amount: { currency: "USD", value: "20" } } }),
    make({ tx_json: { TransactionType: "OfferCreate", Account: source, Destination: destination, Amount: "20000000" } }),
    make({ hash: "not-a-transaction-hash" }),
  ], source);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { hash, sourceAccount: source, destination, amountXrp: 20, timestamp: "2026-11-13T12:00:00Z", ledgerIndex: 120 });
});

test("ledger history handles API v1 transaction data and timestamp conversion", () => {
  const records = [{ validated: true, ledger_index: 42, meta: { TransactionResult: "tesSUCCESS" }, tx: { TransactionType: "Payment", Account: source, Destination: destination, Amount: "1500000", hash, date: 0 } }];
  const [item] = outgoingNativePayments(records, source);
  assert.equal(item.amountXrp, 1.5);
  assert.equal(item.timestamp, "2000-01-01T00:00:00.000Z");
  assert.equal(outgoingNativePayments(null, source).length, 0);
});
