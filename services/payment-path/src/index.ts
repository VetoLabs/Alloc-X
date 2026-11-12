import { xrpToDrops } from "xrpl";

import { type PaymentIntentRecord } from "../../../packages/payment-intents/src/index.ts";
import { type EvaluationReceipt } from "../../approval-layer/src/index.ts";
import { type PaymentJob, type PaymentJobRequest } from "../../payment-orchestrator/src/index.ts";
import { type LedgerMonitor, type Reconciliation, type TreasuryAlert } from "../../ledger-monitor/src/index.ts";

export type AutonomousPaymentState = "BLOCKED" | "REVIEW_REQUIRED" | "VALIDATED" | "RECONCILED" | "RETRYABLE_FAILURE" | "FAILED";

export interface PaymentSecurityGateway {
  evaluate(input: unknown): Promise<EvaluationReceipt>;
}
export interface PaymentExecutionWorker {
  enqueue(request: PaymentJobRequest): Promise<PaymentJob>;
  run(jobId: string, workerId: string, now: string): Promise<PaymentJob>;
}

export interface BeneficiaryDestinationAuthority {
  resolve(input: { readonly organizationId: string; readonly beneficiaryId: string }): { readonly address: string; readonly walletVersion: number; readonly destinationTag?: number };
}

export interface AutonomousPaymentResult {
  readonly state: AutonomousPaymentState;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly reservationId: string;
  readonly decision: EvaluationReceipt["signedDecision"];
  readonly receipt: EvaluationReceipt;
  readonly job?: PaymentJob;
  readonly reconciliation?: Reconciliation;
  readonly alerts: readonly TreasuryAlert[];
}

/**
 * The sole composition boundary for an allowed payment. It accepts no client
 * amount or destination: both originate from its canonical intent and an
 * authoritative beneficiary resolver.
 */
export class AutonomousPaymentPath {
  readonly #security: PaymentSecurityGateway;
  readonly #orchestrator: PaymentExecutionWorker;
  readonly #monitor: LedgerMonitor;
  readonly #beneficiaries: BeneficiaryDestinationAuthority;

  constructor(input: { readonly security: PaymentSecurityGateway; readonly orchestrator: PaymentExecutionWorker; readonly monitor: LedgerMonitor; readonly beneficiaries: BeneficiaryDestinationAuthority }) {
    this.#security = input.security; this.#orchestrator = input.orchestrator; this.#monitor = input.monitor; this.#beneficiaries = input.beneficiaries;
  }

  async execute(input: { readonly record: PaymentIntentRecord; readonly securityRequest: unknown; readonly treasuryAccount: string; readonly workerId: string; readonly now: string }): Promise<AutonomousPaymentResult> {
    const record = input.record;
    if (record.state !== "RESERVED") throw new AutonomousPaymentPathError("Payment intent is not reserved for settlement.");
    const receipt = await this.#security.evaluate(input.securityRequest);
    if (receipt.signedDecision.decision.intentId !== record.intent.intentId || receipt.signedDecision.decision.intentDigest !== record.intentDigest) throw new AutonomousPaymentPathError("Security decision is not bound to the authoritative payment intent.");
    if (receipt.signedDecision.decision.outcome !== "ALLOW") return frozen({ state: receipt.signedDecision.decision.outcome === "REVIEW" ? "REVIEW_REQUIRED" : "BLOCKED", intentId: record.intent.intentId, intentDigest: record.intentDigest, reservationId: record.reservation.reservationId, decision: receipt.signedDecision, receipt, alerts: frozen([]) });
    const destination = this.#beneficiaries.resolve({ organizationId: record.intent.organizationId, beneficiaryId: record.intent.beneficiaryId });
    if (destination.walletVersion !== record.intent.beneficiaryWalletVersion) throw new AutonomousPaymentPathError("Beneficiary wallet version changed after intent creation.");
    const jobId = `job_${record.intent.intentId.slice(3)}`;
    await this.#orchestrator.enqueue({ jobId, organizationId: record.intent.organizationId, intent: record.intent, signedDecision: receipt.signedDecision, instruction: { account: input.treasuryAccount, destination: destination.address, ...(destination.destinationTag === undefined ? {} : { destinationTag: destination.destinationTag }), mode: "sequence" }, enqueuedAt: input.now });
    const job = await this.#orchestrator.run(jobId, input.workerId, input.now);
    if (job.state !== "VALIDATED" || !job.validatedTransaction) return frozen({ state: job.state === "FAILED" ? "FAILED" : "RETRYABLE_FAILURE", intentId: record.intent.intentId, intentDigest: record.intentDigest, reservationId: record.reservation.reservationId, decision: receipt.signedDecision, receipt, job, alerts: frozen([]) });
    await this.#monitor.registerExpectedSettlement({ jobId, organizationId: record.intent.organizationId, reservationId: record.reservation.reservationId, transactionHash: job.validatedTransaction.transactionHash, account: input.treasuryAccount, destination: destination.address, amountDrops: xrpToDrops(record.intent.amount) });
    const monitoring = await this.#monitor.poll({ account: input.treasuryAccount, now: input.now });
    const reconciliation = monitoring.reconciled.find((item) => item.transactionHash === job.validatedTransaction!.transactionHash);
    return frozen({ state: reconciliation ? "RECONCILED" : "VALIDATED", intentId: record.intent.intentId, intentDigest: record.intentDigest, reservationId: record.reservation.reservationId, decision: receipt.signedDecision, receipt, job, ...(reconciliation ? { reconciliation } : {}), alerts: monitoring.alerts });
  }
}

export class AutonomousPaymentPathError extends Error { constructor(message: string) { super(message); this.name = "AutonomousPaymentPathError"; } }
function frozen<T>(value: T): T { return Object.freeze(value); }
