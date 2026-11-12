import { addDecimal, compareDecimal, parsePaymentIntent, sha256Digest, subtractDecimal, type CanonicalValue, type PaymentIntent } from "../../../packages/contracts/src/index.ts";
import { evaluatePaymentIntentWithTrace, parsePolicyBundle, type EvaluationContext, type PolicyBundle, type PolicyEvaluation } from "../../../packages/policy-engine/src/index.ts";

export interface PolicySimulationScenario { readonly scenarioId: string; readonly source: "historical" | "synthetic"; readonly intent: PaymentIntent; readonly context: EvaluationContext; readonly expectedCandidateOutcome?: "ALLOW" | "REVIEW" | "DENY"; }
export interface ScenarioComparison { readonly scenarioId: string; readonly source: "historical" | "synthetic"; readonly amount: string; readonly baseline: PolicyEvaluation["decision"]; readonly candidate: PolicyEvaluation["decision"]; readonly changed: boolean; readonly unexpected: boolean; }
export interface PolicySimulationReport {
  readonly baselinePolicyVersion: string;
  readonly candidatePolicyVersion: string;
  readonly simulatedAt: string;
  readonly comparisons: readonly ScenarioComparison[];
  readonly metrics: { readonly autonomyRatePercent: number; readonly candidateAllowedExposure: string; readonly maximumAllowedPayment: string; readonly minimumReserveAfterAllowedPayment: string; readonly changedDecisions: number; readonly unexpectedChanges: number; };
  readonly digest: string;
}
export interface SimulationThreshold { readonly minimumAutonomyRatePercent: number; readonly maximumAllowedExposure: string; readonly maximumUnexpectedChanges: number; }
export interface SimulationAssessment { readonly passed: boolean; readonly failures: readonly string[]; }

/** Deterministically compares policy versions using exact historical or synthetic inputs. */
export class PolicySimulator {
  run(input: { readonly baseline: PolicyBundle; readonly candidate: PolicyBundle; readonly scenarios: readonly PolicySimulationScenario[]; readonly simulatedAt: string }): PolicySimulationReport {
    const baseline = parsePolicyBundle(input.baseline); const candidate = parsePolicyBundle(input.candidate); if (baseline.organizationId !== candidate.organizationId) throw new PolicySimulatorError("Simulation policies must belong to the same organization."); requireTime(input.simulatedAt, "simulatedAt"); if (!Array.isArray(input.scenarios) || input.scenarios.length === 0 || input.scenarios.length > 10_000) throw new PolicySimulatorError("Simulation requires one through 10,000 scenarios.");
    const ids = new Set<string>(); const comparisons = input.scenarios.map((scenario) => compareScenario(scenario, baseline, candidate, ids)); const metrics = metric(comparisons, input.scenarios);
    const base = { baselinePolicyVersion: baseline.policyVersion, candidatePolicyVersion: candidate.policyVersion, simulatedAt: input.simulatedAt, comparisons: frozen(comparisons), metrics };
    return frozen({ ...base, digest: digest(base) });
  }
  assess(report: PolicySimulationReport, threshold: SimulationThreshold): SimulationAssessment {
    validateThreshold(threshold); const failures: string[] = []; if (report.metrics.autonomyRatePercent < threshold.minimumAutonomyRatePercent) failures.push("AUTONOMY_RATE_BELOW_THRESHOLD"); if (compareDecimal(report.metrics.candidateAllowedExposure, threshold.maximumAllowedExposure) > 0) failures.push("EXPOSURE_ABOVE_THRESHOLD"); if (report.metrics.unexpectedChanges > threshold.maximumUnexpectedChanges) failures.push("UNEXPECTED_DECISIONS_ABOVE_THRESHOLD"); return frozen({ passed: failures.length === 0, failures: frozen(failures) });
  }
}

/** Structural publication gate for Policy Registry. The registry owns enforcement; this service supplies simulation evidence. */
export function simulationPublicationGate(input: { readonly report: PolicySimulationReport; readonly assessment: SimulationAssessment }): { assertCanPublish(value: { readonly policy: PolicyBundle }): void } {
  return frozen({ assertCanPublish(value) { if (value.policy.policyVersion !== input.report.candidatePolicyVersion) throw new PolicySimulatorError("Publication policy version does not match its simulation report."); if (!input.assessment.passed) throw new PolicySimulatorError(`Policy simulation did not pass: ${input.assessment.failures.join(", ")}.`); } });
}

export class PolicySimulatorError extends Error { constructor(message: string) { super(message); this.name = "PolicySimulatorError"; } }

function compareScenario(scenario: PolicySimulationScenario, baseline: PolicyBundle, candidate: PolicyBundle, seen: Set<string>): ScenarioComparison {
  requireId(scenario.scenarioId, "scenarioId", "psc_"); if (seen.has(scenario.scenarioId)) throw new PolicySimulatorError("Simulation scenario identifiers must be unique."); seen.add(scenario.scenarioId); if (scenario.source !== "historical" && scenario.source !== "synthetic") throw new PolicySimulatorError("Simulation scenario source is invalid."); const intent = parsePaymentIntent(scenario.intent); const baselineDecision = evaluatePaymentIntentWithTrace({ ...intent, policyVersion: baseline.policyVersion }, baseline, scenario.context).decision; const candidateDecision = evaluatePaymentIntentWithTrace({ ...intent, policyVersion: candidate.policyVersion }, candidate, scenario.context).decision; const changed = baselineDecision.outcome !== candidateDecision.outcome || baselineDecision.reasonCodes.join(",") !== candidateDecision.reasonCodes.join(","); const unexpected = changed && scenario.expectedCandidateOutcome !== candidateDecision.outcome;
  return frozen({ scenarioId: scenario.scenarioId, source: scenario.source, amount: intent.amount, baseline: baselineDecision, candidate: candidateDecision, changed, unexpected });
}
function metric(comparisons: readonly ScenarioComparison[], scenarios: readonly PolicySimulationScenario[]): PolicySimulationReport["metrics"] { let autonomy = 0; let exposure = "0"; let largest = "0"; let minimumReserve: string | undefined; let changed = 0; let unexpected = 0; for (let index = 0; index < comparisons.length; index += 1) { const comparison = comparisons[index]; if (comparison.changed) changed += 1; if (comparison.unexpected) unexpected += 1; if (comparison.candidate.outcome !== "ALLOW") continue; autonomy += 1; exposure = addDecimal(exposure, comparison.amount); if (compareDecimal(comparison.amount, largest) > 0) largest = comparison.amount; const available = scenarios[index].context.availableTreasuryBalance; const reserve = compareDecimal(available, comparison.amount) >= 0 ? subtractDecimal(available, comparison.amount) : "0"; if (minimumReserve === undefined || compareDecimal(reserve, minimumReserve) < 0) minimumReserve = reserve; }
  return frozen({ autonomyRatePercent: Number(((autonomy / comparisons.length) * 100).toFixed(2)), candidateAllowedExposure: exposure, maximumAllowedPayment: largest, minimumReserveAfterAllowedPayment: minimumReserve ?? "0", changedDecisions: changed, unexpectedChanges: unexpected }); }
function validateThreshold(value: SimulationThreshold): void { if (!Number.isFinite(value.minimumAutonomyRatePercent) || value.minimumAutonomyRatePercent < 0 || value.minimumAutonomyRatePercent > 100) throw new PolicySimulatorError("Simulation autonomy threshold is invalid."); if (!Number.isSafeInteger(value.maximumUnexpectedChanges) || value.maximumUnexpectedChanges < 0) throw new PolicySimulatorError("Simulation unexpected-change threshold is invalid."); if (typeof value.maximumAllowedExposure !== "string" || compareDecimal(value.maximumAllowedExposure, "0") < 0) throw new PolicySimulatorError("Simulation exposure threshold is invalid."); }
function digest(value: unknown): string { return sha256Digest(value as CanonicalValue); }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new PolicySimulatorError(`${name} is invalid.`); }
function requireTime(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new PolicySimulatorError(`${name} is invalid.`); }
function frozen<T>(value: T): T { return Object.freeze(value); }
