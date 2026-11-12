# Alloc-X Beneficiary Registry

This package owns approved payment destinations and their change controls. A beneficiary begins pending, becomes approved only after ownership verification, and records immutable wallet versions.

Wallet changes require a requester, an independent approver, an independent ownership verifier, and a cooling period. During the cooling period the beneficiary is pending, so policy evaluation cannot allow payments to it. Freeze and disable actions immediately make the beneficiary ineligible.

The in-memory adapter is for local operation. A production adapter must transactionally persist the registry transition, version history, audit event, and notification outbox.
