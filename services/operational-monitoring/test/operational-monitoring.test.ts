import assert from "node:assert/strict";
import test from "node:test";
import { OperationalMonitor, OperationalMonitoringError, defaultOperationalRules } from "../src/index.ts";

test("raises actionable alerts with an owner and runbook", () => {
  const monitor = new OperationalMonitor(defaultOperationalRules);
  const alerts = monitor.recordMetric({ name: "unknown_outflows", value: 1, observedAt: "2026-11-10T12:00:00.000Z", service: "ledger-monitor", attributes: { network: "xrpl" } });
  assert.equal(alerts[0]!.severity, "critical"); assert.equal(alerts[0]!.owner, "treasury-security"); assert.equal(alerts[0]!.runbook, "runbooks/unknown-outflow.md"); assert.equal(monitor.snapshot().health, "CRITICAL");
});

test("records privacy-safe traces and rejects secret or evidence fields", () => {
  const monitor = new OperationalMonitor(defaultOperationalRules);
  monitor.recordTrace({ traceId: "trace_payment_1", operation: "payment.evaluate", service: "approval-layer", outcome: "success", durationMs: 42, occurredAt: "2026-11-10T12:00:00.000Z", attributes: { organizationId: "org_meridian", outcome: "ALLOW" } });
  assert.equal(monitor.snapshot().traces.length, 1);
  assert.throws(() => monitor.recordMetric({ name: "service.health", value: 1, observedAt: "2026-11-10T12:00:00.000Z", service: "signer", attributes: { privateKey: "forbidden" } }), OperationalMonitoringError);
  assert.throws(() => monitor.recordTrace({ traceId: "trace_bad_1", operation: "evidence.parse", service: "evidence", outcome: "failure", durationMs: 2, occurredAt: "2026-11-10T12:00:00.000Z", attributes: { evidence: "raw document" } }), OperationalMonitoringError);
});

test("reports healthy operation when metrics remain within thresholds", () => {
  const monitor = new OperationalMonitor(defaultOperationalRules);
  monitor.recordMetric({ name: "service.health", value: 1, observedAt: "2026-11-10T12:00:00.000Z", service: "approval-layer", attributes: {} });
  monitor.recordMetric({ name: "reconciliation.lag_seconds", value: 10, observedAt: "2026-11-10T12:00:00.000Z", service: "ledger-monitor", attributes: {} });
  assert.equal(monitor.snapshot().health, "HEALTHY"); assert.equal(monitor.snapshot().alerts.length, 0);
});
