const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,18}))?$/;

export interface DecimalValue {
  readonly coefficient: bigint;
  readonly scale: number;
}

export function parseDecimal(value: string): DecimalValue {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw new TypeError(
      "Money must be a non-negative base-10 string with at most 18 decimal places.",
    );
  }

  const [whole, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  const digits = `${whole}${normalizedFraction}`;

  return {
    coefficient: BigInt(digits || "0"),
    scale: normalizedFraction.length,
  };
}

export function normalizeDecimal(value: string): string {
  return formatDecimal(parseDecimal(value));
}

export function compareDecimal(left: string, right: string): number {
  const [alignedLeft, alignedRight] = align(parseDecimal(left), parseDecimal(right));
  if (alignedLeft > alignedRight) return 1;
  if (alignedLeft < alignedRight) return -1;
  return 0;
}

export function addDecimal(left: string, right: string): string {
  const leftValue = parseDecimal(left);
  const rightValue = parseDecimal(right);
  const scale = Math.max(leftValue.scale, rightValue.scale);
  const leftCoefficient = rescale(leftValue, scale);
  const rightCoefficient = rescale(rightValue, scale);

  return formatDecimal({ coefficient: leftCoefficient + rightCoefficient, scale });
}

export function subtractDecimal(left: string, right: string): string {
  const leftValue = parseDecimal(left);
  const rightValue = parseDecimal(right);
  const scale = Math.max(leftValue.scale, rightValue.scale);
  const coefficient = rescale(leftValue, scale) - rescale(rightValue, scale);

  if (coefficient < 0n) {
    throw new RangeError("Money subtraction cannot produce a negative value.");
  }

  return formatDecimal({ coefficient, scale });
}

export function isPositiveDecimal(value: string): boolean {
  return parseDecimal(value).coefficient > 0n;
}

function align(left: DecimalValue, right: DecimalValue): readonly [bigint, bigint] {
  const scale = Math.max(left.scale, right.scale);
  return [rescale(left, scale), rescale(right, scale)];
}

function rescale(value: DecimalValue, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

function formatDecimal(value: DecimalValue): string {
  if (value.scale === 0) return value.coefficient.toString();

  const padded = value.coefficient.toString().padStart(value.scale + 1, "0");
  const whole = padded.slice(0, -value.scale);
  const fraction = padded.slice(-value.scale).replace(/0+$/, "");

  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
