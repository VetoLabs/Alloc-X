import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVIRONMENT_NAMES,
  loadEnvironmentConfig,
} from "../../packages/config/src/index.ts";

test("loads four isolated environment configurations without embedded credentials", async () => {
  const configurations = await Promise.all(
    ENVIRONMENT_NAMES.map((name) => loadEnvironmentConfig(name)),
  );

  assert.equal(configurations.length, 4);
  assert.equal(configurations.find((item) => item.environment === "production")?.ledger.network, "mainnet");
  assert.ok(
    configurations
      .filter((item) => item.environment !== "production")
      .every((item) => item.ledger.network !== "mainnet"),
  );

  for (const selector of [
    (item: (typeof configurations)[number]) => item.environmentId,
    (item: (typeof configurations)[number]) => item.identity.issuer,
    (item: (typeof configurations)[number]) => item.ledger.treasuryAccountEnv,
    (item: (typeof configurations)[number]) => item.signing.executorKeyRefEnv,
    (item: (typeof configurations)[number]) => item.signing.policyKeyRefEnv,
  ]) {
    assert.equal(new Set(configurations.map(selector)).size, configurations.length);
  }
});

test("rejects a production environment that targets a non-production network", async () => {
  const production = await loadEnvironmentConfig("production");
  const invalid = {
    ...production,
    ledger: {
      ...production.ledger,
      network: "testnet" as const,
    },
  };

  const { validateEnvironmentConfig } = await import("../../packages/config/src/index.ts");
  assert.throws(() => validateEnvironmentConfig(invalid, "production"), /must explicitly target mainnet/);
});
