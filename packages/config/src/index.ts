import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const ENVIRONMENT_NAMES = ["local", "test", "staging", "production"] as const;
export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

export interface EnvironmentConfig {
  readonly environment: EnvironmentName;
  readonly environmentId: string;
  readonly mode: "development" | "test" | "staging" | "production";
  readonly identity: {
    readonly issuer: string;
    readonly apiAudience: string;
    readonly serviceNamespace: string;
  };
  readonly ledger: {
    readonly network: "standalone" | "devnet" | "testnet" | "mainnet";
    readonly rpcUrlEnv: string;
    readonly treasuryAccountEnv: string;
  };
  readonly signing: {
    readonly executorKeyRefEnv: string;
    readonly policyKeyRefEnv: string;
  };
  readonly storage: {
    readonly databaseUrlEnv: string;
    readonly objectStoreUrlEnv: string;
  };
}

export async function loadEnvironmentConfig(
  environment: EnvironmentName,
  workspaceRoot = process.cwd(),
): Promise<EnvironmentConfig> {
  if (!ENVIRONMENT_NAMES.includes(environment)) {
    throw new TypeError(`Unsupported Alloc-X environment: ${environment}`);
  }

  const file = resolve(workspaceRoot, "infra", "environments", `${environment}.json`);
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  return validateEnvironmentConfig(parsed, environment);
}

export function validateEnvironmentConfig(
  input: unknown,
  expectedEnvironment?: EnvironmentName,
): EnvironmentConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Environment configuration must be an object.");
  }

  const value = input as Record<string, unknown>;
  const serialized = JSON.stringify(value);
  const environment = value.environment;
  if (typeof environment !== "string" || !ENVIRONMENT_NAMES.includes(environment as EnvironmentName)) {
    throw new TypeError("Environment configuration has an unsupported environment name.");
  }
  if (expectedEnvironment && environment !== expectedEnvironment) {
    throw new TypeError(`Expected ${expectedEnvironment} configuration, received ${environment}.`);
  }
  if (/-----BEGIN|\b(?:secret|password|privateKey)\b["']?\s*:/i.test(serialized)) {
    throw new TypeError("Environment configuration must contain references, never secret values.");
  }

  for (const path of REQUIRED_STRING_PATHS) {
    const field = getPath(value, path);
    if (typeof field !== "string" || field.length === 0) {
      throw new TypeError(`Environment configuration requires ${path}.`);
    }
  }

  const config = value as unknown as EnvironmentConfig;
  for (const envReference of [
    config.ledger.rpcUrlEnv,
    config.ledger.treasuryAccountEnv,
    config.signing.executorKeyRefEnv,
    config.signing.policyKeyRefEnv,
    config.storage.databaseUrlEnv,
    config.storage.objectStoreUrlEnv,
  ]) {
    if (!/^ALLOC_X_[A-Z0-9_]+$/.test(envReference)) {
      throw new TypeError(`Invalid environment-variable reference: ${envReference}`);
    }
  }

  if (environment === "production" && config.ledger.network !== "mainnet") {
    throw new TypeError("Production configuration must explicitly target mainnet.");
  }
  if (environment !== "production" && config.ledger.network === "mainnet") {
    throw new TypeError("Non-production configuration cannot target mainnet.");
  }

  return Object.freeze(config);
}

const REQUIRED_STRING_PATHS = [
  "environmentId",
  "mode",
  "identity.issuer",
  "identity.apiAudience",
  "identity.serviceNamespace",
  "ledger.network",
  "ledger.rpcUrlEnv",
  "ledger.treasuryAccountEnv",
  "signing.executorKeyRefEnv",
  "signing.policyKeyRefEnv",
  "storage.databaseUrlEnv",
  "storage.objectStoreUrlEnv",
] as const;

function getPath(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}
