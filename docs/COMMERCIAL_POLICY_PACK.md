# Commercial Organization Policy Pack

The commercial pack adds business-specific controls through the organization capability profile while retaining the same Alloc-X payment, Approval Layer, signing, and receipt boundaries.

## Controls

- Department-level authorized, committed, spent, and available budget views.
- Vendor status checks and purchase-order requirements.
- Payroll-vendor separation: payroll payments may only use designated payroll vendors, and those vendors cannot be used for unrelated spend.
- Purchase-order, invoice, delivery, amount, and tax-tolerance checks.
- Digest-bound treasury reporting by department.

The pack is advisory and deterministic: it returns `ALLOW`, `REVIEW`, or `DENY` plus reason codes. It cannot reserve capacity, approve a payment, change policy, sign a transaction, submit to the ledger, or alter accounting balances. Its result must still be evaluated by the shared Approval Layer before settlement.
