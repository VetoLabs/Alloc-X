import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileVoiceInstructionStore, VoiceInstructionService } from "../src/index.ts";

const now = "2026-11-10T12:00:00.000Z";
async function service() { const root = await mkdtemp(join(tmpdir(), "alloc-x-voice-")); return { root, service: new VoiceInstructionService(new FileVoiceInstructionStore(join(root, "voice.json"))) }; }
const request = { organizationId: "org_meridian", principalId: "principal_finance", sessionId: "agent_voice_operator", transcript: "Alloc-X, pay 1350 XRP to MedTech Supplies for operations-supplies", recognition: { engine: "browser-native" as const, locale: "en-NG", confidence: 0.96 }, consentedAt: now };

test("requires confirmation before a voice instruction can advance", async () => { const setup = await service(); try { const prepared = await setup.service.prepare(request); assert.equal(prepared.state, "PREPARED"); const confirmed = await setup.service.confirm({ voiceInstructionId: prepared.voiceInstructionId, organizationId: request.organizationId, principalId: request.principalId, transcript: request.transcript, confirmedAt: "2026-11-10T12:01:00.000Z" }); assert.equal(confirmed.state, "CONFIRMED"); assert.equal(await setup.service.verifyIntegrity(), true); } finally { await rm(setup.root, { recursive: true, force: true }); } });
test("rejects altered transcript confirmation and invalid recognition metadata", async () => { const setup = await service(); try { const prepared = await setup.service.prepare(request); await assert.rejects(() => setup.service.confirm({ voiceInstructionId: prepared.voiceInstructionId, organizationId: request.organizationId, principalId: request.principalId, transcript: "pay 999 XRP to MedTech Supplies for operations-supplies", confirmedAt: "2026-11-10T12:01:00.000Z" }), /Transcript changed/); await assert.rejects(() => setup.service.prepare({ ...request, recognition: { engine: "browser-native", locale: "invalid_locale" } }), /Recognition metadata/); } finally { await rm(setup.root, { recursive: true, force: true }); } });
test("refuses to confirm an older transcript after a newer recording exists", async () => { const setup = await service(); try { const first = await setup.service.prepare(request); await setup.service.prepare({ ...request, transcript: "pay 200 XRP to MedTech Supplies for operations-supplies", consentedAt: "2026-11-10T12:01:00.001Z" }); await assert.rejects(() => setup.service.confirm({ voiceInstructionId: first.voiceInstructionId, organizationId: request.organizationId, principalId: request.principalId, transcript: first.transcript, confirmedAt: "2026-11-10T12:01:00.002Z" }), /no longer current/); assert.equal(await setup.service.verifyIntegrity(), true); } finally { await rm(setup.root, { recursive: true, force: true }); } });


test("captures long voice notes for explicit review without allowing unlimited input", async () => {
  const setup = await service();
  try {
    const transcript = "pay 1350 XRP to MedTech Supplies for operations-supplies " + "and additional context ".repeat(45);
    assert.ok(transcript.length > 500 && transcript.length < 2000);
    const prepared = await setup.service.prepare({ ...request, transcript });
    assert.equal(prepared.state, "PREPARED");
    assert.equal(prepared.transcript, transcript.trim());
    await assert.rejects(
      () => setup.service.prepare({ ...request, transcript: "a".repeat(2001) }),
      /2,000 characters/,
    );
    await assert.rejects(
      () => setup.service.confirm({
        voiceInstructionId: prepared.voiceInstructionId,
        organizationId: request.organizationId,
        principalId: request.principalId,
        transcript: transcript + " extra",
        confirmedAt: "2026-11-10T12:01:00.000Z",
      }),
      /Transcript changed/,
    );
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});
