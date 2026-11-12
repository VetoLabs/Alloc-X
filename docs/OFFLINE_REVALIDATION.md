# Revalidation Before Signing

Synchronization is not permission to move money. Before an offline-prepared instruction can enter the signing path, Alloc-X creates a current, server-owned payment intent and performs every one of these checks again:

- fresh step-up authentication and organization binding;
- current policy, beneficiary status, beneficiary version, and destination version;
- live treasury and allocation balances;
- current risk-service availability and risk evaluation;
- current ledger availability and network context;
- exact binding from offline preparation to the freshly created intent digest; and
- a newly evaluated, signed Approval Layer decision verified against that exact intent.

The revalidation gate returns `READY_FOR_SIGNING` only for a fresh, cryptographically verified `ALLOW` result. A `REVIEW` result remains human work; a denial, stale input, changed destination, changed policy, unavailable dependency, expired authentication, or invalid binding stops the flow. No offline approval, signature, or journal record can bypass this gate.
