# Autonomous Payment Path

This service composes the final payment lifecycle without accepting a browser-supplied amount, asset, or destination.

1. A canonical, reserved payment intent is evaluated by Approval Layer.
2. Only an `ALLOW` decision bound to that exact intent can enter the orchestrator.
3. The destination is resolved from the authoritative beneficiary registry and its wallet version must match the intent.
4. The payment orchestrator performs independent signing and waits for XRPL validation.
5. The read-only monitor independently observes the validated transaction, settles the accounting reservation idempotently, and records reconciliation.

The console accepts this path through an explicit server-side dependency. It has no default settlement implementation and cannot enable settlement from browser input. A deployed instance must provide independent signer identities, a configured XRPL adapter, a read-only monitor identity, and durable stores before enabling the dependency.
