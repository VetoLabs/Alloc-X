# Alloc-X Allocation Agent

This application will host the durable allocation agent. Its initial operating instructions are defined now so the security boundary can be reviewed before runtime tools are connected.

The agent runtime package is not installed yet because the local package registry connection cannot complete trusted TLS verification. TLS verification has not been disabled, no credentials have been introduced, and the deterministic contracts and policy engine remain fully executable without that dependency.

When the registry connection is repaired, initialize the runtime using the current official Eve scaffold, read its installed version documentation, and expose only typed tools backed by the Alloc-X service contracts.

The runtime must never receive:

- ledger private keys;
- signer credentials;
- raw database access;
- arbitrary network access;
- policy publication authority;
- beneficiary approval authority; or
- a route that bypasses Approval Layer.
