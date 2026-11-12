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
      "services/approval-layer/test/approval-layer.test.ts",
    ],
  ],
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
