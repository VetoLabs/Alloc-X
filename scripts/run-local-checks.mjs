import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [
  ["workspace", ["scripts/quality/validate-workspace.mjs"]],
  ["secrets", ["scripts/security/scan-secrets.mjs"]],
  ["format", ["scripts/quality/check-format.mjs"]],
  ["lint", ["scripts/quality/lint.mjs"]],
  [
    "unit tests",
    [
      "--test",
      "--test-isolation=none",
      "packages/config/test/config.test.ts",
      "packages/contracts/test/contracts.test.ts",
      "packages/contracts/test/domain.test.ts",
      "packages/authorization/test/authorization.test.ts",
      "packages/policy-engine/test/policy-engine.test.ts",
      "packages/policy-engine/test/policy-boundaries.test.ts",
      "packages/audit-chain/test/audit-chain.test.ts",
      "packages/accounting/test/accounting.test.ts",
      "packages/payment-intents/test/payment-intents.test.ts",
      "packages/beneficiaries/test/beneficiaries.test.ts",
      "packages/beneficiaries/test/beneficiary-policy.integration.test.ts",
      "services/approval-layer/test/approval-layer.test.ts",
      "services/approval-layer/test/durable-decision-journal.test.ts",
      "services/xrpl-adapter/test/xrpl-adapter.test.ts",
      "services/signers/test/signers.test.ts",
      "services/data-governance/test/data-governance.test.ts",
      "services/security-assessment/test/security-assessment.test.ts",
      "services/mainnet-activation/test/mainnet-activation.test.ts",
      "services/offline-device-trust/test/offline-device-trust.test.ts",
      "services/agent-evaluations/test/agent-evaluations.test.ts",
      "services/operational-monitoring/test/operational-monitoring.test.ts",
      "services/resilience-recovery/test/resilience-recovery.test.ts",
      "services/key-ceremony/test/key-ceremony.test.ts",
      "services/allocation-agent/test/allocation-agent.test.ts",
      "services/cash-forecasting/test/cash-forecasting.test.ts",
      "services/payment-scheduling/test/payment-scheduling.test.ts",
      "services/safe-replanning/test/safe-replanning.test.ts",
      "services/duplicate-detection/test/duplicate-detection.test.ts",
      "services/procurement-matching/test/procurement-matching.test.ts",
      "services/fraud-scoring/test/fraud-scoring.test.ts",
      "tests/abuse-cases/critical-abuse-cases.test.ts",
      "services/policy-simulator/test/policy-simulator.test.ts",
      "services/security-controls/test/security-controls.test.ts",
      "services/receipt-builder/test/receipt-builder.test.ts",
      "services/evidence-pipeline/test/evidence-pipeline.test.ts",
      "services/payment-orchestrator/test/payment-orchestrator.test.ts",
      "services/ledger-monitor/test/ledger-monitor.test.ts",
      "services/payment-path/test/payment-path.test.ts",
      "services/policy-source/test/policy-source.test.ts",
      "services/policy-registry/test/policy-registry.test.ts",
    ],
  ],
  ["console tests", ["--test", "--test-isolation=none", "apps/console/test/server.test.ts", "apps/console/test/workspace-registry.test.ts", "apps/console/test/wallet-session.test.ts", "apps/console/test/ledger-history.test.js"]],
  [
    "integration tests",
    [
      "--test",
      "--test-isolation=none",
      "tests/integration/environment-boundaries.test.ts",
      "tests/integration/security-boundary.test.ts",
    ],
  ],
];

for (const [name, arguments_] of checks) {
  console.log(`\n[Alloc-X check] ${name}`);
  const result = spawnSync(process.execPath, arguments_, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nAll local Alloc-X checks passed.");
