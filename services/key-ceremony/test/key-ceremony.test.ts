import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCeremonyStore, KeyCeremonyService } from "../src/index.ts";

const participants = [{ principalId: "principal_key_operator", duty: "operator" as const }, { principalId: "principal_key_approver", duty: "approver" as const }, { principalId: "principal_independent_observer", duty: "observer" as const }];
const attestation = `sha256:${"a".repeat(64)}`;

test("records provision, rotation, and emergency exercises in a durable integrity chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-ceremony-")); const path = join(root, "ceremony.json");
  try { const service = new KeyCeremonyService(new FileCeremonyStore(path)); await service.recordSignerCeremony({ ceremonyId: "ceremony_provision_001", organizationId: "org_meridian", signerId: "signer_execution", signerRole: "execution", action: "PROVISION", newKeyReference: "kms://execution/key-v1", participants, externalAttestationDigest: attestation, occurredAt: "2026-11-10T10:00:00.000Z" }); const exercise = await service.recordEmergencyExercise({ exerciseId: "exercise_compromise_001", organizationId: "org_meridian", type: "COMPROMISED_SIGNER", participants, evidenceEventIds: ["sce_freeze_001", "signer_revoke_001"], startedAt: "2026-11-10T10:10:00.000Z", completedAt: "2026-11-10T10:14:00.000Z", detectedWithinSeconds: 60, containedWithinSeconds: 240, detectionObjectiveSeconds: 120, containmentObjectiveSeconds: 300 }); assert.equal(exercise.passed, true); await service.recordSignerCeremony({ ceremonyId: "ceremony_rotate_001", organizationId: "org_meridian", signerId: "signer_execution", signerRole: "execution", action: "ROTATE", oldKeyReference: "kms://execution/key-v1", newKeyReference: "kms://execution/key-v2", participants, externalAttestationDigest: attestation, occurredAt: "2026-11-10T10:20:00.000Z" }); assert.equal(service.verifyIntegrity(), true); const recovered = new KeyCeremonyService(new FileCeremonyStore(path)); await recovered.open(); assert.equal(recovered.snapshot().ceremonies.length, 2); assert.equal(recovered.snapshot().exercises.length, 1); assert.equal(recovered.verifyIntegrity(), true); } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses a ceremony where one participant holds multiple duties", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-ceremony-")); try { const service = new KeyCeremonyService(new FileCeremonyStore(join(root, "ceremony.json"))); await assert.rejects(() => service.recordSignerCeremony({ ceremonyId: "ceremony_bad_001", organizationId: "org_meridian", signerId: "signer_policy", signerRole: "policy", action: "PROVISION", newKeyReference: "kms://policy/key-v1", participants: [{ principalId: "principal_same", duty: "operator" }, { principalId: "principal_same", duty: "approver" }, { principalId: "principal_observer", duty: "observer" }], externalAttestationDigest: attestation, occurredAt: "2026-11-10T10:00:00.000Z" }), /distinct participants/i); } finally { await rm(root, { recursive: true, force: true }); }
});
