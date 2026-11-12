# Key Ceremony and Emergency Exercises

Owner: Treasury Security. Required participants are a key operator, an independent approver, and an independent observer. One person cannot hold multiple duties in the same ceremony.

## Signer lifecycle

1. Provision only a non-exportable KMS or HSM key reference; never record private material.
2. Verify the public XRPL address and provider attestation out of band.
3. Configure execution and policy signers so neither can independently satisfy quorum.
4. For rotation, record old and new references, activate the new signer list through the separate bootstrap authority, verify it on-ledger, then revoke the old reference.
5. For revocation or recovery, freeze autonomous settlement first and retain signer and security-control evidence.

## Emergency exercises

- Organization freeze: apply the freeze, prove new intent creation stops, and require a different approver for release.
- Beneficiary freeze: freeze one beneficiary and prove other eligible beneficiaries remain unaffected.
- Compromised signer: freeze settlement, revoke the key reference, rotate the signer list, and prove the remaining single signer cannot meet quorum.
- Compromised service: revoke its identity, rotate credentials, verify Approval Layer authentication fails closed, and restore only after independent observation.

Every exercise records detection and containment time, supporting event identifiers, participants, and a hash-linked result. A failed objective requires remediation before production activation.
