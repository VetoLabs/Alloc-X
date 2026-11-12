import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTreasuryAccounting } from "../../accounting/src/index.ts";
import {
  IdempotencyConflictError,
  InMemoryPaymentIntentService,
  IntentStateError,
} from "../src/index.ts";

const now = "2026-11-07T10:00:00.000Z";
const evidenceHash = `sha256:${"a".repeat(64)}`;

function allocation(overrides: Record<string, unknown> = {}) {
  return { contractVersion: "1.0", allocationId: "alloc_operations", organizationId: "org_acme", displayName: "Operations", asset: "XRP", authorizedAmount: "700", allowedPurposeCodes: ["operations-supplies"], activeFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", status: "active", ...overrides };
}
function request(overrides: Record<string, unknown> = {}) {
  return { organizationId: "org_acme", idempotencyKey: "org_acme/invoice-42/v1", sourceObligationId: "obl_001", allocationId: "alloc_operations", beneficiaryId: "ben_vendor_1", policyVersion: "policy_2026_01", requestedExecutionWindow: { notBefore: now, expiresAt: "2026-11-07T11:00:00.000Z" }, createdByPrincipalId: "principal_agent", requestedAt: now, ...overrides };
}
function setup() {
  const accounting = new InMemoryTreasuryAccounting();
  accounting.createTreasuryAccount({ organizationId: "org_acme", asset: "XRP", openingAmount: "1000" }, now);
  accounting.registerAllocation(allocation(), now);
  const service = new InMemoryPaymentIntentService(accounting);
  service.registerOrganization({ contractVersion: "1.0", organizationId: "org_acme", displayName: "Acme", status: "active", createdAt: "2026-01-01T00:00:00.000Z" });
  service.registerPrincipal({ contractVersion: "1.0", principalId: "principal_agent", organizationId: "org_acme", kind: "agent", status: "active", roles: ["allocation-agent"], createdAt: "2026-01-01T00:00:00.000Z" });
  service.registerObligation({ contractVersion: "1.0", obligationId: "obl_001", organizationId: "org_acme", beneficiaryId: "ben_vendor_1", amount: "400", asset: "XRP", purposeCode: "operations-supplies", evidenceManifestHash: evidenceHash, dueAt: "2026-12-01T00:00:00.000Z", status: "open", createdByPrincipalId: "principal_agent", createdAt: "2026-01-01T00:00:00.000Z" });
  service.registerAllocation(allocation());
  service.registerBeneficiary({ contractVersion: "1.0", beneficiaryId: "ben_vendor_1", organizationId: "org_acme", status: "approved", wallet: { network: "xrpl-classic", address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }, walletVersion: 3, lastWalletChangeAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
  service.registerEvidenceManifest({ contractVersion: "1.0", evidenceManifestId: "evidence_001", organizationId: "org_acme", obligationId: "obl_001", manifestHash: evidenceHash, items: [{ evidenceId: "evi_001", type: "invoice", contentHash: evidenceHash, sourceSystem: "erp", status: "verified", observedAt: "2026-01-01T00:00:00.000Z" }], createdAt: "2026-01-01T00:00:00.000Z" });
  service.registerPolicy({ organizationId: "org_acme", policyVersion: "policy_2026_01", status: "published", effectiveFrom: "2026-01-01T00:00:00.000Z" });
  return { accounting, service };
}

test("creates an immutable canonical intent from authoritative references and reserves capacity", () => {
  const { accounting, service } = setup();
  const record = service.create(request());
  assert.equal(record.state, "RESERVED");
  assert.equal(record.intent.amount, "400");
  assert.equal(record.intent.asset, "XRP");
  assert.equal(record.intent.beneficiaryWalletVersion, 3);
  assert.equal(record.intent.evidenceManifestHash, evidenceHash);
  assert.equal(record.reservation.intentDigest, record.intentDigest);
  assert.equal(accounting.treasurySnapshot("org_acme", "XRP").availableAmount, "600");
  assert.equal(Object.isFrozen(record.intent), true);
});

test("replays an identical idempotency request but rejects any protected mutation", () => {
  const { accounting, service } = setup();
  const first = service.create(request());
  const retry = service.create(request());
  assert.equal(retry, first);
  assert.equal(accounting.journal("org_acme").filter((entry) => entry.type === "reservation-created").length, 1);
  assert.throws(() => service.create(request({ beneficiaryId: "ben_vendor_2" })), IdempotencyConflictError);
  service.cancel("org_acme", first.intent.intentId, "2026-11-07T10:05:00.000Z");
  const successor = service.create(request({ idempotencyKey: "org_acme/invoice-42/v2" }));
  assert.notEqual(successor.intentDigest, first.intentDigest);
  assert.equal(successor.intent.intentId === first.intent.intentId, false);
});

test("refuses caller-supplied economic fields and untrusted or inactive references", () => {
  const { service } = setup();
  assert.throws(() => service.create({ ...request(), amount: "1" } as unknown as ReturnType<typeof request>), /unsupported field/);
  assert.throws(() => service.create(request({ beneficiaryId: "ben_unknown" })), /was not found/);
  assert.throws(() => service.create(request({ requestedExecutionWindow: { notBefore: "2026-11-07T09:59:59.999Z", expiresAt: "2026-11-07T11:00:00.000Z" } })), /not live/);
});

test("cancellation releases the exact reservation and prevents cross-organization reads", () => {
  const { accounting, service } = setup();
  const active = service.create(request());
  const cancelled = service.cancel("org_acme", active.intent.intentId, "2026-11-07T10:05:00.000Z");
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.reservation.status, "released");
  assert.equal(accounting.treasurySnapshot("org_acme", "XRP").availableAmount, "1000");
  assert.equal(service.cancel("org_acme", active.intent.intentId, "2026-11-07T10:06:00.000Z"), cancelled);
  assert.throws(() => service.get("org_other", active.intent.intentId), IntentStateError);
});
