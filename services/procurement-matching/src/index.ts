import { compareDecimal, normalizeDecimal, parseDecimal } from "../../../packages/contracts/src/index.ts";

export type ProcurementMatchStatus = "verified" | "review" | "mismatch" | "missing";
export type ProcurementMatchSignal =
  | "MISSING_PURCHASE_ORDER"
  | "MISSING_INVOICE"
  | "MISSING_DELIVERY_PROOF"
  | "ORGANIZATION_MISMATCH"
  | "PURCHASE_ORDER_REFERENCE_MISMATCH"
  | "BENEFICIARY_MISMATCH"
  | "VENDOR_MISMATCH"
  | "ASSET_MISMATCH"
  | "SUBTOTAL_OUTSIDE_TOLERANCE"
  | "TAX_OUTSIDE_TOLERANCE"
  | "TOTAL_OUTSIDE_TOLERANCE"
  | "DELIVERY_REFERENCE_MISMATCH"
  | "DELIVERY_BENEFICIARY_MISMATCH"
  | "DELIVERY_ASSET_MISMATCH";

export interface PurchaseOrderEvidence {
  readonly purchaseOrderId: string;
  readonly organizationId: string;
  readonly beneficiaryId: string;
  readonly vendorName: string;
  readonly asset: string;
  readonly subtotal: string;
  readonly tax: string;
  readonly total: string;
}
export interface InvoiceEvidence {
  readonly invoiceId: string;
  readonly organizationId: string;
  readonly purchaseOrderId: string;
  readonly beneficiaryId: string;
  readonly vendorName: string;
  readonly asset: string;
  readonly subtotal: string;
  readonly tax: string;
  readonly total: string;
}
export interface DeliveryProofEvidence {
  readonly deliveryId: string;
  readonly organizationId: string;
  readonly purchaseOrderId: string;
  readonly beneficiaryId: string;
  readonly asset: string;
}
export interface ProcurementMatchPolicy { readonly amountTolerance: string; readonly taxTolerance: string; readonly requireDeliveryProof: boolean; }
export interface ProcurementMatchResult { readonly status: ProcurementMatchStatus; readonly signals: readonly ProcurementMatchSignal[]; readonly matchedEvidenceIds: readonly string[]; }

/** Fail-closed procurement matching. A caller passes the result to the Security Layer as evidence.procurementStatus. */
export function matchProcurementEvidence(input: { readonly organizationId: string; readonly purchaseOrder?: PurchaseOrderEvidence; readonly invoice?: InvoiceEvidence; readonly deliveryProof?: DeliveryProofEvidence; readonly policy: ProcurementMatchPolicy }): ProcurementMatchResult {
  requireId(input.organizationId, "organizationId", "org_"); validatePolicy(input.policy);
  const missing: ProcurementMatchSignal[] = [];
  if (!input.purchaseOrder) missing.push("MISSING_PURCHASE_ORDER"); if (!input.invoice) missing.push("MISSING_INVOICE"); if (input.policy.requireDeliveryProof && !input.deliveryProof) missing.push("MISSING_DELIVERY_PROOF");
  if (missing.length) return result("missing", missing, input);
  const po = input.purchaseOrder!; const invoice = input.invoice!; validatePurchaseOrder(po); validateInvoice(invoice); if (input.deliveryProof) validateDeliveryProof(input.deliveryProof);
  const signals = new Set<ProcurementMatchSignal>();
  if (po.organizationId !== input.organizationId || invoice.organizationId !== input.organizationId || (input.deliveryProof && input.deliveryProof.organizationId !== input.organizationId)) signals.add("ORGANIZATION_MISMATCH");
  if (invoice.purchaseOrderId !== po.purchaseOrderId) signals.add("PURCHASE_ORDER_REFERENCE_MISMATCH");
  if (invoice.beneficiaryId !== po.beneficiaryId) signals.add("BENEFICIARY_MISMATCH");
  if (vendorKey(invoice.vendorName) !== vendorKey(po.vendorName)) signals.add("VENDOR_MISMATCH");
  if (invoice.asset !== po.asset) signals.add("ASSET_MISMATCH");
  if (!withinTolerance(po.subtotal, invoice.subtotal, input.policy.amountTolerance)) signals.add("SUBTOTAL_OUTSIDE_TOLERANCE");
  if (!withinTolerance(po.tax, invoice.tax, input.policy.taxTolerance)) signals.add("TAX_OUTSIDE_TOLERANCE");
  if (!withinTolerance(po.total, invoice.total, input.policy.amountTolerance)) signals.add("TOTAL_OUTSIDE_TOLERANCE");
  if (input.deliveryProof) {
    if (input.deliveryProof.purchaseOrderId !== po.purchaseOrderId) signals.add("DELIVERY_REFERENCE_MISMATCH");
    if (input.deliveryProof.beneficiaryId !== po.beneficiaryId) signals.add("DELIVERY_BENEFICIARY_MISMATCH");
    if (input.deliveryProof.asset !== po.asset) signals.add("DELIVERY_ASSET_MISMATCH");
  }
  return result(signals.size ? "mismatch" : "verified", [...signals], input);
}

export class ProcurementMatchingError extends Error { constructor(message: string) { super(message); this.name = "ProcurementMatchingError"; } }

function result(status: ProcurementMatchStatus, signals: readonly ProcurementMatchSignal[], input: { readonly purchaseOrder?: PurchaseOrderEvidence; readonly invoice?: InvoiceEvidence; readonly deliveryProof?: DeliveryProofEvidence }): ProcurementMatchResult { return frozen({ status, signals: frozen([...signals].sort() as ProcurementMatchSignal[]), matchedEvidenceIds: frozen([input.purchaseOrder?.purchaseOrderId, input.invoice?.invoiceId, input.deliveryProof?.deliveryId].filter((value): value is string => Boolean(value)).sort()) }); }
function withinTolerance(left: string, right: string, tolerance: string): boolean { const leftValue = parseDecimal(left); const rightValue = parseDecimal(right); const scale = Math.max(leftValue.scale, rightValue.scale); const difference = leftValue.coefficient * 10n ** BigInt(scale - leftValue.scale) - rightValue.coefficient * 10n ** BigInt(scale - rightValue.scale); const absolute = difference < 0n ? -difference : difference; const toleranceValue = parseDecimal(tolerance); const allowed = toleranceValue.coefficient * 10n ** BigInt(scale - toleranceValue.scale); return absolute <= allowed; }
function validatePurchaseOrder(value: PurchaseOrderEvidence): void { validateDocument(value, "purchaseOrderId", "po_"); }
function validateInvoice(value: InvoiceEvidence): void { validateDocument(value, "invoiceId", "inv_"); requireId(value.purchaseOrderId, "purchaseOrderId", "po_"); }
function validateDeliveryProof(value: DeliveryProofEvidence): void { requireId(value.deliveryId, "deliveryId", "del_"); requireId(value.organizationId, "organizationId", "org_"); requireId(value.purchaseOrderId, "purchaseOrderId", "po_"); requireId(value.beneficiaryId, "beneficiaryId", "ben_"); asset(value.asset); }
function validateDocument(value: PurchaseOrderEvidence | InvoiceEvidence, idName: string, idPrefix: string): void { requireId(value[idName as "purchaseOrderId" | "invoiceId"], idName, idPrefix); requireId(value.organizationId, "organizationId", "org_"); requireId(value.beneficiaryId, "beneficiaryId", "ben_"); text(value.vendorName, "vendorName"); asset(value.asset); for (const field of ["subtotal", "tax", "total"] as const) amount(value[field], field); if (compareDecimal(normalizeDecimal(value.total), normalizeDecimal(value.subtotal)) < 0) throw new ProcurementMatchingError("total cannot be less than subtotal."); }
function validatePolicy(value: ProcurementMatchPolicy): void { if (!value || typeof value !== "object") throw new ProcurementMatchingError("policy is invalid."); amount(value.amountTolerance, "amountTolerance"); amount(value.taxTolerance, "taxTolerance"); if (typeof value.requireDeliveryProof !== "boolean") throw new ProcurementMatchingError("requireDeliveryProof is invalid."); }
function amount(value: unknown, name: string): asserts value is string { try { if (typeof value !== "string" || parseDecimal(value).coefficient < 0n) throw new Error(); } catch { throw new ProcurementMatchingError(`${name} is invalid.`); } }
function asset(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Z0-9]{3,16}$/u.test(value)) throw new ProcurementMatchingError("asset is invalid."); }
function vendorKey(value: string): string { return value.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/gu, "").replace(/[^a-z0-9]+/gu, " ").replace(/\b(?:ltd|limited|inc|incorporated|llc|plc|company|co)\b/gu, "").trim().replace(/\s+/gu, " "); }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/u.test(value)) throw new ProcurementMatchingError(`${name} is invalid.`); }
function text(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 160) throw new ProcurementMatchingError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
