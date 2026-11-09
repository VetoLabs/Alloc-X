# Alloc-X

**Policy-bound treasury intelligence for Africa.**  
**Allocate. Protect. Settle. Prove.**

Alloc-X is an **XRPL-powered autonomous AI treasury allocation and payment platform** for organizations managing multiple funding sources: donor grants, project and departmental budgets, operational accounts, payroll reserves, and protected funds. An operator tells Alloc-X **who to pay and why**. The agent identifies an eligible source, evaluates the expense against approved rules, requests independent payment authorization, executes the permitted XRPL transaction, reconciles the outcome, and generates an auditable receipt.

> **Project status — planning and early development.** This README describes the **planned capabilities and target architecture**, not features already implemented or deployed. Alloc-X is being developed for the W3Node Node Engine 2026 Ripple Agentic Finance track. Review the [issue backlog](https://github.com/VetoLabs/Alloc-X/issues) for the actual implementation status.

**Organization:** [Veto Labs](https://github.com/VetoLabs) · **Network for MVP:** XRP Ledger Testnet / Devnet · **Focus:** Agentic Finance, financial controls, auditable organizational payments

---

## Why Alloc-X?

For many African SMEs, NGOs, universities, research institutions, and project-funded organizations, the challenge isn't just *sending* money. It's determining **which money is eligible** for a particular payment.

A company can have sufficient cash overall but insufficient *permitted* funding for an invoice. Restricted grants cannot automatically pay unrelated costs. Payroll reserves should not be depleted to cover an ordinary vendor payment. Finance teams currently reconcile these conditions across spreadsheets, agreements, invoices, and manual reviews.

Alloc-X is designed to make the appropriate financial decisions **without giving the AI agent the authority to rewrite its own limits or control the treasury keys**.

### An example

An organization manages three allocations:

- **Healthcare Grant:** permits medical equipment from approved suppliers.
- **Education Grant:** permits education-related expenses, not medical equipment.
- **Payroll Reserve:** protected for staff compensation.

An operator asks: *“Pay the approved supplier for the medical refrigerator.”*

Alloc-X analyzes the invoice and eligible allocations. If all conditions are satisfied, it selects the healthcare grant and executes the payment via independent controls. If the grant does not have enough permitted funds, or an invoice requests an unauthorized wallet, Alloc-X requests review or blocks the payment **rather than taking money from the wrong account**.

## Intended users

- **NGOs, charities, and development programs:** manage donor restrictions, approved expenditures, supporting evidence, and reporting.
- **SMEs, startups, and project businesses:** protect payroll and working capital while paying suppliers from appropriate budgets.
- **Universities, research institutions, and healthcare networks:** allocate sponsor and departmental funds under explicit rules.
- **Public programs (later expansion):** support budget codes, procurement controls, separation of duties, and program audit trails, subject to applicable laws and approvals.

## Complete planned functionalities

The items below describe **what Alloc-X is intended to be capable of doing**, organized into independent modules. Planned does not mean implemented.

### 1. Autonomous AI financial assistant

- Accept **natural-language payment instructions** identifying a recipient, amount, purpose, and due date.
- Add **voice-based input** as a later user-interface option.
- Read trustworthy invoices, balances, spending policies, supplier records, and payment obligations through authorized tools.
- Break requests into bounded steps: understand, allocate, check, authorize, execute, reconcile, and explain.
- Classify expenses and request missing evidence instead of guessing critical financial details.
- Decide whether an obligation should be paid immediately, scheduled, reconsidered, sent for review, or rejected.
- Handle batches of payments subject to the limits governing each individual transaction.
- Explain recommendations and decisions clearly to the operator.
- Use scoped tool APIs; never give the AI unrestricted access to private signing keys or policy administration.

### 2. Intelligent fund allocation and treasury management

- Track multiple **treasury wallets, grants, project budgets, departments, programs, and protected reserves**.
- Choose a funding source that is **eligible** under purpose, amount, date, vendor, location, asset, procurement, and donor restrictions.
- Compare eligible sources based on available balances, prior commitments, deadlines, and approved priority rules.
- Prevent spending from prohibited or unrelated funds even when the organization's aggregate balance is sufficient.
- Enforce minimum cash, payroll, emergency, and project reserves.
- Reserve appropriate budget capacity for pending payment intents and release it safely after failure/cancellation.
- Detect missing, insufficient, exhausted, or ineligible allocations.
- Monitor budget utilization and upcoming payables.
- Forecast cash runway and recommend timing that does not endanger known obligations.
- Support **nonprofit, commercial, and public-sector policy packs** over a common authorization core.

### 3. Independent financial policy management

- Establish per-transaction, per-vendor, category, grant, daily, and velocity-based spending limits.
- Define approved purposes, recipients, payment assets, date windows, evidence requirements, reserves, and exception thresholds.
- Extract candidate rules from grant agreements and other documents **for authorized human review**.
- Let humans simulate, publish, version, activate, revoke, roll back, and freeze financial policies.
- Separate requesters, finance officers, approvers, reviewers, auditors, and signers by role.
- Require human review when a proposed payment falls outside the preapproved autonomous mandate.
- Keep rules and limit changes **outside the agent's control**; human approval is evidence, not a bypass of hard rules.
- Maintain a trace of policy versions and who changed them.

### 4. Approval Layer — internal agent decision governance

Alloc-X will implement its own **Approval Layer** as a first-party, independently administered **evaluate-before-execute** governance component. The agent can request evaluations but cannot change authoritative policy or grant itself approval.

- Submit structured proposed financial actions and relevant evidence for evaluation.
- Receive **ALLOW**, **REVIEW**, or **BLOCK** outcomes.
- Evaluate deterministic hard policies first and use contextual reasoning only when needed.
- Escalate ambiguous actions for authorized human review, then re-evaluate with the new evidence.
- Preserve auditable decision receipts, findings, evidence references, and policy-version linkage.
- Treat missing evidence, policy failure, REVIEW, BLOCK, and unavailable governance services as **non-approval**.
- Require separate transaction-level checks even after an ALLOW verdict.

**Development status:** The Approval Layer is planned as an internal Alloc-X component, with separate authorization and policy administration. No third-party approval engine integration is required.

### 5. Security Layer — payment and supplier protection

The **Security Layer** is Alloc-X's planned first-party supplier authorization and payment-protection component. It is not yet implemented or deployed.

- Register organizations' approved suppliers and verified payment destinations.
- Verify supplier identity/authority and signed invoice instructions.
- Detect altered invoice details, recipient substitutions, unauthorized assets, and expired authorizations.
- Require independent approval, dual control, and optional cooling periods for high-risk beneficiary-wallet changes.
- Match invoices against procurement or contract evidence.
- Identify duplicate invoices, suspicious split payments, and unexpected recipient changes.
- Ensure the signed transaction uses the **exact independently authorized amount, recipient, asset, and obligation**.
- Record security findings for the payment audit trail.

### 6. Canonical payment intents and independent spending enforcement

- Construct canonical payment intents using **server-verified** records, not untrusted browser fields or agent-generated wallet destinations.
- Bind source allocation, beneficiary, amount, token, invoice, expiry, policy version, and unique intent ID.
- Validate intent freshness and protect against replay and double execution.
- Route every permitted action to an **independent policy signer/controller** that rechecks the exact final transaction.
- Use segregated keys and XRPL multi-signature requirements so the AI runtime **cannot spend alone**.
- Enforce spending budgets in independent signing policy—not only in prompts or the LLM's logic.
- Deny payment if amount, recipient, policy, reserve, timing, or approval state changes in an unauthorized way.
- Support emergency payment suspension and explicit recovery procedures.

### 7. XRPL payment execution

- Connect organization-authorized XRPL accounts and maintain supported payment routes.
- Execute real, **agent-initiated XRPL Testnet/Devnet payments** for eligible obligations.
- Build exact XRPL transactions and gather the required protected signatures.
- Submit permitted payments, track ledger validation, and distinguish submission from final settlement.
- Show transaction hashes, amounts, source/destination, fees, and validated outcome.
- Reconcile confirmed payments with the relevant allocation and accounting records.
- Consider additional assets/payment networks only after supported rails, security, and compliance are verified.

### 8. Autonomous payment recovery and reconciliation

- Maintain a durable payment state machine across retries, process restarts, and temporary failures.
- Track requested, evaluated, held for review, authorized, submitted, validated, rejected, uncertain, and reconciled states.
- Investigate **unknown or timed-out outcomes** against validated XRPL ledger evidence before any retry.
- Prevent duplicate payments through idempotency, recorded original transaction references, and independent status checks.
- Retry only after definitive non-settlement and fresh permission to execute the new attempt.
- Identify unexplained outflows, accounting mismatches, stalled tasks, and inconsistent balances.
- Maintain a recovery/exception dashboard and escalation trail for finance operators.
- Record all recovery decisions in the audit history.

**A finalized blockchain payment is not automatically reversible.** Refunds are separately authorized transactions, not magical reversals.

### 9. Offline and low-connectivity operation

- Allow operators to **capture invoices, draft payment requests, and collect evidence** without connectivity.
- Protect locally saved drafts using encrypted, device-scoped storage.
- Queue offline drafts for later synchronization and preserve their history.
- Support optional local QR-style exchange of **provisional** or previously authorized instructions, with clear status labels.
- On reconnection, resolve conflicts, reload authoritative balances and policies, recheck approvals, and only then settle online.
- Distinguish **offline draft**, **pending**, **submitted**, and **validated payment** in the UI.
- Keep treasury signing keys off offline devices.
- Never claim that offline signatures guarantee funds or prevent all offline double spending.

**Offline requests are not settled payments.** The agent cannot use live Approval Layer or XRPL checks while disconnected; final financial authorization remains online.

### 10. Auditability, compliance evidence, and reports

- Generate verifiable payment receipts linking the request, chosen allocation, rule version, evidence, approvals, authorized transaction, ledger result, and final accounting status.
- Maintain a chronological, tamper-evident audit log of financial and administrative events.
- Allow reviewers to inspect blocked actions, suspicious changes, decisions, and payment recovery history.
- Produce budget usage, grant/program expenditure, beneficiary, and treasury-operation summaries.
- Export donor/auditor evidence packets when authorized.
- Track unknown outflows, receipt integrity failures, security events, and operational health.
- Protect confidential files and personal information; place only suitable evidence hashes/references on public ledgers.
- Distinguish technical authorization from legal or donor compliance: **human-approved rules and genuine external evidence remain essential**.

### 11. Web interface, roles, and administration

- Provide a responsive, mobile-friendly **web app/PWA** for organizations and finance teams.
- Support organization onboarding, team invitations, department workspaces, and role-based access.
- Provide **Command Centre**, **Ask Alloc-X**, **Security & Approvals**, **Payment & Receipt**, **Policy Studio**, **Offline & Sync**, and **Proof & Reporting** interfaces.
- Show current balances, allocation restrictions, pending obligations, reviews, transactions, and exceptions without overwhelming the user.
- Clearly distinguish AI suggestions, human-administered rules, and ledger-confirmed outcomes.
- Send notifications for review requests, rejected/blocked payments, settled transfers, and recovery cases.
- Introduce accounting/ERP and MCP-compatible adapters under well-scoped credentials and tool contracts.

### 12. Operational security and production readiness

- Enforce tenant isolation, MFA/step-up authorization, role permissions, and secure service identities.
- Use encrypted evidence storage and independent KMS/HSM-protected signing services for production.
- Maintain durable queues, bounded retries, encrypted backups, tracing, service-health checks, and alerting.
- Separate development, XRPL Testnet/Devnet, staging, and production environments and keys.
- Run security tests for prompt injection, approval bypass, invoice alteration, replay, duplicate settlement, wallet-change attacks, and system failures.
- Require independent security validation and explicit multi-person release controls before activating mainnet settlement.

---

## Payment lifecycle

```text
USER REQUEST
  -> UNDERSTAND (invoice, payee, purpose, supporting records)
  -> ALLOCATE (eligible fund, reserve and budget checks)
  -> GOVERN (Approval Layer: ALLOW / REVIEW / BLOCK)
  -> VERIFY (Security Layer: authentic invoice and authorized recipient)
  -> AUTHORIZE (independent financial policy controller)
  -> SIGN (protected XRPL signer quorum)
  -> SETTLE (XRPL submission and validated ledger outcome)
  -> RECONCILE (accounting, exceptions and safe recovery)
  -> PROVE (decision receipt, audit trail and reporting)
```

At **REVIEW**, **BLOCK**, or failed independent authorization, the payment **must not be signed**. An unknown settlement result must be reconciled before another attempt is considered.

## Core security principles

1. **No self-approval:** the AI agent cannot change its own rules, limits, or signing permissions.
2. **No untrusted payment fields:** payment-critical data must be resolved against authoritative records.
3. **No approval reuse:** each approval applies to the exact payment and applicable policy state.
4. **No signing after REVIEW/BLOCK:** human review cannot silently override deterministic safety restrictions.
5. **No blind retry:** a lost confirmation must not cause an automatic second payment.
6. **No false offline settlement:** queued offline drafts are provisional until validated online.
7. **No unsupported compliance claims:** policy enforcement depends on reviewed rules and trustworthy evidence.

## Ripple Agentic Finance / W3Node MVP

The initial working prototype aims to demonstrate:

- An **autonomous XRPL Testnet or Devnet transaction** initiated by the agent.
- Financial limits enforced **outside the agent's control**, such as a protected policy signer and ledger-enforced signature quorum.
- A distinct interface for an authorized human to establish or modify those limits.
- Successful allocation selection, an independently rejected malicious/unauthorized payment, and traceable ledger evidence.

These are **acceptance criteria**, not evidence that the functionality already exists.

## Delivery roadmap

| Phase | Priority | Target capabilities | Status |
| --- | --- | --- | --- |
| Agentic Finance MVP | P0 | Agent, allocations, policy controls, built-in Approval Layer, initial Security Layer checks, independent XRPL signing, validated testnet transaction, baseline receipts | Planned |
| Reliable financial platform | P1 | Durable recovery, richer fraud/evidence checks, forecasting, finance reporting, security testing, integrations | Planned |
| Expansion and commercialization | P2 | Encrypted offline workflows, sector policy packs, production infrastructure, additional authorized payment connectors | Planned |

Follow the [repository issues](https://github.com/VetoLabs/Alloc-X/issues) for detailed, ordered implementation tasks. The repository may contain open planning issues before the corresponding code is written.

## Proposed technical architecture

| Area | Technology and boundary (proposed) |
| --- | --- |
| Frontend | React, Next.js, TypeScript, responsive PWA |
| Agent & application APIs | Node.js, TypeScript, schema-validated tool contracts |
| Governance | First-party Approval Layer with independently administered deterministic policies |
| Recipient security | First-party Security Layer and verified beneficiary registry |
| Financial state | PostgreSQL, durable work queue, encrypted object storage |
| XRPL integration | `xrpl.js`, exact-transaction validation, multi-signing, ledger monitor |
| Access control | OIDC, MFA, tenant roles, segregation of duties |
| Production key protection | Dedicated policy signer, KMS/HSM and independent signing authority |
| Reliability | CI/CD, observability, backups, reconciliation and audit trails |

This is a **target design**, not a statement that these components or technologies are already present in the repository.

## Africa-first impact

Alloc-X aims to contribute to:

- **SDG 8 — Decent Work and Economic Growth:** improve SME financial operations and protect payroll/working capital.
- **SDG 9 — Industry, Innovation and Infrastructure:** enable accessible, Africa-built intelligent financial infrastructure.
- **SDG 16 — Peace, Justice and Strong Institutions:** strengthen transparent controls, traceable decisions, and accountability.
- **SDG 17 — Partnerships for the Goals:** facilitate responsible donor and project fund administration and reporting.

These are **intended development outcomes**, to be tested through real pilots and measurable results rather than assumed impacts.

## Contributing

Alloc-X is being developed under [Veto Labs](https://github.com/VetoLabs). Contributors should consult the [issue backlog](https://github.com/VetoLabs/Alloc-X/issues), document proposed behavior, and add test evidence for every financial/security feature. Never commit sensitive credentials, treasury keys, real beneficiary personal information, or confidential donor documents.

**Internal safeguards:** Approval Layer (governance) and Security Layer (payment verification)  
**Repository:** [VetoLabs/Alloc-X](https://github.com/VetoLabs/Alloc-X)

---

**Alloc-X — One instruction. The right money. A safe payment. Proof.**
