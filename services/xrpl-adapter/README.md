# Alloc-X XRPL Adapter

The adapter is the only component that connects to an XRPL endpoint. It reads validated account state, verifies the configured network ID, prepares native XRP payments, enforces a fee cap and ledger-expiry window, serializes the exact transaction, submits only an already signed blob, and independently confirms final validation.

It does not hold a seed, private key, or signer capability. Signing remains a separately controlled boundary.

The adapter uses `xrpl` 5.3.0. Its non-production integration exercise is intentionally opt-in because it requests faucet-funded accounts and submits test-network transactions:

```text
XRPL_RUN_INTEGRATION=1 npm run test:xrpl:integration
```

The adapter accepts only `testnet` and `devnet` configurations at this stage. A main-network adapter is not enabled until the later signer, orchestration, monitoring, and activation controls are complete.
