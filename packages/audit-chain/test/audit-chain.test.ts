import assert from "node:assert/strict";
import test from "node:test";

import type { AuthorizationDecision } from "../../authorization/src/index.ts";
import {
  AuditAppendConflictError,
  InMemoryAuditChain,
  redactAuditPayload,
  verifyAuditChain,
} from "../src/index.ts";

function auditReader(organizationId = "org_acme"): AuthorizationDecision {
  return {
    allowed: true,
    action: "audit:read",
    principalId: "principal_auditor",
    organizationId,
    evaluatedAt: "2026-11-07T09:00:00.000Z",
  };
}

function appendInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org_acme",
    eventId: "audit_001",
    occurredAt: "2026-11-07T09:00:00.000Z",
    correlationId: "corr_payment_1",
    actor: { principalId: "principal_operator", kind: "human" as const },
    eventType: "payment-intent-created",
    subject: { type: "payment-intent", id: "pi_001" },
    payload: { amount: "250", token: "must-not-be-stored", nested: { privateKey: "also-hidden", reference: "invoice-42" } },
    ...overrides,
  };
}

test("appends immutable, hash-linked events and redacts sensitive payload values", () => {
  const chain = new InMemoryAuditChain();
  const first = chain.append(appendInput());
  const second = chain.append(appendInput({ eventId: "audit_002", occurredAt: "2026-11-07T09:01:00.000Z", eventType: "security-decision-created", expectedPreviousEventHash: first.eventHash }));

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.previousEventHash, first.eventHash);
  assert.equal(first.retentionUntil, "2033-11-05T09:00:00.000Z");
  assert.equal(JSON.stringify(first).includes("must-not-be-stored"), false);
  assert.equal(JSON.stringify(first).includes("also-hidden"), false);
  assert.deepEqual(first.redactedPayload, { amount: "250", token: "[REDACTED]", nested: { privateKey: "[REDACTED]", reference: "invoice-42" } });
  assert.equal(Object.isFrozen(first), true);
});

test("requires an authorized same-organization audit reader and returns scoped searches only", () => {
  const chain = new InMemoryAuditChain();
  chain.append(appendInput());
  chain.append(appendInput({ organizationId: "org_other", eventId: "audit_003", correlationId: "corr_other_1" }));

  const found = chain.search(auditReader(), { organizationId: "org_acme", correlationId: "corr_payment_1" });
  assert.equal(found.length, 1);
  assert.equal(found[0].organizationId, "org_acme");
  assert.throws(() => chain.search(auditReader("org_other"), { organizationId: "org_acme" }), /Audit read denied/);
  assert.throws(() => chain.search({ ...auditReader(), allowed: false }, { organizationId: "org_acme" }), /Audit read denied/);
});

test("detects modification, deletion, and reordering against the protected head", () => {
  const chain = new InMemoryAuditChain();
  const first = chain.append(appendInput());
  const second = chain.append(appendInput({ eventId: "audit_002", occurredAt: "2026-11-07T09:01:00.000Z", expectedPreviousEventHash: first.eventHash }));
  const events = chain.search(auditReader(), { organizationId: "org_acme" });
  const head = chain.head(auditReader(), "org_acme");
  const altered = [{ ...events[0], eventType: "payment-intent-approved" }, events[1]];
  const deleted = [events[0]];
  const reordered = [second, first];

  assert.deepEqual(chain.verify(auditReader(), "org_acme"), { valid: true, checkedEvents: 2, failures: [] });
  assert.ok(verifyAuditChain(altered, [head]).failures.includes("EVENT_HASH_MISMATCH"));
  assert.ok(verifyAuditChain(deleted, [head]).failures.includes("HEAD_MISMATCH"));
  assert.ok(verifyAuditChain(reordered, [head]).failures.includes("SEQUENCE_GAP"));
});

test("rejects stale append heads and invalid retention configuration", () => {
  const chain = new InMemoryAuditChain();
  const first = chain.append(appendInput());
  chain.append(appendInput({ eventId: "audit_002", expectedPreviousEventHash: first.eventHash }));
  assert.throws(() => chain.append(appendInput({ eventId: "audit_003", expectedPreviousEventHash: first.eventHash })), AuditAppendConflictError);
  assert.throws(() => new InMemoryAuditChain({ retentionDays: 10 }), /at least 365/);
});

test("redacts nested sensitive values without changing ordinary audit evidence", () => {
  assert.deepEqual(redactAuditPayload({ safe: ["reference"], credentials: { password: "hidden", label: "operator" } }), {
    safe: ["reference"], credentials: { password: "[REDACTED]", label: "[REDACTED]" },
  });
});
