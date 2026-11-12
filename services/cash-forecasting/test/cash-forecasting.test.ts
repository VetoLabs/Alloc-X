import assert from "node:assert/strict";
import test from "node:test";

import { CashForecastingError, buildCashForecast } from "../src/index.ts";

const base = {
  organizationId: "org_meridian", asset: "XRP", asOf: "2026-11-09T10:00:00.000Z", sourceFreshAt: "2026-11-09T09:55:00.000Z", treasuryAvailable: "12000", reserveFloor: "1000", payrollProtection: "3000", horizonDays: 30,
  inflows: [{ inflowId: "inflow_grant", amount: "6000", expectedAt: "2026-11-20T10:00:00.000Z", confidencePercent: 70, description: "Confirmed partner disbursement" }],
  obligations: [{ obligationId: "obl_payroll_november", amount: "4500", dueAt: "2026-11-15T10:00:00.000Z", description: "November payroll", category: "payroll" as const }, { obligationId: "obl_supplies", amount: "2500", dueAt: "2026-11-25T10:00:00.000Z", description: "Cold-chain supplies", category: "supplier" as const }],
};

test("builds read-only confidence scenarios without changing input balances", () => {
  const forecast = buildCashForecast({ ...base, observedAvailable: "11900" });
  assert.equal(base.treasuryAvailable, "12000");
  assert.equal(forecast.protections.total, "4000");
  assert.deepEqual(forecast.scenarios.map((scenario) => scenario.endingTreasury), ["8000", "9200", "11000"]);
  assert.deepEqual(forecast.scenarios.map((scenario) => scenario.endingSpendable), ["4000", "5200", "7000"]);
  assert.equal(forecast.confidenceRange.lowerEndingSpendable, "4000");
  assert.equal(forecast.confidenceRange.upperEndingSpendable, "7000");
  assert.equal(forecast.variance?.difference, "2700");
  assert.match(forecast.assumptions[0]!, /cannot alter authoritative/i);
});

test("shows a protection breach date when scheduled obligations exceed spendable capacity", () => {
  const forecast = buildCashForecast({ ...base, treasuryAvailable: "6000", inflows: [], obligations: [{ obligationId: "obl_payroll_november", amount: "3000", dueAt: "2026-11-15T10:00:00.000Z", description: "November payroll", category: "payroll" }] });
  assert.equal(forecast.scenarios[0]!.firstProtectionBreachAt, "2026-11-15");
  assert.equal(forecast.scenarios[0]!.endingSpendable, "-1000");
});

test("rejects stale-shape and invalid advisory inputs", () => {
  assert.throws(() => buildCashForecast({ ...base, sourceFreshAt: "2026-11-10T10:00:00.000Z" }), CashForecastingError);
  assert.throws(() => buildCashForecast({ ...base, inflows: [{ ...base.inflows[0]!, confidencePercent: 101 }] }), CashForecastingError);
});
