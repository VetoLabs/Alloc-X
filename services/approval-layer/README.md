# Approval Layer Service

This service independently authenticates its dedicated service identity, evaluates canonical payment intents through the deterministic policy kernel, writes decision evidence to the append-only audit chain, and signs released decisions with Ed25519.

Settlement code must call `assertSettlementAuthorized` before constructing or signing a ledger transaction. That guard rejects non-`ALLOW` outcomes, expired decisions, altered signatures or digests, cross-organization decisions, intent substitutions, and unknown signing keys.

The local signer accepts an injected key object for verification coverage. A production deployment must replace it with a KMS/HSM-backed signer and retain public-key metadata and audit storage independently.

`DurableSecurityDecisionService` writes each released signed decision and its audit event into a hash-linked, fsynced local journal before the caller receives it. This provides local restart recovery and integrity verification. Production must replace the filesystem adapter with a transactional database adapter and independently retained journal-head anchors; the service contract is intentionally storage-agnostic for that change.
