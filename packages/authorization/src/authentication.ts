import {
  ContractValidationError,
  asRecord,
  deepFreeze,
  readBoundedString,
  readEnum,
  readIdentifier,
  readStringArray,
  readTimestamp,
  rejectUnknownKeys,
  throwIfIssues,
} from "../../contracts/src/index.ts";

export const AUTHENTICATION_METHODS = [
  "password",
  "webauthn",
  "totp",
  "service-mtls",
  "service-oidc",
] as const;

export type AuthenticationMethod = (typeof AUTHENTICATION_METHODS)[number];
export type AssertionSubjectKind = "human" | "service" | "agent";

export interface AuthenticationAssertion {
  readonly issuer: string;
  readonly audience: string;
  readonly subjectId: string;
  readonly organizationId: string;
  readonly subjectKind: AssertionSubjectKind;
  readonly sessionId: string;
  readonly authenticatedAt: string;
  readonly methods: readonly AuthenticationMethod[];
}

export interface AuthenticationProvider {
  readonly issuer: string;
  verify(rawCredentials: unknown): Promise<AuthenticationAssertion>;
}

const VERIFIED_ASSERTION = Symbol("alloc-x.verified-authentication-assertion");

export interface VerifiedAuthentication extends AuthenticationAssertion {
  readonly [VERIFIED_ASSERTION]: true;
}

const ASSERTION_KEYS = new Set([
  "issuer",
  "audience",
  "subjectId",
  "organizationId",
  "subjectKind",
  "sessionId",
  "authenticatedAt",
  "methods",
]);

export function parseAuthenticationAssertion(input: unknown): AuthenticationAssertion {
  const issues: string[] = [];
  const value = asRecord(input, "authenticationAssertion", issues);
  rejectUnknownKeys(value, ASSERTION_KEYS, "authenticationAssertion", issues);
  const rawMethods = readStringArray(value.methods, "methods", 5, issues);
  if (rawMethods.length === 0) issues.push("methods must contain at least one authentication method");
  const methods: AuthenticationMethod[] = [];
  for (const method of rawMethods) {
    if (!AUTHENTICATION_METHODS.includes(method as AuthenticationMethod)) {
      issues.push(`methods contains unsupported value: ${method}`);
    } else {
      methods.push(method as AuthenticationMethod);
    }
  }
  const result: AuthenticationAssertion = {
    issuer: readBoundedString(value.issuer, "issuer", 1, 240, issues),
    audience: readBoundedString(value.audience, "audience", 1, 240, issues),
    subjectId: readIdentifier(value.subjectId, "subjectId", "principal_", issues),
    organizationId: readIdentifier(value.organizationId, "organizationId", "org_", issues),
    subjectKind: readEnum(value.subjectKind, "subjectKind", ["human", "service", "agent"] as const, issues),
    sessionId: readBoundedString(value.sessionId, "sessionId", 16, 200, issues),
    authenticatedAt: readTimestamp(value.authenticatedAt, "authenticatedAt", issues),
    methods,
  };
  throwIfIssues(issues);
  return deepFreeze(result);
}

export async function authenticate(
  provider: AuthenticationProvider,
  rawCredentials: unknown,
): Promise<VerifiedAuthentication> {
  const assertion = parseAuthenticationAssertion(await provider.verify(rawCredentials));
  if (assertion.issuer !== provider.issuer) {
    throw new ContractValidationError(["verified assertion issuer does not match authentication provider"]);
  }
  return deepFreeze({ ...assertion, [VERIFIED_ASSERTION]: true }) as VerifiedAuthentication;
}

export function isVerifiedAuthentication(value: unknown): value is VerifiedAuthentication {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Partial<VerifiedAuthentication>)[VERIFIED_ASSERTION] === true
  );
}

export function assertRecentStepUpAuthentication(
  identity: VerifiedAuthentication,
  evaluatedAt: string,
  maxAgeSeconds = 900,
): void {
  const now = Date.parse(evaluatedAt);
  const authenticatedAt = Date.parse(identity.authenticatedAt);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== evaluatedAt) {
    throw new ContractValidationError(["evaluatedAt must be a canonical UTC RFC3339 timestamp"]);
  }
  if (authenticatedAt > now || now - authenticatedAt > maxAgeSeconds * 1000) {
    throw new ContractValidationError(["step-up authentication is stale"]);
  }
  if (!identity.methods.some((method) => method === "webauthn" || method === "totp")) {
    throw new ContractValidationError(["step-up authentication requires webauthn or totp"]);
  }
}
