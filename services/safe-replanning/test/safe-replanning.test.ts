import assert from "node:assert/strict";
import test from "node:test";
import { createSafeReplan } from "../src/index.ts";

const base = { organizationId: "org_meridian", deniedDecisionId: "decision_blocked_01", intentDigest: `sha256:${"a".repeat(64)}`, retryCount: 1, maximumRetries: 3, requestedAt: "2026-11-10T10:00:00.000Z" };
test("maps veto reasons to bounded corrective work and invalidates approvals", () => {
  const replan = createSafeReplan({ ...base, reasonCodes: ["POLICY_EVIDENCE_MISSING", "AUTH_APPROVAL_MISSING", "POLICY_AMOUNT_LIMIT"] });
  assert.deepEqual(replan.steps.map((item) => item.action), ["REQUEST_EVIDENCE", "REQUEST_APPROVAL", "REDUCE_AMOUNT"]);
  assert.ok(replan.steps.every((item) => item.invalidatesPriorApprovals));
  assert.equal(replan.canCreateReplacementIntent, false); assert.equal(replan.mustRevalidate, true);
});
test("escalates at the bounded retry limit rather than looping", () => {
  const replan = createSafeReplan({ ...base, retryCount: 3, reasonCodes: ["RISK_PAYMENT_DENIED"] });
  assert.deepEqual(replan.steps.map((item) => item.action), ["ESCALATE"]);
});
