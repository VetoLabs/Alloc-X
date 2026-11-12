# Ledger Monitor

The ledger monitor independently observes configured treasury accounts. It only reads validated native-XRP payment activity; it has no wallet seed, signing operation, transaction-construction path, or submission method.

Each monitor mutation is appended to a fsynced, hash-chained journal. On restart it restores expected settlements, observed transaction hashes, reconciliation records, alerts, and the ledger cursor. If the journal integrity check fails, it stops rather than advances the cursor.

For a matched payment, the monitor calls accounting's idempotent reservation settlement operation and then records a reconciliation. An unknown outflow, or a transaction whose destination or amount does not match its expected settlement, is recorded as an alert independently of the payment worker.

The deployed monitor must run as a separate service identity with read-only XRPL access and a transactional durable-store implementation. The local file store is suitable for local development and recovery testing.
