# Alloc-X policy engine

This package is the deterministic payment-policy boundary used before Approval Layer can authorize settlement. It has no network, database, signing, or model capability.

## Guarantees

- Policy bundles, payment intents, and evaluation context are validated at the boundary.
- The same validated input produces the same decision, policy digest, decision identifier, expiry, reason codes, and rule trace.
- Malformed or incomplete input produces `DENY` with `POLICY_EVALUATION_INPUT_INVALID`.
- Decimal amounts use fixed-precision strings; JavaScript floating-point arithmetic is not used for money.
- A review signal never overrides a deterministic denial.

## Public entry points

- `parsePolicyBundle(input)` validates an exact immutable policy bundle.
- `policyBundleDigest(policy)` returns its canonical SHA-256 digest.
- `evaluatePaymentIntent(intent, policy, context)` returns the settlement decision.
- `evaluatePaymentIntentWithTrace(intent, policy, context)` additionally returns the policy digest and a result for every control family.

The caller must obtain context from authoritative, tenant-scoped services. Approval Layer remains responsible for authenticating the caller, signing an allowed decision, and rejecting expired or altered decisions before settlement.

## Local verification

Run `npm run test:policy` for the policy suite, or `npm run check` for all local quality, contract, authorization, policy, and integration checks.
