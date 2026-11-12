# XRPL Mainnet Activation

## Safety position

Alloc-X Mainnet settlement is fail-closed. A production configuration can exist without enabling settlement. The XRPL adapter refuses Mainnet use unless the independent activation gate is in `PILOT` or `ACTIVE` and all current external evidence remains valid.

The allocation agent cannot configure, approve, activate, freeze, roll back, or authorize Mainnet settlement. Those controls live in the Mainnet Activation service and require authenticated service or human duties.

## Required evidence

The gate requires all of the following at the same time:

- A completed independent security assessment with no unresolved high or critical settlement findings.
- A confirmed on-ledger signer list matching the approved treasury account, quorum, member count, and digest.
- Healthy production monitoring through a source separate from submission.
- A passing recovery exercise.
- An approved rollback plan.
- Separate security and finance approval of the production configuration.

Configuration stores references and evidence digests, never private keys or seed material.

## Conservative rollout

1. A platform operator records the production account, signer-list evidence, two trusted WSS endpoints, allowlisted asset, fee ceiling, expiry window, and hard exposure limits.
2. Separate security and finance principals approve the same configuration digest.
3. The gate rechecks live assessment, monitoring, recovery, and signer-list evidence before entering `PILOT`.
4. The settlement service may authorize one low-value native-XRP pilot. Per-payment, daily-amount, daily-count, fee, and four-ledger expiry controls remain outside the agent.
5. An independent monitor must confirm `tesSUCCESS` from a validated ledger and match the exact approved transaction digest.
6. Finance must reconcile the same hash and digest.
7. Separate security and finance principals approve full rollout only after the reconciled pilot.
8. A platform operator may then enter `ACTIVE`.

Any missing or stale dependency blocks new authorizations even if the phase was previously active.

## XRPL protocol alignment

- Mainnet uses network ID `0`; `NetworkID` is omitted for XRPL Mainnet, Testnet, and Devnet transactions.
- Every automated payment uses a bounded `LastLedgerSequence`; the initial production control fixes the offset at four validated ledgers.
- Submission results are treated as provisional. Only `validated: true` with `tesSUCCESS` is accepted as final.
- Multi-signing must satisfy the configured on-ledger signer quorum, with every protected transaction field fixed before signatures are collected.
- Submission and verification use different trusted WSS endpoints. Public endpoints are not treated as a sustained production dependency.

Official protocol references:

- https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission
- https://xrpl.org/docs/concepts/accounts/multi-signing
- https://xrpl.org/docs/references/protocol/transactions/common-fields
- https://xrpl.org/docs/tutorials/public-servers

## Current status

The activation workflow and enforcement boundary are implemented locally. Mainnet remains `BLOCKED` because independent assessment sign-off, production signer-list evidence, production monitoring evidence, a production recovery exercise, and production authority have not been supplied. No real funds, accounts, keys, or Mainnet transactions were used during implementation.
