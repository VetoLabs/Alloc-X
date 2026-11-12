import assert from "node:assert/strict";
import test from "node:test";

import {
  loadEnvironmentConfig,
  validateEnvironmentConfig,
} from "../src/index.ts";

test("rejects embedded credentials and production network drift", async () => {
  const local = await loadEnvironmentConfig("local");
  assert.throws(
    () => validateEnvironmentConfig({ ...local, password: "placeholder" }),
    /never secret values/,
  );

  const production = await loadEnvironmentConfig("production");
  assert.throws(
    () => validateEnvironmentConfig({ ...production, ledger: { ...production.ledger, network: "testnet" } }),
    /must explicitly target mainnet/,
  );
});
