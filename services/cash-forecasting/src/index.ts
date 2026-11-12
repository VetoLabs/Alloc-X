import { parseDecimal } from "../../../packages/contracts/src/index.ts";

export type ForecastScenario = "conservative" | "expected" | "optimistic";
export interface ForecastInflow { readonly inflowId: string; readonly amount: string; readonly expectedAt: string; readonly confidencePercent: number; readonly description: string; }
export interface ForecastObligation { readonly obligationId: string; readonly amount: string; readonly dueAt: string; readonly description: string; readonly category: "payroll" | "supplier" | "operations" | "other"; }
export interface CashForecastInput {
  readonly organizationId: string; readonly asset: string; readonly asOf: string; readonly sourceFreshAt: string; readonly treasuryAvailable: string;
  readonly reserveFloor: string; readonly payrollProtection: string; readonly horizonDays: number; readonly inflows: readonly ForecastInflow[]; readonly obligations: readonly ForecastObligation[];
  readonly observedAvailable?: string;
}
export interface ForecastPoint { readonly date: string; readonly projectedTreasury: string; readonly protectedAmount: string; readonly spendableAmount: string; }
export interface ScenarioForecast { readonly scenario: ForecastScenario; readonly endingTreasury: string; readonly endingSpendable: string; readonly firstProtectionBreachAt?: string; readonly points: readonly ForecastPoint[]; }
export interface CashForecast { readonly organizationId: string; readonly asset: string; readonly calculatedAt: string; readonly sourceFreshAt: string; readonly horizonEndsAt: string; readonly assumptions: readonly string[]; readonly protections: { readonly reserveFloor: string; readonly payrollProtection: string; readonly total: string }; readonly scenarios: readonly ScenarioForecast[]; readonly confidenceRange: { readonly lowerEndingSpendable: string; readonly upperEndingSpendable: string }; readonly variance?: { readonly observedAvailable: string; readonly expectedAvailable: string; readonly difference: string }; }

/** Read-only advisory calculation. It never writes accounting data or changes payment authority. */
export function buildCashForecast(input: CashForecastInput): CashForecast {
  validate(input); const protectedAmount = sum([input.reserveFloor, input.payrollProtection]); const horizonEndsAt = plusDays(input.asOf, input.horizonDays);
  const scenarios = frozen((["conservative", "expected", "optimistic"] as const).map((scenario) => scenarioForecast(input, scenario, protectedAmount, horizonEndsAt)));
  const expected = scenarios.find((value) => value.scenario === "expected")!;
  const range = frozen({ lowerEndingSpendable: scenarios[0]!.endingSpendable, upperEndingSpendable: scenarios[2]!.endingSpendable });
  return frozen({ organizationId: input.organizationId, asset: input.asset, calculatedAt: input.asOf, sourceFreshAt: input.sourceFreshAt, horizonEndsAt, assumptions: frozen(["Forecast values are advisory and cannot alter authoritative treasury balances.", "Obligations are included at their due date; conservative inflows use the lower half of recorded confidence.", "Reserve and payroll protection remain unavailable for discretionary allocation in every scenario."]), protections: frozen({ reserveFloor: input.reserveFloor, payrollProtection: input.payrollProtection, total: protectedAmount }), scenarios, confidenceRange: range, ...(input.observedAvailable === undefined ? {} : { variance: frozen({ observedAvailable: input.observedAvailable, expectedAvailable: expected.endingTreasury, difference: signedDifference(input.observedAvailable, expected.endingTreasury) }) }) });
}

export class CashForecastingError extends Error { constructor(message: string) { super(message); this.name = "CashForecastingError"; } }

function scenarioForecast(input: CashForecastInput, scenario: ForecastScenario, protectedAmount: string, horizonEndsAt: string): ScenarioForecast {
  const timeline = new Map<string, { inflows: ForecastInflow[]; obligations: ForecastObligation[] }>();
  for (const inflow of input.inflows) if (inflow.expectedAt <= horizonEndsAt) bucket(timeline, day(inflow.expectedAt)).inflows.push(inflow);
  for (const obligation of input.obligations) if (obligation.dueAt <= horizonEndsAt) bucket(timeline, day(obligation.dueAt)).obligations.push(obligation);
  let treasury = asUnits(input.treasuryAvailable); const protection = asUnits(protectedAmount); let breach: string | undefined;
  const points: ForecastPoint[] = [point(day(input.asOf), treasury, protection)];
  for (const [date, event] of [...timeline.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    for (const inflow of event.inflows) treasury += inflowUnits(inflow, scenario);
    for (const obligation of event.obligations) treasury -= asUnits(obligation.amount);
    const current = point(date, treasury, protection); if (!breach && treasury - protection < 0n) breach = date; points.push(current);
  }
  const last = points.at(-1)!; return frozen({ scenario, endingTreasury: last.projectedTreasury, endingSpendable: last.spendableAmount, ...(breach ? { firstProtectionBreachAt: breach } : {}), points: frozen(points) });
}
function bucket(timeline: Map<string, { inflows: ForecastInflow[]; obligations: ForecastObligation[] }>, date: string) { const existing = timeline.get(date); if (existing) return existing; const created = { inflows: [] as ForecastInflow[], obligations: [] as ForecastObligation[] }; timeline.set(date, created); return created; }
function point(date: string, treasury: bigint, protection: bigint): ForecastPoint { return frozen({ date, projectedTreasury: formatUnits(treasury), protectedAmount: formatUnits(protection), spendableAmount: formatUnits(treasury - protection) }); }
function inflowUnits(inflow: ForecastInflow, scenario: ForecastScenario): bigint { const percent = scenario === "conservative" ? Math.min(inflow.confidencePercent, 50) : scenario === "expected" ? inflow.confidencePercent : 100; return asUnits(inflow.amount) * BigInt(percent) / 100n; }
function asUnits(value: string): bigint { const decimal = parseDecimal(value); return decimal.coefficient * 10n ** BigInt(18 - decimal.scale); }
function formatUnits(value: bigint): string { const sign = value < 0n ? "-" : ""; const absolute = value < 0n ? -value : value; const digits = absolute.toString().padStart(19, "0"); const whole = digits.slice(0, -18); const fraction = digits.slice(-18).replace(/0+$/, ""); return `${sign}${whole}${fraction ? `.${fraction}` : ""}`; }
function sum(values: readonly string[]): string { return formatUnits(values.reduce((total, value) => total + asUnits(value), 0n)); }
function signedDifference(observed: string, expected: string): string { return formatUnits(asUnits(observed) - asUnits(expected)); }
function day(value: string): string { return value.slice(0, 10); }
function plusDays(value: string, days: number): string { const date = new Date(Date.parse(value)); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function validate(value: CashForecastInput): void { id(value.organizationId, "organizationId", "org_"); if (!/^[A-Z0-9]{3,16}$/.test(value.asset)) throw new CashForecastingError("asset is invalid."); timestamp(value.asOf, "asOf"); timestamp(value.sourceFreshAt, "sourceFreshAt"); if (Date.parse(value.sourceFreshAt) > Date.parse(value.asOf)) throw new CashForecastingError("sourceFreshAt cannot be later than asOf."); positiveOrZero(value.treasuryAvailable, "treasuryAvailable"); positiveOrZero(value.reserveFloor, "reserveFloor"); positiveOrZero(value.payrollProtection, "payrollProtection"); if (!Number.isSafeInteger(value.horizonDays) || value.horizonDays < 1 || value.horizonDays > 366) throw new CashForecastingError("horizonDays is invalid."); for (const inflow of value.inflows) { id(inflow.inflowId, "inflowId", "inflow_"); positiveOrZero(inflow.amount, "inflow.amount"); timestamp(inflow.expectedAt, "inflow.expectedAt"); percent(inflow.confidencePercent, "inflow.confidencePercent"); text(inflow.description, "inflow.description"); } for (const obligation of value.obligations) { id(obligation.obligationId, "obligationId", "obl_"); positiveOrZero(obligation.amount, "obligation.amount"); timestamp(obligation.dueAt, "obligation.dueAt"); text(obligation.description, "obligation.description"); if (!(["payroll", "supplier", "operations", "other"] as const).includes(obligation.category)) throw new CashForecastingError("obligation.category is invalid."); } if (value.observedAvailable !== undefined) positiveOrZero(value.observedAvailable, "observedAvailable"); }
function positiveOrZero(value: string, name: string): void { try { parseDecimal(value); } catch { throw new CashForecastingError(`${name} is invalid.`); } }
function id(value: unknown, name: string, prefix: string): void { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new CashForecastingError(`${name} is invalid.`); }
function text(value: unknown, name: string): void { if (typeof value !== "string" || !value.trim() || value.length > 240) throw new CashForecastingError(`${name} is invalid.`); }
function percent(value: unknown, name: string): void { if (!Number.isInteger(value) || value < 0 || value > 100) throw new CashForecastingError(`${name} is invalid.`); }
function timestamp(value: unknown, name: string): void { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new CashForecastingError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
