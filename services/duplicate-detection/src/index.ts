import { addDecimal, compareDecimal, normalizeDecimal, parseDecimal, sha256Digest, type CanonicalValue } from "../../../packages/contracts/src/index.ts";

export type DuplicateStatus = "clear" | "exact" | "possible";
export type DuplicateSignal = "EXACT_CONTENT_HASH" | "NORMALIZED_INVOICE_FINGERPRINT" | "FUZZY_INVOICE_MATCH" | "SPLIT_THRESHOLD_EVASION";

export interface InvoiceEvidence {
  readonly evidenceId: string;
  readonly organizationId: string;
  readonly contentHash: string;
  readonly vendorName: string;
  readonly invoiceReference: string;
  readonly amount: string;
  readonly asset: string;
  readonly beneficiaryId: string;
  readonly observedAt: string;
}

export interface DuplicateDetectionConfig {
  readonly splitThresholdAmount: string;
  readonly splitWindowHours: number;
  readonly fuzzyVendorSimilarity?: number;
  readonly fuzzyReferenceSimilarity?: number;
}

export interface DuplicateDetectionResult {
  readonly status: DuplicateStatus;
  readonly normalizedInvoiceFingerprint: string;
  readonly signals: readonly DuplicateSignal[];
  readonly linkedEvidenceIds: readonly string[];
  readonly assessedAt: string;
}

/**
 * Deterministic detection for payment evidence. `history` must already be
 * tenant-scoped by the caller. Exact matches deny in the policy engine;
 * near matches and likely payment splitting route to independent review.
 */
export function detectDuplicateOrSplitPayment(input: {
  readonly candidate: InvoiceEvidence;
  readonly history: readonly InvoiceEvidence[];
  readonly config: DuplicateDetectionConfig;
  readonly assessedAt: string;
}): DuplicateDetectionResult {
  validateEvidence(input.candidate); validateConfig(input.config); validateTime(input.assessedAt, "assessedAt");
  const candidate = normalizeEvidence(input.candidate);
  const history = input.history
    .filter((item) => item.evidenceId !== candidate.evidenceId)
    .map((item) => { validateEvidence(item); return normalizeEvidence(item); })
    .filter((item) => item.organizationId === candidate.organizationId && Date.parse(item.observedAt) <= Date.parse(input.assessedAt));

  const exact = new Set<string>(); const possible = new Set<string>();
  const exactSignals = new Set<DuplicateSignal>(); const possibleSignals = new Set<DuplicateSignal>();
  const fingerprint = invoiceFingerprint(candidate);

  for (const prior of history) {
    if (prior.contentHash === candidate.contentHash) { exact.add(prior.evidenceId); exactSignals.add("EXACT_CONTENT_HASH"); }
    if (invoiceFingerprint(prior) === fingerprint) { exact.add(prior.evidenceId); exactSignals.add("NORMALIZED_INVOICE_FINGERPRINT"); }
    if (isFuzzyInvoiceMatch(candidate, prior, input.config)) { possible.add(prior.evidenceId); possibleSignals.add("FUZZY_INVOICE_MATCH"); }
  }

  const splitMatches = likelySplitPayments(candidate, history, input.config, input.assessedAt);
  if (splitMatches.length) {
    for (const evidenceId of splitMatches) possible.add(evidenceId);
    possibleSignals.add("SPLIT_THRESHOLD_EVASION");
  }

  const status: DuplicateStatus = exact.size ? "exact" : possible.size ? "possible" : "clear";
  const signals = [...(status === "exact" ? exactSignals : possibleSignals)].sort() as DuplicateSignal[];
  const linkedEvidenceIds = [...(status === "exact" ? exact : possible)].sort();
  return frozen({ status, normalizedInvoiceFingerprint: fingerprint, signals: frozen(signals), linkedEvidenceIds: frozen(linkedEvidenceIds), assessedAt: input.assessedAt });
}

/** Maps the detector result directly into Policy Engine's evidence snapshot. */
export function policyDuplicateStatus(result: DuplicateDetectionResult): DuplicateStatus { return result.status; }

export class DuplicateDetectionError extends Error { constructor(message: string) { super(message); this.name = "DuplicateDetectionError"; } }

interface NormalizedEvidence extends InvoiceEvidence { readonly vendorKey: string; readonly referenceKey: string; readonly normalizedAmount: string; }

function normalizeEvidence(value: InvoiceEvidence): NormalizedEvidence {
  return frozen({ ...value, vendorKey: normalizeVendor(value.vendorName), referenceKey: normalizeText(value.invoiceReference), normalizedAmount: normalizeDecimal(value.amount) });
}

function invoiceFingerprint(value: NormalizedEvidence): string {
  return sha256Digest({ vendor: value.vendorKey, reference: value.referenceKey, amount: value.normalizedAmount, asset: value.asset } as CanonicalValue);
}

function isFuzzyInvoiceMatch(candidate: NormalizedEvidence, prior: NormalizedEvidence, config: DuplicateDetectionConfig): boolean {
  if (candidate.asset !== prior.asset || candidate.normalizedAmount !== prior.normalizedAmount) return false;
  const vendorSimilarity = similarity(candidate.vendorKey, prior.vendorKey);
  const referenceSimilarity = similarity(candidate.referenceKey, prior.referenceKey);
  return vendorSimilarity >= (config.fuzzyVendorSimilarity ?? 0.82) && referenceSimilarity >= (config.fuzzyReferenceSimilarity ?? 0.78);
}

function likelySplitPayments(candidate: NormalizedEvidence, history: readonly NormalizedEvidence[], config: DuplicateDetectionConfig, assessedAt: string): readonly string[] {
  const threshold = normalizeDecimal(config.splitThresholdAmount);
  if (compareDecimal(candidate.normalizedAmount, threshold) >= 0) return frozen([]);
  const lowerBound = Date.parse(candidate.observedAt) - config.splitWindowHours * 3_600_000;
  const grouped = history.filter((prior) => prior.asset === candidate.asset && prior.beneficiaryId === candidate.beneficiaryId && prior.vendorKey === candidate.vendorKey && Date.parse(prior.observedAt) >= lowerBound && Date.parse(prior.observedAt) <= Date.parse(assessedAt) && compareDecimal(prior.normalizedAmount, threshold) < 0);
  const aggregate = grouped.reduce((total, prior) => addDecimal(total, prior.normalizedAmount), candidate.normalizedAmount);
  return compareDecimal(aggregate, threshold) >= 0 ? frozen(grouped.map((prior) => prior.evidenceId).sort()) : frozen([]);
}

function validateEvidence(value: InvoiceEvidence): void {
  if (!value || typeof value !== "object") throw new DuplicateDetectionError("Evidence is invalid.");
  requireId(value.evidenceId, "evidenceId", "evid_"); requireId(value.organizationId, "organizationId", "org_"); requireId(value.beneficiaryId, "beneficiaryId", "ben_");
  if (typeof value.contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.contentHash)) throw new DuplicateDetectionError("contentHash is invalid.");
  requireText(value.vendorName, "vendorName"); requireText(value.invoiceReference, "invoiceReference");
  if (typeof value.asset !== "string" || !/^[A-Z0-9]{3,16}$/u.test(value.asset)) throw new DuplicateDetectionError("asset is invalid.");
  try { if (parseDecimal(value.amount).coefficient <= 0n) throw new Error(); } catch { throw new DuplicateDetectionError("amount is invalid."); }
  validateTime(value.observedAt, "observedAt");
}

function validateConfig(value: DuplicateDetectionConfig): void {
  try { if (parseDecimal(value.splitThresholdAmount).coefficient <= 0n) throw new Error(); } catch { throw new DuplicateDetectionError("splitThresholdAmount is invalid."); }
  if (!Number.isInteger(value.splitWindowHours) || value.splitWindowHours < 1 || value.splitWindowHours > 720) throw new DuplicateDetectionError("splitWindowHours must be between 1 and 720.");
  for (const [name, score] of [["fuzzyVendorSimilarity", value.fuzzyVendorSimilarity], ["fuzzyReferenceSimilarity", value.fuzzyReferenceSimilarity]] as const) if (score !== undefined && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)) throw new DuplicateDetectionError(`${name} must be between 0 and 1.`);
}

function normalizeText(value: string): string { return value.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/gu, "").replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " "); }
function normalizeVendor(value: string): string { return normalizeText(value).replace(/\b(?:ltd|limited|inc|incorporated|llc|plc|company|co)\b/gu, "").trim().replace(/\s+/gu, " "); }
function similarity(left: string, right: string): number { if (left === right) return 1; if (!left || !right) return 0; const shorter = left.length < right.length ? left : right; const longer = left.length < right.length ? right : left; return 1 - editDistance(shorter, longer) / longer.length; }
function editDistance(left: string, right: string): number { let previous = Array.from({ length: left.length + 1 }, (_, index) => index); for (let row = 1; row <= right.length; row += 1) { const current = [row]; for (let column = 1; column <= left.length; column += 1) current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (left[column - 1] === right[row - 1] ? 0 : 1)); previous = current; } return previous[left.length]; }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/u.test(value)) throw new DuplicateDetectionError(`${name} is invalid.`); }
function requireText(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 160) throw new DuplicateDetectionError(`${name} is invalid.`); }
function validateTime(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new DuplicateDetectionError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
