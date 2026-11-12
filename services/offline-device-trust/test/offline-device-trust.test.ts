import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes, sign as signValue } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEd25519OfflineGrantSigner, createEd25519OfflineGrantVerifier, DeviceTrustService, EncryptedOfflineVault, FileDeviceTrustStore, OfflineDeviceTrustError, verifyOfflineJournal, type DeviceKeyProvider, type DeviceTrustActor, type SealedDevicePayload } from "../src/index.ts";

const sha = (character: string) => `sha256:${character.repeat(64).slice(0, 64)}`;
const actors = {
  administrator: { principalId: "principal_device_administrator", duty: "device-administrator" },
  authority: { principalId: "principal_offline_authority", duty: "offline-authority" },
  user: { principalId: "principal_treasury_operator", duty: "device-user" },
  agent: { principalId: "principal_allocation_agent", duty: "allocation-agent" },
} as const satisfies Record<string, DeviceTrustActor>;

class MemoryDeviceKeyProvider implements DeviceKeyProvider {
  readonly deviceId: string; readonly keyReference: string; readonly publicSigningKeyPem: string; #encryptionKey = randomBytes(32); #privateKey; destroyed = false;
  constructor(deviceId: string, keyReference = "os-keystore://alloc-x-device-one") { this.deviceId = deviceId; this.keyReference = keyReference; const pair = generateKeyPairSync("ed25519"); this.#privateKey = pair.privateKey; this.publicSigningKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString(); }
  async seal(plaintext: Uint8Array, additionalData: Uint8Array): Promise<SealedDevicePayload> { this.assertLive(); const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, iv, { authTagLength: 16 }); cipher.setAAD(additionalData); const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); return { algorithm: "aes-256-gcm", iv: iv.toString("base64"), authenticationTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }; }
  async open(payload: SealedDevicePayload, additionalData: Uint8Array): Promise<Uint8Array> { this.assertLive(); const decipher = createDecipheriv("aes-256-gcm", this.#encryptionKey, Buffer.from(payload.iv, "base64"), { authTagLength: 16 }); decipher.setAAD(additionalData); decipher.setAuthTag(Buffer.from(payload.authenticationTag, "base64")); return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]); }
  async signDigest(digest: string): Promise<string> { this.assertLive(); return signValue(null, Buffer.from(digest, "utf8"), this.#privateKey).toString("base64"); }
  async destroyKey(): Promise<void> { this.#encryptionKey.fill(0); this.destroyed = true; }
  assertLive(): void { if (this.destroyed) throw new Error("device key destroyed"); }
}

async function fixture(root: string) {
  const authorityKeys = generateKeyPairSync("ed25519"); const signer = createEd25519OfflineGrantSigner("offline-authority-key-2026", authorityKeys.privateKey); const verifier = createEd25519OfflineGrantVerifier("offline-authority-key-2026", authorityKeys.publicKey); const trust = new DeviceTrustService({ store: new FileDeviceTrustStore(join(root, "device-trust.json")), grantSigner: signer, grantVerifier: verifier }); const keys = new MemoryDeviceKeyProvider("device_field_tablet_001");
  const enrollment = await trust.enroll({ deviceId: keys.deviceId, organizationId: "org_meridian", principalId: actors.user.principalId, keyReference: keys.keyReference, publicSigningKeyPem: keys.publicSigningKeyPem, platformAttestationDigest: sha("a"), enrolledAt: "2026-11-10T08:00:00.000Z", actor: actors.administrator });
  const grant = await trust.issueGrant({ grantId: "offline_grant_shift_001", deviceId: keys.deviceId, principalId: actors.user.principalId, allowedOperations: ["CACHE_WRITE", "OBLIGATION_CAPTURE", "EVIDENCE_CAPTURE", "ALLOCATION_DRAFT", "PAYMENT_PREPARE"], issuedAt: "2026-11-10T08:01:00.000Z", notBefore: "2026-11-10T08:02:00.000Z", expiresAt: "2026-11-10T16:00:00.000Z", maxJournalEntries: 20, actor: actors.authority });
  const path = join(root, "offline-vault.enc"); const vault = new EncryptedOfflineVault({ path, keyProvider: keys, grantVerifier: verifier }); await vault.create({ enrollment, grant, now: "2026-11-10T08:02:00.000Z" }); return { trust, keys, verifier, enrollment, grant, vault, path };
}

test("encrypts the vault and a copied file is unreadable on another device key", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-offline-")); try { const value = await fixture(root); await value.vault.appendOperation({ operationId: "offline_operation_obligation_001", operation: "OBLIGATION_CAPTURE", payload: { amount: "250", supplier: "Rural Clinic Supplies" }, actor: actors.user, occurredAt: "2026-11-10T09:00:00.000Z" }); const bytes = await readFile(value.path, "utf8"); assert.doesNotMatch(bytes, /Rural Clinic Supplies|"amount":"250"/); const copiedPath = join(root, "copied-vault.enc"); await copyFile(value.path, copiedPath); const otherKeys = new MemoryDeviceKeyProvider(value.keys.deviceId, value.keys.keyReference); const copied = new EncryptedOfflineVault({ path: copiedPath, keyProvider: otherKeys, grantVerifier: value.verifier }); await assert.rejects(() => copied.open(), (error: unknown) => error instanceof OfflineDeviceTrustError && error.code === "DEVICE_BINDING_MISMATCH"); const recovered = new EncryptedOfflineVault({ path: value.path, keyProvider: value.keys, grantVerifier: value.verifier }); await recovered.open(); assert.equal(recovered.snapshot().records[0]?.payloadDigest, recovered.snapshot().journal[0]?.payloadDigest); } finally { await rm(root, { recursive: true, force: true }); }
});

test("detects changed, reordered, and unsigned journal entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-offline-")); try { const value = await fixture(root); await value.vault.appendOperation({ operationId: "offline_operation_cache_001", operation: "CACHE_WRITE", payload: { view: "treasury-summary", version: 4 }, actor: actors.user, occurredAt: "2026-11-10T09:00:00.000Z" }); await value.vault.appendOperation({ operationId: "offline_operation_draft_001", operation: "ALLOCATION_DRAFT", payload: { allocationId: "alloc_field", amount: "100" }, actor: actors.user, occurredAt: "2026-11-10T09:05:00.000Z" }); assert.equal(value.vault.verifyJournal().valid, true); const entries = value.vault.snapshot().journal; const changed = [{ ...entries[0]!, payloadDigest: sha("0") }, entries[1]!]; assert.equal(verifyOfflineJournal({ entries: changed, enrollment: value.enrollment, grant: value.grant }).valid, false); assert.equal(verifyOfflineJournal({ entries: [entries[1]!, entries[0]!], enrollment: value.enrollment, grant: value.grant }).valid, false); } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired and remotely revoked devices cannot synchronize privileged work", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-offline-")); try { const value = await fixture(root); await value.vault.appendOperation({ operationId: "offline_operation_prepare_001", operation: "PAYMENT_PREPARE", payload: { draftId: "draft_field_001", amount: "75", state: "PREPARED_ONLY" }, actor: actors.user, occurredAt: "2026-11-10T10:00:00.000Z" }); const before = value.trust.assessSynchronization({ grant: value.grant, journal: value.vault.snapshot().journal, now: "2026-11-10T10:01:00.000Z" }); assert.equal(before.allowed, true); const expired = value.trust.assessSynchronization({ grant: value.grant, journal: value.vault.snapshot().journal, now: "2026-11-10T16:00:00.000Z" }); assert.equal(expired.allowed, false); assert.ok(expired.blockers.includes("OFFLINE_GRANT_EXPIRED")); await value.trust.revoke({ deviceId: value.keys.deviceId, actor: actors.administrator, reasonDigest: sha("b"), revokedAt: "2026-11-10T11:00:00.000Z" }); const revoked = value.trust.assessSynchronization({ grant: value.grant, journal: value.vault.snapshot().journal, now: "2026-11-10T11:01:00.000Z" }); assert.equal(revoked.allowed, false); assert.ok(revoked.blockers.includes("DEVICE_REVOKED")); } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects clock rollback, signing material, and allocation-agent writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-offline-")); try { const value = await fixture(root); await value.vault.appendOperation({ operationId: "offline_operation_evidence_001", operation: "EVIDENCE_CAPTURE", payload: { evidenceId: "evidence_field_001", digest: sha("c") }, actor: actors.user, occurredAt: "2026-11-10T10:00:00.000Z" }); await assert.rejects(() => value.vault.appendOperation({ operationId: "offline_operation_rollback_001", operation: "CACHE_WRITE", payload: { version: 1 }, actor: actors.user, occurredAt: "2026-11-10T09:59:59.000Z" }), (error: unknown) => error instanceof OfflineDeviceTrustError && error.code === "CLOCK_ROLLBACK"); await assert.rejects(() => value.vault.appendOperation({ operationId: "offline_operation_secret_001", operation: "CACHE_WRITE", payload: { treasury_private_key: "forbidden" }, actor: actors.user, occurredAt: "2026-11-10T10:01:00.000Z" }), /forbidden/i); await assert.rejects(() => value.vault.appendOperation({ operationId: "offline_operation_agent_001", operation: "ALLOCATION_DRAFT", payload: { amount: "5" }, actor: actors.agent, occurredAt: "2026-11-10T10:01:00.000Z" }), /device-user authority/i); } finally { await rm(root, { recursive: true, force: true }); }
});

test("cryptographic wipe destroys the device key and removes the local vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-offline-")); try { const value = await fixture(root); const receipt = await value.vault.secureWipe({ actor: actors.user, reasonDigest: sha("d"), wipedAt: "2026-11-10T12:00:00.000Z" }); assert.equal(receipt.deviceId, value.keys.deviceId); assert.equal(value.keys.destroyed, true); await assert.rejects(() => stat(value.path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"); assert.throws(() => value.vault.snapshot(), (error: unknown) => error instanceof OfflineDeviceTrustError && error.code === "VAULT_LOCKED"); } finally { await rm(root, { recursive: true, force: true }); }
});
