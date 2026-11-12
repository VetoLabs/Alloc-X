# Alloc-X payment intents

This package is the server-side boundary for canonical payment-intent creation. A caller can supply organization, obligation, allocation, beneficiary, policy, creator, idempotency, and timing references only. Amount, asset, purpose, evidence hash, beneficiary wallet version, and actor type are resolved from authoritative records.

Creation validates organization scope and record state, binds the resulting immutable intent to its digest, and reserves the exact capacity in accounting. Repeating an identical idempotency request returns the original record; changing any protected request field requires a new idempotency key and produces a new intent digest.

The local adapter is intentionally persistence-ready. A production implementation must atomically store its idempotency record, intent record, and accounting reservation or compensate a failed transaction before returning a result.
