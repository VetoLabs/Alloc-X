import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, sha256Digest, type CanonicalValue } from "../../../packages/contracts/src/index.ts";
import { type OfflineVaultPayload } from "../../offline-device-trust/src/index.ts";

export type SyncItemState = "SYNCED" | "DUPLICATE" | "CONFLICT" | "RESOLVED_DISCARDED" | "RESOLVED_REPREPARE_ONLINE";
export type ConflictKind = "AMOUNT_CHANGED" | "DESTINATION_CHANGED" | "POLICY_CHANGED" | "APPROVAL_REQUIRED" | "ALLOCATION_CHANGED" | "REFERENCE_MISSING" | "UNSUPPORTED_OFFLINE_RECORD" | "OPERATION_MUTATED";
export interface SynchronizationPreflight { readonly allowed: boolean; readonly blockers: readonly string[]; }
export interface OnlineReferenceState { readonly policyVersion: string; readonly obligations: Readonly<Record<string, { readonly amount: string }>>; readonly allocations: Readonly<Record<string, { readonly version: string }>>; readonly beneficiaries: Readonly<Record<string, { readonly version: string; readonly destinationVersion: string; readonly active: boolean }>>; }
export interface SynchronizationConflict { readonly conflictId: string; readonly operationId: string; readonly kind: ConflictKind; readonly detail: string; readonly detectedAt: string; readonly state: "OPEN" | "RESOLVED"; readonly resolvedAt?: string; readonly resolution?: "DISCARD" | "REPREPARE_ONLINE"; readonly resolvedByPrincipalId?: string; }
export interface SynchronizationItem { readonly operationId: string; readonly operationDigest: string; readonly serverSequence: number; readonly state: SyncItemState; readonly receivedAt: string; readonly conflictId?: string; }
export interface SynchronizationState { readonly contractVersion: "1.0"; readonly nextSequence: number; readonly items: readonly SynchronizationItem[]; readonly conflicts: readonly SynchronizationConflict[]; }
export interface SynchronizationStore { load(): Promise<SynchronizationState | undefined>; save(state: SynchronizationState): Promise<void>; }
export class FileSynchronizationStore implements SynchronizationStore {
  readonly #path: string;
  constructor(path: string) { this.#path = path; }
  async load(): Promise<SynchronizationState | undefined> { try { return JSON.parse(await readFile(this.#path, "utf8")) as SynchronizationState; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  async save(state: SynchronizationState): Promise<void> { await mkdir(dirname(this.#path), { recursive: true }); const next = `${this.#path}.next`; await writeFile(next, canonicalJson(state as unknown as CanonicalValue), { mode: 0o600 }); await rename(next, this.#path); }
}

export class OfflineSynchronizationService {
  readonly #store: SynchronizationStore; #state: SynchronizationState = frozen({ contractVersion: "1.0", nextSequence: 1, items: frozen([]), conflicts: frozen([]) }); #opened = false; #tail: Promise<void> = Promise.resolve();
  constructor(store: SynchronizationStore) { this.#store = store; }
  async open(): Promise<void> { if (this.#opened) return; const saved = await this.#store.load(); if (saved) validateState(saved); this.#state = saved ? freezeState(saved) : this.#state; this.#opened = true; }
  snapshot(): SynchronizationState { return this.#state; }

  async synchronize(input: { readonly vault: OfflineVaultPayload; readonly preflight: SynchronizationPreflight; readonly references: OnlineReferenceState; readonly receivedAt: string }): Promise<readonly SynchronizationItem[]> {
    return this.serial(async () => { await this.open(); timestamp(input.receivedAt); if (!input.preflight.allowed) throw new OfflineSynchronizationError("PREFLIGHT_DENIED", `Synchronization is blocked: ${input.preflight.blockers.join(", ") || "unknown reason"}.`); validateReferences(input.references); assertVaultPairs(input.vault);
      const ordered = input.vault.journal.map((entry, index) => ({ entry, record: input.vault.records[index]! })).sort((left, right) => left.entry.occurredAt.localeCompare(right.entry.occurredAt) || left.entry.entryDigest.localeCompare(right.entry.entryDigest));
      const results: SynchronizationItem[] = [];
      for (const item of ordered) {
        const digest = sha256Digest({ operationId: item.entry.operationId, entryDigest: item.entry.entryDigest, payloadDigest: item.entry.payloadDigest } as unknown as CanonicalValue);
        const existing = this.#state.items.find((value) => value.operationId === item.entry.operationId);
        if (existing) {
          if (existing.operationDigest !== digest) { results.push(await this.recordConflict(item.entry.operationId, digest, "OPERATION_MUTATED", "An existing offline operation arrived with a different signed content digest.", input.receivedAt)); continue; }
          results.push(frozen({ ...existing, state: "DUPLICATE" })); continue;
        }
        const conflict = detectConflict(item.record.payload, item.record.operation, input.references);
        if (conflict) results.push(await this.recordConflict(item.entry.operationId, digest, conflict.kind, conflict.detail, input.receivedAt));
        else results.push(await this.recordSynced(item.entry.operationId, digest, input.receivedAt));
      }
      return frozen(results);
    });
  }

  async resolveConflict(input: { readonly conflictId: string; readonly resolution: "DISCARD" | "REPREPARE_ONLINE"; readonly resolvedByPrincipalId: string; readonly resolvedAt: string }): Promise<SynchronizationConflict> {
    return this.serial(async () => { await this.open(); id(input.conflictId, "sync_conflict_"); id(input.resolvedByPrincipalId, "principal_"); timestamp(input.resolvedAt); const conflict = this.#state.conflicts.find((item) => item.conflictId === input.conflictId); if (!conflict) throw new OfflineSynchronizationError("CONFLICT_NOT_FOUND", "Synchronization conflict was not found."); if (conflict.state === "RESOLVED") return conflict; const resolved = frozen({ ...conflict, state: "RESOLVED" as const, resolution: input.resolution, resolvedByPrincipalId: input.resolvedByPrincipalId, resolvedAt: input.resolvedAt }); const item = this.#state.items.find((value) => value.operationId === conflict.operationId)!; const nextItem = frozen({ ...item, state: input.resolution === "DISCARD" ? "RESOLVED_DISCARDED" as const : "RESOLVED_REPREPARE_ONLINE" as const }); await this.persist({ ...this.#state, items: this.#state.items.map((value) => value.operationId === item.operationId ? nextItem : value), conflicts: this.#state.conflicts.map((value) => value.conflictId === conflict.conflictId ? resolved : value) }); return resolved;
    });
  }

  private async recordSynced(operationId: string, operationDigest: string, receivedAt: string): Promise<SynchronizationItem> { const item = frozen({ operationId, operationDigest, serverSequence: this.#state.nextSequence, state: "SYNCED" as const, receivedAt }); await this.persist({ ...this.#state, nextSequence: this.#state.nextSequence + 1, items: [...this.#state.items, item] }); return item; }
  private async recordConflict(operationId: string, operationDigest: string, kind: ConflictKind, detail: string, detectedAt: string): Promise<SynchronizationItem> { const conflictId = `sync_conflict_${sha256Digest({ operationId, operationDigest, kind } as unknown as CanonicalValue).slice(7, 31)}`; const conflict = frozen({ conflictId, operationId, kind, detail, detectedAt, state: "OPEN" as const }); const item = frozen({ operationId, operationDigest, serverSequence: this.#state.nextSequence, state: "CONFLICT" as const, receivedAt: detectedAt, conflictId }); await this.persist({ ...this.#state, nextSequence: this.#state.nextSequence + 1, items: [...this.#state.items, item], conflicts: [...this.#state.conflicts, conflict] }); return item; }
  private async persist(state: SynchronizationState): Promise<void> { this.#state = freezeState(state); await this.#store.save(this.#state); }
  private async serial<T>(work: () => Promise<T>): Promise<T> { const previous = this.#tail; let release: () => void = () => undefined; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await work(); } finally { release(); } }
}

export class OfflineSynchronizationError extends Error { readonly code: "PREFLIGHT_DENIED" | "CONFLICT_NOT_FOUND" | "INVALID_SYNC"; constructor(code: "PREFLIGHT_DENIED" | "CONFLICT_NOT_FOUND" | "INVALID_SYNC", message: string) { super(message); this.name = "OfflineSynchronizationError"; this.code = code; } }

function detectConflict(payload: CanonicalValue, operation: string, references: OnlineReferenceState): { readonly kind: ConflictKind; readonly detail: string } | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "UNSUPPORTED_OFFLINE_RECORD", detail: "Offline record is malformed." }; const value = payload as Record<string, CanonicalValue>;
  if (operation === "PAYMENT_PREPARE") { if (value.kind !== "prepared-offline-payment" || value.state !== "PREPARED_OFFLINE" || value.requiresOnlineRevalidation !== true || value.settlementStatus !== "NOT_SUBMITTED") return { kind: "APPROVAL_REQUIRED", detail: "Payment preparation does not preserve the required online approval boundary." }; const obligation = references.obligations[string(value.obligationId)]; if (!obligation) return { kind: "REFERENCE_MISSING", detail: "The referenced obligation is no longer available online." }; if (obligation.amount !== value.requestedAmount) return { kind: "AMOUNT_CHANGED", detail: "The authoritative obligation amount differs from the offline preparation." }; if (string(value.policyVersion) !== references.policyVersion) return { kind: "POLICY_CHANGED", detail: "The payment policy changed while the device was offline." }; const beneficiary = references.beneficiaries[string(value.beneficiaryId)]; if (!beneficiary || !beneficiary.active) return { kind: "REFERENCE_MISSING", detail: "The referenced beneficiary is unavailable or inactive." }; if (beneficiary.version !== value.beneficiaryVersion || beneficiary.destinationVersion !== value.beneficiaryDestinationVersion) return { kind: "DESTINATION_CHANGED", detail: "The beneficiary or destination version changed while offline." }; return { kind: "APPROVAL_REQUIRED", detail: "Payment preparation is synchronized as non-executable work and requires AX-063 online revalidation." }; }
  if (operation === "ALLOCATION_DRAFT") { const allocation = references.allocations[string(value.allocationId)]; if (!allocation) return { kind: "REFERENCE_MISSING", detail: "The referenced allocation is no longer available online." }; if (allocation.version !== value.allocationVersion) return { kind: "ALLOCATION_CHANGED", detail: "The allocation version changed while offline." }; return undefined; }
  if (operation === "CACHE_WRITE" || operation === "OBLIGATION_CAPTURE" || operation === "EVIDENCE_CAPTURE") return undefined;
  return { kind: "UNSUPPORTED_OFFLINE_RECORD", detail: "Offline operation is not supported by synchronization." };
}
function assertVaultPairs(vault: OfflineVaultPayload): void { if (vault.records.length !== vault.journal.length) throw new OfflineSynchronizationError("INVALID_SYNC", "Offline records and signed journal entries do not match."); for (let index = 0; index < vault.records.length; index += 1) { const record = vault.records[index]!; const entry = vault.journal[index]!; if (record.operationId !== entry.operationId || record.operation !== entry.operation || record.payloadDigest !== entry.payloadDigest || record.occurredAt !== entry.occurredAt) throw new OfflineSynchronizationError("INVALID_SYNC", "Offline record is not bound to its signed journal entry."); } }
function validateReferences(value: OnlineReferenceState): void { nonEmpty(value.policyVersion); if (!value.obligations || !value.allocations || !value.beneficiaries) throw new OfflineSynchronizationError("INVALID_SYNC", "Online references are required."); }
function validateState(value: SynchronizationState): void { if (value.contractVersion !== "1.0" || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1 || !Array.isArray(value.items) || !Array.isArray(value.conflicts)) throw new OfflineSynchronizationError("INVALID_SYNC", "Synchronization state is invalid."); }
function freezeState(value: SynchronizationState): SynchronizationState { return frozen({ contractVersion: "1.0", nextSequence: value.nextSequence, items: frozen(value.items.map((item) => frozen({ ...item }))), conflicts: frozen(value.conflicts.map((item) => frozen({ ...item }))) }); }
function id(value: string, prefix: string): void { if (!value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new OfflineSynchronizationError("INVALID_SYNC", "Identifier is invalid."); }
function timestamp(value: string): void { if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new OfflineSynchronizationError("INVALID_SYNC", "Timestamp is invalid."); }
function nonEmpty(value: string): void { if (typeof value !== "string" || !value.trim()) throw new OfflineSynchronizationError("INVALID_SYNC", "Reference value is invalid."); }
function string(value: CanonicalValue | undefined): string { return typeof value === "string" ? value : ""; }
function frozen<T>(value: T): T { return Object.freeze(value); }
