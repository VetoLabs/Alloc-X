# Approval Layer Treasury Security Architecture

## 1. Mission

Approval Layer is the security infrastructure between every proposed payment and the treasury account. Its job is to stop fraudulent, unauthorized, manipulated, duplicated, or policy-violating payments before signing occurs.

Approval Layer is not a prompt, a model instruction, or a UI warning. It is an independently authenticated service whose signed decision is required by the payment and signer services.

## 2. Trust boundaries

The following are untrusted until verified:

- all language-model output;
- invoice, email, chat, PDF, image, OCR, and uploaded document content;
- beneficiary addresses received in free text;
- client-side role or approval claims;
- webhook payloads and integration data;
- cached balances, policies, and risk signals;
- previously issued approvals after their digest or expiry changes; and
- transaction objects returned by a client or agent.

Only server-resolved, versioned records may enter the canonical intent. External documents provide evidence; they do not provide instructions.

## 3. Threats and mandatory controls

| Threat | Preventive control | Detection and response |
|---|---|---|
| Agent compromise or unsafe reasoning | No keys; typed tools; schema validation; bounded amount and destination references | Trace every tool call; deny malformed or unsupported intents |
| Prompt injection inside an invoice or email | Parse documents in an isolated pipeline; label content as data; never expose signing tools to document-processing agents | Flag instruction-like content and retain the evidence hash |
| Unauthorized requester | Strong authentication, server-side RBAC/ABAC, organization scoping, service identity verification | Alert on denied high-risk actions and session anomalies |
| Policy manipulation | Human-reviewed immutable versions; publish authority separated from payment initiation; signed bundles | Audit all changes; compare deployed bundle digest with registry |
| Beneficiary wallet substitution | Approved versioned registry; ownership verification; cooling period; dual control for changes | Notify prior and new contacts; block pending or unexpected versions |
| Invoice duplication | Normalized invoice fingerprint, document hash, vendor/reference matching, amount/date similarity | Deny exact duplicates; review likely duplicates and split-invoice patterns |
| Fabricated or altered evidence | File hash, malware scan, OCR provenance, PO/invoice/delivery matching, source-system verification | Quarantine inconsistent documents and require independent evidence |
| Amount or asset manipulation | Fixed-precision values; currency allowlist; server-side totals; transaction-to-intent equivalence | Deny changed fields and record a tamper event |
| Budget or reserve breach | Deterministic policy checks against authoritative committed and available balances | Deny and propose lower amount, later date, or another eligible allocation |
| Velocity or treasury drain | Per-payment, daily, rolling-window, beneficiary, category, and concentration limits | Freeze autonomous execution when aggregate thresholds are crossed |
| Replay or duplicate submission | Idempotency key, unique intent digest, expiring attestations, sequence/ticket ownership, exactly-once state machine | Reconcile every submission and alert on repeated hashes or intents |
| Front running or last-mile transaction replacement | Canonical serialization; signed approval digest; signers recompute exact digest | Refuse signature if any transaction field differs |
| Compromised application server | Independent Approval Layer and signer identities; network segmentation; quorum signing | Emergency freeze, key rotation, forensic audit trail |
| Insider collusion | Segregation of duties, approval thresholds, immutable evidence, signer quorum | Behavioral monitoring, periodic access review, independent reconciliation |
| Unknown ledger outflow | Signer-list controls and read-only independent monitor | Immediate alert, autonomous freeze, incident workflow |

## 4. Evaluation pipeline

Every intent passes the gates below in order. A gate can return `PASS`, `REVIEW`, or `FAIL`. A required gate timeout is a failure.

1. **Schema and canonicalization gate**
   - validates contract version, fixed-precision amount, identifiers, timestamps, and idempotency key;
   - rejects unknown fields where they affect execution; and
   - computes the canonical intent digest.

2. **Identity and authority gate**
   - verifies organization, principal, role, service identity, session strength, and segregation of duties;
   - confirms the agent is acting within a published mandate; and
   - validates required human approvals against the same digest.

3. **Policy gate**
   - evaluates the deterministic policy bundle;
   - checks purpose, allocation, evidence, amount, time window, asset, reserve, and approval requirements; and
   - uses authoritative committed and available balances.

4. **Beneficiary integrity gate**
   - resolves the destination from the approved registry;
   - verifies wallet ownership, status, version, age, and cooling period; and
   - rejects destinations supplied only through documents or conversation.

5. **Evidence integrity gate**
   - verifies evidence hashes, provenance, malware status, and required document types;
   - performs purchase-order, invoice, and delivery matching where applicable; and
   - detects exact, near, and split duplicates.

6. **Fraud and anomaly gate**
   - evaluates velocity, unusual amount, new beneficiary, timing, concentration, device, initiator, category, and historical patterns;
   - combines deterministic rules with a versioned statistical risk model; and
   - never permits a risk model to override a deterministic denial.

7. **Treasury safety gate**
   - calculates post-payment balances, reserve floors, pending commitments, and expected fees;
   - checks concurrent intents using reservations or serializable transactions; and
   - prevents race conditions from overspending the same allocation.

8. **Ledger semantics gate**
   - validates source account, destination, destination tag where required, amount, asset, issuer, fee ceiling, expiry, sequence or ticket, and network;
   - simulates or preflights the transaction using current ledger state; and
   - rejects partial-payment or path behavior unless explicitly supported by policy.

9. **Final equivalence gate**
   - recomputes the canonical transaction digest immediately before signing;
   - compares it with the allowed intent and approval attestation; and
   - issues a short-lived signer authorization bound to that exact digest.

## 5. Decision reason codes

Machine-readable codes make vetoes explainable and allow the agent to replan safely. Initial codes include:

- `AUTH_PRINCIPAL_NOT_ALLOWED`
- `AUTH_APPROVAL_MISSING`
- `AUTH_SEGREGATION_OF_DUTIES`
- `POLICY_PURPOSE_NOT_ALLOWED`
- `POLICY_AMOUNT_LIMIT`
- `POLICY_TIME_WINDOW`
- `POLICY_EVIDENCE_MISSING`
- `TREASURY_RESERVE_BREACH`
- `TREASURY_ALLOCATION_EXHAUSTED`
- `BENEFICIARY_NOT_APPROVED`
- `BENEFICIARY_CHANGE_COOLING_PERIOD`
- `EVIDENCE_DUPLICATE`
- `EVIDENCE_MISMATCH`
- `RISK_VELOCITY_EXCEEDED`
- `RISK_ANOMALOUS_PAYMENT`
- `INTENT_REPLAY_DETECTED`
- `TRANSACTION_DIGEST_MISMATCH`
- `LEDGER_PREFLIGHT_FAILED`
- `SECURITY_DEPENDENCY_UNAVAILABLE`

Each reason code maps to a safe set of next actions. The agent may reduce or split an amount, select another eligible allocation, request evidence, schedule later, choose an already approved beneficiary, or route for named approval. It may not reinterpret or suppress a veto.

## 6. Signing and key security

- Keys are generated and stored in managed KMS or HSM systems; plaintext keys never enter application databases, logs, build systems, or developer machines.
- Approval Layer and execution signers use separate identities, credentials, deployment projects, and authorization policies.
- A signer accepts only canonical transactions, a current policy digest, a live Approval Layer attestation, and a valid job lease.
- Main-network keys are isolated from development and test environments.
- Key rotation, signer-list changes, recovery, and emergency freeze require documented multi-person ceremonies.
- Signer use is logged independently and reconciled against validated ledger events.

## 7. Beneficiary change protocol

Adding or changing a payment destination requires:

1. authenticated request by an authorized operator;
2. ownership verification through an approved out-of-band method;
3. approval from a different authorized operator;
4. notifications to registered contacts through separate channels;
5. a configurable cooling period; and
6. a low-value verification payment or equivalent proof when policy requires it.

Existing scheduled payments are not silently redirected. They must be rebuilt against the new beneficiary version and pass every gate again.

## 8. Emergency controls

The emergency freeze is outside the agent and payment worker. Authorized security or treasury officers can:

- disable autonomous settlement for an organization;
- disable a beneficiary, asset, signer, integration, or policy version;
- lower limits immediately;
- stop queue consumption and signer authorization;
- rotate credentials or signer keys; and
- require human review for every pending intent.

Increasing limits, re-enabling settlement, or weakening a control requires stronger approval than applying a freeze. All emergency actions are audited and generate alerts.

## 9. Audit and privacy

Security events are written to an append-only, hash-chained audit log. Each event records actor, organization, action, target, result, reason, source IP or service identity, correlation identifier, policy version, and timestamp. Sensitive document contents and personal data are not copied into logs. Access is tenant-scoped and retention is configurable by policy and jurisdiction.

## 10. Security release gates

Autonomous settlement cannot be enabled until all of the following pass:

- threat model and abuse-case review;
- authorization and tenant-isolation tests;
- policy bypass and malformed-intent tests;
- prompt-injection corpus tests;
- duplicate, replay, race-condition, and idempotency tests;
- beneficiary substitution and approval-reuse tests;
- transaction-equivalence property tests;
- signer isolation and key-rotation drill;
- ledger failure and reconciliation recovery tests;
- emergency freeze exercise;
- backup restoration exercise; and
- an independent penetration test with critical findings resolved.
