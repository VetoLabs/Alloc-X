import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, sha256Digest, type CanonicalValue } from "../../../packages/contracts/src/index.ts";

const GENESIS_DIGEST = `sha256:${"0".repeat(64)}`;
const MAX_GRANT_MILLISECONDS = 8 * 60 * 60 * 1_000;
const MAX_OPERATION_BYTES = 1_048_576;

export type OfflineOperationType = "CACHE_WRITE" | "OBLIGATION_CAPTURE" | "EVIDENCE_CAPTURE" | "ALLOCATION_DRAFT" | "PAYMENT_PREPARE";
export type DeviceTrustDuty = "device-administrator" | "offline-authority" | "device-user" | "allocation-agent";
export interface DeviceTrustActor { readonly principalId: string; readonly duty: DeviceTrustDuty; }

export interface SealedDevicePayload { readonly algorithm: "aes-256-gcm"; readonly iv: string; readonly authenticationTag: string; readonly ciphertext: string; }
export interface DeviceKeyProvider {
  readonly deviceId: string;
  readonly keyReference: string;
  readonly publicSigningKeyPem: string;
  seal(plaintext: Uint8Array, additionalData: Uint8Array): Promise<SealedDevicePayload>;
  open(payload: SealedDevicePayload, additionalData: Uint8Array): Promise<Uint8Array>;
  signDigest(digest: string): Promise<string>;
  destroyKey(): Promise<void>;
}

export interface DeviceEnrollment {
  readonly deviceId: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly keyReference: string;
  readonly publicSigningKeyPem: string;
  readonly platformAttestationDigest: string;
  readonly enrolledAt: string;
  readonly enrolledByPrincipalId: string;
  readonly status: "ACTIVE" | "REVOKED";
  readonly revokedAt?: string;
  readonly revocationReasonDigest?: string;
}

export interface OfflineAuthorizationGrant {
  readonly contractVersion: "1.0";
  readonly grantId: string;
  readonly deviceId: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly allowedOperations: readonly OfflineOperationType[];
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly maxJournalEntries: number;
  readonly issuerPrincipalId: string;
  readonly signerKeyId: string;
  readonly grantDigest: string;
  readonly signature: string;
}

export interface OfflineJournalEntry {
  readonly contractVersion: "1.0";
  readonly operationId: string;
  readonly deviceId: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly grantId: string;
  readonly operation: OfflineOperationType;
  readonly payloadDigest: string;
  readonly occurredAt: string;
  readonly previousEntryDigest: string;
  readonly entryDigest: string;
  readonly deviceSignature: string;
}

export interface OfflineRecord { readonly operationId: string; readonly operation: OfflineOperationType; readonly payload: CanonicalValue; readonly payloadDigest: string; readonly occurredAt: string; }
export interface OfflineVaultPayload {
  readonly contractVersion: "1.0";
  readonly enrollment: DeviceEnrollment;
  readonly grant: OfflineAuthorizationGrant;
  readonly records: readonly OfflineRecord[];
  readonly journal: readonly OfflineJournalEntry[];
  readonly lastObservedAt: string;
}
export interface EncryptedOfflineVaultFile {
  readonly contractVersion: "1.0";
  readonly deviceId: string;
  readonly organizationId: string;
  readonly keyReference: string;
  readonly algorithm: "aes-256-gcm";
  readonly updatedAt: string;
  readonly sealed: SealedDevicePayload;
}

export interface OfflineGrantSigner { readonly keyId: string; signDigest(digest: string): string; }
export interface OfflineGrantVerifier { readonly keyId: string; verifyDigest(digest: string, signature: string): boolean; }

export function createEd25519OfflineGrantSigner(keyId: string, privateKey: KeyObject | string): OfflineGrantSigner {
  signerKeyId(keyId); const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey; if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new TypeError("Offline grant signer requires an Ed25519 private key.");
  return frozen({ keyId, signDigest: (digestValue: string) => { digest(digestValue); return sign(null, Buffer.from(digestValue, "utf8"), key).toString("base64"); } });
}
export function createEd25519OfflineGrantVerifier(keyId: string, publicKey: KeyObject | string): OfflineGrantVerifier {
  signerKeyId(keyId); const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey; if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new TypeError("Offline grant verifier requires an Ed25519 public key.");
  return frozen({ keyId, verifyDigest: (digestValue: string, signature: string) => { if (!validDigest(digestValue) || !validSignature(signature)) return false; return verify(null, Buffer.from(digestValue, "utf8"), key, Buffer.from(signature, "base64")); } });
}

export interface DeviceTrustState { readonly contractVersion: "1.0"; readonly devices: readonly DeviceEnrollment[]; }
export interface DeviceTrustStore { load(): Promise<DeviceTrustState | undefined>; save(state: DeviceTrustState): Promise<void>; }
export class FileDeviceTrustStore implements DeviceTrustStore {
  readonly #path: string;
  constructor(path: string) { if (!path) throw new TypeError("Device trust state path is required."); this.#path = path; }
  async load(): Promise<DeviceTrustState | undefined> { try { return JSON.parse(await readFile(this.#path, "utf8")) as DeviceTrustState; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  async save(state: DeviceTrustState): Promise<void> { await mkdir(dirname(this.#path), { recursive: true }); const next = `${this.#path}.next`; await writeFile(next, canonicalJson(state as unknown as CanonicalValue), { mode: 0o600 }); await rename(next, this.#path); }
}

export interface SynchronizationAssessment { readonly allowed: boolean; readonly blockers: readonly string[]; readonly checkedEntries: number; readonly journalHead: string; }

export class DeviceTrustService {
  readonly #store: DeviceTrustStore; readonly #signer: OfflineGrantSigner; readonly #verifier: OfflineGrantVerifier; #state: DeviceTrustState = frozen({ contractVersion: "1.0", devices: frozen([]) }); #opened = false; #tail: Promise<void> = Promise.resolve();
  constructor(input: { readonly store: DeviceTrustStore; readonly grantSigner: OfflineGrantSigner; readonly grantVerifier: OfflineGrantVerifier }) { if (input.grantSigner.keyId !== input.grantVerifier.keyId) throw new TypeError("Offline grant signer and verifier key IDs must match."); this.#store = input.store; this.#signer = input.grantSigner; this.#verifier = input.grantVerifier; }
  async open(): Promise<void> { if (this.#opened) return; const stored = await this.#store.load(); if (stored) { validateTrustState(stored); this.#state = freezeTrustState(stored); } this.#opened = true; }
  snapshot(): DeviceTrustState { return this.#state; }

  async enroll(input: Omit<DeviceEnrollment, "enrolledByPrincipalId" | "status"> & { readonly actor: DeviceTrustActor }): Promise<DeviceEnrollment> {
    return this.serial(async () => { await this.open(); requireDuty(input.actor, "device-administrator"); validateEnrollment({ ...input, enrolledByPrincipalId: input.actor.principalId, status: "ACTIVE" }); const existing = this.#state.devices.find((item) => item.deviceId === input.deviceId); if (existing) { if (existing.keyReference === input.keyReference && existing.platformAttestationDigest === input.platformAttestationDigest) return existing; throw new OfflineDeviceTrustError("DEVICE_CONFLICT", "Device ID is already bound to another key or attestation."); } const enrollment = frozen({ ...input, enrolledByPrincipalId: input.actor.principalId, status: "ACTIVE" as const }); await this.persist({ ...this.#state, devices: [...this.#state.devices, enrollment] }); return enrollment; });
  }
  async revoke(input: { readonly deviceId: string; readonly actor: DeviceTrustActor; readonly reasonDigest: string; readonly revokedAt: string }): Promise<DeviceEnrollment> {
    return this.serial(async () => { await this.open(); requireDuty(input.actor, "device-administrator"); id(input.deviceId, "device_"); digest(input.reasonDigest); time(input.revokedAt); const current = requiredDevice(this.#state, input.deviceId); if (current.status === "REVOKED") return current; const revoked = frozen({ ...current, status: "REVOKED" as const, revokedAt: input.revokedAt, revocationReasonDigest: input.reasonDigest }); await this.persist({ ...this.#state, devices: this.#state.devices.map((item) => item.deviceId === input.deviceId ? revoked : item) }); return revoked; });
  }
  async issueGrant(input: { readonly grantId: string; readonly deviceId: string; readonly actor: DeviceTrustActor; readonly principalId: string; readonly allowedOperations: readonly OfflineOperationType[]; readonly issuedAt: string; readonly notBefore: string; readonly expiresAt: string; readonly maxJournalEntries: number }): Promise<OfflineAuthorizationGrant> {
    return this.serial(async () => { await this.open(); requireDuty(input.actor, "offline-authority"); id(input.grantId, "offline_grant_"); id(input.deviceId, "device_"); id(input.principalId, "principal_"); time(input.issuedAt); time(input.notBefore); time(input.expiresAt); const enrollment = requiredDevice(this.#state, input.deviceId); if (enrollment.status !== "ACTIVE" || enrollment.principalId !== input.principalId) throw new OfflineDeviceTrustError("DEVICE_REVOKED", "Only an active device bound to this principal can receive an offline grant."); if (Date.parse(input.notBefore) < Date.parse(input.issuedAt) || Date.parse(input.expiresAt) <= Date.parse(input.notBefore) || Date.parse(input.expiresAt) - Date.parse(input.notBefore) > MAX_GRANT_MILLISECONDS) throw new OfflineDeviceTrustError("GRANT_INVALID", "Offline authorization window is invalid or exceeds eight hours."); const allowedOperations = operations(input.allowedOperations); if (!Number.isSafeInteger(input.maxJournalEntries) || input.maxJournalEntries < 1 || input.maxJournalEntries > 1_000) throw new OfflineDeviceTrustError("GRANT_INVALID", "Offline journal-entry limit is invalid."); const base = { contractVersion: "1.0" as const, grantId: input.grantId, deviceId: input.deviceId, organizationId: enrollment.organizationId, principalId: input.principalId, allowedOperations, issuedAt: input.issuedAt, notBefore: input.notBefore, expiresAt: input.expiresAt, maxJournalEntries: input.maxJournalEntries, issuerPrincipalId: input.actor.principalId, signerKeyId: this.#signer.keyId }; const grantDigest = sha256Digest(base as unknown as CanonicalValue); return frozen({ ...base, grantDigest, signature: this.#signer.signDigest(grantDigest) }); });
  }
  assessSynchronization(input: { readonly grant: OfflineAuthorizationGrant; readonly journal: readonly OfflineJournalEntry[]; readonly now: string }): SynchronizationAssessment {
    time(input.now); const blockers: string[] = []; let enrollment: DeviceEnrollment | undefined; try { enrollment = requiredDevice(this.#state, input.grant.deviceId); } catch { blockers.push("DEVICE_NOT_ENROLLED"); }
    if (enrollment?.status !== "ACTIVE") blockers.push("DEVICE_REVOKED"); if (enrollment && (enrollment.organizationId !== input.grant.organizationId || enrollment.principalId !== input.grant.principalId || enrollment.publicSigningKeyPem !== journalPublicKey(input.grant.deviceId, this.#state))) blockers.push("DEVICE_BINDING_MISMATCH");
    if (!verifyGrant(input.grant, this.#verifier)) blockers.push("OFFLINE_GRANT_INVALID"); if (Date.parse(input.now) < Date.parse(input.grant.notBefore) || Date.parse(input.now) >= Date.parse(input.grant.expiresAt)) blockers.push("OFFLINE_GRANT_EXPIRED");
    const journalResult = enrollment ? verifyOfflineJournal({ entries: input.journal, enrollment, grant: input.grant }) : { valid: false, head: GENESIS_DIGEST, failures: ["DEVICE_NOT_ENROLLED"] as readonly string[] }; if (!journalResult.valid) blockers.push(...journalResult.failures); if (input.journal.length > input.grant.maxJournalEntries) blockers.push("JOURNAL_LIMIT_EXCEEDED");
    return frozen({ allowed: blockers.length === 0, blockers: frozen([...new Set(blockers)]), checkedEntries: input.journal.length, journalHead: journalResult.head });
  }
  private async persist(state: DeviceTrustState): Promise<void> { this.#state = freezeTrustState(state); await this.#store.save(this.#state); }
  private async serial<T>(work: () => Promise<T>): Promise<T> { const prior = this.#tail; let release: () => void = () => undefined; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior; try { return await work(); } finally { release(); } }
}

export class EncryptedOfflineVault {
  readonly #path: string; readonly #keys: DeviceKeyProvider; readonly #grantVerifier: OfflineGrantVerifier; #payload?: OfflineVaultPayload; #tail: Promise<void> = Promise.resolve();
  constructor(input: { readonly path: string; readonly keyProvider: DeviceKeyProvider; readonly grantVerifier: OfflineGrantVerifier }) { if (!input.path) throw new TypeError("Offline vault path is required."); this.#path = input.path; this.#keys = input.keyProvider; this.#grantVerifier = input.grantVerifier; }
  async create(input: { readonly enrollment: DeviceEnrollment; readonly grant: OfflineAuthorizationGrant; readonly now: string }): Promise<void> { return this.serial(async () => { time(input.now); validateEnrollment(input.enrollment); validateProvider(this.#keys); if (input.enrollment.status !== "ACTIVE" || input.enrollment.deviceId !== this.#keys.deviceId || input.enrollment.keyReference !== this.#keys.keyReference || input.enrollment.publicSigningKeyPem !== this.#keys.publicSigningKeyPem) throw new OfflineDeviceTrustError("DEVICE_BINDING_MISMATCH", "Vault key provider does not match the enrolled device."); if (!verifyGrant(input.grant, this.#grantVerifier) || input.grant.deviceId !== input.enrollment.deviceId || input.grant.organizationId !== input.enrollment.organizationId || input.grant.principalId !== input.enrollment.principalId) throw new OfflineDeviceTrustError("GRANT_INVALID", "Offline grant does not match this enrolled device."); assertGrantActive(input.grant, input.now); this.#payload = freezePayload({ contractVersion: "1.0", enrollment: input.enrollment, grant: input.grant, records: [], journal: [], lastObservedAt: input.now }); await this.save(input.now); }); }
  async open(): Promise<void> { return this.serial(async () => { const envelope = parseEnvelope(JSON.parse(await readFile(this.#path, "utf8")) as unknown); validateProvider(this.#keys); if (envelope.deviceId !== this.#keys.deviceId || envelope.keyReference !== this.#keys.keyReference) throw new OfflineDeviceTrustError("DEVICE_BINDING_MISMATCH", "Copied vault cannot be opened by this device key."); let plaintext: Uint8Array; try { plaintext = await this.#keys.open(envelope.sealed, aad(envelope)); } catch { throw new OfflineDeviceTrustError("DEVICE_BINDING_MISMATCH", "Copied or altered vault cannot be opened by this device key."); } let parsed: unknown; try { parsed = JSON.parse(Buffer.from(plaintext).toString("utf8")); } catch { throw new OfflineDeviceTrustError("VAULT_TAMPERED", "Offline vault plaintext is invalid."); } const payload = validatePayload(parsed, this.#grantVerifier, this.#keys); this.#payload = freezePayload(payload); }); }
  snapshot(): OfflineVaultPayload { if (!this.#payload) throw new OfflineDeviceTrustError("VAULT_LOCKED", "Offline vault is not open."); return this.#payload; }
  async appendOperation(input: { readonly operationId: string; readonly operation: OfflineOperationType; readonly payload: CanonicalValue; readonly actor: DeviceTrustActor; readonly occurredAt: string }): Promise<OfflineJournalEntry> {
    return this.serial(async () => { const current = this.snapshot(); requireDuty(input.actor, "device-user"); id(input.operationId, "offline_operation_"); time(input.occurredAt); if (input.actor.principalId !== current.enrollment.principalId) throw new OfflineDeviceTrustError("DEVICE_BINDING_MISMATCH", "Offline operation principal does not own this device."); assertMonotonic(current.lastObservedAt, input.occurredAt); assertGrantActive(current.grant, input.occurredAt); if (!current.grant.allowedOperations.includes(input.operation)) throw new OfflineDeviceTrustError("OPERATION_NOT_ALLOWED", "Offline grant does not allow this operation."); if (current.journal.length >= current.grant.maxJournalEntries) throw new OfflineDeviceTrustError("JOURNAL_LIMIT_EXCEEDED", "Offline journal-entry limit has been reached."); if (current.journal.some((item) => item.operationId === input.operationId)) throw new OfflineDeviceTrustError("DEVICE_CONFLICT", "Offline operation ID already exists."); const safePayload = safeCanonicalPayload(input.payload); const payloadDigest = sha256Digest(safePayload); const base = { contractVersion: "1.0" as const, operationId: input.operationId, deviceId: current.enrollment.deviceId, organizationId: current.enrollment.organizationId, principalId: current.enrollment.principalId, grantId: current.grant.grantId, operation: input.operation, payloadDigest, occurredAt: input.occurredAt, previousEntryDigest: current.journal.at(-1)?.entryDigest ?? GENESIS_DIGEST }; const entryDigest = sha256Digest(base as unknown as CanonicalValue); const entry = frozen({ ...base, entryDigest, deviceSignature: await this.#keys.signDigest(entryDigest) }); const record = frozen({ operationId: input.operationId, operation: input.operation, payload: safePayload, payloadDigest, occurredAt: input.occurredAt }); this.#payload = freezePayload({ ...current, records: [...current.records, record], journal: [...current.journal, entry], lastObservedAt: input.occurredAt }); await this.save(input.occurredAt); return entry; });
  }
  verifyJournal(): { readonly valid: boolean; readonly head: string; readonly failures: readonly string[] } { const current = this.snapshot(); return verifyOfflineJournal({ entries: current.journal, enrollment: current.enrollment, grant: current.grant }); }
  async secureWipe(input: { readonly actor: DeviceTrustActor; readonly reasonDigest: string; readonly wipedAt: string }): Promise<{ readonly deviceId: string; readonly keyReference: string; readonly reasonDigest: string; readonly wipedAt: string; readonly wipeSignature: string }> {
    return this.serial(async () => { const current = this.snapshot(); requireDuty(input.actor, "device-user"); if (input.actor.principalId !== current.enrollment.principalId) throw new OfflineDeviceTrustError("DEVICE_BINDING_MISMATCH", "Only the device owner can wipe this offline vault."); digest(input.reasonDigest); time(input.wipedAt); const receiptBase = { deviceId: current.enrollment.deviceId, keyReference: current.enrollment.keyReference, reasonDigest: input.reasonDigest, wipedAt: input.wipedAt }; const wipeSignature = await this.#keys.signDigest(sha256Digest(receiptBase as unknown as CanonicalValue)); await this.#keys.destroyKey(); await bestEffortOverwriteAndDelete(this.#path); this.#payload = undefined; return frozen({ ...receiptBase, wipeSignature }); });
  }
  private async save(updatedAt: string): Promise<void> { const payload = this.snapshot(); const base = { contractVersion: "1.0" as const, deviceId: payload.enrollment.deviceId, organizationId: payload.enrollment.organizationId, keyReference: payload.enrollment.keyReference, algorithm: "aes-256-gcm" as const, updatedAt }; const sealed = await this.#keys.seal(Buffer.from(canonicalJson(payload as unknown as CanonicalValue), "utf8"), aad(base)); const envelope = frozen({ ...base, sealed }); await mkdir(dirname(this.#path), { recursive: true }); const next = `${this.#path}.next`; await writeFile(next, canonicalJson(envelope as unknown as CanonicalValue), { mode: 0o600 }); await rename(next, this.#path); }
  private async serial<T>(work: () => Promise<T>): Promise<T> { const prior = this.#tail; let release: () => void = () => undefined; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior; try { return await work(); } finally { release(); } }
}

export class OfflineDeviceTrustError extends Error {
  readonly code: "DEVICE_CONFLICT" | "DEVICE_REVOKED" | "DEVICE_BINDING_MISMATCH" | "GRANT_INVALID" | "GRANT_EXPIRED" | "CLOCK_ROLLBACK" | "OPERATION_NOT_ALLOWED" | "JOURNAL_LIMIT_EXCEEDED" | "VAULT_TAMPERED" | "VAULT_LOCKED" | "WIPE_FAILED" | "SEPARATION_OF_DUTIES";
  constructor(code: OfflineDeviceTrustError["code"], message: string) { super(message); this.name = "OfflineDeviceTrustError"; this.code = code; }
}

export function verifyOfflineJournal(input: { readonly entries: readonly OfflineJournalEntry[]; readonly enrollment: DeviceEnrollment; readonly grant: OfflineAuthorizationGrant }): { readonly valid: boolean; readonly head: string; readonly failures: readonly string[] } {
  const failures: string[] = []; const operationIds = new Set<string>(); let previous = GENESIS_DIGEST; let previousTime = input.grant.notBefore; let publicKey: KeyObject; try { publicKey = createPublicKey(input.enrollment.publicSigningKeyPem); } catch { return frozen({ valid: false, head: previous, failures: frozen(["DEVICE_PUBLIC_KEY_INVALID"]) }); }
  for (const entry of input.entries) { try { const { entryDigest, deviceSignature, ...base } = entry; id(entry.operationId, "offline_operation_"); digest(entry.payloadDigest); digest(entry.previousEntryDigest); digest(entry.entryDigest); time(entry.occurredAt); if (entry.contractVersion !== "1.0" || operationIds.has(entry.operationId)) failures.push("JOURNAL_ENTRY_MALFORMED"); operationIds.add(entry.operationId); if (entry.previousEntryDigest !== previous) failures.push("JOURNAL_PREVIOUS_DIGEST_MISMATCH"); if (sha256Digest(base as unknown as CanonicalValue) !== entryDigest) failures.push("JOURNAL_ENTRY_DIGEST_MISMATCH"); if (!validSignature(deviceSignature) || !verify(null, Buffer.from(entryDigest, "utf8"), publicKey, Buffer.from(deviceSignature, "base64"))) failures.push("JOURNAL_SIGNATURE_INVALID"); if (entry.deviceId !== input.enrollment.deviceId || entry.organizationId !== input.enrollment.organizationId || entry.principalId !== input.enrollment.principalId || entry.grantId !== input.grant.grantId) failures.push("JOURNAL_DEVICE_BINDING_MISMATCH"); if (!input.grant.allowedOperations.includes(entry.operation)) failures.push("JOURNAL_OPERATION_NOT_ALLOWED"); if (Date.parse(entry.occurredAt) < Date.parse(previousTime) || Date.parse(entry.occurredAt) < Date.parse(input.grant.notBefore) || Date.parse(entry.occurredAt) >= Date.parse(input.grant.expiresAt)) failures.push("JOURNAL_TIME_INVALID"); previous = entryDigest; previousTime = entry.occurredAt; } catch { failures.push("JOURNAL_ENTRY_MALFORMED"); } }
  return frozen({ valid: failures.length === 0, head: previous, failures: frozen([...new Set(failures)]) });
}

function verifyGrant(grant: OfflineAuthorizationGrant, verifier: OfflineGrantVerifier): boolean { try { const { grantDigest, signature, ...base } = grant; return grant.signerKeyId === verifier.keyId && sha256Digest(base as unknown as CanonicalValue) === grantDigest && verifier.verifyDigest(grantDigest, signature); } catch { return false; } }
function validatePayload(input: unknown, verifier: OfflineGrantVerifier, provider: DeviceKeyProvider): OfflineVaultPayload { if (!input || typeof input !== "object" || Array.isArray(input)) throw new OfflineDeviceTrustError("VAULT_TAMPERED", "Offline vault payload is malformed."); const value = input as OfflineVaultPayload; if (value.contractVersion !== "1.0" || !Array.isArray(value.records) || !Array.isArray(value.journal)) throw new OfflineDeviceTrustError("VAULT_TAMPERED", "Offline vault payload is malformed."); validateEnrollment(value.enrollment); if (value.enrollment.deviceId !== provider.deviceId || value.enrollment.keyReference !== provider.keyReference || value.enrollment.publicSigningKeyPem !== provider.publicSigningKeyPem || !verifyGrant(value.grant, verifier) || value.grant.deviceId !== value.enrollment.deviceId || value.grant.organizationId !== value.enrollment.organizationId || value.grant.principalId !== value.enrollment.principalId) throw new OfflineDeviceTrustError("DEVICE_BINDING_MISMATCH", "Offline vault device or grant binding is invalid."); time(value.lastObservedAt); const journal = verifyOfflineJournal({ entries: value.journal, enrollment: value.enrollment, grant: value.grant }); if (!journal.valid) throw new OfflineDeviceTrustError("VAULT_TAMPERED", `Offline journal verification failed: ${journal.failures.join(", ")}.`); if (value.records.length !== value.journal.length || value.journal.length > value.grant.maxJournalEntries || (value.journal.at(-1) && Date.parse(value.lastObservedAt) < Date.parse(value.journal.at(-1)!.occurredAt))) throw new OfflineDeviceTrustError("VAULT_TAMPERED", "Offline records, journal, limit, or monotonic clock state differ."); for (let index = 0; index < value.records.length; index += 1) { const record = value.records[index]!; const entry = value.journal[index]!; if (record.operationId !== entry.operationId || record.operation !== entry.operation || sha256Digest(record.payload) !== record.payloadDigest || record.payloadDigest !== entry.payloadDigest || record.occurredAt !== entry.occurredAt) throw new OfflineDeviceTrustError("VAULT_TAMPERED", "Offline record is not bound to its signed journal entry."); safeCanonicalPayload(record.payload); } return value; }
function validateTrustState(state: DeviceTrustState): void { if (state.contractVersion !== "1.0" || !Array.isArray(state.devices)) throw new OfflineDeviceTrustError("VAULT_TAMPERED", "Device trust state is malformed."); state.devices.forEach(validateEnrollment); if (new Set(state.devices.map((item) => item.deviceId)).size !== state.devices.length) throw new OfflineDeviceTrustError("VAULT_TAMPERED", "Device trust state contains duplicate devices."); }
function validateEnrollment(value: DeviceEnrollment): void { id(value.deviceId, "device_"); id(value.organizationId, "org_"); id(value.principalId, "principal_"); id(value.enrolledByPrincipalId, "principal_"); keyReference(value.keyReference); digest(value.platformAttestationDigest); time(value.enrolledAt); if (value.status !== "ACTIVE" && value.status !== "REVOKED") throw new OfflineDeviceTrustError("DEVICE_CONFLICT", "Device status is invalid."); try { const key = createPublicKey(value.publicSigningKeyPem); if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type"); } catch { throw new OfflineDeviceTrustError("DEVICE_CONFLICT", "Device signing key is invalid."); } if (value.status === "REVOKED") { if (!value.revokedAt || !value.revocationReasonDigest) throw new OfflineDeviceTrustError("DEVICE_CONFLICT", "Revoked device is missing evidence."); time(value.revokedAt); digest(value.revocationReasonDigest); } }
function validateProvider(value: DeviceKeyProvider): void { id(value.deviceId, "device_"); keyReference(value.keyReference); try { const key = createPublicKey(value.publicSigningKeyPem); if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type"); } catch { throw new OfflineDeviceTrustError("DEVICE_BINDING_MISMATCH", "Device key provider is invalid."); } }
function parseEnvelope(input: unknown): EncryptedOfflineVaultFile { if (!input || typeof input !== "object" || Array.isArray(input)) throw new OfflineDeviceTrustError("VAULT_TAMPERED", "Encrypted offline vault is malformed."); const value = input as EncryptedOfflineVaultFile; if (value.contractVersion !== "1.0" || value.algorithm !== "aes-256-gcm" || value.sealed?.algorithm !== "aes-256-gcm") throw new OfflineDeviceTrustError("VAULT_TAMPERED", "Encrypted offline vault metadata is invalid."); id(value.deviceId, "device_"); id(value.organizationId, "org_"); keyReference(value.keyReference); time(value.updatedAt); for (const item of [value.sealed.iv, value.sealed.authenticationTag, value.sealed.ciphertext]) if (typeof item !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(item)) throw new OfflineDeviceTrustError("VAULT_TAMPERED", "Encrypted offline vault contains invalid binary encoding."); return value; }
function aad(value: { readonly contractVersion: "1.0"; readonly deviceId: string; readonly organizationId: string; readonly keyReference: string; readonly algorithm: "aes-256-gcm"; readonly updatedAt: string }): Uint8Array { const binding = { contractVersion: value.contractVersion, deviceId: value.deviceId, organizationId: value.organizationId, keyReference: value.keyReference, algorithm: value.algorithm, updatedAt: value.updatedAt }; return Buffer.from(canonicalJson(binding as unknown as CanonicalValue), "utf8"); }
function safeCanonicalPayload(input: CanonicalValue): CanonicalValue { const serialized = canonicalJson(input); if (Buffer.byteLength(serialized, "utf8") > MAX_OPERATION_BYTES) throw new OfflineDeviceTrustError("OPERATION_NOT_ALLOWED", "Offline operation payload exceeds one megabyte."); const forbidden = /(?:^|_)(?:seed|secret|password|credential|private.?key|signing.?key|treasury.?key|signed.?decision|approval.?signature)(?:$|_)/i; const visit = (value: unknown): void => { if (!value || typeof value !== "object") return; if (Array.isArray(value)) return value.forEach(visit); for (const [key, item] of Object.entries(value)) { if (forbidden.test(key)) throw new OfflineDeviceTrustError("OPERATION_NOT_ALLOWED", `Offline payload field ${key} is forbidden.`); visit(item); } }; const parsed = JSON.parse(serialized) as CanonicalValue; visit(parsed); return parsed; }
function operations(values: readonly OfflineOperationType[]): readonly OfflineOperationType[] { const valid = ["CACHE_WRITE", "OBLIGATION_CAPTURE", "EVIDENCE_CAPTURE", "ALLOCATION_DRAFT", "PAYMENT_PREPARE"] as const; if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length || values.some((item) => !valid.includes(item))) throw new OfflineDeviceTrustError("GRANT_INVALID", "Offline operations are invalid."); return frozen([...values]); }
function assertGrantActive(grant: OfflineAuthorizationGrant, now: string): void { time(now); if (Date.parse(now) < Date.parse(grant.notBefore) || Date.parse(now) >= Date.parse(grant.expiresAt)) throw new OfflineDeviceTrustError("GRANT_EXPIRED", "Offline authorization is not currently active."); }
function assertMonotonic(previous: string, next: string): void { if (Date.parse(next) < Date.parse(previous)) throw new OfflineDeviceTrustError("CLOCK_ROLLBACK", "Device clock moved backwards; online reauthorization is required."); }
async function bestEffortOverwriteAndDelete(path: string): Promise<void> { let handle; try { const details = await stat(path); handle = await open(path, "r+"); const zeroes = Buffer.alloc(Math.min(65_536, Math.max(1, details.size))); let offset = 0; while (offset < details.size) { const length = Math.min(zeroes.length, details.size - offset); await handle.write(zeroes, 0, length, offset); offset += length; } await handle.sync(); await handle.truncate(0); await handle.close(); handle = undefined; await unlink(path); } catch (error) { try { await handle?.close(); } catch { /* preserve original wipe failure */ } if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new OfflineDeviceTrustError("WIPE_FAILED", "Device key was destroyed, but vault-file removal requires operator attention."); } }
function requiredDevice(state: DeviceTrustState, deviceId: string): DeviceEnrollment { const device = state.devices.find((item) => item.deviceId === deviceId); if (!device) throw new OfflineDeviceTrustError("DEVICE_CONFLICT", "Device is not enrolled."); return device; }
function journalPublicKey(deviceId: string, state: DeviceTrustState): string { return requiredDevice(state, deviceId).publicSigningKeyPem; }
function freezeTrustState(state: DeviceTrustState): DeviceTrustState { return frozen({ contractVersion: "1.0", devices: frozen(state.devices.map((item) => frozen({ ...item }))) }); }
function freezePayload(value: OfflineVaultPayload): OfflineVaultPayload { return frozen({ ...value, enrollment: frozen({ ...value.enrollment }), grant: frozen({ ...value.grant, allowedOperations: frozen([...value.grant.allowedOperations]) }), records: frozen(value.records.map((item) => frozen({ ...item }))), journal: frozen(value.journal.map((item) => frozen({ ...item }))) }); }
function requireDuty(actor: DeviceTrustActor, duty: DeviceTrustDuty): void { id(actor.principalId, "principal_"); if (actor.duty !== duty) throw new OfflineDeviceTrustError("SEPARATION_OF_DUTIES", `${duty} authority is required.`); }
function id(value: unknown, prefix: string): void { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new OfflineDeviceTrustError("DEVICE_CONFLICT", "Identifier is invalid."); }
function keyReference(value: string): void { if (!/^[a-z][a-z0-9:/._-]{5,200}$/.test(value)) throw new OfflineDeviceTrustError("DEVICE_BINDING_MISMATCH", "Device key reference is invalid."); }
function signerKeyId(value: string): void { if (!/^[a-z][a-z0-9:._-]{5,120}$/.test(value)) throw new TypeError("Offline grant signer key ID is invalid."); }
function validDigest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function digest(value: unknown): asserts value is string { if (!validDigest(value)) throw new OfflineDeviceTrustError("GRANT_INVALID", "Digest is invalid."); }
function validSignature(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9+/]{80,120}={0,2}$/.test(value); }
function time(value: unknown): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new OfflineDeviceTrustError("GRANT_INVALID", "Timestamp is invalid."); }
function frozen<T>(value: T): T { return Object.freeze(value); }
