import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashes } from "xrpl";

import { canonicalJson, parsePaymentIntent, paymentIntentDigest, sha256Digest, type CanonicalValue, type PaymentIntent } from "../../../packages/contracts/src/index.ts";
import { assertSettlementAuthorized, type DecisionSignatureVerifier, type SignedSecurityDecision } from "../../approval-layer/src/index.ts";
import { assembleQuorumSignature, createSigningEnvelope, type IndependentSignerService, type SignerListConfiguration } from "../../signers/src/index.ts";
import type { PreparedXrplPayment, ValidatedLedgerTransaction, XrplAdapter } from "../../xrpl-adapter/src/index.ts";

const GENESIS_HASH = `sha256:${"0".repeat(64)}`;

export type PaymentJobState = "QUEUED" | "LEASED" | "SUBMISSION_PLANNED" | "VALIDATED" | "RETRYABLE_FAILURE" | "FAILED";
export type PaymentJobEventType = "ENQUEUED" | "LEASE_ACQUIRED" | "SUBMISSION_PLANNED" | "VALIDATED" | "REQUEUED" | "FAILED";
export type OrchestratorErrorCode = "DECISION_REJECTED" | "LEASE_UNAVAILABLE" | "LEASE_LOST" | "ATTEMPTS_EXHAUSTED" | "JOB_CONFLICT" | "JOURNAL_TAMPERED" | "SETTLEMENT_UNCERTAIN" | "UNSUPPORTED_ASSET";

export class PaymentOrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;
  constructor(code: OrchestratorErrorCode, message: string) { super(message); this.name = "PaymentOrchestratorError"; this.code = code; }
}

export interface TreasuryPaymentInstruction {
  readonly account: string;
  readonly destination: string;
  readonly destinationTag?: number;
  readonly mode: "sequence" | "ticket";
  readonly ticketSequence?: number;
}

export interface PaymentJobRequest {
  readonly jobId: string;
  readonly organizationId: string;
  readonly intent: PaymentIntent;
  readonly signedDecision: SignedSecurityDecision;
  readonly instruction: TreasuryPaymentInstruction;
  readonly enqueuedAt: string;
}

export interface PaymentJob {
  readonly contractVersion: "1.0";
  readonly jobId: string;
  readonly organizationId: string;
  readonly intent: PaymentIntent;
  readonly intentDigest: string;
  readonly signedDecision: SignedSecurityDecision;
  readonly instruction: TreasuryPaymentInstruction;
  readonly state: PaymentJobState;
  readonly attemptCount: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly signedTransactionBlob?: string;
  readonly transactionHash?: string;
  readonly validatedTransaction?: ValidatedLedgerTransaction;
  readonly lastFailure?: string;
  readonly updatedAt: string;
}

export interface PaymentJobEvent {
  readonly contractVersion: "1.0";
  readonly eventType: PaymentJobEventType;
  readonly occurredAt: string;
  readonly job: PaymentJob;
  readonly previousRecordHash: string;
  readonly recordHash: string;
}

export interface PaymentJobIntegrity { readonly valid: boolean; readonly checkedRecords: number; readonly failures: readonly ("MALFORMED_RECORD" | "PREVIOUS_HASH_MISMATCH" | "RECORD_HASH_MISMATCH")[]; }

export interface PaymentJobStore {
  enqueue(request: PaymentJobRequest): Promise<PaymentJob>;
  get(jobId: string): Promise<PaymentJob | undefined>;
  acquireLease(input: { readonly jobId: string; readonly workerId: string; readonly now: string; readonly leaseExpiresAt: string; readonly maxAttempts: number }): Promise<PaymentJob>;
  recordSubmissionPlan(input: { readonly jobId: string; readonly workerId: string; readonly now: string; readonly signedTransactionBlob: string; readonly transactionHash: string }): Promise<PaymentJob>;
  recordValidated(input: { readonly jobId: string; readonly workerId: string; readonly now: string; readonly validatedTransaction: ValidatedLedgerTransaction }): Promise<PaymentJob>;
  requeue(input: { readonly jobId: string; readonly workerId: string; readonly now: string; readonly reason: string }): Promise<PaymentJob>;
  fail(input: { readonly jobId: string; readonly workerId: string; readonly now: string; readonly reason: string }): Promise<PaymentJob>;
  verifyIntegrity(): Promise<PaymentJobIntegrity>;
}

/**
 * Local durable queue: every state transition is appended and fsynced before
 * acknowledgement. A deployed environment should replace this with a
 * transactional queue/workflow store without changing the orchestrator API.
 */
export class FilePaymentJobStore implements PaymentJobStore {
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();
  constructor(path: string) { if (typeof path !== "string" || path.length === 0) throw new TypeError("Payment job journal path is required."); this.#path = path; }

  async enqueue(request: PaymentJobRequest): Promise<PaymentJob> {
    return this.serial(async () => {
      const candidate = newJob(request); const latest = await this.latest(); const existing = latest.get(candidate.jobId);
      if (existing) {
        if (existing.intentDigest !== candidate.intentDigest || stable(existing.instruction) !== stable(candidate.instruction) || existing.signedDecision.decisionDigest !== candidate.signedDecision.decisionDigest) throw new PaymentOrchestratorError("JOB_CONFLICT", "jobId is already bound to a different settlement request.");
        return existing;
      }
      await this.append("ENQUEUED", candidate, candidate.updatedAt); return candidate;
    });
  }
  async get(jobId: string): Promise<PaymentJob | undefined> { requireId(jobId, "jobId", "job_"); return (await this.latest()).get(jobId); }
  async acquireLease(input: { readonly jobId: string; readonly workerId: string; readonly now: string; readonly leaseExpiresAt: string; readonly maxAttempts: number }): Promise<PaymentJob> {
    return this.transition(input.jobId, input.workerId, input.now, "LEASE_ACQUIRED", (job) => {
      requireTime(input.leaseExpiresAt, "leaseExpiresAt"); if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) throw new TypeError("Lease expiry must be in the future.");
      if (job.state === "VALIDATED" || job.state === "FAILED") return job;
      if (job.leaseOwner && job.leaseOwner !== input.workerId && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > Date.parse(input.now)) throw new PaymentOrchestratorError("LEASE_UNAVAILABLE", "Payment job is leased by another worker.");
      if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) throw new TypeError("maxAttempts is invalid.");
      if (job.attemptCount >= input.maxAttempts) throw new PaymentOrchestratorError("ATTEMPTS_EXHAUSTED", "Payment job retry budget is exhausted.");
      const { lastFailure: ignored, ...base } = job; return freeze({ ...base, state: job.signedTransactionBlob ? "SUBMISSION_PLANNED" : "LEASED", attemptCount: job.attemptCount + 1, leaseOwner: input.workerId, leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now });
    });
  }
  async recordSubmissionPlan(input: { readonly jobId: string; readonly workerId: string; readonly now: string; readonly signedTransactionBlob: string; readonly transactionHash: string }): Promise<PaymentJob> {
    return this.transition(input.jobId, input.workerId, input.now, "SUBMISSION_PLANNED", (job) => {
      assertLease(job, input.workerId, input.now); requireBlob(input.signedTransactionBlob); requireHash(input.transactionHash);
      if (job.signedTransactionBlob && (job.signedTransactionBlob !== input.signedTransactionBlob || job.transactionHash !== input.transactionHash)) throw new PaymentOrchestratorError("JOB_CONFLICT", "Payment job already has a different signed transaction.");
      return freeze({ ...job, state: "SUBMISSION_PLANNED", signedTransactionBlob: input.signedTransactionBlob, transactionHash: input.transactionHash, updatedAt: input.now });
    });
  }
  async recordValidated(input: { readonly jobId: string; readonly workerId: string; readonly now: string; readonly validatedTransaction: ValidatedLedgerTransaction }): Promise<PaymentJob> {
    return this.transition(input.jobId, input.workerId, input.now, "VALIDATED", (job) => {
      assertLease(job, input.workerId, input.now); if (!job.transactionHash || job.transactionHash !== input.validatedTransaction.transactionHash || input.validatedTransaction.resultCode !== "tesSUCCESS") throw new PaymentOrchestratorError("JOB_CONFLICT", "Validated transaction does not match the durable submission plan.");
      const { leaseOwner: ignoredOwner, leaseExpiresAt: ignoredExpiry, ...base } = job; return freeze({ ...base, state: "VALIDATED", validatedTransaction: input.validatedTransaction, updatedAt: input.now });
    });
  }
  async requeue(input: { readonly jobId: string; readonly workerId: string; readonly now: string; readonly reason: string }): Promise<PaymentJob> { return this.transition(input.jobId, input.workerId, input.now, "REQUEUED", (job) => { assertLease(job, input.workerId, input.now); const { leaseOwner: ignoredOwner, leaseExpiresAt: ignoredExpiry, ...base } = job; return freeze({ ...base, state: "RETRYABLE_FAILURE", lastFailure: boundedReason(input.reason), updatedAt: input.now }); }); }
  async fail(input: { readonly jobId: string; readonly workerId: string; readonly now: string; readonly reason: string }): Promise<PaymentJob> { return this.transition(input.jobId, input.workerId, input.now, "FAILED", (job) => { assertLease(job, input.workerId, input.now); const { leaseOwner: ignoredOwner, leaseExpiresAt: ignoredExpiry, ...base } = job; return freeze({ ...base, state: "FAILED", lastFailure: boundedReason(input.reason), updatedAt: input.now }); }); }
  async verifyIntegrity(): Promise<PaymentJobIntegrity> {
    const lines = await this.lines(); const failures = new Set<PaymentJobIntegrity["failures"][number]>(); let prior = GENESIS_HASH;
    for (const line of lines) { try { const event = JSON.parse(line) as PaymentJobEvent; if (!isEvent(event)) { failures.add("MALFORMED_RECORD"); continue; } if (event.previousRecordHash !== prior) failures.add("PREVIOUS_HASH_MISMATCH"); const { recordHash: ignored, ...base } = event; if (sha256Digest(base as unknown as CanonicalValue) !== event.recordHash) failures.add("RECORD_HASH_MISMATCH"); prior = event.recordHash; } catch { failures.add("MALFORMED_RECORD"); } }
    return freeze({ valid: failures.size === 0, checkedRecords: lines.length, failures: freeze([...failures].sort()) });
  }
  private async transition(jobId: string, workerId: string, now: string, eventType: PaymentJobEventType, transition: (job: PaymentJob) => PaymentJob): Promise<PaymentJob> {
    return this.serial(async () => { requireId(jobId, "jobId", "job_"); requireId(workerId, "workerId", "worker_"); requireTime(now, "now"); const job = (await this.latest()).get(jobId); if (!job) throw new PaymentOrchestratorError("JOB_CONFLICT", "Payment job was not found."); const next = transition(job); if (next === job) return job; await this.append(eventType, next, now); return next; });
  }
  private async append(eventType: PaymentJobEventType, job: PaymentJob, occurredAt: string): Promise<void> {
    const lines = await this.lines(); const prior = lines.length === 0 ? GENESIS_HASH : (JSON.parse(lines.at(-1)!) as PaymentJobEvent).recordHash; const base = { contractVersion: "1.0" as const, eventType, occurredAt, job, previousRecordHash: prior }; const event = freeze({ ...base, recordHash: sha256Digest(base as unknown as CanonicalValue) });
    await mkdir(dirname(this.#path), { recursive: true }); const file = await open(this.#path, "a"); try { await file.writeFile(`${canonicalJson(event as unknown as CanonicalValue)}\n`); await file.sync(); } finally { await file.close(); }
  }
  private async latest(): Promise<Map<string, PaymentJob>> { const integrity = await this.verifyIntegrity(); if (!integrity.valid) throw new PaymentOrchestratorError("JOURNAL_TAMPERED", "Payment job journal integrity verification failed."); const jobs = new Map<string, PaymentJob>(); for (const line of await this.lines()) { const event = JSON.parse(line) as PaymentJobEvent; jobs.set(event.job.jobId, freeze(event.job)); } return jobs; }
  private async lines(): Promise<readonly string[]> { try { return (await readFile(this.#path, "utf8")).split("\n").filter(Boolean); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  private async serial<T>(work: () => Promise<T>): Promise<T> { const prior = this.#tail; let release: () => void = () => undefined; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior; try { return await work(); } finally { release(); } }
}

export interface SettlementLedger {
  prepareNativePayment(input: { readonly intentId: string; readonly intentDigest: string; readonly organizationId: string; readonly account: string; readonly destination: string; readonly destinationTag?: number; readonly amountXrp: string; readonly mode: "sequence" | "ticket"; readonly ticketSequence?: number }): Promise<PreparedXrplPayment>;
  submitSignedPayment(input: { readonly prepared: PreparedXrplPayment; readonly signedTransactionBlob: string }): Promise<ValidatedLedgerTransaction>;
  lookupValidatedPayment(transactionHash: string): Promise<ValidatedLedgerTransaction | undefined>;
}

/**
 * Owns the deterministic settlement path. A network retry can repeat a
 * submission attempt, but only for the same signed blob and transaction hash;
 * the journal prevents a second transaction from being constructed or signed.
 */
export class PaymentOrchestrator {
  readonly #store: PaymentJobStore; readonly #ledger: SettlementLedger; readonly #verifier: DecisionSignatureVerifier; readonly #execution: IndependentSignerService; readonly #policy: IndependentSignerService; readonly #signerList: SignerListConfiguration; readonly #maxAttempts: number; readonly #leaseMilliseconds: number;
  constructor(input: { readonly store: PaymentJobStore; readonly ledger: SettlementLedger | XrplAdapter; readonly decisionVerifier: DecisionSignatureVerifier; readonly executionSigner: IndependentSignerService; readonly policySigner: IndependentSignerService; readonly signerList: SignerListConfiguration; readonly maxAttempts?: number; readonly leaseMilliseconds?: number }) {
    this.#store = input.store; this.#ledger = input.ledger; this.#verifier = input.decisionVerifier; this.#execution = input.executionSigner; this.#policy = input.policySigner; this.#signerList = input.signerList; this.#maxAttempts = input.maxAttempts ?? 3; this.#leaseMilliseconds = input.leaseMilliseconds ?? 30_000;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || !Number.isSafeInteger(this.#leaseMilliseconds) || this.#leaseMilliseconds < 1_000) throw new TypeError("Orchestrator retry or lease configuration is invalid.");
  }
  async enqueue(request: PaymentJobRequest): Promise<PaymentJob> {
    const intent = parsePaymentIntent(request.intent); if (intent.organizationId !== request.organizationId) throw new PaymentOrchestratorError("DECISION_REJECTED", "Payment job organization does not match its intent."); if (intent.asset !== "XRP") throw new PaymentOrchestratorError("UNSUPPORTED_ASSET", "The current settlement path supports native XRP only.");
    assertSettlementAuthorized({ signedDecision: request.signedDecision, organizationId: request.organizationId, intent, now: request.enqueuedAt, verifier: this.#verifier }); return this.#store.enqueue(freeze({ ...request, intent }));
  }
  async run(jobId: string, workerId: string, now: string): Promise<PaymentJob> {
    const leaseExpiresAt = new Date(Date.parse(now) + this.#leaseMilliseconds).toISOString(); let job = await this.#store.acquireLease({ jobId, workerId, now, leaseExpiresAt, maxAttempts: this.#maxAttempts });
    if (job.state === "VALIDATED" || job.state === "FAILED") return job;
    try {
      assertSettlementAuthorized({ signedDecision: job.signedDecision, organizationId: job.organizationId, intent: job.intent, now, verifier: this.#verifier });
      if (job.state === "SUBMISSION_PLANNED") {
        const confirmed = await this.#ledger.lookupValidatedPayment(job.transactionHash!);
        if (confirmed) return this.#store.recordValidated({ jobId, workerId, now, validatedTransaction: confirmed });
        if (!job.signedTransactionBlob) throw new PaymentOrchestratorError("SETTLEMENT_UNCERTAIN", "Submission plan is missing its signed transaction.");
        const prepared = await this.prepare(job); const validated = await this.#ledger.submitSignedPayment({ prepared, signedTransactionBlob: job.signedTransactionBlob });
        return this.#store.recordValidated({ jobId, workerId, now, validatedTransaction: validated });
      }
      const prepared = await this.prepare(job); const envelope = createSigningEnvelope({ prepared, securityDecisionDigest: job.signedDecision.decisionDigest, expiresAt: job.signedDecision.decision.expiresAt });
      const execution = await this.#execution.sign(envelope, envelope.protectedTransaction, now); const policy = await this.#policy.sign(envelope, envelope.protectedTransaction, now); const signedTransactionBlob = assembleQuorumSignature({ envelope, configuration: this.#signerList, signatures: [execution, policy] }); const transactionHash = hashes.hashSignedTx(signedTransactionBlob);
      job = await this.#store.recordSubmissionPlan({ jobId, workerId, now, signedTransactionBlob, transactionHash });
      const known = await this.#ledger.lookupValidatedPayment(transactionHash); if (known) return this.#store.recordValidated({ jobId, workerId, now, validatedTransaction: known });
      const validated = await this.#ledger.submitSignedPayment({ prepared, signedTransactionBlob }); return this.#store.recordValidated({ jobId, workerId, now, validatedTransaction: validated });
    } catch (error) {
      if (error instanceof PaymentOrchestratorError && ["DECISION_REJECTED", "UNSUPPORTED_ASSET", "JOB_CONFLICT"].includes(error.code)) return this.#store.fail({ jobId, workerId, now, reason: error.message });
      return this.#store.requeue({ jobId, workerId, now, reason: error instanceof Error ? error.message : "Unknown settlement dependency failure." });
    }
  }
  private async prepare(job: PaymentJob): Promise<PreparedXrplPayment> { return this.#ledger.prepareNativePayment({ intentId: job.intent.intentId, intentDigest: job.intentDigest, organizationId: job.organizationId, account: job.instruction.account, destination: job.instruction.destination, ...(job.instruction.destinationTag === undefined ? {} : { destinationTag: job.instruction.destinationTag }), amountXrp: job.intent.amount, mode: job.instruction.mode, ...(job.instruction.ticketSequence === undefined ? {} : { ticketSequence: job.instruction.ticketSequence }) }); }
}

function newJob(request: PaymentJobRequest): PaymentJob { requireId(request.jobId, "jobId", "job_"); requireId(request.organizationId, "organizationId", "org_"); requireTime(request.enqueuedAt, "enqueuedAt"); const intent = parsePaymentIntent(request.intent); const intentDigest = paymentIntentDigest(intent); if (intent.organizationId !== request.organizationId) throw new PaymentOrchestratorError("JOB_CONFLICT", "Payment job intent organization is invalid."); validateInstruction(request.instruction); return freeze({ contractVersion: "1.0", jobId: request.jobId, organizationId: request.organizationId, intent, intentDigest, signedDecision: request.signedDecision, instruction: freeze({ ...request.instruction }), state: "QUEUED", attemptCount: 0, updatedAt: request.enqueuedAt }); }
function assertLease(job: PaymentJob, workerId: string, now: string): void { if (job.leaseOwner !== workerId || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) < Date.parse(now)) throw new PaymentOrchestratorError("LEASE_LOST", "Worker does not hold an active lease for this payment job."); }
function validateInstruction(value: TreasuryPaymentInstruction): void { requireAddress(value.account, "treasury account"); requireAddress(value.destination, "destination"); if (value.account === value.destination) throw new TypeError("Treasury account and destination cannot match."); if (value.mode !== "sequence" && value.mode !== "ticket") throw new TypeError("Submission mode is invalid."); if (value.mode === "ticket" && (!Number.isSafeInteger(value.ticketSequence) || value.ticketSequence! < 1)) throw new TypeError("Ticket sequence is required."); if (value.mode === "sequence" && value.ticketSequence !== undefined) throw new TypeError("Ticket sequence is not valid for sequence submission."); }
function isEvent(value: unknown): value is PaymentJobEvent { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const event = value as Partial<PaymentJobEvent>; return event.contractVersion === "1.0" && typeof event.eventType === "string" && typeof event.occurredAt === "string" && typeof event.previousRecordHash === "string" && typeof event.recordHash === "string" && !!event.job && typeof event.job.jobId === "string"; }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requireAddress(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requireTime(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid.`); }
function requireBlob(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-F0-9]+$/.test(value)) throw new TypeError("Signed transaction blob is invalid."); }
function requireHash(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-F0-9]{64}$/.test(value)) throw new TypeError("Transaction hash is invalid."); }
function boundedReason(value: string): string { if (typeof value !== "string" || value.length === 0) return "Settlement attempt failed."; return value.slice(0, 500); }
function stable(value: unknown): string { return canonicalJson(value as CanonicalValue); }
function freeze<T>(value: T): T { return Object.freeze(value); }
