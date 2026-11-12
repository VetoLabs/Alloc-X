import {
  ContractValidationError,
  type Principal,
} from "../../contracts/src/index.ts";
import {
  assertRecentStepUpAuthentication,
  isVerifiedAuthentication,
  type VerifiedAuthentication,
} from "./authentication.ts";

export const TREASURY_ACTIONS = [
  "obligation:create",
  "payment-intent:create",
  "payment-intent:approve",
  "beneficiary:request-change",
  "beneficiary:approve-change",
  "policy:draft",
  "policy:publish",
  "policy:change-limits",
  "security:freeze",
  "security:unfreeze",
  "security:evaluate",
  "payment:submit",
  "ledger:reconcile",
  "audit:read",
] as const;

export type TreasuryAction = (typeof TREASURY_ACTIONS)[number];

export function isTreasuryAction(value: unknown): value is TreasuryAction {
  return typeof value === "string" && TREASURY_ACTIONS.includes(value as TreasuryAction);
}

export type AuthorizationReasonCode =
  | "IDENTITY_UNVERIFIED"
  | "PRINCIPAL_IDENTITY_MISMATCH"
  | "TENANT_MISMATCH"
  | "PRINCIPAL_INACTIVE"
  | "ACTOR_KIND_NOT_ALLOWED"
  | "ROLE_MISSING"
  | "STEP_UP_REQUIRED"
  | "SEGREGATION_OF_DUTIES";

export interface AuthorizationTarget {
  readonly organizationId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly initiatedByPrincipalId?: string;
  readonly draftedByPrincipalId?: string;
  readonly beneficiaryChangeRequestedByPrincipalId?: string;
  readonly freezeAppliedByPrincipalId?: string;
}

export interface AuthorizationRequest {
  readonly identity: unknown;
  readonly principal: Principal;
  readonly action: TreasuryAction;
  readonly target: AuthorizationTarget;
  readonly evaluatedAt: string;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly action: TreasuryAction;
  readonly principalId: string;
  readonly organizationId: string;
  readonly evaluatedAt: string;
  readonly reasonCode?: AuthorizationReasonCode;
}

interface ActionPolicy {
  readonly roles: readonly string[];
  readonly actorKinds: readonly Principal["kind"][];
  readonly requiresStepUp: boolean;
  readonly requiresDifferentPrincipalFrom?: keyof AuthorizationTarget;
}

const ACTION_POLICIES: Readonly<Record<TreasuryAction, ActionPolicy>> = {
  "obligation:create": {
    roles: ["treasury-operator"],
    actorKinds: ["human"],
    requiresStepUp: false,
  },
  "payment-intent:create": {
    roles: ["treasury-operator", "allocation-agent"],
    actorKinds: ["human", "agent"],
    requiresStepUp: false,
  },
  "payment-intent:approve": {
    roles: ["finance-approver"],
    actorKinds: ["human"],
    requiresStepUp: true,
    requiresDifferentPrincipalFrom: "initiatedByPrincipalId",
  },
  "beneficiary:request-change": {
    roles: ["beneficiary-admin"],
    actorKinds: ["human"],
    requiresStepUp: true,
  },
  "beneficiary:approve-change": {
    roles: ["beneficiary-approver"],
    actorKinds: ["human"],
    requiresStepUp: true,
    requiresDifferentPrincipalFrom: "beneficiaryChangeRequestedByPrincipalId",
  },
  "policy:draft": {
    roles: ["policy-author"],
    actorKinds: ["human"],
    requiresStepUp: false,
  },
  "policy:publish": {
    roles: ["policy-publisher"],
    actorKinds: ["human"],
    requiresStepUp: true,
    requiresDifferentPrincipalFrom: "draftedByPrincipalId",
  },
  "policy:change-limits": {
    roles: ["policy-publisher"],
    actorKinds: ["human"],
    requiresStepUp: true,
    requiresDifferentPrincipalFrom: "draftedByPrincipalId",
  },
  "security:freeze": {
    roles: ["security-officer", "treasury-officer"],
    actorKinds: ["human"],
    requiresStepUp: true,
  },
  "security:unfreeze": {
    roles: ["security-officer"],
    actorKinds: ["human"],
    requiresStepUp: true,
    requiresDifferentPrincipalFrom: "freezeAppliedByPrincipalId",
  },
  "security:evaluate": {
    roles: ["approval-layer-service"],
    actorKinds: ["service"],
    requiresStepUp: false,
  },
  "payment:submit": {
    roles: ["payment-worker-service"],
    actorKinds: ["service"],
    requiresStepUp: false,
  },
  "ledger:reconcile": {
    roles: ["ledger-monitor-service"],
    actorKinds: ["service"],
    requiresStepUp: false,
  },
  "audit:read": {
    roles: ["auditor", "security-officer", "treasury-officer"],
    actorKinds: ["human"],
    requiresStepUp: false,
  },
};

export function authorize(request: AuthorizationRequest): AuthorizationDecision {
  if (!isTreasuryAction(request.action)) {
    return deny(request, "ROLE_MISSING");
  }
  const policy = ACTION_POLICIES[request.action];
  const identity = request.identity;
  if (!isVerifiedAuthentication(identity)) {
    return deny(request, "IDENTITY_UNVERIFIED");
  }
  if (!sameIdentity(identity, request.principal)) {
    return deny(request, "PRINCIPAL_IDENTITY_MISMATCH");
  }
  if (
    request.principal.organizationId !== request.target.organizationId ||
    identity.organizationId !== request.target.organizationId
  ) {
    return deny(request, "TENANT_MISMATCH");
  }
  if (request.principal.status !== "active") return deny(request, "PRINCIPAL_INACTIVE");
  if (!policy.actorKinds.includes(request.principal.kind)) return deny(request, "ACTOR_KIND_NOT_ALLOWED");
  if (!policy.roles.some((role) => request.principal.roles.includes(role))) return deny(request, "ROLE_MISSING");

  if (policy.requiresStepUp) {
    try {
      assertRecentStepUpAuthentication(identity, request.evaluatedAt);
    } catch (error) {
      if (error instanceof ContractValidationError) return deny(request, "STEP_UP_REQUIRED");
      throw error;
    }
  }

  const differentFrom = policy.requiresDifferentPrincipalFrom;
  if (differentFrom) {
    const otherPrincipalId = request.target[differentFrom];
    if (!otherPrincipalId || otherPrincipalId === request.principal.principalId) {
      return deny(request, "SEGREGATION_OF_DUTIES");
    }
  }

  return Object.freeze({
    allowed: true,
    action: request.action,
    principalId: request.principal.principalId,
    organizationId: request.target.organizationId,
    evaluatedAt: request.evaluatedAt,
  });
}

export function assertAuthorized(request: AuthorizationRequest): AuthorizationDecision {
  const decision = authorize(request);
  if (!decision.allowed) {
    throw new ContractValidationError([`authorization denied: ${decision.reasonCode}`]);
  }
  return decision;
}

function sameIdentity(identity: VerifiedAuthentication, principal: Principal): boolean {
  return (
    identity.subjectId === principal.principalId &&
    identity.organizationId === principal.organizationId &&
    identity.subjectKind === principal.kind
  );
}

function deny(request: AuthorizationRequest, reasonCode: AuthorizationReasonCode): AuthorizationDecision {
  return Object.freeze({
    allowed: false,
    action: request.action,
    principalId: request.principal.principalId,
    organizationId: request.target.organizationId,
    evaluatedAt: request.evaluatedAt,
    reasonCode,
  });
}
