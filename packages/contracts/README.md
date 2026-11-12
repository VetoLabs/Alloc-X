# Versioned Domain Contracts

`@alloc-x/contracts` defines Alloc-X's executable data boundary. Every record declares contract version `1.0`, rejects unknown fields, normalizes fixed-precision amounts, validates canonical timestamps and identifiers, and returns deeply frozen values.

The package covers organizations, principals, obligations, allocations, beneficiaries, evidence manifests, payment intents, security decisions, approvals, ledger transaction results, and decision receipts. Cross-record validation prevents one organization, beneficiary, obligation, allocation, evidence record, or principal from being substituted into another organization's payment flow.

Canonical JSON and SHA-256 helpers provide stable digests regardless of property insertion order. XRPL classic addresses are checksum-validated before they can enter a beneficiary contract. Execution-window assertions require callers to supply an explicit evaluation time, keeping expiry checks deterministic and testable.

Run the contract suite with:

```bash
npm run test:contracts
```
