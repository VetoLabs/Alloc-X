# Alloc-X Engineering Issue Backlog

## 1. Backlog rules

This backlog is ordered by dependency and treasury risk. Security controls are part of the settlement path, not a later enhancement.

Priority meanings:

- **P0:** required to move assets safely and reconcile the result;
- **P1:** required for the first production release;
- **P2:** valuable expansion after the core release is stable.

An issue is complete only when code, automated tests, observability, operational documentation, and security acceptance criteria are finished. Mocked ledger success does not satisfy any issue that requires settlement evidence.

## 2. Release milestones

| Milestone | Outcome | Exit evidence |
|---|---|---|
| M1 â€” Secure foundation | Identities, typed contracts, deterministic policy kernel, audit chain, and the role-aware application shell exist | Authorization, isolation, schema, tamper, and accessibility checks pass |
| M2 â€” Controlled settlement | Alloc-X autonomously settles an allowed XRPL payment and blocks unsafe variants | Validated transaction hash, decision receipt, veto test report, and operator-visible payment timeline |
| M3 â€” Policy operations | Operators can compile, simulate, publish, and roll back policy versions safely | Approved source-to-policy trace and simulation report |
| M4 â€” Evidence and fraud defense | Invoice, vendor, beneficiary, duplicate, and anomaly controls protect payments | Attack corpus and three-way-match tests pass |
| M5 â€” Autonomous treasury planning | Agent selects allocations and timing, then replans safely after vetoes | Scenario evaluation and budget correctness report |
| M6 â€” Production readiness | Resilience, monitoring, recovery, privacy, and security reviews are complete | Operational readiness and independent security sign-off |
| M7 â€” Offline operation | Core non-settlement workflows work offline and synchronize safely | Conflict, tamper, device-loss, and reconnect revalidation tests pass |
| M8 â€” Organization expansion | Configurable policy packs support broader organizations and public-sector workflows | At least three organization packs pass the same settlement contract suite |

## 3. Stage 1 â€” Secure foundation

### AX-001 â€” Initialize the production repository and environments

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** none
- **Deliver:** application, service, package, infrastructure, and test workspaces; local, test, staging, and production configuration boundaries; secret scanning; formatting; linting; unit and integration test commands.
- **Acceptance:** a clean checkout can be configured without committed secrets; each environment uses distinct identities and ledger accounts; CI-equivalent checks run locally.

### AX-002 â€” Define versioned domain contracts

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-001
- **Deliver:** schemas and types for organization, principal, obligation, allocation, beneficiary, evidence manifest, payment intent, security decision, approval, ledger transaction result, and decision receipt.
- **Acceptance:** invalid amounts, addresses, unknown executable fields, expired timestamps, and cross-organization identifiers are rejected; canonical serialization is stable across repeated runs.

### AX-003 â€” Implement identity, organization tenancy, and authorization

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-002
- **Deliver:** authentication, tenant isolation, server-side roles and attributes, service identities, step-up authentication hooks, and segregation-of-duties rules.
- **Acceptance:** cross-tenant reads and writes fail; initiators cannot approve their own high-risk actions; authorization tests cover every state-changing route.

### AX-004 â€” Build the deterministic policy kernel

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-002
- **Deliver:** pure policy evaluation for purpose, amount, allocation, reserve, time window, asset, evidence, beneficiary, velocity, and approval requirements.
- **Acceptance:** identical input and policy version always produce the same result; property tests cover boundary values; fail-closed behavior is proven.

### AX-005 â€” Create the append-only audit chain

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-002, AX-003
- **Deliver:** structured security events, correlation identifiers, hash chaining, protected retention, tenant-scoped search, and tamper verification.
- **Acceptance:** insertion, modification, deletion, or reordering of audited events is detectable; sensitive payloads are redacted.

### AX-006 â€” Implement authoritative treasury accounting

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-002
- **Deliver:** allocation envelopes, available/committed/settled balances, reservations, fixed-precision arithmetic, concurrency control, and journal entries.
- **Acceptance:** concurrent intents cannot reserve the same capacity; accounting invariants hold under retry and cancellation tests.

### AX-007 â€” Build the Alloc-X application shell and UX system

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-001, AX-003
- **Deliver:** responsive authenticated web application shell; role-aware navigation; clear connectivity, loading, error, and empty states; shared components; accessibility baseline; and task journeys for treasury operators, approvers, security officers, and auditors.
- **Acceptance:** users can navigate only to authorized areas; critical workflows work with keyboard and screen readers; destructive actions present an explicit consequence and confirmation state; user-facing language distinguishes `ALLOW`, `REVIEW`, and **Blocked** without hiding the machine decision.

### AX-008 â€” Deliver the payment operations workspace

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-006, AX-007, AX-010, AX-011R
- **Deliver:** allocation and treasury balance views; reference-based payment-intent creation; payment queue and detail views; live `ALLOW`/`REVIEW`/`DENY` status; policy reason codes and control trace; approval requirements; decision receipt access; and a complete payment lifecycle timeline.
- **Acceptance:** the UI never accepts a free-text destination or client-authoritative amount; it cannot represent a `REVIEW` or `DENY` decision as executable; operators can recover a persisted decision after refresh or restart; every displayed payment state derives from server data.

## 4. Stage 2 â€” Approval Layer and controlled XRPL settlement

### AX-010 â€” Build canonical payment intent creation

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-002, AX-003, AX-006
- **Deliver:** server-side intent builder, authoritative beneficiary and allocation resolution, idempotency keys, immutable versions, and state machine.
- **Acceptance:** free-text destinations never enter an intent; mutations create a new digest; repeated requests return the same intent rather than a second payment.

### AX-011 â€” Implement the Approval Layer evaluation service

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-004, AX-005, AX-010
- **Deliver:** independently authenticated service, ordered gates, signed `ALLOW/REVIEW/DENY` decisions, expiry, reason codes, and fail-closed dependency handling.
- **Acceptance:** no payment worker route can proceed without a valid signed decision; expired, altered, or cross-tenant decisions are rejected.

### AX-011R â€” Add durable internal security-decision recovery

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-011
- **Deliver:** a hash-linked durable decision journal, correlation-id replay protection, restart recovery, integrity verification, and a settlement recovery gate that revalidates the original signed decision.
- **Acceptance:** a new service instance recovers an unexpired decision and verifies it against the original intent; conflicting retries and journal tampering are detected; journal-write failures do not release a result to the caller.
- **Deployment note:** local operation uses an fsynced filesystem journal. Before autonomous production settlement, replace it with a transactional database adapter, independently retained journal-head anchors, and a KMS/HSM signing provider.

### AX-012 â€” Build the beneficiary registry and change controls

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-003, AX-005
- **Deliver:** wallet validation, ownership verification workflow, version history, dual control, notifications, cooling period, and disable/freeze actions.
- **Acceptance:** a changed wallet cannot redirect an existing intent; unapproved, disabled, or cooling-period addresses are vetoed.

### AX-013 â€” Implement the XRPL adapter

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-002
- **Deliver:** account-state reads, amount conversion, transaction serialization, fees, expiry, sequence or ticket management, preflight, multi-sign assembly, submission, validation polling, and normalized errors.
- **Acceptance:** integration tests submit and validate a payment in the configured non-production XRPL environment; serialized transaction fixtures are deterministic.

### AX-014 â€” Provision independent signer services

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-011, AX-013
- **Deliver:** isolated execution and policy signer identities, KMS/HSM integration, XRPL signer-list configuration, digest verification, signer audit logs, rotation procedure, and recovery signer procedure.
- **Acceptance:** neither signer can settle alone; altered amount, destination, asset, fee, expiry, or network is refused; keys never appear in application memory dumps or logs.

### AX-015 â€” Build the durable payment orchestrator

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-010, AX-011, AX-013, AX-014
- **Deliver:** durable queue, leases, bounded retries, exact transaction construction, signature collection, exactly-once submission behavior, and terminal state handling.
- **Acceptance:** worker crashes and redelivery do not create duplicate settlements; every signed transaction maps to one live allowed digest.

### AX-016 â€” Implement independent ledger monitoring and reconciliation

- **Status:** Complete locally â€” 2026-11-07
- **Priority:** P0
- **Depends on:** AX-006, AX-013, AX-015
- **Deliver:** read-only account watcher, validated-transaction ingestion, intent matching, accounting finalization, unknown-outflow alerts, and drift repair workflow.
- **Acceptance:** the system distinguishes submitted from validated; unknown treasury transactions alert independently; temporary outages catch up without duplication.
- **Local evidence:** the monitor has a separate read-only XRPL adapter that verifies network identity and ingests only validated successful native-XRP payments. Expected settlements, cursors, observed hashes, reconciliations, and alerts are persisted in an fsynced hash-chained journal; restart, replay, outage recovery, accounting finalization, source filtering, and tamper tests pass locally. Deployed operation requires a separately retained transactional store and independent read-only service identity.

### AX-017 â€” Deliver the first complete autonomous payment path

- **Status:** Complete locally â€” 2026-11-08
- **Priority:** P0
- **Depends on:** AX-008, AX-010 through AX-016
- **Deliver:** obligation intake, allocation selection, intent creation, Approval Layer decision, quorum signing, XRPL submission, validation, reconciliation, and operator-visible receipt and timeline.
- **Acceptance:** one permitted payment reaches `RECONCILED` with a real validated hash; variants with an unauthorized wallet, over-limit amount, duplicate idempotency key, expired decision, and changed transaction digest are stopped before signing and clearly explained in the workspace.
- **Local evidence:** a server-owned payment-path coordinator composes security evaluation, authoritative destination resolution, durable orchestration, validated settlement, independent monitoring, accounting finalization, and reconciliation. Console settlement is dependency-injected and stays disabled without separately configured signers and ledger adapters. Unit tests prove that an allowed intent reaches `RECONCILED` and review, denial, or a changed beneficiary wallet are stopped before enqueueing. A gated XRPL Testnet acceptance run completed one Approval Layer-authorized native-XRP payment through a 2-of-3 signer list and independently reconciled the validated hash to its accounting reservation.

## 5. Stage 3 â€” Mandate Compiler and policy operations

### AX-020 â€” Build policy source ingestion

- **Status:** Complete locally â€” 2026-11-08
- **Priority:** P1
- **Depends on:** AX-004, AX-005
- **Deliver:** encrypted document upload, extraction provenance, clause citations, structured draft generation, and unsupported-rule warnings.
- **Acceptance:** every generated rule links to source evidence; document text cannot call tools or alter system instructions.
- **Local evidence:** the Policy Source service encrypts accepted UTF-8 source uploads with AES-256-GCM, records byte and extraction hashes, and produces immutable clause-level provenance. Its deterministic draft generator recognizes only explicit policy clauses and emits every draft rule with an exact clause hash. Citation substitution is rejected; unsupported or instruction-like text is retained only as a warning. The service has no publishing method and no tool interface.

### AX-021 â€” Build human review and policy publication

- **Status:** Complete locally â€” 2026-11-08
- **Priority:** P1
- **Depends on:** AX-020
- **Deliver:** draft diff, four-eyes publication, effective dates, signed immutable bundle, revocation, and rollback to a previously published version.
- **Acceptance:** the agent cannot publish; published versions cannot be edited; all intents bind to one explicit version.
- **Local evidence:** the Policy Registry requires a human policy author, a separate human approver, and a non-author human publisher. It signs immutable policy bundles using Ed25519, exposes signature verification, activates versions only at their effective date, and records hash-linked lifecycle events. An agent is rejected from publication; source or policy tampering invalidates verification. Revocation appends an immutable event, while rollback activates an earlier non-revoked version without editing either bundle. Existing payment-intent creation remains bound to one explicit `policyVersion` reference.

### AX-022 â€” Implement the policy simulator

- **Status:** Complete locally â€” 2026-11-08
- **Priority:** P1
- **Depends on:** AX-021
- **Deliver:** historical and synthetic scenario runner, allow/review/deny comparison, autonomy rate, maximum exposure, reserve impact, and regression report.
- **Acceptance:** publication can require a passing simulation threshold; unexpected decision changes are presented before activation.
- **Local evidence:** the Policy Simulator evaluates the same scenarios against baseline and candidate bundles, separately recording every outcome, reason-code change, and expected or unexpected regression. Reports include autonomy rate, aggregate and maximum permitted exposure, and minimum remaining treasury reserve. Threshold assessment can gate Policy Registry publication; the registry calls the gate before signing or activating a bundle. Tests cover a permitted expected change, an unexpected historical regression, and a gate rejection.

### AX-023 â€” Build the Approval Layer security console

- **Status:** Complete locally â€” 2026-11-08
- **Priority:** P1
- **Depends on:** AX-011, AX-021
- **Deliver:** live controls, decision trace, reason codes, policy versions, beneficiary events, signer health, emergency freeze, and safely scoped limit changes.
- **Acceptance:** operators can explain any veto from deterministic evidence; weaker controls require stronger approval than applying a freeze.
- **Local evidence:** the console presents signed decision traces and reason codes, policy and beneficiary status, signer health, durable decision-journal health, active freezes, and control-change history. An emergency freeze is persisted and blocks matching payment creation before an intent is made; an independent approver releases it. Limit changes are separately recorded: tightening requires two humans, while a relaxation requires a third independent escalation before it can enter policy publication. Service and console tests cover each boundary.

## 6. Stage 4 â€” Decision receipts, vendor integrity, and fraud defense

### AX-030 â€” Generate verifiable decision receipts

- **Status:** Complete locally â€” 2026-11-08
- **Priority:** P1
- **Depends on:** AX-005, AX-016, AX-017
- **Deliver:** immutable receipt builder, policy citations, evidence hashes, budget movement, security decisions, signer attestations, XRPL details, downloadable export, and verification endpoint.
- **Acceptance:** changing any receipt field invalidates verification; the validated transaction and receipt reference each other through a stored digest.
- **Local evidence:** the receipt builder hashes the canonical receipt content, persists it immutably, and verifies both receipt and transaction-link digests. The console creates a receipt after every payment decision, exposes a verification endpoint, and downloads only a verified export. Validated transactions receive an immutable stored link containing both transaction and receipt digests.

### AX-031 â€” Build the evidence pipeline

- **Priority:** P1
- **Depends on:** AX-005
- **Deliver:** malware scanning, isolated parsing, OCR provenance, encryption, content hashes, document classification, retention controls, and prompt-injection signals.
- **Acceptance:** unsafe files are quarantined; instruction-like document content is never executed; every extracted fact retains provenance.
- **Local evidence:** the evidence service scans before parsing, stores source content encrypted with AES-256-GCM, quarantines known unsafe signatures, parses in a bounded no-tool boundary, records parser/OCR provenance and a content hash for each extracted fact, classifies supported source types, applies retention metadata, and flags instruction-like content as data rather than commands.

### AX-032 â€” Implement duplicate and split-payment detection

- **Priority:** P1
- **Depends on:** AX-031, AX-011
- **Deliver:** exact hash detection, normalized invoice fingerprints, fuzzy vendor/reference/amount matching, temporal grouping, and split-threshold evasion rules.
- **Acceptance:** exact duplicates are denied and near or split duplicates route to review with linked evidence.
- **Local evidence:** the duplicate-detection service produces the policy-ready evidence status used by the Security Layer. It denies exact content-hash and normalized invoice-fingerprint matches, routes fuzzy vendor/reference/amount matches and bounded same-vendor split patterns to review, and always returns the linked evidence IDs and matching signals. Its result is organization-scoped and excludes future evidence.

### AX-033 â€” Implement procurement evidence matching

- **Priority:** P1
- **Depends on:** AX-012, AX-031
- **Deliver:** purchase-order, invoice, delivery, beneficiary, amount, tax, and asset matching with organization-configured tolerances.
- **Acceptance:** mismatches are visible and policy-addressable; missing evidence cannot be inferred as present by the agent.
- **Local evidence:** the procurement matcher checks purchase orders, invoices, and optionally required delivery proof against organization-scoped amount and tax tolerances. Beneficiary, asset, organization, and purchase-order references must match exactly. The Security Layer receives a required procurement status: missing or mismatched evidence denies settlement, while a review status routes the payment for human attention.

### AX-034 â€” Add fraud and anomaly scoring

- **Priority:** P1
- **Depends on:** AX-011, AX-012, AX-016
- **Deliver:** versioned features for amount, velocity, timing, beneficiary age, concentration, operator behavior, and treasury drain; deterministic override rules; explainable outcomes.
- **Acceptance:** model unavailability fails according to published policy; no score can override a deterministic denial; drift metrics are monitored.
- **Local evidence:** the versioned Fraud Scoring service calculates a deterministic, explainable score from the required payment features and records each contributing signal. Confirmed fraud beneficiaries receive a denial-level score. The existing Security Layer fails closed when its risk dependency is unavailable and preserves all deterministic denials. A bounded drift monitor reports aggregate score movement and intervention rates without retaining payment details.

### AX-035 â€” Build attack and abuse-case test suites

- **Priority:** P0
- **Depends on:** AX-011, AX-014, AX-031 through AX-034
- **Deliver:** automated cases for prompt injection, tenant escape, wallet substitution, duplicate invoices, approval replay, amount mutation, race conditions, queue replay, malicious files, and signer compromise simulations.
- **Acceptance:** all critical abuse cases block before signing and emit the expected reason code and audit event.
- **Local evidence:** the dedicated abuse-case suite covers malicious and instruction-like evidence, tenant escape, exact duplicate invoices, beneficiary wallet substitution, capacity races, approval-correlation replay, durable queue replay, transaction amount mutation, and a compromised single signer. It verifies that blocked duplicate payments emit an Approval Layer audit event without queueing settlement, while mutation attempts emit signer refusal records.

## 7. Stage 5 â€” Autonomous allocation and cash planning

### AX-040 â€” Create the allocation agent with bounded tools

- **Priority:** P1
- **Depends on:** AX-004, AX-006, AX-010, AX-031
- **Deliver:** durable agent sessions, typed read tools, draft-intent tool, evidence-request tool, policy explanation tool, and full action tracing. Use the established application stack; choose an agent runtime during implementation based on durability and deployment requirements.
- **Acceptance:** the agent cannot access credentials, raw signing, policy publication, direct SQL, or arbitrary network tools; tool authorization is enforced server-side.
- **Local evidence:** the Allocation Agent has durable, organization- and principal-scoped sessions backed by atomic storage. Its server-owned typed tool surface is limited to resolving approved beneficiaries, requesting evidence, explaining policy, and creating bounded drafts; every action records input and output digests. The console exposes the same bounded workflow and its durable action trace. It has no signing, credential, policy-publication, database, settlement, or arbitrary-network tool. Console verification proves an agent draft does not create or settle a payment.

### AX-041 â€” Implement cash runway forecasting

- **Priority:** P1
- **Depends on:** AX-006
- **Deliver:** expected inflows, obligations, confidence ranges, reserves, payroll protection, scenarios, and variance tracking.
- **Acceptance:** forecasts never alter authoritative balances; assumptions and data freshness are visible.
- **Local evidence:** the Cash Forecasting service produces deterministic conservative, expected, and optimistic runway scenarios from expected inflows and scheduled obligations. It protects the reserve floor and payroll in every scenario, exposes first protection-breach dates, confidence ranges, and observed-versus-expected variance, and accepts no accounting write capability. The console presents a Cash Runway workspace with data freshness, assumptions, protections, scenario comparison, and the event timeline.

### AX-042 â€” Implement payment scheduling and allocation selection

- **Priority:** P1
- **Depends on:** AX-040, AX-041
- **Deliver:** pay-now/pay-later recommendations, expiring-allocation priority, eligible allocation selection, partial schedules, and fee-aware timing.
- **Acceptance:** schedules respect due dates, policy, reserve floors, and committed balances under concurrent updates.
- **Local evidence:** the Payment Scheduling service deterministically ranks scheduled obligations by due date, selects the earliest-expiring eligible allocation, accounts for the reserve floor and estimated XRPL fee, and yields pay-now, pay-later, partial, or hold recommendations. A snapshot digest and mandatory revalidation flag prevent a recommendation from becoming executable after capacity changes. The console presents the live Payment Plan and clearly states that only a later canonical-intent and Approval Layer flow can create a payment.

### AX-043 â€” Implement safe replanning after veto

- **Priority:** P1
- **Depends on:** AX-023, AX-040, AX-042
- **Deliver:** reason-code-to-action mapping for requesting evidence, lowering or splitting an amount, choosing another eligible allocation, delaying, selecting an approved beneficiary, or requesting the named approval.
- **Acceptance:** the agent cannot remove checks, edit a denial, reuse an approval for changed data, or create repeated intents without bounded retry limits.
- **Local evidence:** the Safe Replanning service maps a signed veto reason to bounded corrective workâ€”request evidence, reduce or split a permitted amount, choose another eligible allocation, delay, select an approved beneficiary, request independent approval, or escalate. Every step explicitly invalidates prior approvals, never edits the original decision, cannot create a replacement intent, and escalates when the configured retry limit is reached.

### AX-044 â€” Build agent quality and safety evaluations

- **Priority:** P1
- **Depends on:** AX-040 through AX-043
- **Deliver:** decision scenarios, adversarial evidence, tool-selection accuracy, calculation correctness, safe-replanning tests, regression thresholds, and trace review.
- **Acceptance:** a release fails when critical safety scenarios regress; settlement correctness does not depend on model compliance.
- **Local evidence:** the Agent Evaluations service makes critical evaluation failures release-blocking. The suite covers typed-tool selection, adversarial instruction refusal, calculation and replanning checks, durable trace expectations, and absence of any signing tool. The evaluation is run by the local quality gate, so a critical safety regression fails the build rather than being reported as an advisory warning.

## 8. Stage 6 â€” Operational hardening

### AX-050 â€” Add production observability and alerting

- **Priority:** P1
- **Depends on:** AX-016, AX-023
- **Deliver:** service health, queues, payment latency, veto rates, signer failures, reconciliation lag, unknown outflows, policy errors, model cost, and privacy-safe traces.
- **Acceptance:** each critical failure has an actionable alert, owner, and runbook; secrets and full evidence are absent from telemetry.
- **Local evidence:** the Operational Monitoring service records bounded health, queue, latency, veto-rate, signer, reconciliation, unknown-outflow, policy-error, and model-cost signals. Threshold breaches create open alerts with a severity, accountable owner, and repository runbook. Telemetry rejects secret, credential, signing, destination, and raw-evidence attributes before storage. The console Operations workspace renders the live monitoring snapshot rather than static status cards.

### AX-051 â€” Complete resilience and recovery engineering

- **Priority:** P0
- **Depends on:** AX-015, AX-016, AX-050
- **Deliver:** backups, point-in-time recovery, queue recovery, regional failure plan, ledger outage behavior, dependency timeouts, and tested restoration procedures.
- **Acceptance:** recovery objectives are measured in exercises; Approval Layer fails closed; validation and reconciliation resume without double payment.
- **Local evidence:** the Resilience and Recovery service creates point-in-time file backups with per-entry SHA-256 manifests, verifies integrity before restoration, restores each explicit target atomically, rejects tampered archives and path traversal, and provides fail-closed dependency timeouts. Recovery exercises measure RPO, RTO, integrity, queue duplicates, and reconciliation duplicates. The release gate also runs durable payment-orchestrator restart recovery and ledger-monitor cursor/reconciliation recovery tests, while the regional restoration runbook requires independent journal verification before execution resumes.

### AX-052 â€” Complete key ceremony and emergency exercises

- **Priority:** P0
- **Depends on:** AX-014, AX-023
- **Deliver:** signer provisioning, rotation, revocation, recovery, organization freeze, beneficiary freeze, and compromised-service response procedures.
- **Acceptance:** designated operators complete observed exercises; audit evidence proves no single participant can silently bypass quorum.
- **Local evidence:** the Key Ceremony service durably records signer provisioning, rotation, revocation, recovery, and emergency exercises without storing private key material. Every record is hash-linked and binds an operator, separate approver, and separate observer to an external attestation or security-event evidence. The service rejects overlapping duties, records measured detection and containment results, and recovers and verifies its journal after restart. The operational runbook covers organization and beneficiary freezes plus compromised signer and service response, while signer tests prove a single participant cannot satisfy quorum.

### AX-053 â€” Complete privacy, retention, and data governance

- **Priority:** P1
- **Depends on:** AX-003, AX-031
- **Deliver:** data inventory, classification, tenant export/deletion where permitted, retention policies, encryption, residency options, and privileged-access reviews.
- **Acceptance:** retention is policy-driven and testable; audit obligations and deletion requirements are reconciled explicitly.
- **Local evidence:** the Data Governance service inventories tenant records by category, classification, residency, encryption, and legal-hold state. It produces tenant-scoped exports with digest-bound manifests, enforces category retention through a storage adapter, deletes only expired and permitted data, preserves legal holds and immutable security/audit/ledger obligations with an explicit reason, blocks residency violations, and identifies overdue unconfirmed privileged grants for revocation. Default policies and the reconciliation between deletion and audit duties are documented and tested.

### AX-054 â€” Conduct independent security assessment

- **Priority:** P0
- **Depends on:** AX-035, AX-051 through AX-053
- **Deliver:** architecture review, penetration test, dependency and infrastructure review, remediation tracking, and retest.
- **Acceptance:** all critical and high findings affecting settlement are resolved before autonomous production activation.
- **Local evidence:** the Security Assessment service rejects self-assessment, requires independent attestation and complete architecture, penetration-test, dependency, and infrastructure scope, tracks evidence-bound findings through remediation and independent retest, and blocks production while any high or critical settlement finding remains unresolved. Dependency versions are now lockfile-pinned. External assessor execution and sign-off remain intentionally pending; the readiness document states that the service cannot self-certify independence and main-network activation stays blocked until evidence is entered.

### AX-055 â€” Activate main-network settlement controls

- **Priority:** P0
- **Depends on:** AX-017, AX-030, AX-035, AX-050 through AX-054
- **Deliver:** production account setup, signer list, allowlisted assets, conservative initial limits, monitored rollout, rollback/freeze plan, and finance reconciliation sign-off.
- **Acceptance:** a controlled low-value payment validates and reconciles; independent monitoring confirms the exact approved transaction; rollout limits remain enforced outside the agent.
- **Local evidence:** the Mainnet Activation service now provides a durable fail-closed rollout state machine, digest-bound configuration, separate platform, security, finance, settlement, and monitoring duties, conservative native-XRP pilot and daily limits, exact approved-transaction validation, finance reconciliation, dual approval for full rollout, and immediate freeze or rollback. XRPL Mainnet adapter use requires the live activation gate, enforces network ID `0`, and rejects a `NetworkID` field on Mainnet. The console exposes a read-only Mainnet readiness view. Automated tests prove that an incomplete independent assessment blocks the pilot, the allocation agent cannot activate or authorize settlement, over-limit payments are refused, mismatched monitoring evidence is rejected, and a tampered activation journal fails closed. Live Mainnet acceptance remains pending the external AX-054 sign-off, production signer and monitoring evidence, production authority, and a controlled funded pilot; no production transaction has been submitted.

## 9. Stage 7 â€” Offline operation

### AX-060 â€” Build encrypted offline storage and device trust

- **Priority:** P2
- **Depends on:** AX-003, AX-005, AX-053
- **Deliver:** encrypted local database, device binding, short-lived offline authorization, signed append-only operation journal, remote revocation, and secure wipe behavior.
- **Acceptance:** copied storage is unreadable; altered journal entries are detected; expired or revoked devices cannot synchronize privileged actions.
- **Local evidence:** the Offline Device Trust service now supports server-side device enrollment and revocation, Ed25519-signed authorization grants limited to eight hours, device-bound AES-256-GCM vault storage, an append-only hash-linked and device-signed operation journal, monotonic-clock enforcement, operation and journal-size limits, forbidden signing-material checks, synchronization preflight against current server trust, and cryptographic wipe followed by best-effort overwrite and file deletion. Tests prove that copied storage cannot be opened with another device key, plaintext does not leak into the vault file, changed or reordered journal entries fail verification, expired and remotely revoked devices cannot synchronize, clock rollback and allocation-agent writes are rejected, and wipe destroys the key and removes the vault. The console now exposes explicit offline device and synchronization status without representing preparation as settlement.

### AX-061 â€” Implement offline treasury workflows

- **Priority:** P2
- **Depends on:** AX-060
- **Deliver:** cached read views, obligation capture, evidence capture, allocation drafts, payment preparation, and explicit connectivity state.
- **Acceptance:** the UI never represents prepared work as settled; no treasury key or live Approval Layer approval is stored offline.
- **Local evidence:** the Offline Workflows service now writes cached views, obligation and evidence captures, allocation drafts, and payment preparation records only through the encrypted, device-bound journal. Connectivity is explicit (`ONLINE`, `OFFLINE`, or `RECONNECTING`). A prepared payment is structurally limited to `PREPARED_OFFLINE`, `NOT_SUBMITTED`, and `requiresOnlineRevalidation: true`; it has no signing, Approval Layer, destination-authority, submission, transaction-hash, or settlement capability. The console exposes these boundaries and accurately reports that no local browser device is enrolled.

### AX-062 â€” Build secure synchronization and conflict resolution

- **Priority:** P2
- **Depends on:** AX-061
- **Deliver:** resumable sync, operation identifiers, server ordering, conflict UI, policy and beneficiary version checks, and duplicate suppression.
- **Acceptance:** reconnect cannot duplicate an obligation or payment; conflicts involving amount, destination, approval, or policy require explicit resolution.
- **Local evidence:** the Offline Synchronization service now requires successful device-trust preflight, pairs every record with its signed journal entry, orders accepted work deterministically on the server, and assigns a durable server sequence. Exact retries are returned as `DUPLICATE`; reused operation IDs with altered content create an `OPERATION_MUTATED` conflict. Amount, beneficiary destination, allocation, policy, reference, and mandatory-online-approval conflicts are named and persisted. A human can only discard or reprepare online; synchronization never approves, signs, submits, or settles a payment.

### AX-063 â€” Enforce reconnect revalidation

- **Priority:** P0
- **Depends on:** AX-011, AX-062
- **Deliver:** fresh authentication, balances, policies, beneficiary status, risk signals, ledger state, intent digest, and complete Approval Layer evaluation before any offline-prepared payment enters signing.
- **Acceptance:** stale or altered offline work is denied or reviewed; no offline approval can bypass an online gate.
- **Local evidence:** the Offline Revalidation Gate now requires fresh step-up authentication, current policy and beneficiary/destination references, current treasury and allocation balances, available risk and ledger state, an exact current payment-intent digest, and a newly evaluated Approval Layer result. A signed `ALLOW` decision must be verified against the newly bound intent before the gate returns `READY_FOR_SIGNING`; review and denial outcomes remain non-executable. Tests prove stale ledger data, changed destination references, and denied fresh evaluations cannot advance to signing.

## 10. Stage 8 â€” Organization expansion

### AX-070 â€” Extract configurable organization capabilities

- **Priority:** P2
- **Depends on:** M6 completion
- **Deliver:** organization-type configuration, chart-of-accounts mappings, approval matrices, policy-pack interface, reporting templates, and integration contracts.
- **Acceptance:** core payment, Approval Layer, signing, and receipt code contains no organization-specific branching that belongs in configuration.
- **Local evidence:** the Organization Capabilities service now supplies tenant-scoped, versioned capability profiles for commercial, nonprofit, and public-sector organizations. Profiles include a policy-pack reference, chart-of-accounts mappings, approval matrices, reporting templates, and explicit integration contracts. An organization administrator creates a draft and a different configuration reviewer must activate it; activating a profile retires the previous active profile. The service contains no payment, Approval Layer, signing, or receipt authority, and the allocation agent cannot administer profiles.

### AX-071 â€” Deliver commercial organization policy pack

- **Priority:** P2
- **Depends on:** AX-070
- **Deliver:** department budgets, procurement, payroll protection, vendor controls, purchase-order matching, and treasury reporting.
- **Acceptance:** representative commercial scenarios pass the shared security and settlement suite.
- **Local evidence:** the Commercial Policy Pack now evaluates department budget capacity using fixed-precision integer arithmetic, approved/suspended/blocked vendor status, payroll-vendor separation, required purchase orders, purchase-order/invoice/delivery matching, amount and tax tolerances, and digest-bound department treasury reports. It returns only deterministic `ALLOW`, `REVIEW`, or `DENY` reason codes and has no accounting-write, Approval Layer, signing, or ledger capability. Commercial scenarios prove funded matched procurement is allowed, payroll misuse and budget overruns are denied, and uncertain purchase-order evidence is reviewed.

### AX-072 â€” Deliver nonprofit organization policy pack

- **Priority:** P2
- **Depends on:** AX-070
- **Deliver:** program budgets, donor mandates, cost categories, reporting periods, evidence requirements, and allocation expiry.
- **Acceptance:** representative nonprofit scenarios pass the shared security and settlement suite.
- **Local evidence:** the Nonprofit Policy Pack now evaluates program budgets with fixed-precision arithmetic, donor-mandate activity and program binding, permitted cost categories, required evidence, allocation expiry, reporting periods, and digest-bound program reports. It returns deterministic `ALLOW`, `REVIEW`, or `DENY` reason codes only and cannot write balances, alter mandates, approve, sign, or settle. Tests prove funded mandate-compliant spend is allowed, budget and donor-category violations are denied, and missing donor evidence requires review.

### AX-073 â€” Deliver public-sector policy pack

- **Priority:** P2
- **Depends on:** AX-070
- **Deliver:** appropriation, warrant, commitment, procurement, expenditure-control, multi-level approval, audit export, and jurisdiction extension points.
- **Acceptance:** representative public-sector scenarios pass the shared security and settlement suite; jurisdiction-specific claims are disabled until formally configured and reviewed.
- **Local evidence:** the Public-Sector Policy Pack now evaluates appropriation, warrant, account-code, commitment/procurement, amount, expiry, expenditure capacity, multi-level approval, and a digest-bound audit-export record. Jurisdiction extensions are explicitly inert unless reviewed and enabled; attempts to invoke unreviewed extensions are denied. The pack returns deterministic `ALLOW`, `REVIEW`, or `DENY` only and has no appropriation-write, Approval Layer, signing, or settlement capability. Tests prove a warranted and procured multi-approved expenditure is allowed, over-appropriation and unreviewed jurisdiction claims are denied, and incomplete procurement or approval levels require review.

## 11. Stage 9 â€” Accessible voice operations

### AX-074 â€” Add confirmed voice payment instructions

- **Priority:** P1
- **Status:** Complete locally â€” 2026-11-10
- **Categories:** frontend, agent, backend, security
- **Depends on:** AX-007, AX-011, AX-040
- **Deliver:** an accessible microphone control, explicit recording consent, a browser-native transcription adapter, a server-owned confirmation boundary, transcript review, explicit user confirmation, ambiguity handling, and tamper-evident transcript evidence. A managed transcription provider can later be connected at the same server boundary without changing payment authority.
- **Acceptance:** the user can start, stop, cancel, and confirm a voice instruction with keyboard and screen-reader support; a voice instruction is never executed from raw audio alone; permission denial, unavailable microphone, no speech, and transcription failure have clear recovery states; an altered transcript, replayed confirmation, or ambiguous beneficiary cannot create a payment intent; a confirmed instruction takes the identical bounded-agent, canonical-intent, Approval Layer, signer, and settlement path as typed input; the allocation agent never accesses raw audio, signing material, policy publication, or arbitrary network tools; consent, transcript digest, recognition metadata, confirmation, and final control result are durable and tamper-evident. Raw audio is not collected by the current browser-native adapter.
- **Local evidence:** the command centre now exposes an accessible microphone control backed by the browser-native speech-recognition API. No raw audio is sent to or persisted by Alloc-X. The browser submits a transcript only after explicit microphone permission; Alloc-X writes it to a tenant- and principal-bound, hash-linked local voice-instruction journal in `PREPARED` state. The exact transcript must be explicitly confirmed before it reaches the bounded allocation agent. Changed transcripts are rejected, and preparing a transcript cannot create an intent, sign, submit, or settle a payment. The agent accepts optional â€œAlloc-Xâ€ / â€œsendâ€ phrasing but still requires amount, asset, beneficiary, and purpose; incomplete language produces clarification rather than guessed execution. Service and console tests cover confirmation, transcript substitution, invalid recognition metadata, and the no-payment-before-confirmation boundary.

## 12. Cross-cutting definition of done

Every issue that touches payments must demonstrate:

- tenant isolation and least-privilege authorization;
- deterministic validation of amount, asset, beneficiary, and policy version;
- idempotency, concurrency, retry, and replay behavior;
- structured audit events and privacy-safe telemetry;
- failure behavior when dependencies are unavailable;
- no private key or secret exposure;
- unit, integration, security, and applicable ledger tests; and
- updated operating documentation and rollback procedure.
