import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { PolicyRegistry, PolicyRegistryError, type PolicyActor } from "../src/index.ts";

const keys = generateKeyPairSync("ed25519");
const author: PolicyActor = { principalId: "principal_author", organizationId: "org_meridian", kind: "human", roles: ["policy-author", "policy-publisher"] };
const reviewer: PolicyActor = { principalId: "principal_reviewer", organizationId: "org_meridian", kind: "human", roles: ["policy-approver", "policy-publisher"] };
const agent: PolicyActor = { principalId: "principal_agent", organizationId: "org_meridian", kind: "agent", roles: ["policy-publisher"] };
const sourceDigest = `sha256:${"a".repeat(64)}`;
const createdAt = "2026-11-08T14:00:00.000Z";
function bundle(version = "policy_meridian_2026") { return { policyVersion: version, organizationId: "org_meridian", status: "published" as const, effectiveFrom: "2026-11-01T00:00:00.000Z", allowedPurposeCodes: ["clinic-supplies"], allowedAssets: ["XRP"], maxPaymentAmount: "5000", reserveFloor: "1000", requiredEvidenceByPurpose: { "clinic-supplies": ["invoice"] }, approvalRules: [], beneficiaryChangeCoolingPeriodHours: 24, velocity: { maxPaymentCount24Hours: 10, maxPaymentAmount24Hours: "10000" }, risk: { reviewAtScore: 60, denyAtScore: 85 }, decisionTtlSeconds: 300 }; }
function registry() { return new PolicyRegistry({ privateKey: keys.privateKey, publicKey: keys.publicKey, signerKeyId: "alloc-x-policy-2026" }); }
function draft(version = "policy_meridian_2026") { return { draftId: `pdr_${version.slice(7)}`, organizationId: "org_meridian", sourceDraftDigest: sourceDigest, policy: bundle(version), createdBy: author, createdAt }; }

test("publishes a separately reviewed immutable signed policy bundle", () => {
  const service = registry(); const submission = draft(); service.createDraft(submission); service.review({ draftId: submission.draftId, decision: "approved", comment: "Verified against cited mandate clauses.", reviewer, reviewedAt: "2026-11-08T14:05:00.000Z" });
  const published = service.publish({ draftId: submission.draftId, publisher: reviewer, publishedAt: "2026-11-08T14:10:00.000Z" });
  assert.equal(service.verify(published), true); assert.equal(service.active("org_meridian", "2026-11-08T14:10:00.000Z").policy.policyVersion, "policy_meridian_2026");
  assert.equal(service.verify({ ...published, policy: { ...published.policy, maxPaymentAmount: "6000" } }), false);
  assert.throws(() => service.createDraft({ ...submission, policy: { ...bundle("policy_meridian_2026"), maxPaymentAmount: "6000" } }), (error: unknown) => error instanceof PolicyRegistryError && /different content/.test(error.message));
  assert.throws(() => service.publish({ draftId: submission.draftId, publisher: author, publishedAt: "2026-11-08T14:11:00.000Z" }), /cannot publish/);
});

test("rejects agent publication and self-review", () => {
  const service = registry(); const submission = draft(); service.createDraft(submission);
  assert.throws(() => service.review({ draftId: submission.draftId, decision: "approved", comment: "self", reviewer: { ...author, roles: ["policy-approver"] }, reviewedAt: "2026-11-08T14:05:00.000Z" }), /cannot review/);
  assert.throws(() => service.publish({ draftId: submission.draftId, publisher: agent, publishedAt: "2026-11-08T14:10:00.000Z" }), /authorized human/);
});

test("enforces an attached simulation gate before publication", () => {
  const service = new PolicyRegistry({ privateKey: keys.privateKey, publicKey: keys.publicKey, signerKeyId: "alloc-x-policy-2026", publicationGate: { assertCanPublish: () => { throw new Error("Simulation gate rejected this version."); } } }); const submission = draft(); service.createDraft(submission); service.review({ draftId: submission.draftId, decision: "approved", comment: "approved", reviewer, reviewedAt: "2026-11-08T14:05:00.000Z" });
  assert.throws(() => service.publish({ draftId: submission.draftId, publisher: reviewer, publishedAt: "2026-11-08T14:10:00.000Z" }), /Simulation gate rejected/);
});

test("rolls back to an earlier immutable version and prevents reactivation after revocation", () => {
  const service = registry(); const first = draft("policy_meridian_2026a"); service.createDraft(first); service.review({ draftId: first.draftId, decision: "approved", comment: "approved", reviewer, reviewedAt: "2026-11-08T14:05:00.000Z" }); service.publish({ draftId: first.draftId, publisher: reviewer, publishedAt: "2026-11-08T14:10:00.000Z" });
  const second = draft("policy_meridian_2026b"); service.createDraft(second); service.review({ draftId: second.draftId, decision: "approved", comment: "approved", reviewer, reviewedAt: "2026-11-08T14:15:00.000Z" }); service.publish({ draftId: second.draftId, publisher: reviewer, publishedAt: "2026-11-08T14:20:00.000Z" });
  assert.equal(service.active("org_meridian", "2026-11-08T14:20:00.000Z").policy.policyVersion, "policy_meridian_2026b"); service.rollback({ organizationId: "org_meridian", policyVersion: "policy_meridian_2026a", actor: reviewer, activatedAt: "2026-11-08T14:25:00.000Z" });
  assert.equal(service.active("org_meridian", "2026-11-08T14:25:00.000Z").policy.policyVersion, "policy_meridian_2026a"); service.revoke({ organizationId: "org_meridian", policyVersion: "policy_meridian_2026a", reason: "Emergency withdrawal", actor: reviewer, revokedAt: "2026-11-08T14:30:00.000Z" });
  assert.throws(() => service.rollback({ organizationId: "org_meridian", policyVersion: "policy_meridian_2026a", actor: reviewer, activatedAt: "2026-11-08T14:35:00.000Z" }), /revoked/);
});
