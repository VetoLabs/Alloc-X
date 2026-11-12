import assert from "node:assert/strict";
import test from "node:test";

import { detectDuplicateOrSplitPayment } from "../src/index.ts";

const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
const assessedAt = "2026-11-09T12:00:00.000Z";
const config = { splitThresholdAmount: "1000", splitWindowHours: 24 };
function evidence(overrides: Partial<Parameters<typeof detectDuplicateOrSplitPayment>[0]["candidate"]> = {}) {
  return { evidenceId: "evid_current_001", organizationId: "org_meridian", contentHash: hash("a"), vendorName: "MedSupply Nigeria Ltd", invoiceReference: "INV-2026-001", amount: "450", asset: "XRP", beneficiaryId: "ben_medsupply", observedAt: "2026-11-09T11:00:00.000Z", ...overrides };
}

test("denies an exact content hash duplicate and links the original evidence", () => {
  const result = detectDuplicateOrSplitPayment({ candidate: evidence(), history: [evidence({ evidenceId: "evid_prior_001", observedAt: "2026-11-08T12:00:00.000Z" })], config, assessedAt });
  assert.equal(result.status, "exact"); assert.deepEqual(result.signals, ["EXACT_CONTENT_HASH", "NORMALIZED_INVOICE_FINGERPRINT"]); assert.deepEqual(result.linkedEvidenceIds, ["evid_prior_001"]);
});

test("denies a normalized invoice duplicate even when raw documents differ", () => {
  const result = detectDuplicateOrSplitPayment({ candidate: evidence(), history: [evidence({ evidenceId: "evid_prior_002", contentHash: hash("b"), vendorName: "MEDSUPPLY   NIGERIA, LTD.", invoiceReference: "inv 2026 001", amount: "450.000" })], config, assessedAt });
  assert.equal(result.status, "exact"); assert.deepEqual(result.signals, ["NORMALIZED_INVOICE_FINGERPRINT"]);
});

test("routes a fuzzy vendor and invoice-reference match to review", () => {
  const result = detectDuplicateOrSplitPayment({ candidate: evidence(), history: [evidence({ evidenceId: "evid_prior_003", contentHash: hash("c"), vendorName: "MedSuplly Nigeria Limited", invoiceReference: "INV-2026-OO1" })], config, assessedAt });
  assert.equal(result.status, "possible"); assert.deepEqual(result.signals, ["FUZZY_INVOICE_MATCH"]); assert.deepEqual(result.linkedEvidenceIds, ["evid_prior_003"]);
});

test("routes likely threshold splitting to review within a bounded window", () => {
  const result = detectDuplicateOrSplitPayment({ candidate: evidence({ amount: "450", invoiceReference: "INV-003" }), history: [evidence({ evidenceId: "evid_prior_004", contentHash: hash("d"), amount: "600", invoiceReference: "INV-002", observedAt: "2026-11-09T09:00:00.000Z" })], config, assessedAt });
  assert.equal(result.status, "possible"); assert.deepEqual(result.signals, ["SPLIT_THRESHOLD_EVASION"]); assert.deepEqual(result.linkedEvidenceIds, ["evid_prior_004"]);
});

test("keeps organizations, later evidence, and unrelated vendors out of matching", () => {
  const result = detectDuplicateOrSplitPayment({ candidate: evidence(), history: [evidence({ evidenceId: "evid_other_org", organizationId: "org_other", observedAt: "2026-11-09T11:30:00.000Z" }), evidence({ evidenceId: "evid_future", contentHash: hash("f"), observedAt: "2026-11-09T13:00:00.000Z" }), evidence({ evidenceId: "evid_other_vendor", contentHash: hash("e"), vendorName: "Other Vendor", invoiceReference: "OTHER-001", observedAt: "2026-11-09T11:00:00.000Z" })], config, assessedAt });
  assert.equal(result.status, "clear"); assert.deepEqual(result.linkedEvidenceIds, []);
});
