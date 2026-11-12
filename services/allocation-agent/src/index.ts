import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { sha256Digest, type CanonicalValue } from "../../../packages/contracts/src/index.ts";

export type AgentSessionState = "ACTIVE" | "AWAITING_EVIDENCE" | "DRAFTED" | "COMPLETED";
export type AgentActionName = "beneficiary.resolve" | "evidence.request" | "payment.draft" | "policy.explain" | "clarification.request";
export interface AgentAction { readonly sequence: number; readonly occurredAt: string; readonly name: AgentActionName; readonly inputDigest: string; readonly outputDigest: string; readonly detail: string; }
export interface AllocationAgentSession { readonly sessionId: string; readonly organizationId: string; readonly principalId: string; readonly state: AgentSessionState; readonly createdAt: string; readonly updatedAt: string; readonly actions: readonly AgentAction[]; readonly draftIntentId?: string; readonly evidenceRequestId?: string; }
export interface ResolvedBeneficiary { readonly beneficiaryId: string; readonly displayName: string; readonly asset: string; readonly status: "approved" | "pending" | "disabled"; }
export interface AgentTools {
  readonly beneficiaries: { resolve(input: { readonly organizationId: string; readonly query: string }): Promise<ResolvedBeneficiary> | ResolvedBeneficiary };
  readonly evidence: { request(input: { readonly organizationId: string; readonly beneficiaryId: string; readonly amount: string; readonly asset: string; readonly purposeCode: string; readonly requestedByPrincipalId: string; readonly requestedAt: string }): Promise<{ readonly requestId: string; readonly detail: string }> | { readonly requestId: string; readonly detail: string } };
  readonly drafts: { create(input: { readonly organizationId: string; readonly beneficiaryId: string; readonly amount: string; readonly asset: string; readonly purposeCode: string; readonly requestedByPrincipalId: string; readonly requestedAt: string }): Promise<{ readonly draftIntentId: string; readonly detail: string }> | { readonly draftIntentId: string; readonly detail: string } };
  readonly policy: { explain(input: { readonly organizationId: string; readonly amount: string; readonly asset: string; readonly purposeCode: string }): Promise<{ readonly detail: string }> | { readonly detail: string } };
}
export interface AllocationAgentSessionStore { load(): Promise<readonly AllocationAgentSession[]>; save(sessions: readonly AllocationAgentSession[]): Promise<void>; }

/** File-backed session store for local operation. Each update is atomically replaced before acknowledgement. */
export class FileAllocationAgentSessionStore implements AllocationAgentSessionStore {
  readonly #path: string;
  constructor(path: string) { if (!path) throw new AllocationAgentError("Agent session store path is required."); this.#path = path; }
  async load(): Promise<readonly AllocationAgentSession[]> { try { const raw = JSON.parse(await readFile(this.#path, "utf8")) as unknown; if (!Array.isArray(raw)) throw new AllocationAgentError("Agent session store is invalid."); return frozen(raw.map(parseSession)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return frozen([]); throw error; } }
  async save(sessions: readonly AllocationAgentSession[]): Promise<void> { await mkdir(dirname(this.#path), { recursive: true }); const next = `${this.#path}.next`; await writeFile(next, JSON.stringify(sessions), { mode: 0o600 }); await rename(next, this.#path); }
}

/**
 * Secure command boundary. It intentionally accepts a small explicit language
 * until a model-backed interpreter is configured. A model may only output this
 * command shape; all tools remain server-side and typed.
 */
export function interpretAllocationCommand(message: string): { readonly kind: "pay"; readonly amount: string; readonly asset: string; readonly beneficiaryQuery: string; readonly purposeCode: string } | undefined {
  if (typeof message !== "string" || message.length > 500) return undefined;
  const match = /^\s*(?:alloc[- ]?x[,:]?\s*)?(?:pay|send)\s+(\d+(?:\.\d{1,18})?)\s+([A-Za-z0-9]{3,16})\s+to\s+(.+?)\s+for\s+([a-z][a-z0-9-]{1,79})\s*$/iu.exec(message);
  if (!match) return undefined;
  const [, amount, rawAsset, beneficiaryQuery, purposeCode] = match;
  if (!/^(0|[1-9]\d*)(?:\.\d{1,18})?$/u.test(amount) || BigInt(amount.replace(".", "").replace(/^0+(?=\d)/u, "") || "0") <= 0n || beneficiaryQuery.trim().length < 2 || beneficiaryQuery.trim().length > 160) return undefined;
  return frozen({ kind: "pay", amount, asset: rawAsset.toUpperCase(), beneficiaryQuery: beneficiaryQuery.trim(), purposeCode });
}

export class AllocationAgentService {
  readonly #store: AllocationAgentSessionStore; readonly #tools: AgentTools; #sessions = new Map<string, AllocationAgentSession>(); #opened = false;
  constructor(input: { readonly store: AllocationAgentSessionStore; readonly tools: AgentTools }) { this.#store = input.store; this.#tools = input.tools; }
  async open(): Promise<void> { if (this.#opened) return; for (const session of await this.#store.load()) this.#sessions.set(session.sessionId, session); this.#opened = true; }
  async start(input: { readonly organizationId: string; readonly principalId: string; readonly sessionId: string; readonly startedAt: string }): Promise<AllocationAgentSession> { await this.open(); requireId(input.organizationId, "organizationId", "org_"); requireId(input.principalId, "principalId", "principal_"); requireId(input.sessionId, "sessionId", "agent_"); timestamp(input.startedAt, "startedAt"); const existing = this.#sessions.get(input.sessionId); if (existing) { if (existing.organizationId !== input.organizationId || existing.principalId !== input.principalId) throw new AllocationAgentError("Agent session cannot be accessed by another organization or principal."); return existing; } const session = frozen({ sessionId: input.sessionId, organizationId: input.organizationId, principalId: input.principalId, state: "ACTIVE" as const, createdAt: input.startedAt, updatedAt: input.startedAt, actions: frozen([]) }); await this.#persist(session); return session; }
  async handle(input: { readonly organizationId: string; readonly principalId: string; readonly sessionId: string; readonly message: string; readonly occurredAt: string }): Promise<AllocationAgentSession> {
    const session = await this.start({ organizationId: input.organizationId, principalId: input.principalId, sessionId: input.sessionId, startedAt: input.occurredAt }); timestamp(input.occurredAt, "occurredAt");
    const command = interpretAllocationCommand(input.message);
    if (!command) return this.transition(session, "ACTIVE", input.occurredAt, "clarification.request", { message: input.message }, { detail: "Use: pay <amount> <asset> to <beneficiary> for <purpose>." });
    const beneficiary = await this.#tools.beneficiaries.resolve({ organizationId: session.organizationId, query: command.beneficiaryQuery }); validateBeneficiary(beneficiary); let current = await this.transition(session, "ACTIVE", input.occurredAt, "beneficiary.resolve", { query: command.beneficiaryQuery }, { detail: `Resolved ${beneficiary.displayName}.` });
    if (beneficiary.status !== "approved" || beneficiary.asset !== command.asset) return this.transition(current, "AWAITING_EVIDENCE", input.occurredAt, "evidence.request", command, await this.#tools.evidence.request({ organizationId: session.organizationId, beneficiaryId: beneficiary.beneficiaryId, amount: command.amount, asset: command.asset, purposeCode: command.purposeCode, requestedByPrincipalId: session.principalId, requestedAt: input.occurredAt }));
    const policy = await this.#tools.policy.explain({ organizationId: session.organizationId, amount: command.amount, asset: command.asset, purposeCode: command.purposeCode }); current = await this.transition(current, "ACTIVE", input.occurredAt, "policy.explain", command, policy);
    const draft = await this.#tools.drafts.create({ organizationId: session.organizationId, beneficiaryId: beneficiary.beneficiaryId, amount: command.amount, asset: command.asset, purposeCode: command.purposeCode, requestedByPrincipalId: session.principalId, requestedAt: input.occurredAt }); return this.transition(current, "DRAFTED", input.occurredAt, "payment.draft", command, draft);
  }
  async get(input: { readonly organizationId: string; readonly principalId: string; readonly sessionId: string }): Promise<AllocationAgentSession> { await this.open(); const session = this.#sessions.get(input.sessionId); if (!session || session.organizationId !== input.organizationId || session.principalId !== input.principalId) throw new AllocationAgentError("Agent session was not found."); return session; }
  async #persist(next: AllocationAgentSession): Promise<void> { this.#sessions.set(next.sessionId, next); await this.#store.save(frozen([...this.#sessions.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)))); }
  async transition(session: AllocationAgentSession, state: AgentSessionState, occurredAt: string, name: AgentActionName, input: CanonicalValue, output: { readonly detail: string; readonly draftIntentId?: string; readonly requestId?: string }): Promise<AllocationAgentSession> { if (session.state === "COMPLETED") throw new AllocationAgentError("Completed agent session cannot accept new actions."); const action = frozen({ sequence: session.actions.length + 1, occurredAt, name, inputDigest: sha256Digest(input), outputDigest: sha256Digest(output as CanonicalValue), detail: output.detail }); const next = frozen({ ...session, state, updatedAt: occurredAt, actions: frozen([...session.actions, action]), ...(output.draftIntentId ? { draftIntentId: output.draftIntentId } : {}), ...(output.requestId ? { evidenceRequestId: output.requestId } : {}) }); await this.#persist(next); return next; }
}

export class AllocationAgentError extends Error { constructor(message: string) { super(message); this.name = "AllocationAgentError"; } }
function parseSession(value: unknown): AllocationAgentSession { if (!value || typeof value !== "object" || Array.isArray(value)) throw new AllocationAgentError("Agent session is invalid."); const session = value as Partial<AllocationAgentSession>; requireId(session.sessionId, "sessionId", "agent_"); requireId(session.organizationId, "organizationId", "org_"); requireId(session.principalId, "principalId", "principal_"); if (!session.state || !["ACTIVE", "AWAITING_EVIDENCE", "DRAFTED", "COMPLETED"].includes(session.state) || !Array.isArray(session.actions)) throw new AllocationAgentError("Agent session is invalid."); timestamp(session.createdAt, "createdAt"); timestamp(session.updatedAt, "updatedAt"); return frozen({ ...(session as AllocationAgentSession), actions: frozen(session.actions.map((action) => frozen(action))) }); }
function validateBeneficiary(value: ResolvedBeneficiary): void { requireId(value.beneficiaryId, "beneficiaryId", "ben_"); if (typeof value.displayName !== "string" || !value.displayName.trim() || !/^[A-Z0-9]{3,16}$/u.test(value.asset) || !["approved", "pending", "disabled"].includes(value.status)) throw new AllocationAgentError("Beneficiary resolver returned invalid data."); }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/u.test(value)) throw new AllocationAgentError(`${name} is invalid.`); }
function timestamp(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new AllocationAgentError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
