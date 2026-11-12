import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

import {
  ENVIRONMENT_NAMES,
  loadEnvironmentConfig,
} from "../../packages/config/src/index.ts";
import {
  pathExists,
  readWorkspaceFile,
  WORKSPACE_ROOT,
  workspaceFiles,
} from "../lib/workspace.mjs";

const failures = [];
const requiredPaths = [
  ".editorconfig",
  ".env.example",
  ".gitignore",
  "tsconfig.json",
  "apps/README.md",
  "packages/README.md",
  "services/README.md",
  "packages/config/package.json",
  "packages/contracts/package.json",
  "packages/authorization/package.json",
  "packages/policy-engine/package.json",
  "tests/README.md",
  "tests/integration/environment-boundaries.test.ts",
  "tests/integration/security-boundary.test.ts",
  "infra/schemas/environment.schema.json",
];

for (const path of requiredPaths) {
  if (!(await pathExists(resolve(WORKSPACE_ROOT, path)))) failures.push(`Missing required path: ${path}`);
}

const packageFiles = (await workspaceFiles({ extensions: [".json"] })).filter(
  (file) => basename(file) === "package.json",
);
const packageNames = new Set();
for (const file of packageFiles) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    failures.push(`${relative(WORKSPACE_ROOT, file)}: package name is required`);
  } else if (packageNames.has(parsed.name)) {
    failures.push(`${relative(WORKSPACE_ROOT, file)}: duplicate package name ${parsed.name}`);
  } else {
    packageNames.add(parsed.name);
  }
  if (parsed.private !== true) failures.push(`${relative(WORKSPACE_ROOT, file)}: package must be private`);
}

const rootPackage = JSON.parse(await readFile(resolve(WORKSPACE_ROOT, "package.json"), "utf8"));
for (const command of [
  "check",
  "workspace:validate",
  "security:scan",
  "format:check",
  "lint",
  "test:unit",
  "test:integration",
]) {
  if (typeof rootPackage.scripts?.[command] !== "string") failures.push(`Missing package script: ${command}`);
}

const environments = [];
for (const name of ENVIRONMENT_NAMES) {
  try {
    environments.push(await loadEnvironmentConfig(name, WORKSPACE_ROOT));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : `Unable to load ${name} environment`);
  }
}

const localEnvironment = environments.find((environment) => environment.environment === "local");
if (localEnvironment) {
  const exampleSource = await readFile(resolve(WORKSPACE_ROOT, ".env.example"), "utf8");
  const exampleNames = new Set(
    exampleSource
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("=", 1)[0]),
  );
  for (const reference of [
    localEnvironment.ledger.rpcUrlEnv,
    localEnvironment.ledger.treasuryAccountEnv,
    localEnvironment.signing.executorKeyRefEnv,
    localEnvironment.signing.policyKeyRefEnv,
    localEnvironment.storage.databaseUrlEnv,
    localEnvironment.storage.objectStoreUrlEnv,
  ]) {
    if (!exampleNames.has(reference)) failures.push(`.env.example is missing local reference: ${reference}`);
  }
}

for (const field of [
  "environmentId",
  "identity.issuer",
  "identity.apiAudience",
  "identity.serviceNamespace",
  "ledger.treasuryAccountEnv",
  "signing.executorKeyRefEnv",
  "signing.policyKeyRefEnv",
]) {
  const values = environments.map((environment) => getPath(environment, field));
  if (new Set(values).size !== environments.length) failures.push(`Environment boundary is not unique: ${field}`);
}

const prohibitedProductTerm = ["hack", "athon"].join("");
for (const file of await workspaceFiles()) {
  const display = relative(WORKSPACE_ROOT, file);
  if (display.toLowerCase().includes(prohibitedProductTerm)) {
    failures.push(`Prohibited product-positioning term found in path: ${display}`);
  }
  const name = basename(file).toLowerCase();
  if ([".json", ".md", ".ts", ".mjs", ".example"].some((suffix) => name.endsWith(suffix))) {
    const source = await readWorkspaceFile(file);
    if (source.toLowerCase().includes(prohibitedProductTerm)) {
      failures.push(`Prohibited product-positioning term found in file: ${display}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Workspace validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Workspace validation passed for ${packageFiles.length} packages and ${environments.length} environments.`);

function getPath(value, path) {
  return path.split(".").reduce((current, segment) => current?.[segment], value);
}
