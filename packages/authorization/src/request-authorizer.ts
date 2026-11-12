import type { Principal } from "../../contracts/src/index.ts";
import {
  authenticate,
  type AuthenticationProvider,
} from "./authentication.ts";
import {
  authorize,
  type AuthorizationDecision,
  type AuthorizationTarget,
  type TreasuryAction,
} from "./authorization.ts";

export interface PrincipalDirectory {
  findByIdentity(input: {
    readonly subjectId: string;
    readonly organizationId: string;
  }): Promise<Principal | undefined>;
}

export interface ServerAuthorizationInput {
  readonly rawCredentials: unknown;
  readonly action: TreasuryAction;
  readonly target: AuthorizationTarget;
  readonly evaluatedAt: string;
}

export function createServerAuthorizer(
  provider: AuthenticationProvider,
  principals: PrincipalDirectory,
): (input: ServerAuthorizationInput) => Promise<AuthorizationDecision> {
  return async (input) => {
    const identity = await authenticate(provider, input.rawCredentials);
    const principal = await principals.findByIdentity({
      subjectId: identity.subjectId,
      organizationId: identity.organizationId,
    });
    if (!principal) {
      return Object.freeze({
        allowed: false,
        action: input.action,
        principalId: identity.subjectId,
        organizationId: input.target.organizationId,
        evaluatedAt: input.evaluatedAt,
        reasonCode: "PRINCIPAL_IDENTITY_MISMATCH" as const,
      });
    }
    return authorize({ identity, principal, action: input.action, target: input.target, evaluatedAt: input.evaluatedAt });
  };
}
