import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountingConcurrencyError,
  AccountingStateError,
  InMemoryTreasuryAccounting,
  InsufficientTreasuryCapacityError,
} from "../src/index.ts";

const now = "2026-11-07T10:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const transactionHash = "A".repeat(64);

function allocation(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "1.0", allocationId: "alloc_operations", organizationId: "org_acme",
    displayName: "Operations", asset: "XRP", authorizedAmount: "700",
    allowedPurposeCodes: ["operations-supplies"], activeFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z", status: "active", ...overrides,
  };
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    reservationId: "res_001", organizationId: "org_acme", allocationId: "alloc_operations",
    intentId: "pi_001", intentDigest: digest, asset: "XRP", amount: "400", reservedAt: now,
    expiresAt: "2026-11-07T11:00:00.000Z", ...overrides,
  };
}

function accounting() {
  const ledger = new InMemoryTreasuryAccounting();
  ledger.createTreasuryAccount({ organizationId: "org_acme", asset: "XRP", openingAmount: "1000" }, now);
  ledger.registerAllocation(allocation(), now);
  return ledger;
}

test("reserves capacity in both treasury and allocation envelopes using fixed-precision values", () => {
  const ledger = accounting();
  const created = ledger.reserve(reservation({ amount: "400.000000000000000001" }));
  const treasury = ledger.treasurySnapshot("org_acme", "XRP");
  const envelope = ledger.allocationSnapshot("org_acme", "alloc_operations");
  assert.equal(created.status, "active");
  assert.equal(treasury.availableAmount, "599.999999999999999999");
  assert.equal(treasury.committedAmount, "400.000000000000000001");
  assert.equal(envelope.availableAmount, "299.999999999999999999");
  ledger.assertInvariants();
});

test("prevents concurrent reuse of the same capacity and supports idempotent reservation retry", () => {
  const ledger = accounting();
  const first = ledger.reserve(reservation({ expectedTreasuryVersion: 1, expectedAllocationVersion: 1 }));
  const retry = ledger.reserve(reservation({ expectedTreasuryVersion: 1, expectedAllocationVersion: 1 }));
  assert.equal(retry, first);
  assert.throws(() => ledger.reserve(reservation({ reservationId: "res_002", intentId: "pi_002", amount: "400", expectedTreasuryVersion: 1, expectedAllocationVersion: 1 })), AccountingConcurrencyError);
  assert.throws(() => ledger.reserve(reservation({ reservationId: "res_003", intentId: "pi_003", amount: "400" })), InsufficientTreasuryCapacityError);
  assert.equal(ledger.treasurySnapshot("org_acme", "XRP").committedAmount, "400");
  ledger.assertInvariants();
});

test("releases cancelled capacity and expires stale reservations without reducing settled balances", () => {
  const ledger = accounting();
  const active = ledger.reserve(reservation());
  const released = ledger.release({ reservationId: active.reservationId, releasedAt: "2026-11-07T10:05:00.000Z" });
  assert.equal(released.status, "released");
  assert.equal(ledger.treasurySnapshot("org_acme", "XRP").availableAmount, "1000");
  ledger.reserve(reservation({ reservationId: "res_002", intentId: "pi_002", amount: "200", expiresAt: "2026-11-07T10:10:00.000Z" }));
  const expired = ledger.expireReservations("2026-11-07T10:10:00.000Z");
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, "expired");
  assert.equal(ledger.treasurySnapshot("org_acme", "XRP").availableAmount, "1000");
  assert.ok(ledger.journal("org_acme").some((entry) => entry.type === "reservation-expired"));
  ledger.assertInvariants();
});

test("moves only committed capacity into settled balance and settlement is transaction-idempotent", () => {
  const ledger = accounting();
  ledger.reserve(reservation());
  const settled = ledger.settle({ reservationId: "res_001", settledAt: "2026-11-07T10:30:00.000Z", transactionHash });
  const retry = ledger.settle({ reservationId: "res_001", settledAt: "2026-11-07T10:30:00.000Z", transactionHash });
  const treasury = ledger.treasurySnapshot("org_acme", "XRP");
  const envelope = ledger.allocationSnapshot("org_acme", "alloc_operations");
  assert.equal(retry, settled);
  assert.equal(treasury.committedAmount, "0");
  assert.equal(treasury.settledAmount, "400");
  assert.equal(treasury.availableAmount, "600");
  assert.equal(envelope.settledAmount, "400");
  assert.throws(() => ledger.release({ reservationId: "res_001", releasedAt: "2026-11-07T10:31:00.000Z" }), AccountingStateError);
  ledger.assertInvariants();
});

test("enforces allocation and organization boundaries", () => {
  const ledger = accounting();
  assert.throws(() => ledger.allocationSnapshot("org_other", "alloc_operations"), /another organization/);
  assert.throws(() => ledger.reserve(reservation({ organizationId: "org_other" })), /does not match allocation scope/);
  assert.throws(() => ledger.reserve(reservation({ expiresAt: now })), /after reservedAt/);
});
