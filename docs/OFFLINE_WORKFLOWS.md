# Offline Treasury Workflows

Alloc-X lets an enrolled, trusted device continue **preparation work** during a connectivity interruption. This protects operational continuity without turning a disconnected device into a settlement system.

## Permitted work

- Cache a versioned, expiring read view for reference.
- Capture an obligation and its evidence digest.
- Draft an allocation request against a known allocation version.
- Prepare a payment instruction using approved-record references.

Every item is encrypted in the device-bound vault and added to its signed, hash-linked journal. The device records its connectivity state as `ONLINE`, `OFFLINE`, or `RECONNECTING` so the operator can distinguish current server information from a cached view.

## Preparation boundary

An offline-prepared payment is always labelled `PREPARED_OFFLINE` and `NOT_SUBMITTED`. It carries `requiresOnlineRevalidation: true`.

Offline workflow data never contains a treasury signing key, credential, signed Approval Layer decision, approval signature, submission payload, transaction hash, or settlement claim. Beneficiary and allocation references are re-resolved online; a device cannot make its cached destination authoritative.

Reconnection is intentionally handled by AX-062 and AX-063. Before any prepared instruction may reach signing, Alloc-X must synchronize it safely and obtain fresh authentication, beneficiary status, policy, balances, risk signals, and a complete online Approval Layer evaluation.
