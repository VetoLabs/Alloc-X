import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, sha256Digest, type CanonicalValue } from "../../../packages/contracts/src/index.ts";

export type ActivationPhase = "BLOCKED" | "PILOT" | "ACTIVE" | "FROZEN" | "ROLLED_BACK";
export type ActivationDuty = "platform-operator" | "security-approver" | "finance-approver" | "independent-monitor" | "settlement-service" | "allocation-agent";
export type ActivationApprovalKind = "CONFIGURATION" | "ROLLOUT";
export type ActivationEventType = "CONFIGURED" | "CONFIGURATION_APPROVED" | "PILOT_STARTED" | "PAYMENT_AUTHORIZED" | "PAYMENT_VALIDATED" | "PAYMENT_RECONCILED" | "ROLLOUT_APPROVED" | "ACTIVATED" | "FROZEN" | "ROLLED_BACK";

export interface ActivationActor { readonly principalId: string; readonly duty: ActivationDuty; }
export interface ExternalReadiness {
  readonly assessment: { readonly allowed: boolean; readonly blockers: readonly string[]; readonly digest?: string };
  readonly monitoring: { readonly healthy: boolean; readonly digest: string };
  readonly recovery: { readonly passed: boolean; readonly digest: string };
  readonly signerList: { readonly configured: boolean; readonly treasuryAccount: string; readonly quorum: number; readonly memberCount: number; readonly digest: string };
}
export interface ActivationDependencies { current(): ExternalReadiness; }

export interface ProductionSettlementConfiguration {
  readonly configurationId: string;
  readonly organizationId: string;
  readonly network: "mainnet";
  readonly networkId: 0;
  readonly treasuryAccount: string;
  readonly signerListDigest: string;
  readonly signerQuorum: number;
  readonly signerMemberCount: number;
  readonly allowlistedAssets: readonly ["XRP"];
  readonly perPaymentLimitXrp: string;
  readonly dailyAmountLimitXrp: string;
  readonly dailyPaymentCountLimit: number;
  readonly pilotPaymentLimitXrp: string;
  readonly pilotPaymentCountLimit: 1;
  readonly maxFeeDrops: string;
  readonly lastLedgerOffset: 4;
  readonly submissionEndpoint: string;
  readonly monitoringEndpoint: string;
  readonly rollbackPlanDigest: string;
  readonly configuredByPrincipalId: string;
  readonly configuredAt: string;
  readonly configurationDigest: string;
}

export interface ActivationApproval {
  readonly approvalId: string;
  readonly kind: ActivationApprovalKind;
  readonly configurationDigest: string;
  readonly principalId: string;
  readonly duty: "security-approver" | "finance-approver";
  readonly evidenceDigest: string;
  readonly approvedAt: string;
}

export interface SettlementAuthorization {
  readonly authorizationId: string;
  readonly organizationId: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly securityDecisionDigest: string;
  readonly transactionDigest: string;
  readonly asset: "XRP";
  readonly amountXrp: string;
  readonly phase: "PILOT" | "ACTIVE";
  readonly requestedByPrincipalId: string;
  readonly requestedAt: string;
  readonly status: "AUTHORIZED" | "VALIDATED" | "RECONCILED";
  readonly authorizationDigest: string;
  readonly transactionHash?: string;
  readonly ledgerIndex?: number;
  readonly validatedAt?: string;
  readonly monitorPrincipalId?: string;
  readonly monitoringEvidenceDigest?: string;
  readonly reconciliationDigest?: string;
  readonly reconciledAt?: string;
  readonly financePrincipalId?: string;
}

export interface ActivationEvent {
  readonly eventId: string;
  readonly type: ActivationEventType;
  readonly occurredAt: string;
  readonly principalId: string;
  readonly duty: ActivationDuty;
  readonly subjectDigest: string;
  readonly previousEventDigest: string;
  readonly eventDigest: string;
}

export interface MainnetActivationState {
  readonly contractVersion: "1.0";
  readonly phase: ActivationPhase;
  readonly configuration?: ProductionSettlementConfiguration;
  readonly approvals: readonly ActivationApproval[];
  readonly authorizations: readonly SettlementAuthorization[];
  readonly events: readonly ActivationEvent[];
  readonly frozenFromPhase?: "PILOT" | "ACTIVE";
}

export interface ActivationReadiness {
  readonly allowed: boolean;
  readonly phase: ActivationPhase;
  readonly blockers: readonly string[];
  readonly configurationDigest?: string;
}

export interface MainnetActivationStore { load(): Promise<MainnetActivationState | undefined>; save(state: MainnetActivationState): Promise<void>; }

export class FileMainnetActivationStore implements MainnetActivationStore {
  readonly #path: string;
  constructor(path: string) { if (!path) throw new TypeError("Activation state path is required."); this.#path = path; }
  async load(): Promise<MainnetActivationState | undefined> { try { return JSON.parse(await readFile(this.#path, "utf8")) as MainnetActivationState; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  async save(state: MainnetActivationState): Promise<void> { await mkdir(dirname(this.#path), { recursive: true }); const next = `${this.#path}.next`; await writeFile(next, canonicalJson(state as unknown as CanonicalValue), { mode: 0o600 }); await rename(next, this.#path); }
}

export class MainnetActivationService {
  readonly #store: MainnetActivationStore;
  readonly #dependencies: ActivationDependencies;
  #state: MainnetActivationState = freezeState({ contractVersion: "1.0", phase: "BLOCKED", approvals: [], authorizations: [], events: [] });
  #opened = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(store: MainnetActivationStore, dependencies: ActivationDependencies) { this.#store = store; this.#dependencies = dependencies; }

  async open(): Promise<void> { if (this.#opened) return; const stored = await this.#store.load(); if (stored) { validateState(stored); this.#state = freezeState(stored); } this.#opened = true; }
  snapshot(): MainnetActivationState { return this.#state; }

  readiness(): ActivationReadiness {
    const blockers: string[] = [];
    const configuration = this.#state.configuration;
    if (!configuration) blockers.push("PRODUCTION_CONFIGURATION_MISSING");
    if (configuration) {
      for (const duty of ["security-approver", "finance-approver"] as const) if (!this.#state.approvals.some((item) => item.kind === "CONFIGURATION" && item.duty === duty && item.configurationDigest === configuration.configurationDigest)) blockers.push(`CONFIGURATION_APPROVAL_MISSING:${duty}`);
    }
    const external = this.#dependencies.current();
    if (!external.assessment.allowed) blockers.push(...(external.assessment.blockers.length ? external.assessment.blockers : ["INDEPENDENT_ASSESSMENT_INCOMPLETE"]));
    if (external.assessment.allowed && !external.assessment.digest) blockers.push("ASSESSMENT_DIGEST_MISSING");
    if (!external.monitoring.healthy) blockers.push("OPERATIONAL_MONITORING_UNHEALTHY");
    if (!external.recovery.passed) blockers.push("RECOVERY_EXERCISE_INCOMPLETE");
    if (!external.signerList.configured) blockers.push("MAINNET_SIGNER_LIST_UNCONFIRMED");
    if (configuration && (external.signerList.treasuryAccount !== configuration.treasuryAccount || external.signerList.quorum !== configuration.signerQuorum || external.signerList.memberCount !== configuration.signerMemberCount || external.signerList.digest !== configuration.signerListDigest)) blockers.push("MAINNET_SIGNER_LIST_MISMATCH");
    for (const item of [external.monitoring.digest, external.recovery.digest, external.signerList.digest]) if (!validDigest(item)) blockers.push("READINESS_EVIDENCE_INVALID");
    return frozen({ allowed: blockers.length === 0, phase: this.#state.phase, blockers: frozen([...new Set(blockers)]), ...(configuration ? { configurationDigest: configuration.configurationDigest } : {}) });
  }

  async configure(input: Omit<ProductionSettlementConfiguration, "configuredByPrincipalId" | "configurationDigest"> & { readonly actor: ActivationActor }): Promise<ProductionSettlementConfiguration> {
    return this.serial(async () => {
      await this.open(); requireDuty(input.actor, "platform-operator"); if (this.#state.configuration || this.#state.phase !== "BLOCKED") throw new MainnetActivationError("CONFLICT", "Mainnet activation is already configured.");
      const base = validateConfiguration({ ...input, configuredByPrincipalId: input.actor.principalId });
      const configuration = frozen({ ...base, configurationDigest: sha256Digest(base as unknown as CanonicalValue) });
      await this.persist(this.withEvent({ ...this.#state, configuration }, "CONFIGURED", input.actor, configuration.configurationDigest, configuration.configuredAt));
      return configuration;
    });
  }

  async approveConfiguration(input: { readonly approvalId: string; readonly actor: ActivationActor; readonly evidenceDigest: string; readonly approvedAt: string }): Promise<ActivationApproval> {
    return this.serial(async () => {
      await this.open(); const actor = requireApprovalActor(input.actor); const configuration = requiredConfiguration(this.#state); digest(input.evidenceDigest); time(input.approvedAt); id(input.approvalId, "approval_");
      if (actor.principalId === configuration.configuredByPrincipalId) throw new MainnetActivationError("SEPARATION_OF_DUTIES", "The configuration operator cannot approve the configuration.");
      const existing = this.#state.approvals.find((item) => item.kind === "CONFIGURATION" && item.duty === actor.duty);
      if (existing) { if (existing.principalId === actor.principalId && existing.evidenceDigest === input.evidenceDigest) return existing; throw new MainnetActivationError("CONFLICT", `${actor.duty} configuration approval already exists.`); }
      const other = this.#state.approvals.find((item) => item.kind === "CONFIGURATION"); if (other?.principalId === actor.principalId) throw new MainnetActivationError("SEPARATION_OF_DUTIES", "Security and finance approvals require different principals.");
      const approval = frozen({ approvalId: input.approvalId, kind: "CONFIGURATION" as const, configurationDigest: configuration.configurationDigest, principalId: actor.principalId, duty: actor.duty, evidenceDigest: input.evidenceDigest, approvedAt: input.approvedAt });
      await this.persist(this.withEvent({ ...this.#state, approvals: [...this.#state.approvals, approval] }, "CONFIGURATION_APPROVED", actor, sha256Digest(approval as unknown as CanonicalValue), input.approvedAt)); return approval;
    });
  }

  async beginPilot(input: { readonly actor: ActivationActor; readonly startedAt: string }): Promise<MainnetActivationState> {
    return this.serial(async () => {
      await this.open(); requireDuty(input.actor, "platform-operator"); time(input.startedAt); if (this.#state.phase !== "BLOCKED") throw new MainnetActivationError("INVALID_PHASE", "Pilot can start only from the blocked phase."); assertReady(this.readiness()); const configuration = requiredConfiguration(this.#state);
      await this.persist(this.withEvent({ ...this.#state, phase: "PILOT" }, "PILOT_STARTED", input.actor, configuration.configurationDigest, input.startedAt)); return this.#state;
    });
  }

  async authorizeSettlement(input: { readonly authorizationId: string; readonly organizationId: string; readonly intentId: string; readonly intentDigest: string; readonly securityDecisionDigest: string; readonly transactionDigest: string; readonly asset: "XRP"; readonly amountXrp: string; readonly actor: ActivationActor; readonly requestedAt: string }): Promise<SettlementAuthorization> {
    return this.serial(async () => {
      await this.open(); requireDuty(input.actor, "settlement-service"); if (this.#state.phase !== "PILOT" && this.#state.phase !== "ACTIVE") throw new MainnetActivationError("INVALID_PHASE", "Mainnet settlement is not enabled."); assertReady(this.readiness());
      const configuration = requiredConfiguration(this.#state); id(input.authorizationId, "authorization_"); id(input.organizationId, "org_"); id(input.intentId, "pi_"); digest(input.intentDigest); digest(input.securityDecisionDigest); digest(input.transactionDigest); time(input.requestedAt);
      if (input.organizationId !== configuration.organizationId || !configuration.allowlistedAssets.includes(input.asset)) throw new MainnetActivationError("LIMIT_EXCEEDED", "Organization or asset is outside the Mainnet allowlist.");
      const amount = xrpDrops(input.amountXrp); const perPayment = xrpDrops(configuration.perPaymentLimitXrp); const pilotLimit = xrpDrops(configuration.pilotPaymentLimitXrp); const dailyLimit = xrpDrops(configuration.dailyAmountLimitXrp);
      if (amount > perPayment || (this.#state.phase === "PILOT" && amount > pilotLimit)) throw new MainnetActivationError("LIMIT_EXCEEDED", "Payment exceeds the externally enforced rollout limit.");
      const duplicate = this.#state.authorizations.find((item) => item.authorizationId === input.authorizationId || item.intentId === input.intentId);
      if (duplicate) { if (duplicate.intentDigest === input.intentDigest && duplicate.transactionDigest === input.transactionDigest && duplicate.amountXrp === input.amountXrp) return duplicate; throw new MainnetActivationError("CONFLICT", "Authorization or intent is already bound to another transaction."); }
      const day = input.requestedAt.slice(0, 10); const sameDay = this.#state.authorizations.filter((item) => item.requestedAt.startsWith(day)); const total = sameDay.reduce((sum, item) => sum + xrpDrops(item.amountXrp), 0n);
      if (sameDay.length >= configuration.dailyPaymentCountLimit || total + amount > dailyLimit) throw new MainnetActivationError("LIMIT_EXCEEDED", "Daily Mainnet rollout limit has been reached.");
      if (this.#state.phase === "PILOT" && this.#state.authorizations.filter((item) => item.phase === "PILOT").length >= configuration.pilotPaymentCountLimit) throw new MainnetActivationError("LIMIT_EXCEEDED", "The single-payment pilot limit has been reached.");
      const base = { authorizationId: input.authorizationId, organizationId: input.organizationId, intentId: input.intentId, intentDigest: input.intentDigest, securityDecisionDigest: input.securityDecisionDigest, transactionDigest: input.transactionDigest, asset: input.asset, amountXrp: input.amountXrp, phase: this.#state.phase, requestedByPrincipalId: input.actor.principalId, requestedAt: input.requestedAt, status: "AUTHORIZED" as const };
      const authorization = frozen({ ...base, authorizationDigest: sha256Digest(base as unknown as CanonicalValue) });
      await this.persist(this.withEvent({ ...this.#state, authorizations: [...this.#state.authorizations, authorization] }, "PAYMENT_AUTHORIZED", input.actor, authorization.authorizationDigest, input.requestedAt)); return authorization;
    });
  }

  async recordIndependentValidation(input: { readonly authorizationId: string; readonly transactionDigest: string; readonly transactionHash: string; readonly ledgerIndex: number; readonly resultCode: "tesSUCCESS"; readonly validated: true; readonly actor: ActivationActor; readonly monitoringEvidenceDigest: string; readonly validatedAt: string }): Promise<SettlementAuthorization> {
    return this.serial(async () => {
      await this.open(); requireDuty(input.actor, "independent-monitor"); id(input.authorizationId, "authorization_"); digest(input.transactionDigest); hash(input.transactionHash); digest(input.monitoringEvidenceDigest); time(input.validatedAt); if (!Number.isSafeInteger(input.ledgerIndex) || input.ledgerIndex < 1 || input.resultCode !== "tesSUCCESS" || input.validated !== true) throw new MainnetActivationError("VALIDATION_MISMATCH", "Only final successful validated-ledger results are accepted.");
      const current = requiredAuthorization(this.#state, input.authorizationId); if (current.status !== "AUTHORIZED") throw new MainnetActivationError("CONFLICT", "Authorization is not awaiting validation."); if (current.transactionDigest !== input.transactionDigest) throw new MainnetActivationError("VALIDATION_MISMATCH", "Monitored transaction differs from the approved transaction.");
      const configuration = requiredConfiguration(this.#state); const approvalPrincipals = this.#state.approvals.filter((item) => item.kind === "CONFIGURATION").map((item) => item.principalId); if ([configuration.configuredByPrincipalId, current.requestedByPrincipalId, ...approvalPrincipals].includes(input.actor.principalId)) throw new MainnetActivationError("SEPARATION_OF_DUTIES", "Validation must come from an independent monitoring principal.");
      const next = frozen({ ...current, status: "VALIDATED" as const, transactionHash: input.transactionHash, ledgerIndex: input.ledgerIndex, validatedAt: input.validatedAt, monitorPrincipalId: input.actor.principalId, monitoringEvidenceDigest: input.monitoringEvidenceDigest });
      await this.replaceAuthorization(next, "PAYMENT_VALIDATED", input.actor, input.monitoringEvidenceDigest, input.validatedAt); return next;
    });
  }

  async recordFinanceReconciliation(input: { readonly authorizationId: string; readonly transactionDigest: string; readonly transactionHash: string; readonly actor: ActivationActor; readonly reconciliationDigest: string; readonly reconciledAt: string }): Promise<SettlementAuthorization> {
    return this.serial(async () => {
      await this.open(); requireDuty(input.actor, "finance-approver"); id(input.authorizationId, "authorization_"); digest(input.transactionDigest); hash(input.transactionHash); digest(input.reconciliationDigest); time(input.reconciledAt); const current = requiredAuthorization(this.#state, input.authorizationId);
      if (current.status !== "VALIDATED" || current.transactionDigest !== input.transactionDigest || current.transactionHash !== input.transactionHash) throw new MainnetActivationError("VALIDATION_MISMATCH", "Finance reconciliation does not match the independently validated transaction.");
      if (input.actor.principalId === current.requestedByPrincipalId || input.actor.principalId === current.monitorPrincipalId) throw new MainnetActivationError("SEPARATION_OF_DUTIES", "Finance reconciliation must be independent of submission and monitoring.");
      const next = frozen({ ...current, status: "RECONCILED" as const, reconciliationDigest: input.reconciliationDigest, reconciledAt: input.reconciledAt, financePrincipalId: input.actor.principalId });
      await this.replaceAuthorization(next, "PAYMENT_RECONCILED", input.actor, input.reconciliationDigest, input.reconciledAt); return next;
    });
  }

  async approveRollout(input: { readonly approvalId: string; readonly actor: ActivationActor; readonly evidenceDigest: string; readonly approvedAt: string }): Promise<ActivationApproval> {
    return this.serial(async () => {
      await this.open(); const actor = requireApprovalActor(input.actor); if (this.#state.phase !== "PILOT" || !this.#state.authorizations.some((item) => item.phase === "PILOT" && item.status === "RECONCILED")) throw new MainnetActivationError("INVALID_PHASE", "A reconciled pilot is required before rollout approval."); id(input.approvalId, "approval_"); digest(input.evidenceDigest); time(input.approvedAt); const configuration = requiredConfiguration(this.#state);
      const existing = this.#state.approvals.find((item) => item.kind === "ROLLOUT" && item.duty === actor.duty); if (existing) { if (existing.principalId === actor.principalId && existing.evidenceDigest === input.evidenceDigest) return existing; throw new MainnetActivationError("CONFLICT", `${actor.duty} rollout approval already exists.`); }
      const other = this.#state.approvals.find((item) => item.kind === "ROLLOUT"); if (other?.principalId === actor.principalId) throw new MainnetActivationError("SEPARATION_OF_DUTIES", "Security and finance rollout approvals require different principals.");
      const approval = frozen({ approvalId: input.approvalId, kind: "ROLLOUT" as const, configurationDigest: configuration.configurationDigest, principalId: actor.principalId, duty: actor.duty, evidenceDigest: input.evidenceDigest, approvedAt: input.approvedAt }); await this.persist(this.withEvent({ ...this.#state, approvals: [...this.#state.approvals, approval] }, "ROLLOUT_APPROVED", actor, sha256Digest(approval as unknown as CanonicalValue), input.approvedAt)); return approval;
    });
  }

  async activate(input: { readonly actor: ActivationActor; readonly activatedAt: string }): Promise<MainnetActivationState> {
    return this.serial(async () => {
      await this.open(); requireDuty(input.actor, "platform-operator"); time(input.activatedAt); if (this.#state.phase !== "PILOT") throw new MainnetActivationError("INVALID_PHASE", "Full activation requires an active pilot."); assertReady(this.readiness()); const configuration = requiredConfiguration(this.#state); for (const duty of ["security-approver", "finance-approver"] as const) if (!this.#state.approvals.some((item) => item.kind === "ROLLOUT" && item.duty === duty && item.configurationDigest === configuration.configurationDigest)) throw new MainnetActivationError("APPROVAL_REQUIRED", `${duty} rollout approval is missing.`);
      await this.persist(this.withEvent({ ...this.#state, phase: "ACTIVE" }, "ACTIVATED", input.actor, configuration.configurationDigest, input.activatedAt)); return this.#state;
    });
  }

  async freeze(input: { readonly actor: ActivationActor; readonly reasonDigest: string; readonly frozenAt: string }): Promise<MainnetActivationState> {
    return this.serial(async () => {
      await this.open(); requireOneOf(input.actor, ["platform-operator", "security-approver"]); digest(input.reasonDigest); time(input.frozenAt); if (this.#state.phase !== "PILOT" && this.#state.phase !== "ACTIVE") throw new MainnetActivationError("INVALID_PHASE", "Only a live rollout can be frozen."); const previous = this.#state.phase;
      await this.persist(this.withEvent({ ...this.#state, phase: "FROZEN", frozenFromPhase: previous }, "FROZEN", input.actor, input.reasonDigest, input.frozenAt)); return this.#state;
    });
  }

  async rollback(input: { readonly actor: ActivationActor; readonly reasonDigest: string; readonly rolledBackAt: string }): Promise<MainnetActivationState> {
    return this.serial(async () => {
      await this.open(); requireOneOf(input.actor, ["platform-operator", "security-approver"]); digest(input.reasonDigest); time(input.rolledBackAt); if (!["PILOT", "ACTIVE", "FROZEN"].includes(this.#state.phase)) throw new MainnetActivationError("INVALID_PHASE", "There is no live rollout to roll back.");
      const { frozenFromPhase: ignored, ...base } = this.#state; void ignored; await this.persist(this.withEvent({ ...base, phase: "ROLLED_BACK" }, "ROLLED_BACK", input.actor, input.reasonDigest, input.rolledBackAt)); return this.#state;
    });
  }

  assertAdapterEnabled(input: { readonly endpoint: string; readonly networkId: number; readonly maxFeeDrops: string }): void {
    if (this.#state.phase !== "PILOT" && this.#state.phase !== "ACTIVE") throw new MainnetActivationError("INVALID_PHASE", "XRPL Mainnet adapter is disabled by the activation gate."); assertReady(this.readiness()); const configuration = requiredConfiguration(this.#state);
    if (input.networkId !== 0 || input.endpoint !== configuration.submissionEndpoint || BigInt(input.maxFeeDrops) > BigInt(configuration.maxFeeDrops)) throw new MainnetActivationError("CONFIGURATION_MISMATCH", "XRPL Mainnet adapter configuration differs from the approved rollout configuration.");
  }

  private async replaceAuthorization(next: SettlementAuthorization, type: ActivationEventType, actor: ActivationActor, subjectDigest: string, occurredAt: string): Promise<void> { await this.persist(this.withEvent({ ...this.#state, authorizations: this.#state.authorizations.map((item) => item.authorizationId === next.authorizationId ? next : item) }, type, actor, subjectDigest, occurredAt)); }
  private withEvent(state: MainnetActivationState, type: ActivationEventType, actor: ActivationActor, subjectDigest: string, occurredAt: string): MainnetActivationState { actorValue(actor); digest(subjectDigest); time(occurredAt); const previousEventDigest = state.events.at(-1)?.eventDigest ?? `sha256:${"0".repeat(64)}`; const base = { eventId: `activation_event_${String(state.events.length + 1).padStart(6, "0")}`, type, occurredAt, principalId: actor.principalId, duty: actor.duty, subjectDigest, previousEventDigest }; const event = frozen({ ...base, eventDigest: sha256Digest(base as unknown as CanonicalValue) }); return { ...state, events: [...state.events, event] }; }
  private async persist(value: MainnetActivationState): Promise<void> { this.#state = freezeState(value); await this.#store.save(this.#state); }
  private async serial<T>(work: () => Promise<T>): Promise<T> { const prior = this.#tail; let release: () => void = () => undefined; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior; try { return await work(); } finally { release(); } }
}

export class MainnetActivationError extends Error {
  readonly code: "INVALID_PHASE" | "APPROVAL_REQUIRED" | "SEPARATION_OF_DUTIES" | "LIMIT_EXCEEDED" | "VALIDATION_MISMATCH" | "CONFIGURATION_MISMATCH" | "CONFLICT" | "STATE_TAMPERED";
  constructor(code: MainnetActivationError["code"], message: string) { super(message); this.name = "MainnetActivationError"; this.code = code; }
}

function validateConfiguration(input: Omit<ProductionSettlementConfiguration, "configurationDigest">): Omit<ProductionSettlementConfiguration, "configurationDigest"> {
  id(input.configurationId, "configuration_"); id(input.organizationId, "org_"); id(input.configuredByPrincipalId, "principal_"); address(input.treasuryAccount); digest(input.signerListDigest); digest(input.rollbackPlanDigest); time(input.configuredAt);
  if (input.network !== "mainnet" || input.networkId !== 0 || input.allowlistedAssets.length !== 1 || input.allowlistedAssets[0] !== "XRP") throw new MainnetActivationError("CONFIGURATION_MISMATCH", "Only explicitly allowlisted native XRP on XRPL Mainnet is supported.");
  if (!Number.isSafeInteger(input.signerQuorum) || input.signerQuorum < 2 || !Number.isSafeInteger(input.signerMemberCount) || input.signerMemberCount < input.signerQuorum || input.signerMemberCount > 32) throw new MainnetActivationError("CONFIGURATION_MISMATCH", "Mainnet signer quorum is invalid.");
  const pilot = xrpDrops(input.pilotPaymentLimitXrp); const payment = xrpDrops(input.perPaymentLimitXrp); const daily = xrpDrops(input.dailyAmountLimitXrp); if (pilot > payment || payment > daily || input.pilotPaymentCountLimit !== 1 || !Number.isSafeInteger(input.dailyPaymentCountLimit) || input.dailyPaymentCountLimit < 1 || input.dailyPaymentCountLimit > 100) throw new MainnetActivationError("CONFIGURATION_MISMATCH", "Rollout limits are invalid.");
  drops(input.maxFeeDrops); if (input.lastLedgerOffset !== 4) throw new MainnetActivationError("CONFIGURATION_MISMATCH", "Mainnet transactions must use the approved four-ledger expiry offset."); endpoint(input.submissionEndpoint); endpoint(input.monitoringEndpoint); if (input.submissionEndpoint === input.monitoringEndpoint) throw new MainnetActivationError("CONFIGURATION_MISMATCH", "Submission and independent monitoring must use different trusted endpoints.");
  return frozen({ ...input, allowlistedAssets: frozen(["XRP"] as const) });
}

function validateState(state: MainnetActivationState): void {
  if (state.contractVersion !== "1.0" || !(["BLOCKED", "PILOT", "ACTIVE", "FROZEN", "ROLLED_BACK"] as const).includes(state.phase) || !Array.isArray(state.approvals) || !Array.isArray(state.authorizations) || !Array.isArray(state.events)) throw new MainnetActivationError("STATE_TAMPERED", "Activation state is malformed.");
  if (state.configuration) { const { configurationDigest, ...base } = state.configuration; validateConfiguration(base); if (sha256Digest(base as unknown as CanonicalValue) !== configurationDigest) throw new MainnetActivationError("STATE_TAMPERED", "Activation configuration digest is invalid."); }
  let prior = `sha256:${"0".repeat(64)}`; for (const event of state.events) { const { eventDigest, ...base } = event; if (event.previousEventDigest !== prior || sha256Digest(base as unknown as CanonicalValue) !== eventDigest) throw new MainnetActivationError("STATE_TAMPERED", "Activation event chain is invalid."); prior = eventDigest; }
  const hasEvent = (type: ActivationEventType, subjectDigest?: string) => state.events.some((event) => event.type === type && (subjectDigest === undefined || event.subjectDigest === subjectDigest));
  if (state.configuration && !hasEvent("CONFIGURED", state.configuration.configurationDigest)) throw new MainnetActivationError("STATE_TAMPERED", "Activation configuration is not bound to its event chain.");
  for (const approval of state.approvals) {
    id(approval.approvalId, "approval_"); id(approval.principalId, "principal_"); digest(approval.configurationDigest); digest(approval.evidenceDigest); time(approval.approvedAt);
    if (!(["CONFIGURATION", "ROLLOUT"] as const).includes(approval.kind) || !(["security-approver", "finance-approver"] as const).includes(approval.duty) || approval.configurationDigest !== state.configuration?.configurationDigest) throw new MainnetActivationError("STATE_TAMPERED", "Activation approval is invalid.");
    const type = approval.kind === "CONFIGURATION" ? "CONFIGURATION_APPROVED" : "ROLLOUT_APPROVED"; if (!hasEvent(type, sha256Digest(approval as unknown as CanonicalValue))) throw new MainnetActivationError("STATE_TAMPERED", "Activation approval is not bound to its event chain.");
  }
  for (const authorization of state.authorizations) {
    id(authorization.authorizationId, "authorization_"); id(authorization.organizationId, "org_"); id(authorization.intentId, "pi_"); id(authorization.requestedByPrincipalId, "principal_"); digest(authorization.intentDigest); digest(authorization.securityDecisionDigest); digest(authorization.transactionDigest); time(authorization.requestedAt); xrpDrops(authorization.amountXrp);
    const base = { authorizationId: authorization.authorizationId, organizationId: authorization.organizationId, intentId: authorization.intentId, intentDigest: authorization.intentDigest, securityDecisionDigest: authorization.securityDecisionDigest, transactionDigest: authorization.transactionDigest, asset: authorization.asset, amountXrp: authorization.amountXrp, phase: authorization.phase, requestedByPrincipalId: authorization.requestedByPrincipalId, requestedAt: authorization.requestedAt, status: "AUTHORIZED" as const };
    if (authorization.asset !== "XRP" || (authorization.phase !== "PILOT" && authorization.phase !== "ACTIVE") || sha256Digest(base as unknown as CanonicalValue) !== authorization.authorizationDigest || !hasEvent("PAYMENT_AUTHORIZED", authorization.authorizationDigest)) throw new MainnetActivationError("STATE_TAMPERED", "Settlement authorization is invalid.");
    if (authorization.status === "VALIDATED" || authorization.status === "RECONCILED") {
      hash(authorization.transactionHash); if (!Number.isSafeInteger(authorization.ledgerIndex) || authorization.ledgerIndex! < 1 || !authorization.monitorPrincipalId || !authorization.validatedAt || !authorization.monitoringEvidenceDigest) throw new MainnetActivationError("STATE_TAMPERED", "Validated settlement evidence is incomplete."); id(authorization.monitorPrincipalId, "principal_"); time(authorization.validatedAt); digest(authorization.monitoringEvidenceDigest); if (!hasEvent("PAYMENT_VALIDATED", authorization.monitoringEvidenceDigest)) throw new MainnetActivationError("STATE_TAMPERED", "Settlement validation is not bound to its event chain.");
    }
    if (authorization.status === "RECONCILED") {
      if (!authorization.financePrincipalId || !authorization.reconciledAt || !authorization.reconciliationDigest) throw new MainnetActivationError("STATE_TAMPERED", "Reconciliation evidence is incomplete."); id(authorization.financePrincipalId, "principal_"); time(authorization.reconciledAt); digest(authorization.reconciliationDigest); if (!hasEvent("PAYMENT_RECONCILED", authorization.reconciliationDigest)) throw new MainnetActivationError("STATE_TAMPERED", "Settlement reconciliation is not bound to its event chain.");
    }
    if (!(["AUTHORIZED", "VALIDATED", "RECONCILED"] as const).includes(authorization.status)) throw new MainnetActivationError("STATE_TAMPERED", "Settlement authorization status is invalid.");
  }
  const requiredPhaseEvent: Partial<Record<ActivationPhase, ActivationEventType>> = { PILOT: "PILOT_STARTED", ACTIVE: "ACTIVATED", FROZEN: "FROZEN", ROLLED_BACK: "ROLLED_BACK" }; const phaseEvent = requiredPhaseEvent[state.phase]; if (phaseEvent && !hasEvent(phaseEvent)) throw new MainnetActivationError("STATE_TAMPERED", "Activation phase is not supported by its event chain.");
}
function freezeState(state: MainnetActivationState): MainnetActivationState { return frozen({ ...state, ...(state.configuration ? { configuration: frozen({ ...state.configuration, allowlistedAssets: frozen([...state.configuration.allowlistedAssets] as ["XRP"]) }) } : {}), approvals: frozen(state.approvals.map((item) => frozen({ ...item }))), authorizations: frozen(state.authorizations.map((item) => frozen({ ...item }))), events: frozen(state.events.map((item) => frozen({ ...item }))) }); }
function requiredConfiguration(state: MainnetActivationState): ProductionSettlementConfiguration { if (!state.configuration) throw new MainnetActivationError("CONFIGURATION_MISMATCH", "Production settlement configuration is missing."); return state.configuration; }
function requiredAuthorization(state: MainnetActivationState, authorizationId: string): SettlementAuthorization { const value = state.authorizations.find((item) => item.authorizationId === authorizationId); if (!value) throw new MainnetActivationError("CONFLICT", "Settlement authorization was not found."); return value; }
function assertReady(value: ActivationReadiness): void { if (!value.allowed) throw new MainnetActivationError("APPROVAL_REQUIRED", `Mainnet activation is blocked: ${value.blockers.join(", ")}.`); }
function requireApprovalActor(actor: ActivationActor): ActivationActor & { readonly duty: "security-approver" | "finance-approver" } { requireOneOf(actor, ["security-approver", "finance-approver"]); return actor as ActivationActor & { readonly duty: "security-approver" | "finance-approver" }; }
function requireDuty(actor: ActivationActor, duty: ActivationDuty): void { actorValue(actor); if (actor.duty !== duty) throw new MainnetActivationError("SEPARATION_OF_DUTIES", `${duty} authority is required.`); }
function requireOneOf(actor: ActivationActor, duties: readonly ActivationDuty[]): void { actorValue(actor); if (!duties.includes(actor.duty)) throw new MainnetActivationError("SEPARATION_OF_DUTIES", "Actor does not hold the required activation duty."); }
function actorValue(actor: ActivationActor): void { id(actor.principalId, "principal_"); if (!(["platform-operator", "security-approver", "finance-approver", "independent-monitor", "settlement-service", "allocation-agent"] as const).includes(actor.duty)) throw new MainnetActivationError("SEPARATION_OF_DUTIES", "Activation duty is invalid."); }
function xrpDrops(value: string): bigint { if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new MainnetActivationError("LIMIT_EXCEEDED", "XRP amount is invalid."); const [whole = "0", fraction = ""] = value.split("."); const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")); if (result <= 0n) throw new MainnetActivationError("LIMIT_EXCEEDED", "XRP amount must be positive."); return result; }
function address(value: string): void { if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) throw new MainnetActivationError("CONFIGURATION_MISMATCH", "XRPL treasury account is invalid."); }
function endpoint(value: string): void { if (!/^wss:\/\/[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(value)) throw new MainnetActivationError("CONFIGURATION_MISMATCH", "XRPL endpoint must use WSS."); }
function drops(value: string): void { if (!/^[1-9]\d{0,15}$/.test(value)) throw new MainnetActivationError("CONFIGURATION_MISMATCH", "Maximum fee is invalid."); }
function id(value: unknown, prefix: string): void { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new MainnetActivationError("CONFLICT", "Identifier is invalid."); }
function validDigest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function digest(value: unknown): asserts value is string { if (!validDigest(value)) throw new MainnetActivationError("CONFLICT", "Evidence digest is invalid."); }
function hash(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-F0-9]{64}$/.test(value)) throw new MainnetActivationError("VALIDATION_MISMATCH", "XRPL transaction hash is invalid."); }
function time(value: unknown): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new MainnetActivationError("CONFLICT", "Timestamp is invalid."); }
function frozen<T>(value: T): T { return Object.freeze(value); }
