# Alloc-X Payment Orchestrator

The orchestrator is the only component allowed to combine a live security
decision, an exact XRPL transaction, and independent signer responses. It has no
signing key and cannot alter a payment after preparation.

## Settlement sequence

1. Enqueue one payment job, bound to its canonical intent and signed decision.
2. Acquire a short worker lease from the durable journal.
3. Revalidate the decision and prepare the exact native-XRP transaction.
4. Collect execution and policy signatures over one immutable envelope.
5. Fsync the signed blob and deterministic transaction hash before submitting.
6. Look up the hash first on redelivery, then submit only that same blob.
7. Persist the validated `tesSUCCESS` result as the terminal local state.

The same signed transaction can be safely retried after an ambiguous network
failure because it has the same XRPL hash and cannot become a second distinct
payment. A different amount, destination, fee, expiry, network, or decision is
never reconstructed for an existing job.

## Local and deployed durability

`FilePaymentJobStore` is a fsynced hash-linked local journal. It is intentionally
an adapter: deployment must replace it with a transactional queue/workflow store,
database-backed lease coordination, independently retained journal-head anchors,
and monitored dead-letter handling. The state machine and signatures remain the
same.

The next ledger-monitoring stage will independently reconcile validated results
and detect any unknown treasury outflow.
