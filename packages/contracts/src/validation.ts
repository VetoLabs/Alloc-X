import { isPositiveDecimal, normalizeDecimal } from "./money.ts";

export const CONTRACT_VERSION = "1.0" as const;

export class ContractValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Contract validation failed: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export function asRecord(value: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  return value as Record<string, unknown>;
}

export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is not allowed`);
  }
}

export function readContractVersion(value: unknown, issues: string[]): typeof CONTRACT_VERSION {
  const version = readString(value, "contractVersion", issues);
  if (version !== CONTRACT_VERSION) issues.push(`contractVersion must be ${CONTRACT_VERSION}`);
  return CONTRACT_VERSION;
}

export function readString(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string") {
    issues.push(`${path} must be a string`);
    return "";
  }
  return value;
}

export function readBoundedString(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: string[],
): string {
  const result = readString(value, path, issues);
  if (result.length < minimum || result.length > maximum) {
    issues.push(`${path} must contain between ${minimum} and ${maximum} characters`);
  }
  return result;
}

export function readIdentifier(
  value: unknown,
  path: string,
  prefix: string,
  issues: string[],
): string {
  const result = readBoundedString(value, path, prefix.length + 1, 140, issues);
  if (!result.startsWith(prefix) || !/^[A-Za-z0-9_.:-]+$/.test(result)) {
    issues.push(`${path} must start with ${prefix} and contain safe identifier characters`);
  }
  return result;
}

export function readTimestamp(value: unknown, path: string, issues: string[]): string {
  const result = readString(value, path, issues);
  const timestamp = Date.parse(result);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== result) {
    issues.push(`${path} must be a canonical UTC RFC3339 timestamp`);
  }
  return result;
}

export function readDigest(value: unknown, path: string, issues: string[]): string {
  const result = readString(value, path, issues);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) {
    issues.push(`${path} must be a lowercase SHA-256 digest`);
  }
  return result;
}

export function readPositiveAmount(value: unknown, path: string, issues: string[]): string {
  const amount = readString(value, path, issues);
  try {
    const normalized = normalizeDecimal(amount);
    if (!isPositiveDecimal(normalized)) issues.push(`${path} must be greater than zero`);
    return normalized;
  } catch (error) {
    issues.push(error instanceof Error ? `${path}: ${error.message}` : `${path} is invalid`);
    return amount;
  }
}

export function readEnum<T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
  issues: string[],
): T[number] {
  const result = readString(value, path, issues);
  if (!values.includes(result)) {
    issues.push(`${path} must be one of: ${values.join(", ")}`);
  }
  return (values.includes(result) ? result : values[0]) as T[number];
}

export function readStringArray(
  value: unknown,
  path: string,
  maximumItems: number,
  issues: string[],
): readonly string[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  if (value.length > maximumItems) issues.push(`${path} must contain no more than ${maximumItems} items`);
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = readBoundedString(item, `${path}[${index}]`, 1, 100, issues);
    result.push(parsed);
  }
  if (new Set(result).size !== result.length) issues.push(`${path} must not contain duplicates`);
  return result;
}

export function readPositiveSafeInteger(value: unknown, path: string, issues: string[]): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    issues.push(`${path} must be a positive safe integer`);
    return 0;
  }
  return Number(value);
}

export function readOptionalDestinationTag(
  value: unknown,
  path: string,
  issues: string[],
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 4_294_967_295) {
    issues.push(`${path} must be an unsigned 32-bit integer`);
    return undefined;
  }
  return Number(value);
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function throwIfIssues(issues: readonly string[]): void {
  if (issues.length > 0) throw new ContractValidationError(issues);
}
