import { sign, verify, type KeyObject } from "node:crypto";

import { sha256Digest, type CanonicalValue } from "../../../packages/contracts/src/index.ts";
import { parsePolicyBundle, policyBundleDigest, type PolicyBundle } from "../../../packages/policy-engine/src/index.ts";

export type PolicyActorKind = "human" | "agent" | "service";
export interface PolicyActor { readonly principalId: string; readonly organizationId: string; readonly kind: PolicyActorKind; readonly roles: readonly string[]; }
export interface PolicyDraftSubmission { readonly draftId: string; readonly organizationId: string; readonly sourceDraftDigest: string; readonly policy: PolicyBundle; readonly createdBy: PolicyActor; readonly createdAt: string; }
export interface PolicyReview { readonly reviewId: string; readonly draftId: string; readonly decision: "approved" | "rejected"; readonly comment: string; readonly reviewedBy: PolicyActor; readonly reviewedAt: string; }
export interface SignedPolicyBundle { readonly policy: PolicyBundle; readonly policyDigest: string; readonly sourceDraftDigest: string; readonly draftDigest: string; readonly publishedAt: string; readonly publishedByPrincipalId: string; readonly signerKeyId: string; readonly signature: string; readonly bundleDigest: string; }
export interface PolicyRegistryEvent { readonly eventId: string; readonly eventType: "DRAFT_CREATED" | "REVIEW_RECORDED" | "PUBLISHED" | "ACTIVATED" | "REVOKED"; readonly organizationId: string; readonly policyVersion: string; readonly occurredAt: string; readonly actorPrincipalId: string; readonly valueDigest: string; readonly previousEventDigest: string; readonly eventDigest: string; }
export interface PolicyPublicationGate { assertCanPublish(input: { readonly draftId: string; readonly policy: PolicyBundle }): void; }

interface DraftRecord { readonly submission: PolicyDraftSubmission; readonly digest: string; readonly reviews: readonly PolicyReview[]; }
interface Activation { readonly policyVersion: string; readonly activatedAt: string; readonly activatedByPrincipalId: string; }

/**
 * An in-memory implementation of the policy registry state machine. The
 * interfaces and immutable event stream are intentionally suitable for a
 * transactional persistent adapter in deployment.
 */
export class PolicyRegistry {
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #signerKeyId: string;
  readonly #publicationGate: PolicyPublicationGate | undefined;
  readonly #drafts = new Map<string, DraftRecord>();
  readonly #published = new Map<string, SignedPolicyBundle>();
  readonly #revoked = new Map<string, { readonly revokedAt: string; readonly revokedByPrincipalId: string; readonly reason: string }>();
  readonly #activations = new Map<string, Activation[]>();
  readonly #events: PolicyRegistryEvent[] = [];
  constructor(input: { readonly privateKey: KeyObject; readonly publicKey: KeyObject; readonly signerKeyId: string; readonly publicationGate?: PolicyPublicationGate }) { if (typeof input.signerKeyId !== "string" || !/^[a-z][a-z0-9._-]{4,119}$/.test(input.signerKeyId)) throw new TypeError("Policy signer key identifier is invalid."); this.#privateKey = input.privateKey; this.#publicKey = input.publicKey; this.#signerKeyId = input.signerKeyId; this.#publicationGate = input.publicationGate; }

  createDraft(input: PolicyDraftSubmission): { readonly draftId: string; readonly digest: string } {
    const submission = parseSubmission(input); assertHumanRole(submission.createdBy, "policy-author"); const existing = this.#drafts.get(submission.draftId); const digest = digestDraft(submission);
    if (existing) { if (existing.digest !== digest) throw new PolicyRegistryError("Draft id is already bound to different content."); return frozen({ draftId: submission.draftId, digest }); }
    this.#drafts.set(submission.draftId, frozen({ submission, digest, reviews: frozen([]) })); this.event("DRAFT_CREATED", submission.organizationId, submission.policy.policyVersion, submission.createdAt, submission.createdBy.principalId, digest); return frozen({ draftId: submission.draftId, digest });
  }

  review(input: { readonly draftId: string; readonly decision: "approved" | "rejected"; readonly comment: string; readonly reviewer: PolicyActor; readonly reviewedAt: string }): PolicyReview {
    const draft = this.draft(input.draftId); assertHumanRole(input.reviewer, "policy-approver"); assertSameOrganization(draft.submission.organizationId, input.reviewer.organizationId); if (input.reviewer.principalId === draft.submission.createdBy.principalId) throw new PolicyRegistryError("Policy author cannot review their own draft."); requireTime(input.reviewedAt, "reviewedAt"); if (input.decision !== "approved" && input.decision !== "rejected") throw new PolicyRegistryError("Policy review decision is invalid."); if (typeof input.comment !== "string" || input.comment.length > 2_000) throw new PolicyRegistryError("Policy review comment is invalid.");
    const review = frozen({ reviewId: `prv_${sha256Digest({ draftId: input.draftId, decision: input.decision, reviewer: input.reviewer.principalId, reviewedAt: input.reviewedAt } as unknown as CanonicalValue).slice(7, 39)}`, draftId: input.draftId, decision: input.decision, comment: input.comment, reviewedBy: freezeActor(input.reviewer), reviewedAt: input.reviewedAt });
    if (draft.reviews.some((value) => value.reviewedBy.principalId === review.reviewedBy.principalId)) throw new PolicyRegistryError("A reviewer may record only one decision for a draft.");
    this.#drafts.set(draft.submission.draftId, frozen({ ...draft, reviews: frozen([...draft.reviews, review]) })); this.event("REVIEW_RECORDED", draft.submission.organizationId, draft.submission.policy.policyVersion, review.reviewedAt, review.reviewedBy.principalId, sha256Digest(review as unknown as CanonicalValue)); return review;
  }

  publish(input: { readonly draftId: string; readonly publisher: PolicyActor; readonly publishedAt: string }): SignedPolicyBundle {
    const draft = this.draft(input.draftId); assertHumanRole(input.publisher, "policy-publisher"); assertSameOrganization(draft.submission.organizationId, input.publisher.organizationId); requireTime(input.publishedAt, "publishedAt"); if (input.publisher.principalId === draft.submission.createdBy.principalId) throw new PolicyRegistryError("Policy author cannot publish their own draft.");
    const approvals = draft.reviews.filter((review) => review.decision === "approved" && review.reviewedBy.principalId !== draft.submission.createdBy.principalId); if (!approvals.length) throw new PolicyRegistryError("A separate human approval is required before publication.");
    this.#publicationGate?.assertCanPublish({ draftId: draft.submission.draftId, policy: draft.submission.policy });
    const existing = this.#published.get(key(draft.submission.organizationId, draft.submission.policy.policyVersion)); if (existing) { if (existing.draftDigest !== draft.digest) throw new PolicyRegistryError("Published policy version is immutable."); return existing; }
    const base = { policy: draft.submission.policy, policyDigest: policyBundleDigest(draft.submission.policy), sourceDraftDigest: draft.submission.sourceDraftDigest, draftDigest: draft.digest, publishedAt: input.publishedAt, publishedByPrincipalId: input.publisher.principalId, signerKeyId: this.#signerKeyId };
    const signature = sign(null, Buffer.from(canonical(base)), this.#privateKey).toString("base64"); const bundle = frozen({ ...base, signature, bundleDigest: sha256Digest({ ...base, signature } as unknown as CanonicalValue) });
    this.#published.set(key(bundle.policy.organizationId, bundle.policy.policyVersion), bundle); this.event("PUBLISHED", bundle.policy.organizationId, bundle.policy.policyVersion, input.publishedAt, input.publisher.principalId, bundle.bundleDigest); this.activate(bundle.policy.organizationId, bundle.policy.policyVersion, input.publishedAt, input.publisher.principalId); return bundle;
  }

  revoke(input: { readonly organizationId: string; readonly policyVersion: string; readonly reason: string; readonly actor: PolicyActor; readonly revokedAt: string }): void {
    requireId(input.organizationId, "organizationId", "org_"); requireId(input.policyVersion, "policyVersion", "policy_"); assertHumanRole(input.actor, "policy-publisher"); assertSameOrganization(input.organizationId, input.actor.organizationId); requireTime(input.revokedAt, "revokedAt"); if (typeof input.reason !== "string" || input.reason.length < 3 || input.reason.length > 500) throw new PolicyRegistryError("Revocation reason is invalid.");
    if (!this.#published.has(key(input.organizationId, input.policyVersion))) throw new PolicyRegistryError("Published policy was not found."); if (this.#revoked.has(key(input.organizationId, input.policyVersion))) return;
    this.#revoked.set(key(input.organizationId, input.policyVersion), frozen({ revokedAt: input.revokedAt, revokedByPrincipalId: input.actor.principalId, reason: input.reason })); this.event("REVOKED", input.organizationId, input.policyVersion, input.revokedAt, input.actor.principalId, sha256Digest({ reason: input.reason } as CanonicalValue));
  }

  rollback(input: { readonly organizationId: string; readonly policyVersion: string; readonly actor: PolicyActor; readonly activatedAt: string }): SignedPolicyBundle {
    requireId(input.organizationId, "organizationId", "org_"); requireId(input.policyVersion, "policyVersion", "policy_"); assertHumanRole(input.actor, "policy-publisher"); assertSameOrganization(input.organizationId, input.actor.organizationId); requireTime(input.activatedAt, "activatedAt"); const bundle = this.published(input.organizationId, input.policyVersion); if (this.#revoked.has(key(input.organizationId, input.policyVersion))) throw new PolicyRegistryError("A revoked policy cannot be reactivated."); this.activate(input.organizationId, input.policyVersion, input.activatedAt, input.actor.principalId); return bundle;
  }

  published(organizationId: string, policyVersion: string): SignedPolicyBundle { const bundle = this.#published.get(key(organizationId, policyVersion)); if (!bundle) throw new PolicyRegistryError("Published policy was not found."); return bundle; }
  active(organizationId: string, at: string): SignedPolicyBundle { requireId(organizationId, "organizationId", "org_"); requireTime(at, "at"); const activation = [...(this.#activations.get(organizationId) ?? [])].filter((value) => Date.parse(value.activatedAt) <= Date.parse(at)).sort((left, right) => right.activatedAt.localeCompare(left.activatedAt))[0]; if (!activation) throw new PolicyRegistryError("No active policy is available."); const bundle = this.published(organizationId, activation.policyVersion); if (this.#revoked.has(key(organizationId, bundle.policy.policyVersion))) throw new PolicyRegistryError("Active policy has been revoked."); if (Date.parse(at) < Date.parse(bundle.policy.effectiveFrom) || (bundle.policy.effectiveUntil && Date.parse(at) >= Date.parse(bundle.policy.effectiveUntil))) throw new PolicyRegistryError("Active policy is not effective at the requested time."); return bundle; }
  verify(bundle: SignedPolicyBundle): boolean { const { signature, bundleDigest, ...base } = bundle; return bundleDigest === sha256Digest({ ...base, signature } as unknown as CanonicalValue) && verify(null, Buffer.from(canonical(base)), this.#publicKey, Buffer.from(signature, "base64")); }
  events(): readonly PolicyRegistryEvent[] { return frozen([...this.#events]); }

  private draft(draftId: string): DraftRecord { requireId(draftId, "draftId", "pdr_"); const draft = this.#drafts.get(draftId); if (!draft) throw new PolicyRegistryError("Policy draft was not found."); return draft; }
  private activate(organizationId: string, policyVersion: string, activatedAt: string, actorPrincipalId: string): void { const activation = frozen({ policyVersion, activatedAt, activatedByPrincipalId: actorPrincipalId }); const history = this.#activations.get(organizationId) ?? []; this.#activations.set(organizationId, [...history, activation]); this.event("ACTIVATED", organizationId, policyVersion, activatedAt, actorPrincipalId, sha256Digest(activation as unknown as CanonicalValue)); }
  private event(eventType: PolicyRegistryEvent["eventType"], organizationId: string, policyVersion: string, occurredAt: string, actorPrincipalId: string, valueDigest: string): void { const previousEventDigest = this.#events.at(-1)?.eventDigest ?? `sha256:${"0".repeat(64)}`; const base = { eventId: `pre_${String(this.#events.length + 1).padStart(10, "0")}`, eventType, organizationId, policyVersion, occurredAt, actorPrincipalId, valueDigest, previousEventDigest }; this.#events.push(frozen({ ...base, eventDigest: sha256Digest(base as unknown as CanonicalValue) })); }
}

export class PolicyRegistryError extends Error { constructor(message: string) { super(message); this.name = "PolicyRegistryError"; } }

function parseSubmission(input: PolicyDraftSubmission): PolicyDraftSubmission { requireId(input.draftId, "draftId", "pdr_"); requireId(input.organizationId, "organizationId", "org_"); requireDigest(input.sourceDraftDigest, "sourceDraftDigest"); requireTime(input.createdAt, "createdAt"); const policy = parsePolicyBundle(input.policy); if (policy.organizationId !== input.organizationId) throw new PolicyRegistryError("Policy draft organization does not match the policy bundle."); return frozen({ ...input, policy, createdBy: freezeActor(input.createdBy) }); }
function digestDraft(value: PolicyDraftSubmission): string { return sha256Digest({ draftId: value.draftId, organizationId: value.organizationId, sourceDraftDigest: value.sourceDraftDigest, policy: value.policy, createdByPrincipalId: value.createdBy.principalId, createdAt: value.createdAt } as unknown as CanonicalValue); }
function assertHumanRole(actor: PolicyActor, role: string): void { const safe = freezeActor(actor); if (safe.kind !== "human" || !safe.roles.includes(role)) throw new PolicyRegistryError("This policy action requires an authorized human operator."); }
function freezeActor(value: PolicyActor): PolicyActor { requireId(value.principalId, "principalId", "principal_"); requireId(value.organizationId, "organizationId", "org_"); if (value.kind !== "human" && value.kind !== "agent" && value.kind !== "service") throw new PolicyRegistryError("Policy actor kind is invalid."); if (!Array.isArray(value.roles) || value.roles.some((role) => typeof role !== "string" || !/^[a-z][a-z0-9-]{1,79}$/.test(role))) throw new PolicyRegistryError("Policy actor roles are invalid."); return frozen({ principalId: value.principalId, organizationId: value.organizationId, kind: value.kind, roles: frozen([...value.roles]) }); }
function assertSameOrganization(expected: string, actual: string): void { if (expected !== actual) throw new PolicyRegistryError("Policy action crosses organization boundaries."); }
function key(organizationId: string, policyVersion: string): string { return `${organizationId}:${policyVersion}`; }
function canonical(value: unknown): string { return JSON.stringify(value); }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new PolicyRegistryError(`${name} is invalid.`); }
function requireDigest(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new PolicyRegistryError(`${name} is invalid.`); }
function requireTime(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new PolicyRegistryError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
