# Mainnet Freeze and Rollback

## Trigger conditions

Freeze immediately when any of the following occurs:

- An unknown treasury outflow or transaction mismatch.
- Signer failure, suspected key compromise, or quorum drift.
- A transaction remains ambiguous beyond its approved ledger window.
- Independent monitoring becomes unhealthy or disagrees with submission telemetry.
- Reconciliation misses its objective.
- The security assessment gate becomes invalid.
- A rollout limit is unexpectedly reached or bypass is suspected.

## Freeze procedure

1. A security approver or platform operator invokes the Mainnet Activation service freeze operation with a digest-bound incident reason.
2. Confirm that the phase is `FROZEN` and that both new settlement authorization and XRPL adapter access fail closed.
3. Freeze the affected organization through Treasury Security Controls.
4. Preserve activation events, payment-job records, signer audit events, ledger-monitor evidence, and operational telemetry.
5. Reconcile all authorized transactions against validated ledger history using the independent monitoring endpoint.
6. Escalate suspected signer compromise through the signer key ceremony and revocation process.

## Rollback procedure

1. A security approver or platform operator records the digest-bound rollback decision.
2. Confirm that the activation phase is `ROLLED_BACK`.
3. Keep Mainnet adapter access disabled.
4. Revoke or rotate affected signer references when required.
5. Reconcile all known authorizations and investigate every unmatched outflow.
6. Complete remediation, independent retesting, recovery exercises, and new configuration approvals.

There is no direct resume operation. A rolled-back rollout requires a new reviewed activation cycle so a single actor cannot silently restore autonomous settlement.
