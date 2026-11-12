# Alloc-X audit chain

This package records security-relevant events in a tenant-local, hash-linked sequence. It is used to make policy, approval, beneficiary, signing, and settlement actions explainable and tamper-evident.

The local adapter has no mutation or deletion API. Each append checks the expected prior head when provided, writes a fixed retention date, and hashes the exact event contents. Search and verification require an already-authorized `audit:read` decision for the same organization.

Sensitive payload fields are replaced before persistence. The stored payload digest represents the original submitted payload; the stored event contains only its redacted form.

`InMemoryAuditChain` is for local development and contract verification only. A production adapter must preserve the same API semantics using an atomic database append, immutable retention controls, backups, and independently monitored retained heads.
