import { createHash } from "node:crypto";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue): string {
  return JSON.stringify(sortCanonicalValue(value));
}

export function sha256Digest(value: CanonicalValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function sortCanonicalValue(value: CanonicalValue): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers.");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortCanonicalValue(item));
  }

  const record = value as Readonly<Record<string, CanonicalValue>>;
  const sorted: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) {
      throw new TypeError(`Canonical JSON does not support undefined at ${key}.`);
    }
    sorted[key] = sortCanonicalValue(item);
  }
  return sorted;
}
