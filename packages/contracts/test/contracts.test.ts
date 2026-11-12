import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractValidationError,
  addDecimal,
  assertPaymentIntentActiveAt,
  canonicalJson,
  compareDecimal,
  normalizeDecimal,
  parsePaymentIntent,
  paymentIntentDigest,
  subtractDecimal,
} from "../src/index.ts";

function validIntent() {
  return {
    contractVersion: "1.0",
    intentId: "pi_001",
    organizationId: "org_acme",
    idempotencyKey: "org_acme/invoice-42/v1",
    sourceObligationId: "obl_42",
    allocationId: "alloc_operations",
    amount: "1250.00",
    asset: "XRP",
    beneficiaryId: "ben_vendor_7",
    beneficiaryWalletVersion: 3,
    purposeCode: "operations-supplies",
    evidenceManifestHash: `sha256:${"a".repeat(64)}`,
    policyVersion: "policy_2026_01",
    requestedExecutionWindow: {
      notBefore: "2026-11-06T12:00:00.000Z",
      expiresAt: "2026-11-06T13:00:00.000Z",
    },
    createdBy: {
      principalId: "principal_alloc_agent",
      actorType: "agent",
    },
  };
}

test("normalizes fixed-precision amounts without using floating point", () => {
  assert.equal(normalizeDecimal("1250.00"), "1250");
  assert.equal(addDecimal("0.1", "0.2"), "0.3");
  assert.equal(subtractDecimal("10.00", "0.01"), "9.99");
  assert.equal(compareDecimal("999999999999999999.1", "999999999999999999.01"), 1);
});

test("rejects unsafe decimal forms", () => {
  for (const value of ["-1", "01", "1e3", "NaN", "1.1234567890123456789"]) {
    assert.throws(() => normalizeDecimal(value), TypeError);
  }
});

test("parses and deeply freezes a canonical payment intent", () => {
  const intent = parsePaymentIntent(validIntent());
  assert.equal(intent.amount, "1250");
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.createdBy), true);
  assert.equal(Object.isFrozen(intent.requestedExecutionWindow), true);
});

test("rejects unknown executable fields", () => {
  assert.throws(
    () => parsePaymentIntent({ ...validIntent(), destinationWallet: "rAttacker" }),
    (error: unknown) =>
      error instanceof ContractValidationError &&
      error.issues.includes("intent.destinationWallet is not allowed"),
  );
});

test("rejects invalid windows, identifiers, hashes, and zero amounts", () => {
  const input = validIntent();
  input.amount = "0";
  input.intentId = "wrong";
  input.evidenceManifestHash = "sha256:not-a-hash";
  input.requestedExecutionWindow.expiresAt = input.requestedExecutionWindow.notBefore;

  assert.throws(
    () => parsePaymentIntent(input),
    (error: unknown) => error instanceof ContractValidationError && error.issues.length >= 4,
  );
});

test("canonical JSON and intent digests are independent of property insertion order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, b: "x" } }), '{"a":{"b":"x","y":true},"z":1}');

  const first = parsePaymentIntent(validIntent());
  const original = validIntent();
  const reversed = Object.fromEntries(Object.entries(original).reverse());
  const second = parsePaymentIntent(reversed);
  assert.equal(paymentIntentDigest(first), paymentIntentDigest(second));
});

test("changing a protected payment field changes the digest", () => {
  const first = parsePaymentIntent(validIntent());
  const changed = parsePaymentIntent({ ...validIntent(), amount: "1250.01" });
  assert.notEqual(paymentIntentDigest(first), paymentIntentDigest(changed));
});

test("rejects payment intents outside their authorized execution window", () => {
  const intent = parsePaymentIntent(validIntent());
  assert.throws(
    () => assertPaymentIntentActiveAt(intent, "2026-11-06T11:59:59.999Z"),
    /not active/,
  );
  assert.doesNotThrow(() => assertPaymentIntentActiveAt(intent, "2026-11-06T12:30:00.000Z"));
  assert.throws(
    () => assertPaymentIntentActiveAt(intent, "2026-11-06T13:00:00.000Z"),
    /expired/,
  );
});
