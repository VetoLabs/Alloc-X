import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ControlActor {
  readonly principalId: string;
  readonly organizationId: string;
  readonly kind: "human" | "agent" | "service";
  readonly roles: readonly string[];
}

export type FreezeScope =
  | { readonly kind: "organization" }
  | { readonly kind: "beneficiary"; readonly beneficiaryId: string }
  | { readonly kind: "asset"; readonly asset: string };

export interface EmergencyFreeze {
  readonly freezeId: string;
  readonly organizationId: string;
  readonly scope: FreezeScope;
  readonly reason: string;
  readonly frozenByPrincipalId: string;
  readonly frozenAt: string;
  readonly status: "ACTIVE" | "RELEASED";
  readonly releasedByPrincipalId?: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
}

export type LimitControl = "max-payment-amount" | "reserve-floor" | "daily-payment-count" | "daily-payment-amount";
export interface LimitChangeRequest {
  readonly changeId: string;
  readonly organizationId: string;
  readonly control: LimitControl;
  readonly currentValue: string;
  readonly requestedValue: string;
  readonly effect: "TIGHTEN" | "RELAX";
  readonly justification: string;
  readonly requestedByPrincipalId: string;
  readonly requestedAt: string;
  readonly approvedByPrincipalId?: string;
  readonly approvedAt?: string;
  readonly escalatedByPrincipalId?: string;
  readonly escalatedAt?: string;
  readonly status: "PENDING" | "AWAITING_ESCALATION" | "READY_FOR_POLICY_PUBLICATION" | "REJECTED";
}

export interface SecurityControlEvent {
  readonly eventId: string;
  readonly type: "FREEZE_APPLIED" | "FREEZE_RELEASED" | "LIMIT_CHANGE_REQUESTED" | "LIMIT_CHANGE_APPROVED" | "LIMIT_CHANGE_ESCALATED";
  readonly organizationId: string;
  readonly occurredAt: string;
  readonly actorPrincipalId: string;
  readonly subjectId: string;
}

export interface SecurityControlSnapshot {
  readonly contractVersion: "1.0";
  readonly freezes: readonly EmergencyFreeze[];
  readonly limitChanges: readonly LimitChangeRequest[];
  readonly events: readonly SecurityControlEvent[];
}

export interface SecurityControlStore {
  load(): Promise<SecurityControlSnapshot | undefined>;
  save(snapshot: SecurityControlSnapshot): Promise<void>;
}

/** JSON file store for local operation. Replace with a transactional database adapter in deployment. */
export class FileSecurityControlStore implements SecurityControlStore {
  readonly #path: string;
  constructor(path: string) { this.#path = path; }
  async load(): Promise<SecurityControlSnapshot | undefined> {
    try { return parseSnapshot(JSON.parse(await readFile(this.#path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async save(snapshot: SecurityControlSnapshot): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const next = `${this.#path}.next`;
    await writeFile(next, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(next, this.#path);
  }
}

/**
 * Security controls sit before payment intent creation. A freeze is immediate;
 * a control weakening never changes execution policy directly and must be
 * independently approved and escalated before a separate policy publication.
 */
export class TreasurySecurityControls {
  readonly #store: SecurityControlStore;
  #snapshot: SecurityControlSnapshot;
  private constructor(store: SecurityControlStore, snapshot: SecurityControlSnapshot) { this.#store = store; this.#snapshot = snapshot; }
  static async open(store: SecurityControlStore): Promise<TreasurySecurityControls> { return new TreasurySecurityControls(store, (await store.load()) ?? emptySnapshot()); }
  snapshot(): SecurityControlSnapshot { return freezeSnapshot(this.#snapshot); }

  assertPaymentAllowed(input: { readonly organizationId: string; readonly beneficiaryId: string; readonly asset: string }): void {
    const active = this.#snapshot.freezes.filter((value) => value.organizationId === input.organizationId && value.status === "ACTIVE");
    const match = active.find((value) => value.scope.kind === "organization" || (value.scope.kind === "beneficiary" && value.scope.beneficiaryId === input.beneficiaryId) || (value.scope.kind === "asset" && value.scope.asset === input.asset));
    if (match) throw new SecurityControlError(`Payment creation is frozen by ${match.freezeId}: ${match.reason}`);
  }

  async applyEmergencyFreeze(input: { readonly organizationId: string; readonly scope: FreezeScope; readonly reason: string; readonly actor: ControlActor; readonly frozenAt: string }): Promise<EmergencyFreeze> {
    assertHumanRole(input.actor, input.organizationId, "security-operator"); assertScope(input.scope); assertText(input.reason, "reason", 5, 500); assertTime(input.frozenAt, "frozenAt");
    const existing = this.#snapshot.freezes.find((value) => value.organizationId === input.organizationId && value.status === "ACTIVE" && sameScope(value.scope, input.scope));
    if (existing) return existing;
    const freeze = frozen({ freezeId: `frz_${String(this.#snapshot.freezes.length + 1).padStart(8, "0")}`, organizationId: input.organizationId, scope: freezeScope(input.scope), reason: input.reason.trim(), frozenByPrincipalId: input.actor.principalId, frozenAt: input.frozenAt, status: "ACTIVE" as const });
    await this.persist({ ...this.#snapshot, freezes: [...this.#snapshot.freezes, freeze], events: [...this.#snapshot.events, event(this.#snapshot, "FREEZE_APPLIED", input.organizationId, input.frozenAt, input.actor.principalId, freeze.freezeId)] });
    return freeze;
  }

  async releaseEmergencyFreeze(input: { readonly organizationId: string; readonly freezeId: string; readonly reason: string; readonly actor: ControlActor; readonly releasedAt: string }): Promise<EmergencyFreeze> {
    assertHumanRole(input.actor, input.organizationId, "security-approver"); assertText(input.reason, "reason", 5, 500); assertTime(input.releasedAt, "releasedAt");
    const current = requiredFreeze(this.#snapshot, input.organizationId, input.freezeId);
    if (current.status !== "ACTIVE") throw new SecurityControlError("Emergency freeze is not active.");
    if (current.frozenByPrincipalId === input.actor.principalId) throw new SecurityControlError("The operator who applied a freeze cannot release it.");
    const released = frozen({ ...current, status: "RELEASED" as const, releasedByPrincipalId: input.actor.principalId, releasedAt: input.releasedAt, releaseReason: input.reason.trim() });
    await this.persist({ ...this.#snapshot, freezes: this.#snapshot.freezes.map((value) => value.freezeId === released.freezeId ? released : value), events: [...this.#snapshot.events, event(this.#snapshot, "FREEZE_RELEASED", input.organizationId, input.releasedAt, input.actor.principalId, released.freezeId)] });
    return released;
  }

  async requestLimitChange(input: { readonly organizationId: string; readonly control: LimitControl; readonly currentValue: string; readonly requestedValue: string; readonly justification: string; readonly actor: ControlActor; readonly requestedAt: string }): Promise<LimitChangeRequest> {
    assertHumanRole(input.actor, input.organizationId, "security-operator"); assertLimit(input.control, input.currentValue); assertLimit(input.control, input.requestedValue); assertText(input.justification, "justification", 10, 1_000); assertTime(input.requestedAt, "requestedAt");
    const effect = classifyEffect(input.control, input.currentValue, input.requestedValue);
    const request = frozen({ changeId: `lcr_${String(this.#snapshot.limitChanges.length + 1).padStart(8, "0")}`, organizationId: input.organizationId, control: input.control, currentValue: input.currentValue, requestedValue: input.requestedValue, effect, justification: input.justification.trim(), requestedByPrincipalId: input.actor.principalId, requestedAt: input.requestedAt, status: "PENDING" as const });
    await this.persist({ ...this.#snapshot, limitChanges: [...this.#snapshot.limitChanges, request], events: [...this.#snapshot.events, event(this.#snapshot, "LIMIT_CHANGE_REQUESTED", input.organizationId, input.requestedAt, input.actor.principalId, request.changeId)] });
    return request;
  }

  async approveLimitChange(input: { readonly organizationId: string; readonly changeId: string; readonly actor: ControlActor; readonly approvedAt: string }): Promise<LimitChangeRequest> {
    assertHumanRole(input.actor, input.organizationId, "security-approver"); assertTime(input.approvedAt, "approvedAt"); const request = requiredChange(this.#snapshot, input.organizationId, input.changeId);
    if (request.status !== "PENDING") throw new SecurityControlError("Limit change is not awaiting approval.");
    if (request.requestedByPrincipalId === input.actor.principalId) throw new SecurityControlError("Limit-change requester cannot approve the same change.");
    const status = request.effect === "RELAX" ? "AWAITING_ESCALATION" as const : "READY_FOR_POLICY_PUBLICATION" as const;
    const approved = frozen({ ...request, approvedByPrincipalId: input.actor.principalId, approvedAt: input.approvedAt, status });
    await this.persist({ ...this.#snapshot, limitChanges: replace(this.#snapshot.limitChanges, approved), events: [...this.#snapshot.events, event(this.#snapshot, "LIMIT_CHANGE_APPROVED", input.organizationId, input.approvedAt, input.actor.principalId, approved.changeId)] });
    return approved;
  }

  async escalateLimitRelaxation(input: { readonly organizationId: string; readonly changeId: string; readonly actor: ControlActor; readonly escalatedAt: string }): Promise<LimitChangeRequest> {
    assertHumanRole(input.actor, input.organizationId, "security-escalation-approver"); assertTime(input.escalatedAt, "escalatedAt"); const request = requiredChange(this.#snapshot, input.organizationId, input.changeId);
    if (request.status !== "AWAITING_ESCALATION" || request.effect !== "RELAX") throw new SecurityControlError("Limit change does not require escalation.");
    if ([request.requestedByPrincipalId, request.approvedByPrincipalId].includes(input.actor.principalId)) throw new SecurityControlError("Escalation requires a third independent human operator.");
    const escalated = frozen({ ...request, escalatedByPrincipalId: input.actor.principalId, escalatedAt: input.escalatedAt, status: "READY_FOR_POLICY_PUBLICATION" as const });
    await this.persist({ ...this.#snapshot, limitChanges: replace(this.#snapshot.limitChanges, escalated), events: [...this.#snapshot.events, event(this.#snapshot, "LIMIT_CHANGE_ESCALATED", input.organizationId, input.escalatedAt, input.actor.principalId, escalated.changeId)] });
    return escalated;
  }

  private async persist(snapshot: SecurityControlSnapshot): Promise<void> { this.#snapshot = freezeSnapshot(snapshot); await this.#store.save(this.#snapshot); }
}

export class SecurityControlError extends Error { constructor(message: string) { super(message); this.name = "SecurityControlError"; } }

function emptySnapshot(): SecurityControlSnapshot { return frozen({ contractVersion: "1.0" as const, freezes: frozen([]), limitChanges: frozen([]), events: frozen([]) }); }
function parseSnapshot(value: unknown): SecurityControlSnapshot { if (!value || typeof value !== "object" || (value as { contractVersion?: unknown }).contractVersion !== "1.0") throw new SecurityControlError("Security control store is invalid."); const record = value as Partial<SecurityControlSnapshot>; if (!Array.isArray(record.freezes) || !Array.isArray(record.limitChanges) || !Array.isArray(record.events)) throw new SecurityControlError("Security control store is invalid."); return freezeSnapshot({ contractVersion: "1.0", freezes: record.freezes as EmergencyFreeze[], limitChanges: record.limitChanges as LimitChangeRequest[], events: record.events as SecurityControlEvent[] }); }
function freezeSnapshot(value: SecurityControlSnapshot): SecurityControlSnapshot { return frozen({ contractVersion: "1.0" as const, freezes: frozen(value.freezes.map((item) => frozen({ ...item, scope: freezeScope(item.scope) }))), limitChanges: frozen(value.limitChanges.map((item) => frozen({ ...item }))), events: frozen(value.events.map((item) => frozen({ ...item }))) }); }
function event(snapshot: SecurityControlSnapshot, type: SecurityControlEvent["type"], organizationId: string, occurredAt: string, actorPrincipalId: string, subjectId: string): SecurityControlEvent { return frozen({ eventId: `sce_${String(snapshot.events.length + 1).padStart(8, "0")}`, type, organizationId, occurredAt, actorPrincipalId, subjectId }); }
function requiredFreeze(snapshot: SecurityControlSnapshot, organizationId: string, freezeId: string): EmergencyFreeze { const item = snapshot.freezes.find((value) => value.organizationId === organizationId && value.freezeId === freezeId); if (!item) throw new SecurityControlError("Emergency freeze was not found."); return item; }
function requiredChange(snapshot: SecurityControlSnapshot, organizationId: string, changeId: string): LimitChangeRequest { const item = snapshot.limitChanges.find((value) => value.organizationId === organizationId && value.changeId === changeId); if (!item) throw new SecurityControlError("Limit change was not found."); return item; }
function replace<T extends { readonly changeId: string }>(items: readonly T[], changed: T): readonly T[] { return items.map((item) => item.changeId === changed.changeId ? changed : item); }
function assertHumanRole(actor: ControlActor, organizationId: string, role: string): void { if (actor.kind !== "human" || actor.organizationId !== organizationId || !actor.roles.includes(role)) throw new SecurityControlError("This security action requires an authorized human operator."); assertId(actor.principalId, "principalId", "principal_"); }
function assertScope(scope: FreezeScope): void { if (!scope || typeof scope !== "object" || !["organization", "beneficiary", "asset"].includes(scope.kind)) throw new SecurityControlError("Freeze scope is invalid."); if (scope.kind === "beneficiary") assertId(scope.beneficiaryId, "beneficiaryId", "ben_"); if (scope.kind === "asset" && !/^[A-Z0-9]{3,16}$/.test(scope.asset)) throw new SecurityControlError("Freeze asset is invalid."); }
function freezeScope(scope: FreezeScope): FreezeScope { assertScope(scope); return scope.kind === "organization" ? frozen({ kind: "organization" as const }) : scope.kind === "beneficiary" ? frozen({ kind: "beneficiary" as const, beneficiaryId: scope.beneficiaryId }) : frozen({ kind: "asset" as const, asset: scope.asset }); }
function sameScope(left: FreezeScope, right: FreezeScope): boolean { return left.kind === right.kind && (left.kind === "organization" || (left.kind === "beneficiary" && right.kind === "beneficiary" && left.beneficiaryId === right.beneficiaryId) || (left.kind === "asset" && right.kind === "asset" && left.asset === right.asset)); }
function assertLimit(control: LimitControl, value: string): void { if (!(["max-payment-amount", "reserve-floor", "daily-payment-count", "daily-payment-amount"] as const).includes(control)) throw new SecurityControlError("Limit control is invalid."); if (!/^\d+(?:\.\d{1,6})?$/.test(value) || Number(value) < 0) throw new SecurityControlError("Limit value is invalid."); if (control === "daily-payment-count" && (!Number.isSafeInteger(Number(value)) || Number(value) < 1)) throw new SecurityControlError("Daily payment count is invalid."); }
function classifyEffect(control: LimitControl, currentValue: string, requestedValue: string): "TIGHTEN" | "RELAX" { const current = Number(currentValue); const requested = Number(requestedValue); if (current === requested) throw new SecurityControlError("Requested limit must differ from the current limit."); return control === "reserve-floor" ? requested > current ? "TIGHTEN" : "RELAX" : requested < current ? "TIGHTEN" : "RELAX"; }
function assertId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new SecurityControlError(`${name} is invalid.`); }
function assertText(value: unknown, name: string, min: number, max: number): asserts value is string { if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw new SecurityControlError(`${name} is invalid.`); }
function assertTime(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new SecurityControlError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
