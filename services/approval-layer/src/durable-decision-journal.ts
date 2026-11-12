import { open, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  canonicalJson,
  sha256Digest,
  type CanonicalValue,
} from "../../../packages/contracts/src/index.ts";
import type { AuditEvent } from "../../../packages/audit-chain/src/index.ts";
import {
  assertSettlementAuthorized,
  type DecisionSignatureVerifier,
  type EvaluateSecurityRequest,
  type EvaluationReceipt,
  type SignedSecurityDecision,
  type ApprovalLayerService,
} from "./index.ts";

const GENESIS_HASH = `sha256:${"0".repeat(64)}`;

export interface StoredSecurityDecision {
  readonly contractVersion: "1.0";
  readonly organizationId: string;
  readonly decisionId: string;
  readonly correlationId: string;
  readonly storedAt: string;
  readonly signedDecision: SignedSecurityDecision;
  readonly auditEvent: AuditEvent;
  readonly previousRecordHash: string;
  readonly recordHash: string;
}

export interface DecisionJournalIntegrity {
  readonly valid: boolean;
  readonly checkedRecords: number;
  readonly failures: readonly ("RECORD_HASH_MISMATCH" | "PREVIOUS_HASH_MISMATCH" | "MALFORMED_RECORD")[];
}

export interface SecurityDecisionJournal {
  append(input: Omit<StoredSecurityDecision, "contractVersion" | "previousRecordHash" | "recordHash">): Promise<StoredSecurityDecision>;
  get(organizationId: string, decisionId: string): Promise<StoredSecurityDecision | undefined>;
  verifyIntegrity(): Promise<DecisionJournalIntegrity>;
}

export class DecisionJournalConflictError extends Error {
  constructor(message: string) { super(message); this.name = "DecisionJournalConflictError"; }
}

/**
 * Filesystem-backed journal for local operation. Each line is fsynced before
 * it is acknowledged. Production replaces this adapter with a transactional
 * database implementation plus independently retained head anchors.
 */
export class FileSecurityDecisionJournal implements SecurityDecisionJournal {
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (!path || typeof path !== "string") throw new TypeError("journal path is required.");
    this.#path = path;
  }

  async append(input: Omit<StoredSecurityDecision, "contractVersion" | "previousRecordHash" | "recordHash">): Promise<StoredSecurityDecision> {
    return this.serial(async () => {
      validateStoredInput(input);
      const existing = await this.readRecords();
      const duplicate = existing.find((record) => record.organizationId === input.organizationId && record.correlationId === input.correlationId);
      if (duplicate) {
        if (duplicate.signedDecision.decisionDigest === input.signedDecision.decisionDigest) return duplicate;
        throw new DecisionJournalConflictError("correlationId is already bound to a different security decision.");
      }
      const previousRecordHash = existing.at(-1)?.recordHash ?? GENESIS_HASH;
      const recordBase = { contractVersion: "1.0" as const, ...input, previousRecordHash };
      const record = frozen({ ...recordBase, recordHash: sha256Digest(recordBase as unknown as CanonicalValue) });
      await mkdir(dirname(this.#path), { recursive: true });
      const file = await open(this.#path, "a");
      try { await file.writeFile(`${canonicalJson(record as unknown as CanonicalValue)}\n`); await file.sync(); }
      finally { await file.close(); }
      return record;
    });
  }

  async get(organizationId: string, decisionId: string): Promise<StoredSecurityDecision | undefined> {
    requireIdentifier(organizationId, "organizationId", "org_"); requireIdentifier(decisionId, "decisionId", "sec_");
    const records = await this.readRecords(); return records.find((record) => record.organizationId === organizationId && record.decisionId === decisionId);
  }

  async verifyIntegrity(): Promise<DecisionJournalIntegrity> {
    const raw = await this.readRawLines(); const failures = new Set<DecisionJournalIntegrity["failures"][number]>(); let previous = GENESIS_HASH;
    for (const line of raw) {
      try {
        const record = JSON.parse(line) as StoredSecurityDecision;
        if (!isStoredRecord(record)) { failures.add("MALFORMED_RECORD"); continue; }
        if (record.previousRecordHash !== previous) failures.add("PREVIOUS_HASH_MISMATCH");
        const { recordHash: ignored, ...base } = record;
        if (sha256Digest(base as unknown as CanonicalValue) !== record.recordHash) failures.add("RECORD_HASH_MISMATCH");
        previous = record.recordHash;
      } catch { failures.add("MALFORMED_RECORD"); }
    }
    return frozen({ valid: failures.size === 0, checkedRecords: raw.length, failures: frozen([...failures].sort()) });
  }

  private async readRecords(): Promise<readonly StoredSecurityDecision[]> {
    const raw = await this.readRawLines(); const records: StoredSecurityDecision[] = [];
    for (const line of raw) {
      const record = JSON.parse(line) as StoredSecurityDecision;
      if (!isStoredRecord(record)) throw new DecisionJournalConflictError("Security decision journal contains a malformed record.");
      records.push(frozen(record));
    }
    return frozen(records);
  }
  private async readRawLines(): Promise<readonly string[]> {
    try { const content = await readFile(this.#path, "utf8"); return content.split("\n").filter(Boolean); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.#tail; let release: () => void = () => undefined; this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await prior; try { return await work(); } finally { release(); }
  }
}

/** Combines live ApprovalLayer evaluation with durable decision recovery. */
export class DurableSecurityDecisionService {
  readonly #approvalLayer: ApprovalLayerService;
  readonly #journal: SecurityDecisionJournal;
  constructor(approvalLayer: ApprovalLayerService, journal: SecurityDecisionJournal) { this.#approvalLayer = approvalLayer; this.#journal = journal; }

  async evaluate(request: EvaluateSecurityRequest): Promise<EvaluationReceipt & { readonly storedDecision: StoredSecurityDecision }> {
    const receipt = await this.#approvalLayer.evaluate(request);
    const storedDecision = await this.#journal.append({ organizationId: request.organizationId, decisionId: receipt.signedDecision.decision.decisionId, correlationId: request.correlationId, storedAt: receipt.signedDecision.signedAt, signedDecision: receipt.signedDecision, auditEvent: receipt.auditEvent });
    return frozen({ ...receipt, storedDecision });
  }

  async recoverForSettlement(input: { readonly organizationId: string; readonly decisionId: string; readonly intent: unknown; readonly now: string; readonly verifier: DecisionSignatureVerifier }): Promise<StoredSecurityDecision> {
    const stored = await this.#journal.get(input.organizationId, input.decisionId);
    if (!stored) throw new DecisionJournalConflictError("Security decision was not found in the durable journal.");
    assertSettlementAuthorized({ signedDecision: stored.signedDecision, organizationId: input.organizationId, intent: input.intent, now: input.now, verifier: input.verifier });
    return stored;
  }
}

function validateStoredInput(input: Omit<StoredSecurityDecision, "contractVersion" | "previousRecordHash" | "recordHash">): void {
  requireIdentifier(input.organizationId, "organizationId", "org_"); requireIdentifier(input.decisionId, "decisionId", "sec_"); requireIdentifier(input.correlationId, "correlationId", "corr_"); requireTimestamp(input.storedAt, "storedAt");
  if (input.signedDecision.decision.decisionId !== input.decisionId || input.signedDecision.organizationId !== input.organizationId || input.auditEvent.organizationId !== input.organizationId) throw new DecisionJournalConflictError("Durable decision record has mismatched organization or decision identifiers.");
}
function isStoredRecord(value: unknown): value is StoredSecurityDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StoredSecurityDecision>;
  return record.contractVersion === "1.0" && typeof record.organizationId === "string" && typeof record.decisionId === "string" && typeof record.correlationId === "string" && typeof record.storedAt === "string" && typeof record.previousRecordHash === "string" && typeof record.recordHash === "string" && !!record.signedDecision && !!record.auditEvent;
}
function requireIdentifier(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requireTimestamp(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
