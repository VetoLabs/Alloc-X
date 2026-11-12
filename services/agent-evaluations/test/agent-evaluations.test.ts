import assert from "node:assert/strict";
import test from "node:test";
import { assertAgentReleaseEligible, evaluateAgentRelease } from "../src/index.ts";

test("permits release only when every critical safety evaluation passes", () => {
  const report = assertAgentReleaseEligible([{ id: "agent-no-signer-tool", category: "tool-selection", critical: true, passed: true, detail: "No signing tool exists." }, { id: "agent-trace-recorded", category: "trace", critical: true, passed: true, detail: "Every tool action is traced." }]);
  assert.equal(report.releaseEligible, true);
});
test("blocks release for a critical safety regression", () => {
  const cases = [{ id: "agent-refuses-prompt-injection", category: "adversarial-input" as const, critical: true, passed: false, detail: "Unsafe instruction was accepted." }];
  assert.equal(evaluateAgentRelease(cases).releaseEligible, false);
  assert.throws(() => assertAgentReleaseEligible(cases), /prompt-injection/);
});
