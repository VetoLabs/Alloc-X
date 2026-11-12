# Alloc-X accounting

This package is the authoritative balance-transition core. It uses fixed-precision decimal strings and makes a payment capacity available only after both the organization treasury account and the selected allocation envelope have been reserved.

The reservation lifecycle is:

`available → committed → settled`

or, on cancellation or expiry:

`available → committed → available`

Every transition emits an immutable journal entry with resulting treasury and allocation snapshots. Reservation IDs are idempotent only when every protected field matches. Expected account versions support optimistic concurrency control.

`InMemoryTreasuryAccounting` provides local verification. The production adapter must perform the matching read, version check, balance transition, reservation write, and journal write atomically in durable storage.
