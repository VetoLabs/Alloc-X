# Alloc-X Product Foundation

Alloc-X is an autonomous, policy-bound treasury allocation and payment system. It helps an organization decide what should be paid, proves why the payment is allowed, blocks unsafe instructions, and settles approved transactions on the XRP Ledger.

This folder is the implementation source of truth for the first production build:

- [ARCHITECTURE.md](./ARCHITECTURE.md) defines the system boundaries, transaction lifecycle, data model, deployment shape, and delivery stages.
- [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) defines Approval Layer and the controls that stop fraudulent, unauthorized, or manipulated payments before treasury assets leave an account.
- [ISSUE_BACKLOG.md](./ISSUE_BACKLOG.md) turns the architecture into ordered, testable engineering work.

## Product promise

Alloc-X may recommend, schedule, and initiate a payment autonomously, but no language model can sign a transaction or bypass policy. Every settlement must pass an independently operated security boundary, produce a verifiable decision receipt, and be reconciled against the ledger.

## Non-negotiable release standard

A release is not considered functional until it can complete the full path below in a configured XRPL environment:

1. ingest a treasury obligation and supporting evidence;
2. select an eligible treasury allocation;
3. create a canonical payment intent;
4. pass deterministic policy and fraud controls;
5. obtain the required independent signatures;
6. submit and validate the transaction on XRPL; and
7. produce a decision receipt containing the validated transaction hash.

Screens, recommendations, or generated transaction payloads without validated settlement do not satisfy this standard.

## Working decisions

- Product name: **Alloc-X**.
- Security boundary: **Approval Layer Treasury Security Gateway**.
- Initial ledger: **XRP Ledger**.
- Initial operating model: organizations with policy-bound budgets and treasury allocations.
- Payment authority: isolated services using weighted multi-signature control; never the AI runtime.
- Connectivity: online settlement first; secure offline operation is the penultimate delivery stage.
- Expansion: reusable organization and public-sector policy packs are the final delivery stage.
- Repository policy: development remains local until the owner explicitly authorizes a remote commit or push.
