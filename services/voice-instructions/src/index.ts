import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { sha256Digest } from "../../../packages/contracts/src/index.ts";

export type VoiceInstructionState = "PREPARED" | "CONFIRMED";
export interface VoiceInstruction {
  readonly voiceInstructionId: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly transcript: string;
  readonly transcriptDigest: string;
  readonly recognition: { readonly engine: "browser-native"; readonly locale: string; readonly confidence?: number };
  readonly consentedAt: string;
  readonly preparedAt: string;
  readonly confirmedAt?: string;
  readonly state: VoiceInstructionState;
  readonly previousRecordHash?: string;
  readonly recordHash: string;
}

export interface VoiceInstructionStore { load(): Promise<readonly VoiceInstruction[]>; save(records: readonly VoiceInstruction[]): Promise<void>; }

/** Local durable store. It retains transcript evidence, never raw microphone audio. */
export class FileVoiceInstructionStore implements VoiceInstructionStore {
  readonly #path: string;
  constructor(path: string) { if (!path) throw new VoiceInstructionError("Voice instruction store path is required."); this.#path = path; }
  async load(): Promise<readonly VoiceInstruction[]> { try { const parsed = JSON.parse(await readFile(this.#path, "utf8")) as unknown; if (!Array.isArray(parsed)) throw new VoiceInstructionError("Voice instruction store is invalid."); return Object.freeze(parsed.map(parse)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]); throw error; } }
  async save(records: readonly VoiceInstruction[]): Promise<void> { await mkdir(dirname(this.#path), { recursive: true }); const next = `${this.#path}.next`; await writeFile(next, JSON.stringify(records), { mode: 0o600 }); await rename(next, this.#path); }
}

export class VoiceInstructionService {
  readonly #store: VoiceInstructionStore; #records = new Map<string, VoiceInstruction>(); #opened = false;
  constructor(store: VoiceInstructionStore) { this.#store = store; }
  async open(): Promise<void> { if (this.#opened) return; const records = await this.#store.load(); let previous: string | undefined; for (const record of records) { if (record.previousRecordHash !== previous || record.recordHash !== hash(record)) throw new VoiceInstructionError("Voice instruction integrity check failed."); this.#records.set(record.voiceInstructionId, record); previous = record.recordHash; } this.#opened = true; }
  async prepare(input: { readonly organizationId: string; readonly principalId: string; readonly sessionId: string; readonly transcript: string; readonly recognition: VoiceInstruction["recognition"]; readonly consentedAt: string }): Promise<VoiceInstruction> {
    await this.open(); requireId(input.organizationId, "organizationId", "org_"); requireId(input.principalId, "principalId", "principal_"); requireId(input.sessionId, "sessionId", "agent_"); const transcript = cleanTranscript(input.transcript); recognition(input.recognition); timestamp(input.consentedAt, "consentedAt");
    const preparedAt = input.consentedAt; const prior = latest(this.#records.values()); const draft = { voiceInstructionId: `voice_${randomUUID().replaceAll("-", "")}`, organizationId: input.organizationId, principalId: input.principalId, sessionId: input.sessionId, transcript, transcriptDigest: sha256Digest({ transcript }), recognition: input.recognition, consentedAt: input.consentedAt, preparedAt, state: "PREPARED" as const, ...(prior ? { previousRecordHash: prior.recordHash } : {}) };
    const record = Object.freeze({ ...draft, recordHash: sha256Digest(draft) }); await this.#persist(record); return record;
  }
  async confirm(input: { readonly voiceInstructionId: string; readonly organizationId: string; readonly principalId: string; readonly transcript: string; readonly confirmedAt: string }): Promise<VoiceInstruction> {
    await this.open(); requireId(input.voiceInstructionId, "voiceInstructionId", "voice_"); requireId(input.organizationId, "organizationId", "org_"); requireId(input.principalId, "principalId", "principal_"); timestamp(input.confirmedAt, "confirmedAt"); const record = this.#records.get(input.voiceInstructionId);
    if (!record || record.organizationId !== input.organizationId || record.principalId !== input.principalId) throw new VoiceInstructionError("Voice instruction was not found."); if (record.state !== "PREPARED") throw new VoiceInstructionError("Voice instruction has already been confirmed."); if (latest(this.#records.values())?.voiceInstructionId !== record.voiceInstructionId) throw new VoiceInstructionError("Voice instruction is no longer current. Record and review a new instruction."); if (cleanTranscript(input.transcript) !== record.transcript) throw new VoiceInstructionError("Transcript changed. Review the edited instruction before confirmation.");
    const updatedDraft = { ...record, state: "CONFIRMED" as const, confirmedAt: input.confirmedAt }; const updated = Object.freeze({ ...updatedDraft, recordHash: hash(updatedDraft) }); await this.#replace(updated); return updated;
  }
  async verifyIntegrity(): Promise<boolean> { try { this.#opened = false; this.#records.clear(); await this.open(); return true; } catch { return false; } }
  async #persist(record: VoiceInstruction): Promise<void> { this.#records.set(record.voiceInstructionId, record); await this.#store.save(Object.freeze([...this.#records.values()].sort((left, right) => left.preparedAt.localeCompare(right.preparedAt)))); }
  async #replace(record: VoiceInstruction): Promise<void> { this.#records.set(record.voiceInstructionId, record); await this.#store.save(Object.freeze([...this.#records.values()].sort((left, right) => left.preparedAt.localeCompare(right.preparedAt)))); }
}

export class VoiceInstructionError extends Error { constructor(message: string) { super(message); this.name = "VoiceInstructionError"; } }
function hash(record: Omit<VoiceInstruction, "recordHash"> | VoiceInstruction): string { const { recordHash: ignored, ...canonical } = record; return sha256Digest(canonical); }
function latest(records: Iterable<VoiceInstruction>): VoiceInstruction | undefined { return [...records].sort((left, right) => left.preparedAt.localeCompare(right.preparedAt)).at(-1); }
function parse(value: unknown): VoiceInstruction { if (!value || typeof value !== "object" || Array.isArray(value)) throw new VoiceInstructionError("Voice instruction is invalid."); const record = value as Partial<VoiceInstruction>; requireId(record.voiceInstructionId, "voiceInstructionId", "voice_"); requireId(record.organizationId, "organizationId", "org_"); requireId(record.principalId, "principalId", "principal_"); requireId(record.sessionId, "sessionId", "agent_"); const transcript = cleanTranscript(record.transcript); recognition(record.recognition); timestamp(record.consentedAt, "consentedAt"); timestamp(record.preparedAt, "preparedAt"); if (record.confirmedAt) timestamp(record.confirmedAt, "confirmedAt"); if (!record.transcriptDigest || !record.recordHash || !["PREPARED", "CONFIRMED"].includes(record.state ?? "")) throw new VoiceInstructionError("Voice instruction is invalid."); return Object.freeze({ ...(record as VoiceInstruction), transcript }); }
function recognition(value: unknown): asserts value is VoiceInstruction["recognition"] { if (!value || typeof value !== "object" || Array.isArray(value)) throw new VoiceInstructionError("Recognition metadata is invalid."); const item = value as Partial<VoiceInstruction["recognition"]>; if (item.engine !== "browser-native" || typeof item.locale !== "string" || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(item.locale) || (item.confidence !== undefined && (typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1))) throw new VoiceInstructionError("Recognition metadata is invalid."); }
function cleanTranscript(value: unknown): string { if (typeof value !== "string") throw new VoiceInstructionError("Transcript is required."); const transcript = value.trim().replace(/\s+/gu, " "); if (transcript.length < 4 || transcript.length > 2000) throw new VoiceInstructionError("Transcript must be between 4 and 2,000 characters."); return transcript; }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/u.test(value)) throw new VoiceInstructionError(`${name} is invalid.`); }
function timestamp(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new VoiceInstructionError(`${name} is invalid.`); }
