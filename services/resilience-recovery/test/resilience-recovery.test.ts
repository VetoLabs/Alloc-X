import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileRecoveryManager, RecoveryError, assessRecoveryExercise, withDependencyTimeout } from "../src/index.ts";

test("creates, verifies, and restores a checksum-bound point-in-time backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-recovery-")); const source = join(root, "source"); const backups = join(root, "backups"); const restored = join(root, "restored");
  try { await mkdir(join(source, "state"), { recursive: true }); await writeFile(join(source, "state", "payments.json"), JSON.stringify({ paymentId: "pay_1", state: "VALIDATED" })); const manager = new FileRecoveryManager({ sourceRoot: source, backupRoot: backups }); const manifest = await manager.createBackup({ backupId: "backup_payments_001", relativePaths: ["state/payments.json"], createdAt: "2026-11-10T12:01:00.000Z", recoveryPointAt: "2026-11-10T12:00:00.000Z" }); assert.equal(manifest.entries.length, 1); await manager.restore({ backupId: manifest.backupId, targetRoot: restored }); assert.deepEqual(JSON.parse(await readFile(join(restored, "state", "payments.json"), "utf8")), { paymentId: "pay_1", state: "VALIDATED" }); } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a tampered backup and a path outside the configured roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "alloc-x-recovery-")); const source = join(root, "source"); const backups = join(root, "backups");
  try { await mkdir(source, { recursive: true }); await writeFile(join(source, "journal.ndjson"), "safe\n"); const manager = new FileRecoveryManager({ sourceRoot: source, backupRoot: backups }); await manager.createBackup({ backupId: "backup_journal_001", relativePaths: ["journal.ndjson"], createdAt: "2026-11-10T12:01:00.000Z", recoveryPointAt: "2026-11-10T12:00:00.000Z" }); await writeFile(join(backups, "backup_journal_001", "journal.ndjson"), "tampered\n"); await assert.rejects(() => manager.verify("backup_journal_001"), /integrity failed/i); await assert.rejects(() => manager.createBackup({ backupId: "backup_escape_001", relativePaths: ["../outside"], createdAt: "2026-11-10T12:01:00.000Z", recoveryPointAt: "2026-11-10T12:00:00.000Z" }), RecoveryError); } finally { await rm(root, { recursive: true, force: true }); }
});

test("times out a dependency and records measured recovery objectives", async () => {
  await assert.rejects(() => withDependencyTimeout({ operation: "approval-layer", timeoutMs: 10, task: async () => new Promise(() => undefined) }), /failed closed/i);
  const exercise = assessRecoveryExercise({ exerciseId: "exercise_001", backupId: "backup_001", startedAt: "2026-11-10T12:00:00.000Z", completedAt: "2026-11-10T12:04:00.000Z", recoveryPointObjectiveSeconds: 300, measuredDataLossSeconds: 40, recoveryTimeObjectiveSeconds: 600, measuredRecoverySeconds: 240, integrityVerified: true, queueReplayDuplicateCount: 0, reconciliationDuplicateCount: 0 });
  assert.equal(exercise.passed, true); assert.equal(assessRecoveryExercise({ ...exercise, reconciliationDuplicateCount: 1 }).passed, false);
});
