import assert from "node:assert/strict";
import test from "node:test";
import { buildPaymentSchedule } from "../src/index.ts";

const base = { organizationId: "org_meridian", asset: "XRP", calculatedAt: "2026-11-10T10:00:00.000Z", capacitySnapshotVersion: "capacity_v1", treasuryAvailable: "6000", reserveFloor: "1000", estimatedFee: "1", allocations: [{ allocationId: "alloc_expiring", availableAmount: "3000", expiresAt: "2026-11-12T00:00:00.000Z", allowedPurposeCodes: ["operations-supplies"], status: "active" as const }, { allocationId: "alloc_later", availableAmount: "4000", expiresAt: "2027-01-01T00:00:00.000Z", allowedPurposeCodes: ["operations-supplies"], status: "active" as const }] };

test("prioritizes urgent and expiring eligible capacity without altering the source snapshot", () => {
  const schedule = buildPaymentSchedule({ ...base, obligations: [{ obligationId: "obl_urgent", amount: "2500", dueAt: "2026-11-11T10:00:00.000Z", purposeCode: "operations-supplies", policyEligible: true, beneficiaryEligible: true, evidenceReady: true }, { obligationId: "obl_later", amount: "1000", dueAt: "2026-11-25T10:00:00.000Z", purposeCode: "operations-supplies", policyEligible: true, beneficiaryEligible: true, evidenceReady: true }] });
  assert.deepEqual(schedule.recommendations.map((item) => [item.action, item.allocationId, item.recommendedAmount]), [["PAY_NOW", "alloc_expiring", "2500"], ["PARTIAL", "alloc_expiring", "500"]]);
  assert.equal(schedule.unallocatedSpendable, "1998");
  assert.ok(schedule.recommendations.every((item) => item.revalidationRequired));
  assert.equal(base.allocations[0]!.availableAmount, "3000");
});

test("keeps ineligible work on hold and creates only a safe partial recommendation", () => {
  const schedule = buildPaymentSchedule({ ...base, treasuryAvailable: "2500", allocations: [{ ...base.allocations[0]!, availableAmount: "5000" }], obligations: [{ obligationId: "obl_missing_evidence", amount: "200", dueAt: "2026-11-11T10:00:00.000Z", purposeCode: "operations-supplies", policyEligible: true, beneficiaryEligible: true, evidenceReady: false }, { obligationId: "obl_large", amount: "3000", dueAt: "2026-11-11T10:00:00.000Z", purposeCode: "operations-supplies", policyEligible: true, beneficiaryEligible: true, evidenceReady: true }] });
  const held = schedule.recommendations.find((item) => item.obligationId === "obl_missing_evidence")!;
  const partial = schedule.recommendations.find((item) => item.obligationId === "obl_large")!;
  assert.equal(held.action, "HOLD");
  assert.deepEqual(partial.action, "PARTIAL");
  assert.equal(partial.recommendedAmount, "1499");
});
