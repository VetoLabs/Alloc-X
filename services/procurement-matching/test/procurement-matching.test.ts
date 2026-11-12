import assert from "node:assert/strict";
import test from "node:test";
import { matchProcurementEvidence } from "../src/index.ts";

const policy = { amountTolerance: "2", taxTolerance: "0.5", requireDeliveryProof: true };
const po = { purchaseOrderId: "po_001", organizationId: "org_meridian", beneficiaryId: "ben_medsupply", vendorName: "MedSupply Nigeria Ltd", asset: "XRP", subtotal: "100", tax: "7.5", total: "107.5" };
const invoice = { invoiceId: "inv_001", organizationId: "org_meridian", purchaseOrderId: "po_001", beneficiaryId: "ben_medsupply", vendorName: "MedSupply Nigeria Limited", asset: "XRP", subtotal: "101.5", tax: "7.8", total: "109" };
const deliveryProof = { deliveryId: "del_001", organizationId: "org_meridian", purchaseOrderId: "po_001", beneficiaryId: "ben_medsupply", asset: "XRP" };

test("verifies procurement documents within configured amount and tax tolerance", () => {
  const result = matchProcurementEvidence({ organizationId: "org_meridian", purchaseOrder: po, invoice, deliveryProof, policy });
  assert.equal(result.status, "verified"); assert.deepEqual(result.signals, []); assert.deepEqual(result.matchedEvidenceIds, ["del_001", "inv_001", "po_001"]);
});
test("fails closed when an expected procurement document is missing", () => {
  const result = matchProcurementEvidence({ organizationId: "org_meridian", purchaseOrder: po, policy });
  assert.equal(result.status, "missing"); assert.deepEqual(result.signals, ["MISSING_DELIVERY_PROOF", "MISSING_INVOICE"]);
});
test("makes beneficiary, asset, delivery, and financial mismatches visible", () => {
  const result = matchProcurementEvidence({ organizationId: "org_meridian", purchaseOrder: po, invoice: { ...invoice, beneficiaryId: "ben_other", asset: "USD", subtotal: "120", tax: "20", total: "140" }, deliveryProof: { ...deliveryProof, beneficiaryId: "ben_other", asset: "USD" }, policy });
  assert.equal(result.status, "mismatch"); assert.deepEqual(result.signals, ["ASSET_MISMATCH", "BENEFICIARY_MISMATCH", "DELIVERY_ASSET_MISMATCH", "DELIVERY_BENEFICIARY_MISMATCH", "SUBTOTAL_OUTSIDE_TOLERANCE", "TAX_OUTSIDE_TOLERANCE", "TOTAL_OUTSIDE_TOLERANCE"]);
});
test("does not allow another organization to satisfy evidence requirements", () => {
  const result = matchProcurementEvidence({ organizationId: "org_meridian", purchaseOrder: po, invoice: { ...invoice, organizationId: "org_other" }, deliveryProof, policy });
  assert.equal(result.status, "mismatch"); assert.deepEqual(result.signals, ["ORGANIZATION_MISMATCH"]);
});
