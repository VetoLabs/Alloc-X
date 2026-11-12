# Alloc-X Console

The Alloc-X console is the local treasury-operator workspace. It provides a responsive application shell, payment queue, protected payment creation, signed Approval Layer decision views, decision recovery, and audit timeline.

Run it locally from the repository root:

```text
npm run start --workspace @alloc-x/console
```

Open `http://127.0.0.1:4173`.

The browser is never authoritative for roles, balances, approvals, amounts, destinations, policy outcomes, or payment state. Payment creation accepts only authoritative record references. The server resolves the protected fields, creates the canonical intent, obtains a signed Approval Layer outcome, then writes the decision journal before returning a result.

`runtime/` is deliberately local and ignored. It contains the development signing pair, decision journal, and console payment records. Before external settlement is enabled, replace the in-memory accounting and intent adapters with transactional persistence, move the signing material to KMS/HSM, and complete the independent signer, XRPL adapter, and reconciliation work.
