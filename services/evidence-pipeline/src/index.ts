import { createCipheriv, randomBytes } from "node:crypto";

import { sha256Digest, type CanonicalValue } from "../../../packages/contracts/src/index.ts";

export type EvidenceContentType = "text/plain";
export type EvidenceClassification = "invoice" | "purchase-order" | "contract" | "delivery-proof" | "other";
export type EvidenceStatus = "processed" | "quarantined";
export type EvidenceWarningCode =
  | "INSTRUCTION_LIKE_CONTENT"
  | "MALWARE_QUARANTINED"
  | "UNSUPPORTED_DOCUMENT_TYPE"
  | "UNCLASSIFIED_CONTENT";

export interface EvidenceUpload {
  readonly evidenceId: string;
  readonly organizationId: string;
  readonly fileName: string;
  readonly contentType: EvidenceContentType;
  readonly content: Uint8Array;
  readonly uploadedByPrincipalId: string;
  readonly uploadedAt: string;
  readonly retentionDays: number;
}

export interface MalwareScanResult {
  readonly verdict: "clean" | "quarantined";
  readonly scannerId: string;
  readonly scannerVersion: string;
  readonly reason?: string;
}

export interface ContentScanner {
  scan(input: { readonly evidenceId: string; readonly content: Uint8Array; readonly contentType: EvidenceContentType }): Promise<MalwareScanResult> | MalwareScanResult;
}

export interface ParsedEvidence {
  readonly text: string;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly ocr: { readonly applied: boolean; readonly engineId?: string; readonly engineVersion?: string };
}

export interface IsolatedEvidenceParser {
  parse(input: { readonly evidenceId: string; readonly content: Uint8Array; readonly contentType: EvidenceContentType }): Promise<ParsedEvidence> | ParsedEvidence;
}

export interface EncryptedEvidence {
  readonly evidenceId: string;
  readonly organizationId: string;
  readonly fileName: string;
  readonly contentType: EvidenceContentType;
  readonly contentHash: string;
  readonly uploadedByPrincipalId: string;
  readonly uploadedAt: string;
  readonly status: EvidenceStatus;
  readonly encryption: { readonly algorithm: "aes-256-gcm"; readonly iv: string; readonly authTag: string; readonly ciphertext: string };
}

export interface EvidenceProvenance {
  readonly evidenceId: string;
  readonly sourceContentHash: string;
  readonly extractedTextHash: string;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly parsedAt: string;
  readonly ocr: ParsedEvidence["ocr"];
}

export interface ProcessedEvidence {
  readonly evidenceId: string;
  readonly organizationId: string;
  readonly status: EvidenceStatus;
  readonly classification?: EvidenceClassification;
  readonly provenance?: EvidenceProvenance;
  readonly warnings: readonly { readonly code: EvidenceWarningCode; readonly detail: string }[];
  readonly retentionUntil: string;
  readonly digest: string;
}

export interface EvidenceStore {
  saveRaw(value: EncryptedEvidence): Promise<void> | void;
  saveProcessed(value: ProcessedEvidence): Promise<void> | void;
  getRaw(evidenceId: string): Promise<EncryptedEvidence | undefined> | EncryptedEvidence | undefined;
  getProcessed(evidenceId: string): Promise<ProcessedEvidence | undefined> | ProcessedEvidence | undefined;
}

export class EncryptedMemoryEvidenceStore implements EvidenceStore {
  readonly #raw = new Map<string, EncryptedEvidence>();
  readonly #processed = new Map<string, ProcessedEvidence>();

  saveRaw(value: EncryptedEvidence): void {
    const existing = this.#raw.get(value.evidenceId);
    if (existing && (existing.contentHash !== value.contentHash || existing.organizationId !== value.organizationId)) throw new EvidencePipelineError("Evidence id cannot be rebound.");
    this.#raw.set(value.evidenceId, frozen(value));
  }

  saveProcessed(value: ProcessedEvidence): void { this.#processed.set(value.evidenceId, frozen(value)); }
  getRaw(evidenceId: string): EncryptedEvidence | undefined { return this.#raw.get(evidenceId); }
  getProcessed(evidenceId: string): ProcessedEvidence | undefined { return this.#processed.get(evidenceId); }
  rawForVerification(evidenceId: string): EncryptedEvidence | undefined { return this.#raw.get(evidenceId); }
}

/** Local signature scanner. Production replaces this adapter with an isolated malware-scanning service. */
export class SignatureContentScanner implements ContentScanner {
  scan(input: { readonly evidenceId: string; readonly content: Uint8Array; readonly contentType: EvidenceContentType }): MalwareScanResult {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(input.content);
    const malicious = /EICAR-STANDARD-ANTIVIRUS-TEST-FILE|\bMALWARE\s*:/iu.test(text);
    return frozen(malicious
      ? { verdict: "quarantined" as const, scannerId: "alloc-x-signature-scanner", scannerVersion: "1.0", reason: "Known unsafe-content signature detected." }
      : { verdict: "clean" as const, scannerId: "alloc-x-signature-scanner", scannerVersion: "1.0" });
  }
}

/** Local deterministic parser. It has no tools, network access, or policy/publication capability. */
export class Utf8TextEvidenceParser implements IsolatedEvidenceParser {
  parse(input: { readonly evidenceId: string; readonly content: Uint8Array; readonly contentType: EvidenceContentType }): ParsedEvidence {
    if (input.contentType !== "text/plain") throw new EvidencePipelineError("Unsupported evidence document type.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(input.content); } catch { throw new EvidencePipelineError("Evidence text must be valid UTF-8."); }
    if (!text.trim() || text.includes("\u0000")) throw new EvidencePipelineError("Evidence text is empty or unsafe to parse.");
    return frozen({ text, parserId: "alloc-x-utf8-isolated-parser", parserVersion: "1.0", ocr: frozen({ applied: false }) });
  }
}

/**
 * A single ingestion boundary for payment evidence. Raw document content is
 * encrypted before persistence; extracted text is only used for deterministic
 * classification and warnings, never for command or tool execution.
 */
export class EvidencePipelineService {
  readonly #key: Uint8Array;
  readonly #store: EvidenceStore;
  readonly #scanner: ContentScanner;
  readonly #parser: IsolatedEvidenceParser;

  constructor(input: { readonly encryptionKey: Uint8Array; readonly store: EvidenceStore; readonly scanner?: ContentScanner; readonly parser?: IsolatedEvidenceParser }) {
    if (!(input.encryptionKey instanceof Uint8Array) || input.encryptionKey.byteLength !== 32) throw new TypeError("Evidence encryption key must be exactly 32 bytes.");
    this.#key = new Uint8Array(input.encryptionKey);
    this.#store = input.store;
    this.#scanner = input.scanner ?? new SignatureContentScanner();
    this.#parser = input.parser ?? new Utf8TextEvidenceParser();
  }

  async ingest(upload: EvidenceUpload): Promise<ProcessedEvidence> {
    validateUpload(upload);
    const contentHash = digestBytes(upload.content);
    const prior = await this.#store.getProcessed(upload.evidenceId);
    if (prior) {
      const stored = await this.#store.getRaw(upload.evidenceId);
      if (!stored || stored.organizationId !== upload.organizationId || stored.contentHash !== contentHash) throw new EvidencePipelineError("Evidence id cannot be reused for different content or organization.");
      return prior;
    }

    const scan = await this.#scanner.scan({ evidenceId: upload.evidenceId, content: upload.content, contentType: upload.contentType });
    validateScan(scan);
    const raw: EncryptedEvidence = frozen({ evidenceId: upload.evidenceId, organizationId: upload.organizationId, fileName: upload.fileName, contentType: upload.contentType, contentHash, uploadedByPrincipalId: upload.uploadedByPrincipalId, uploadedAt: upload.uploadedAt, status: scan.verdict === "clean" ? "processed" : "quarantined", encryption: encrypt(this.#key, upload.content) });
    await this.#store.saveRaw(raw);

    const retentionUntil = futureTimestamp(upload.uploadedAt, upload.retentionDays);
    if (scan.verdict === "quarantined") {
      return this.#persist({ evidenceId: upload.evidenceId, organizationId: upload.organizationId, status: "quarantined", warnings: frozen([{ code: "MALWARE_QUARANTINED" as const, detail: `Evidence was quarantined before parsing: ${scan.reason ?? "scanner verdict"}` }]), retentionUntil });
    }

    const parsed = await this.#parser.parse({ evidenceId: upload.evidenceId, content: upload.content, contentType: upload.contentType });
    validateParsed(parsed);
    const warnings = warningSignals(parsed.text);
    const classification = classify(parsed.text);
    if (classification === "other") warnings.push(frozen({ code: "UNCLASSIFIED_CONTENT", detail: "Evidence was retained but did not match a supported financial document classification." }));
    const provenance: EvidenceProvenance = frozen({ evidenceId: upload.evidenceId, sourceContentHash: contentHash, extractedTextHash: digestText(parsed.text), parserId: parsed.parserId, parserVersion: parsed.parserVersion, parsedAt: upload.uploadedAt, ocr: frozen(parsed.ocr) });
    return this.#persist({ evidenceId: upload.evidenceId, organizationId: upload.organizationId, status: "processed", classification, provenance, warnings: frozen(warnings), retentionUntil });
  }

  async getProcessed(input: { readonly evidenceId: string; readonly organizationId: string }): Promise<ProcessedEvidence> {
    requireId(input.evidenceId, "evidenceId", "evid_"); requireId(input.organizationId, "organizationId", "org_");
    const value = await this.#store.getProcessed(input.evidenceId);
    if (!value || value.organizationId !== input.organizationId) throw new EvidencePipelineError("Evidence was not found.");
    return value;
  }

  async #persist(value: Omit<ProcessedEvidence, "digest">): Promise<ProcessedEvidence> {
    const result = frozen({ ...value, digest: sha256Digest(value as CanonicalValue) });
    await this.#store.saveProcessed(result);
    return result;
  }
}

export class EvidencePipelineError extends Error { constructor(message: string) { super(message); this.name = "EvidencePipelineError"; } }

function validateUpload(value: EvidenceUpload): void {
  requireId(value.evidenceId, "evidenceId", "evid_"); requireId(value.organizationId, "organizationId", "org_"); requireId(value.uploadedByPrincipalId, "uploadedByPrincipalId", "principal_"); requireTime(value.uploadedAt, "uploadedAt");
  if (value.contentType !== "text/plain") throw new EvidencePipelineError("Unsupported evidence document type.");
  if (typeof value.fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/u.test(value.fileName)) throw new EvidencePipelineError("Evidence file name is invalid.");
  if (!(value.content instanceof Uint8Array) || value.content.byteLength === 0 || value.content.byteLength > 2_000_000) throw new EvidencePipelineError("Evidence content must be 1 through 2,000,000 bytes.");
  if (!Number.isInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 3_650) throw new EvidencePipelineError("retentionDays must be between 1 and 3650.");
}

function validateScan(value: MalwareScanResult): void { if (!value || (value.verdict !== "clean" && value.verdict !== "quarantined") || !value.scannerId || !value.scannerVersion) throw new EvidencePipelineError("Scanner returned an invalid result."); }
function validateParsed(value: ParsedEvidence): void { if (!value || typeof value.text !== "string" || !value.text.trim() || !value.parserId || !value.parserVersion || !value.ocr || typeof value.ocr.applied !== "boolean") throw new EvidencePipelineError("Parser returned an invalid result."); }
function warningSignals(text: string): { code: EvidenceWarningCode; detail: string }[] { return /(?:ignore\s+(?:all\s+)?(?:previous|system)\s+instructions|system\s+prompt|<\/?tool\b|call\s+(?:a\s+)?tool)/iu.test(text) ? [frozen({ code: "INSTRUCTION_LIKE_CONTENT" as const, detail: "Instruction-like text was retained as evidence and was never executed." })] : []; }
function classify(text: string): EvidenceClassification { const lower = text.toLowerCase(); if (/\binvoice\b/u.test(lower)) return "invoice"; if (/\b(?:purchase order|po\s*number)\b/u.test(lower)) return "purchase-order"; if (/\b(?:contract|agreement)\b/u.test(lower)) return "contract"; if (/\b(?:delivery note|proof of delivery)\b/u.test(lower)) return "delivery-proof"; return "other"; }
function encrypt(key: Uint8Array, content: Uint8Array): EncryptedEvidence["encryption"] { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]); return frozen({ algorithm: "aes-256-gcm", iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }); }
function digestBytes(value: Uint8Array): string { return sha256Digest({ bytes: Buffer.from(value).toString("base64") } as CanonicalValue); }
function digestText(value: string): string { return sha256Digest({ text: value } as CanonicalValue); }
function futureTimestamp(value: string, days: number): string { const date = new Date(value); date.setUTCDate(date.getUTCDate() + days); return date.toISOString(); }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/u.test(value)) throw new EvidencePipelineError(`${name} is invalid.`); }
function requireTime(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new EvidencePipelineError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
