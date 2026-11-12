import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { sha256Digest, type CanonicalValue } from "../../../packages/contracts/src/index.ts";

export type PolicyRuleField = "allowedPurposeCodes" | "allowedAssets" | "maxPaymentAmount" | "reserveFloor" | "requiredEvidence";
export type SourceWarningCode = "UNSUPPORTED_CLAUSE" | "UNTRUSTED_INSTRUCTION_CONTENT" | "UNSUPPORTED_DOCUMENT_TYPE";

export interface SourceUpload {
  readonly documentId: string;
  readonly organizationId: string;
  readonly fileName: string;
  readonly contentType: "text/plain";
  readonly content: Uint8Array;
  readonly uploadedByPrincipalId: string;
  readonly uploadedAt: string;
}

export interface EncryptedPolicySource {
  readonly documentId: string;
  readonly organizationId: string;
  readonly fileName: string;
  readonly contentType: "text/plain";
  readonly contentHash: string;
  readonly uploadedByPrincipalId: string;
  readonly uploadedAt: string;
  readonly encryption: { readonly algorithm: "aes-256-gcm"; readonly iv: string; readonly authTag: string; readonly ciphertext: string };
}

export interface ExtractedClause {
  readonly clauseId: string;
  readonly documentId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly textHash: string;
  readonly characterRange: { readonly start: number; readonly end: number };
}

export interface ExtractionProvenance {
  readonly documentId: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly extractedAt: string;
  readonly sourceContentHash: string;
  readonly extractedTextHash: string;
  readonly clauses: readonly ExtractedClause[];
}

export interface SourceCitation {
  readonly documentId: string;
  readonly clauseId: string;
  readonly quoteHash: string;
}

export interface DraftPolicyRule {
  readonly ruleId: string;
  readonly field: PolicyRuleField;
  readonly value: string | { readonly purposeCode: string; readonly evidenceType: string };
  readonly citations: readonly SourceCitation[];
}

export interface SourceWarning {
  readonly code: SourceWarningCode;
  readonly clauseId?: string;
  readonly detail: string;
}

export interface PolicySourceDraft {
  readonly draftId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly sourceContentHash: string;
  readonly extraction: ExtractionProvenance;
  readonly rules: readonly DraftPolicyRule[];
  readonly warnings: readonly SourceWarning[];
  readonly status: "draft";
  readonly generatedAt: string;
  readonly digest: string;
}

export interface PolicySourceStore {
  save(document: EncryptedPolicySource): Promise<void> | void;
  get(documentId: string): Promise<EncryptedPolicySource | undefined> | EncryptedPolicySource | undefined;
}

export interface PolicyDraftGenerator {
  generate(input: { readonly organizationId: string; readonly documentId: string; readonly clauses: readonly ExtractedClause[] }): Promise<{ readonly rules: readonly DraftPolicyRule[]; readonly warnings: readonly SourceWarning[] }> | { readonly rules: readonly DraftPolicyRule[]; readonly warnings: readonly SourceWarning[] };
}

/** Local encrypted store. Production replaces its backing map with encrypted object storage without changing the service boundary. */
export class EncryptedMemoryPolicySourceStore implements PolicySourceStore {
  readonly #documents = new Map<string, EncryptedPolicySource>();
  save(document: EncryptedPolicySource): void { const prior = this.#documents.get(document.documentId); if (prior && prior.contentHash !== document.contentHash) throw new PolicySourceError("Document id cannot be rebound to different content."); this.#documents.set(document.documentId, frozen(document)); }
  get(documentId: string): EncryptedPolicySource | undefined { return this.#documents.get(documentId); }
  raw(documentId: string): EncryptedPolicySource | undefined { return this.#documents.get(documentId); }
}

/**
 * Deterministic local draft generator. It only recognizes explicit policy
 * clauses; everything else remains a review warning. A future model-backed
 * generator must return this exact schema and passes through the same citation
 * validation before any draft is released.
 */
export class DeterministicPolicyDraftGenerator implements PolicyDraftGenerator {
  generate(input: { readonly organizationId: string; readonly documentId: string; readonly clauses: readonly ExtractedClause[] }): { readonly rules: readonly DraftPolicyRule[]; readonly warnings: readonly SourceWarning[] } {
    const rules: DraftPolicyRule[] = []; const warnings: SourceWarning[] = [];
    for (const clause of input.clauses) {
      const value = clause.text.trim();
      if (instructionLike(value)) { warnings.push(frozen({ code: "UNTRUSTED_INSTRUCTION_CONTENT", clauseId: clause.clauseId, detail: "Instruction-like text was retained as evidence and was not executed." })); continue; }
      const purpose = /^allowed purpose:\s*([a-z][a-z0-9-]{1,79})$/iu.exec(value);
      const asset = /^allowed asset:\s*([A-Za-z0-9-]{3,80})$/iu.exec(value);
      const maximum = /^maximum payment amount:\s*(\d+(?:\.\d+)?)$/iu.exec(value);
      const reserve = /^reserve floor:\s*(\d+(?:\.\d+)?)$/iu.exec(value);
      const evidence = /^required evidence for\s+([a-z][a-z0-9-]{1,79}):\s*([a-z][a-z0-9-]{1,79})$/iu.exec(value);
      const citation = frozen([{ documentId: input.documentId, clauseId: clause.clauseId, quoteHash: clause.textHash }]);
      if (purpose) rules.push(rule("allowedPurposeCodes", purpose[1].toLowerCase(), citation, rules.length));
      else if (asset) rules.push(rule("allowedAssets", asset[1], citation, rules.length));
      else if (maximum) rules.push(rule("maxPaymentAmount", maximum[1], citation, rules.length));
      else if (reserve) rules.push(rule("reserveFloor", reserve[1], citation, rules.length));
      else if (evidence) rules.push(rule("requiredEvidence", frozen({ purposeCode: evidence[1].toLowerCase(), evidenceType: evidence[2].toLowerCase() }), citation, rules.length));
      else warnings.push(frozen({ code: "UNSUPPORTED_CLAUSE", clauseId: clause.clauseId, detail: "Clause is retained for human review but cannot be compiled into a deterministic rule." }));
    }
    return frozen({ rules: frozen(rules), warnings: frozen(warnings) });
  }
}

/** The ingestion boundary: encrypts raw source, preserves extraction provenance, and validates every generated citation. */
export class PolicySourceIngestionService {
  readonly #key: Uint8Array;
  readonly #store: PolicySourceStore;
  readonly #generator: PolicyDraftGenerator;
  constructor(input: { readonly encryptionKey: Uint8Array; readonly store: PolicySourceStore; readonly generator?: PolicyDraftGenerator }) {
    if (!(input.encryptionKey instanceof Uint8Array) || input.encryptionKey.byteLength !== 32) throw new TypeError("Policy source encryption key must be exactly 32 bytes.");
    this.#key = new Uint8Array(input.encryptionKey); this.#store = input.store; this.#generator = input.generator ?? new DeterministicPolicyDraftGenerator();
  }
  async ingest(upload: SourceUpload): Promise<PolicySourceDraft> {
    validateUpload(upload); const contentHash = digestBytes(upload.content); const text = decodeUtf8(upload.content); const encrypted = encrypt(this.#key, upload.content);
    const stored: EncryptedPolicySource = frozen({ documentId: upload.documentId, organizationId: upload.organizationId, fileName: upload.fileName, contentType: upload.contentType, contentHash, uploadedByPrincipalId: upload.uploadedByPrincipalId, uploadedAt: upload.uploadedAt, encryption: encrypted });
    await this.#store.save(stored);
    const clauses = clauseExtraction(upload.documentId, text); const extraction: ExtractionProvenance = frozen({ documentId: upload.documentId, extractorId: "alloc-x-plain-text-extractor", extractorVersion: "1.0", extractedAt: upload.uploadedAt, sourceContentHash: contentHash, extractedTextHash: digestText(text), clauses });
    const generated = await this.#generator.generate({ organizationId: upload.organizationId, documentId: upload.documentId, clauses }); validateGenerated(generated, upload, extraction);
    const base = { draftId: `pdr_${sha256Digest({ documentId: upload.documentId, contentHash, generated } as unknown as CanonicalValue).slice(7, 39)}`, organizationId: upload.organizationId, documentId: upload.documentId, sourceContentHash: contentHash, extraction, rules: frozen([...generated.rules]), warnings: frozen([...generated.warnings]), status: "draft" as const, generatedAt: upload.uploadedAt };
    return frozen({ ...base, digest: sha256Digest(base as unknown as CanonicalValue) });
  }
  async decryptForAuthorizedProcessing(input: { readonly organizationId: string; readonly documentId: string }): Promise<Uint8Array> {
    requireId(input.organizationId, "organizationId", "org_"); requireId(input.documentId, "documentId", "psd_"); const document = await this.#store.get(input.documentId);
    if (!document || document.organizationId !== input.organizationId) throw new PolicySourceError("Policy source document was not found.");
    return decrypt(this.#key, document.encryption);
  }
}

export class PolicySourceError extends Error { constructor(message: string) { super(message); this.name = "PolicySourceError"; } }

function clauseExtraction(documentId: string, text: string): readonly ExtractedClause[] { const clauses: ExtractedClause[] = []; let offset = 0; for (const raw of text.split(/\r?\n/)) { const start = offset; offset += raw.length + 1; const value = raw.trim(); if (!value) continue; const clauseId = `psc_${sha256Digest({ documentId, ordinal: clauses.length + 1, text: value } as unknown as CanonicalValue).slice(7, 31)}`; clauses.push(frozen({ clauseId, documentId, ordinal: clauses.length + 1, text: value, textHash: digestText(value), characterRange: frozen({ start, end: start + raw.length }) })); } if (!clauses.length) throw new PolicySourceError("Policy source did not contain extractable text."); return frozen(clauses); }
function rule(field: PolicyRuleField, value: DraftPolicyRule["value"], citations: readonly SourceCitation[], index: number): DraftPolicyRule { return frozen({ ruleId: `pdrule_${String(index + 1).padStart(4, "0")}`, field, value, citations }); }
function validateGenerated(value: { readonly rules: readonly DraftPolicyRule[]; readonly warnings: readonly SourceWarning[] }, upload: SourceUpload, extraction: ExtractionProvenance): void { if (!Array.isArray(value.rules) || !Array.isArray(value.warnings)) throw new PolicySourceError("Draft generator returned an invalid result."); const clauses = new Map(extraction.clauses.map((clause) => [clause.clauseId, clause])); const seen = new Set<string>(); for (const ruleValue of value.rules) { if (!ruleValue || typeof ruleValue !== "object" || !["allowedPurposeCodes", "allowedAssets", "maxPaymentAmount", "reserveFloor", "requiredEvidence"].includes(ruleValue.field) || !Array.isArray(ruleValue.citations) || ruleValue.citations.length === 0) throw new PolicySourceError("Draft rule is malformed or has no source citation."); if (seen.has(ruleValue.ruleId)) throw new PolicySourceError("Draft contains duplicate rule identifiers."); seen.add(ruleValue.ruleId); for (const citation of ruleValue.citations) { const clause = clauses.get(citation.clauseId); if (!clause || citation.documentId !== upload.documentId || citation.quoteHash !== clause.textHash) throw new PolicySourceError("Draft rule cites content outside the uploaded source."); } } for (const warning of value.warnings) if (!warning || typeof warning !== "object" || !["UNSUPPORTED_CLAUSE", "UNTRUSTED_INSTRUCTION_CONTENT", "UNSUPPORTED_DOCUMENT_TYPE"].includes(warning.code)) throw new PolicySourceError("Draft warning is malformed."); }
function validateUpload(value: SourceUpload): void { requireId(value.documentId, "documentId", "psd_"); requireId(value.organizationId, "organizationId", "org_"); requireId(value.uploadedByPrincipalId, "uploadedByPrincipalId", "principal_"); if (value.contentType !== "text/plain") throw new PolicySourceError("Unsupported policy-source document type."); if (typeof value.fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(value.fileName)) throw new PolicySourceError("Policy-source file name is invalid."); if (!(value.content instanceof Uint8Array) || value.content.byteLength === 0 || value.content.byteLength > 2_000_000) throw new PolicySourceError("Policy-source content must be 1 through 2,000,000 bytes."); requireTime(value.uploadedAt, "uploadedAt"); }
function encrypt(key: Uint8Array, content: Uint8Array): EncryptedPolicySource["encryption"] { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]); return frozen({ algorithm: "aes-256-gcm", iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }); }
function decrypt(key: Uint8Array, value: EncryptedPolicySource["encryption"]): Uint8Array { const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64")); decipher.setAuthTag(Buffer.from(value.authTag, "base64")); return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()])); }
function decodeUtf8(value: Uint8Array): string { try { const text = new TextDecoder("utf-8", { fatal: true }).decode(value); if (text.includes("\u0000")) throw new Error(); return text; } catch { throw new PolicySourceError("Policy-source text must be valid UTF-8."); } }
function instructionLike(value: string): boolean { return /(?:ignore\s+(?:all\s+)?(?:previous|system)\s+instructions|system\s+prompt|<\/?tool\b|call\s+(?:a\s+)?tool)/iu.test(value); }
function digestText(value: string): string { return sha256Digest({ text: value } as CanonicalValue); }
function digestBytes(value: Uint8Array): string { return sha256Digest({ bytes: Buffer.from(value).toString("base64") } as CanonicalValue); }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new PolicySourceError(`${name} is invalid.`); }
function requireTime(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new PolicySourceError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
