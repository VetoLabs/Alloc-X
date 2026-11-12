# Offline Synchronization and Conflicts

Alloc-X synchronizes offline preparation work only after the device-trust preflight accepts the enrolled device, current authorization grant, and signed journal. The server processes records in a deterministic order: operation time, then signed entry digest. Each accepted item receives a durable server sequence.

## Safe reconnect behavior

- An identical reconnect retry is recorded as `DUPLICATE`; it cannot create another obligation or payment.
- A reused operation ID with different signed content becomes an `OPERATION_MUTATED` conflict.
- A prepared payment is never made executable by synchronization. It creates an explicit `APPROVAL_REQUIRED` conflict until fresh online revalidation is performed.
- Amount, beneficiary/destination, allocation, policy, and missing-reference changes are captured as named conflicts.

## Explicit human resolution

An operator must choose one of two non-executing outcomes for an open conflict:

- `DISCARD` â€” close the disconnected record without using it.
- `REPREPARE_ONLINE` â€” preserve the audit trail and create fresh work using current authoritative records.

Neither resolution signs a transaction, approves a payment, or submits to the ledger. AX-063 must complete the current online checks before any payment can enter signing.
