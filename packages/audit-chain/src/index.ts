import {
  canonicalJson,
  sha256Digest,
  type CanonicalValue,
} from "../../contracts/src/index.ts";
import type { AuthorizationDecision } from "../../authorization/src/index.ts";

const GENESIS_EVENT_HASH = `sha256:${"0".repeat(64)}`;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(authorization|credential|pass(word|phrase)?|private|secret|seed|token|api[-_]?key|signature)/i;

export interface AuditActor {
  readonly principalId: string;
  readonly kind: "human" | "agent" | "service";
}

export interface AuditSubject {
  readonly type: string;
  readonly id: string;
}

export interface AppendAuditEvent {
  readonly organizationId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly actor: AuditActor;
  readonly eventType: string;
  readonly subject: AuditSubject;
  readonly payload: CanonicalValue;
  readonly expectedPreviousEventHash?: string;
}

export interface AuditEvent {
  readonly contractVersion: "1.0";
  readonly organizationId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly actor: AuditActor;
  readonly eventType: string;
  readonly subject: AuditSubject;
  readonly payloadDigest: string;
  readonly redactedPayload: CanonicalValue;
  readonly previousEventHash: string;
  readonly eventHash: string;
  readonly retentionUntil: string;
}

export interface AuditSearch {
  readonly organizationId: string;
  readonly correlationId?: string;
  readonly eventType?: string;
  readonly subjectId?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface AuditHead {
  readonly organizationId: string;
  readonly sequence: number;
  readonly eventHash: string;
}

export type AuditIntegrityFailure =
  | "ORGANIZATION_MISMATCH"
  | "SEQUENCE_GAP"
  | "PREVIOUS_HASH_MISMATCH"
  | "EVENT_HASH_MISMATCH"
  | "HEAD_MISMATCH";

export interface AuditIntegrityResult {
  readonly valid: boolean;
  readonly checkedEvents: number;
  readonly failures: readonly AuditIntegrityFailure[];
}

export class AuditAppendConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditAppendConflictError";
  }
}

/**
 * A deterministic in-memory adapter for local development and test evidence.
 * It exposes no edit or deletion operation. Production storage must implement
 * the same atomic expected-head append behavior with protected retention.
 */
export class InMemoryAuditChain {
  readonly #events: AuditEvent[] = [];
  readonly #heads = new Map<string, AuditHead>();
  readonly #retentionDays: number;

  constructor(options: { readonly retentionDays?: number } = {}) {
    const retentionDays = options.retentionDays ?? 2_555;
    if (!Number.isInteger(retentionDays) || retentionDays < 365) {
      throw new TypeError("retentionDays must be an integer of at least 365 days.");
    }
    this.#retentionDays = retentionDays;
  }

  append(input: AppendAuditEvent): AuditEvent {
    const request = parseAppendAuditEvent(input);
    const head = this.headFor(request.organizationId);
    if (request.expectedPreviousEventHash && request.expectedPreviousEventHash !== head.eventHash) {
      throw new AuditAppendConflictError("Audit append rejected because the expected head does not match.");
    }

    const payloadDigest = sha256Digest(request.payload);
    const redactedPayload = redactAuditPayload(request.payload);
    const eventBase = {
      contractVersion: "1.0" as const,
      organizationId: request.organizationId,
      eventId: request.eventId,
      sequence: head.sequence + 1,
      occurredAt: request.occurredAt,
      correlationId: request.correlationId,
      actor: request.actor,
      eventType: request.eventType,
      subject: request.subject,
      payloadDigest,
      redactedPayload,
      previousEventHash: head.eventHash,
      retentionUntil: addDays(request.occurredAt, this.#retentionDays),
    };
    const event = frozen({ ...eventBase, eventHash: eventHash(eventBase) });
    this.#events.push(event);
    this.#heads.set(event.organizationId, frozen({ organizationId: event.organizationId, sequence: event.sequence, eventHash: event.eventHash }));
    return event;
  }

  search(authorization: AuthorizationDecision, query: AuditSearch): readonly AuditEvent[] {
    assertAuditRead(authorization, query.organizationId);
    const normalized = parseSearch(query);
    return frozen(this.#events.filter((event) =>
      event.organizationId === normalized.organizationId &&
      (normalized.correlationId === undefined || event.correlationId === normalized.correlationId) &&
      (normalized.eventType === undefined || event.eventType === normalized.eventType) &&
      (normalized.subjectId === undefined || event.subject.id === normalized.subjectId) &&
      (normalized.afterSequence === undefined || event.sequence > normalized.afterSequence),
    ).slice(0, normalized.limit));
  }

  head(authorization: AuthorizationDecision, organizationId: string): AuditHead {
    assertAuditRead(authorization, organizationId);
    return this.headFor(organizationId);
  }

  verify(authorization: AuthorizationDecision, organizationId: string): AuditIntegrityResult {
    assertAuditRead(authorization, organizationId);
    const events = this.#events.filter((event) => event.organizationId === organizationId);
    return verifyAuditChain(events, [this.headFor(organizationId)]);
  }

  private headFor(organizationId: string): AuditHead {
    requireIdentifier(organizationId, "organizationId", "org_");
    return this.#heads.get(organizationId) ?? frozen({ organizationId, sequence: 0, eventHash: GENESIS_EVENT_HASH });
  }
}

/** Verifies order, event content, and optionally the externally retained head(s). */
export function verifyAuditChain(events: readonly AuditEvent[], expectedHeads: readonly AuditHead[] = []): AuditIntegrityResult {
  const expected = new Map(expectedHeads.map((head) => [head.organizationId, head]));
  const state = new Map<string, AuditHead>();
  const failures = new Set<AuditIntegrityFailure>();

  for (const event of events) {
    const current = state.get(event.organizationId) ?? { organizationId: event.organizationId, sequence: 0, eventHash: GENESIS_EVENT_HASH };
    if (!event.organizationId.startsWith("org_")) failures.add("ORGANIZATION_MISMATCH");
    if (event.sequence !== current.sequence + 1) failures.add("SEQUENCE_GAP");
    if (event.previousEventHash !== current.eventHash) failures.add("PREVIOUS_HASH_MISMATCH");
    if (event.eventHash !== eventHash(event)) failures.add("EVENT_HASH_MISMATCH");
    state.set(event.organizationId, { organizationId: event.organizationId, sequence: event.sequence, eventHash: event.eventHash });
  }
  for (const [organizationId, head] of expected) {
    const actual = state.get(organizationId) ?? { organizationId, sequence: 0, eventHash: GENESIS_EVENT_HASH };
    if (actual.sequence !== head.sequence || actual.eventHash !== head.eventHash) failures.add("HEAD_MISMATCH");
  }
  return frozen({ valid: failures.size === 0, checkedEvents: events.length, failures: frozen([...failures].sort()) });
}

export function redactAuditPayload(payload: CanonicalValue): CanonicalValue {
  return redact(payload, false);
}

function parseAppendAuditEvent(input: AppendAuditEvent): AppendAuditEvent {
  const value = input as Record<string, unknown>;
  exactKeys(value, ["organizationId", "eventId", "occurredAt", "correlationId", "actor", "eventType", "subject", "payload", "expectedPreviousEventHash"], ["expectedPreviousEventHash"], "audit event");
  requireIdentifier(input.organizationId, "organizationId", "org_");
  requireIdentifier(input.eventId, "eventId", "audit_");
  requireIdentifier(input.correlationId, "correlationId", "corr_");
  requireTimestamp(input.occurredAt, "occurredAt");
  requireCode(input.eventType, "eventType");
  requireActor(input.actor); requireSubject(input.subject);
  if (input.expectedPreviousEventHash !== undefined) requireDigest(input.expectedPreviousEventHash, "expectedPreviousEventHash");
  canonicalJson(input.payload);
  return input;
}

function parseSearch(input: AuditSearch): Required<Pick<AuditSearch, "organizationId" | "limit">> & AuditSearch {
  requireIdentifier(input.organizationId, "organizationId", "org_");
  if (input.correlationId !== undefined) requireIdentifier(input.correlationId, "correlationId", "corr_");
  if (input.eventType !== undefined) requireCode(input.eventType, "eventType");
  if (input.subjectId !== undefined) requireIdentifier(input.subjectId, "subjectId", "");
  if (input.afterSequence !== undefined && (!Number.isInteger(input.afterSequence) || input.afterSequence < 0)) throw new TypeError("afterSequence must be a non-negative integer.");
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError("limit must be an integer from 1 through 500.");
  return { ...input, limit };
}

function assertAuditRead(authorization: AuthorizationDecision, organizationId: string): void {
  if (!authorization.allowed || authorization.action !== "audit:read" || authorization.organizationId !== organizationId) {
    throw new Error("Audit read denied.");
  }
}

function eventHash(event: Omit<AuditEvent, "eventHash"> | AuditEvent): string {
  const { eventHash: ignored, ...content } = event as AuditEvent;
  return sha256Digest(content as unknown as CanonicalValue);
}

function redact(value: CanonicalValue, sensitiveAncestor: boolean): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sensitiveAncestor ? REDACTED : value;
  if (Array.isArray(value)) return frozen(value.map((item) => redact(item, sensitiveAncestor)));
  const output: Record<string, CanonicalValue> = {};
  for (const [key, item] of Object.entries(value)) output[key] = redact(item, sensitiveAncestor || SENSITIVE_KEY.test(key));
  return frozen(output);
}

function addDays(timestamp: string, days: number): string { return new Date(Date.parse(timestamp) + days * 86_400_000).toISOString(); }
function requireActor(actor: AuditActor): void { requireIdentifier(actor?.principalId, "actor.principalId", "principal_"); if (!actor || !["human", "agent", "service"].includes(actor.kind)) throw new TypeError("actor.kind is invalid."); }
function requireSubject(subject: AuditSubject): void { if (!subject || typeof subject.type !== "string" || !/^[a-z][a-z0-9-]{1,79}$/.test(subject.type)) throw new TypeError("subject.type is invalid."); requireIdentifier(subject.id, "subject.id", ""); }
function requireIdentifier(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requireCode(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,79}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requireTimestamp(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid.`); }
function requireDigest(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[], name: string): void { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name} has unsupported field ${key}.`); for (const key of keys) if (!(key in value) && !optional.includes(key)) throw new TypeError(`${name} is missing ${key}.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
