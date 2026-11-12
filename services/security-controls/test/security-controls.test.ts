import assert from "node:assert/strict";
import test from "node:test";

import { TreasurySecurityControls, type SecurityControlSnapshot, type SecurityControlStore } from "../src/index.ts";

class MemoryStore implements SecurityControlStore {
  value: SecurityControlSnapshot | undefined;
  async load() { return this.value; }
  async save(value: SecurityControlSnapshot) { this.value = value; }
}

const org = "org_meridian";
const operator = { principalId: "principal_operator", organizationId: org, kind: "human" as const, roles: ["security-operator"] };
const approver = { principalId: "principal_approver", organizationId: org, kind: "human" as const, roles: ["security-approver"] };
const escalator = { principalId: "principal_escalator", organizationId: org, kind: "human" as const, roles: ["security-escalation-approver"] };

test("an emergency freeze blocks payment creation and needs an independent release", async () => {
  const controls = await TreasurySecurityControls.open(new MemoryStore());
  const freeze = await controls.applyEmergencyFreeze({ organizationId: org, scope: { kind: "organization" }, reason: "Unexpected payment pattern", actor: operator, frozenAt: "2026-11-08T12:00:00.000Z" });
  assert.throws(() => controls.assertPaymentAllowed({ organizationId: org, beneficiaryId: "ben_medtech", asset: "XRP" }), /frozen/i);
  await assert.rejects(controls.releaseEmergencyFreeze({ organizationId: org, freezeId: freeze.freezeId, reason: "Attempted self release", actor: { ...operator, roles: ["security-operator", "security-approver"] }, releasedAt: "2026-11-08T12:01:00.000Z" }), /cannot release/i);
  await controls.releaseEmergencyFreeze({ organizationId: org, freezeId: freeze.freezeId, reason: "Investigation cleared", actor: approver, releasedAt: "2026-11-08T12:02:00.000Z" });
  assert.doesNotThrow(() => controls.assertPaymentAllowed({ organizationId: org, beneficiaryId: "ben_medtech", asset: "XRP" }));
});

test("weakening a limit requires three independent humans before policy publication", async () => {
  const controls = await TreasurySecurityControls.open(new MemoryStore());
  const change = await controls.requestLimitChange({ organizationId: org, control: "max-payment-amount", currentValue: "5000", requestedValue: "7000", justification: "Temporary supplier price increase", actor: operator, requestedAt: "2026-11-08T12:00:00.000Z" });
  const approved = await controls.approveLimitChange({ organizationId: org, changeId: change.changeId, actor: approver, approvedAt: "2026-11-08T12:01:00.000Z" });
  assert.equal(approved.status, "AWAITING_ESCALATION");
  await assert.rejects(controls.escalateLimitRelaxation({ organizationId: org, changeId: change.changeId, actor: { ...approver, roles: ["security-approver", "security-escalation-approver"] }, escalatedAt: "2026-11-08T12:02:00.000Z" }), /third independent/i);
  const ready = await controls.escalateLimitRelaxation({ organizationId: org, changeId: change.changeId, actor: escalator, escalatedAt: "2026-11-08T12:03:00.000Z" });
  assert.equal(ready.status, "READY_FOR_POLICY_PUBLICATION");
});
