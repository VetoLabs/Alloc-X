# Resilience and Recovery

Owner: Platform Operations. Treasury Security and Treasury Operations must independently observe settlement recovery.

## Recovery objectives

- Target recovery point: 5 minutes for payment, decision, queue, and reconciliation state.
- Target recovery time: 10 minutes for a single service; 30 minutes for regional service restoration.
- A recovery exercise fails if integrity verification fails or any queue/reconciliation replay creates a duplicate.

## Restoration procedure

1. Freeze new autonomous execution while reads and independent ledger monitoring remain available.
2. Select the latest checksum-verified backup at or before the required recovery point.
3. Restore into an isolated target and verify every manifest entry before activation.
4. Verify the Approval Layer journal and payment-orchestrator job state before accepting work.
5. Resume the ledger monitor from its durable cursor. Never advance the cursor after a failed ledger read.
6. Recover ambiguous submissions by transaction hash or the exact previously signed blob; never construct a second transaction.
7. Resume queue consumers with their existing idempotency keys and retry budgets.
8. Record measured data loss, recovery duration, integrity result, and duplicate counts. Activation requires a passing exercise.

## Regional failure

Fail traffic to a prepared region only after its restored state and retained journal heads verify. Keep the Approval Layer fail-closed until policy, beneficiary, evidence, accounting, signer, and ledger dependencies are healthy. Signing identities remain independently provisioned and are not copied inside application backups.
