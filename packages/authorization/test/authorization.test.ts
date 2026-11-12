import assert from "node:assert/strict";
import test from "node:test";

import { parsePrincipal } from "../../contracts/src/index.ts";
import {
  authenticate,
  authorize,
  createServerAuthorizer,
  TREASURY_ACTIONS,
  type AuthenticationProvider,
} from "../src/index.ts";

const EVALUATED_AT = "2026-11-07T12:00:00.000Z";

function principal(overrides: Record<string, unknown> = {}) {
  return parsePrincipal({
    contractVersion: "1.0",
    principalId: "principal_finance_1",
    organizationId: "org_acme",
    kind: "human",
    status: "active",
    roles: ["finance-approver"],
    createdAt: "2026-11-07T08:00:00.000Z",
    ...overrides,
  });
}

function provider(overrides: Record<string, unknown> = {}): AuthenticationProvider {
  return {
    issuer: "alloc-x-test-identity",
    async verify() {
      return {
        issuer: "alloc-x-test-identity",
        audience: "alloc-x-test-api",
        subjectId: "principal_finance_1",
        organizationId: "org_acme",
        subjectKind: "human",
        sessionId: "session_0123456789abcdef",
        authenticatedAt: "2026-11-07T11:55:00.000Z",
        methods: ["password", "webauthn"],
        ...overrides,
      };
    },
  };
}

const approvalTarget = {
  organizationId: "org_acme",
  resourceType: "payment-intent",
  resourceId: "pi_001",
  initiatedByPrincipalId: "principal_treasury_1",
};

test("denies raw, unverified authentication assertions", () => {
  const decision = authorize({
    identity: {
      issuer: "alloc-x-test-identity",
      subjectId: "principal_finance_1",
      organizationId: "org_acme",
    },
    principal: principal(),
    action: "payment-intent:approve",
    target: approvalTarget,
    evaluatedAt: EVALUATED_AT,
  });
  assert.deepEqual(decision.reasonCode, "IDENTITY_UNVERIFIED");
});

test("allows a fresh step-up finance approver from the same organization", async () => {
  const identity = await authenticate(provider(), {});
  const decision = authorize({
    identity,
    principal: principal(),
    action: "payment-intent:approve",
    target: approvalTarget,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(decision.allowed, true);
});

test("rejects cross-organization access before role evaluation", async () => {
  const identity = await authenticate(provider({ organizationId: "org_other" }), {});
  const decision = authorize({
    identity,
    principal: principal(),
    action: "payment-intent:approve",
    target: approvalTarget,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "PRINCIPAL_IDENTITY_MISMATCH");
});

test("rejects cross-organization resource reads and writes", async () => {
  const identity = await authenticate(provider(), {});
  const decision = authorize({
    identity,
    principal: principal({ roles: ["auditor"] }),
    action: "audit:read",
    target: { organizationId: "org_other", resourceType: "receipt", resourceId: "receipt_001" },
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "TENANT_MISMATCH");
});

test("rejects an initiator approving their own high-risk payment", async () => {
  const identity = await authenticate(provider(), {});
  const decision = authorize({
    identity,
    principal: principal(),
    action: "payment-intent:approve",
    target: { ...approvalTarget, initiatedByPrincipalId: "principal_finance_1" },
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "SEGREGATION_OF_DUTIES");
});

test("requires recent MFA for beneficiary and policy changes", async () => {
  const noMfa = await authenticate(provider({ methods: ["password"] }), {});
  const beneficiaryAdmin = principal({ roles: ["beneficiary-admin"] });
  const decision = authorize({
    identity: noMfa,
    principal: beneficiaryAdmin,
    action: "beneficiary:request-change",
    target: { organizationId: "org_acme", resourceType: "beneficiary", resourceId: "ben_001" },
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(decision.reasonCode, "STEP_UP_REQUIRED");

  const stale = await authenticate(provider({ authenticatedAt: "2026-11-07T11:00:00.000Z" }), {});
  const policyPublisher = principal({ roles: ["policy-publisher"] });
  const staleDecision = authorize({
    identity: stale,
    principal: policyPublisher,
    action: "policy:publish",
    target: {
      organizationId: "org_acme",
      resourceType: "policy",
      resourceId: "policy_001",
      draftedByPrincipalId: "principal_policy_author",
    },
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(staleDecision.reasonCode, "STEP_UP_REQUIRED");
});

test("prevents an allocation agent from submitting a payment", async () => {
  const agent = principal({
    principalId: "principal_alloc_agent",
    kind: "agent",
    roles: ["allocation-agent"],
  });
  const identity = await authenticate(provider({ subjectId: "principal_alloc_agent", subjectKind: "agent" }), {});
  const decision = authorize({
    identity,
    principal: agent,
    action: "payment:submit",
    target: { organizationId: "org_acme", resourceType: "payment", resourceId: "pi_001" },
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(decision.reasonCode, "ACTOR_KIND_NOT_ALLOWED");
});

test("allows only the dedicated service identity to evaluate security", async () => {
  const service = principal({
    principalId: "principal_approval-layer_service",
    kind: "service",
    roles: ["approval-layer-service"],
  });
  const identity = await authenticate(
    provider({
      subjectId: "principal_approval-layer_service",
      subjectKind: "service",
      methods: ["service-mtls"],
    }),
    {},
  );
  const decision = authorize({
    identity,
    principal: service,
    action: "security:evaluate",
    target: { organizationId: "org_acme", resourceType: "payment-intent", resourceId: "pi_001" },
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(decision.allowed, true);
});

test("binds provider verification, principal lookup, and authorization on the server", async () => {
  const authorizer = createServerAuthorizer(provider(), {
    async findByIdentity() {
      return principal();
    },
  });
  const decision = await authorizer({
    rawCredentials: { opaque: "never parsed as authorization" },
    action: "payment-intent:approve",
    target: approvalTarget,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(decision.allowed, true);
});

test("protects every declared state-changing action from an unverified caller", () => {
  const actor = principal();
  for (const action of TREASURY_ACTIONS) {
    const decision = authorize({
      identity: {},
      principal: actor,
      action,
      target: {
        organizationId: "org_acme",
        resourceType: "test-resource",
        resourceId: "resource_001",
        initiatedByPrincipalId: "principal_other",
        draftedByPrincipalId: "principal_other",
        beneficiaryChangeRequestedByPrincipalId: "principal_other",
        freezeAppliedByPrincipalId: "principal_other",
      },
      evaluatedAt: EVALUATED_AT,
    });
    assert.equal(decision.allowed, false, `${action} must reject an unverified caller`);
    assert.equal(decision.reasonCode, "IDENTITY_UNVERIFIED");
  }
});
