export interface AgentEvaluationCase { readonly id: string; readonly category: "tool-selection" | "adversarial-input" | "calculation" | "replanning" | "trace"; readonly critical: boolean; readonly passed: boolean; readonly detail: string; }
export interface AgentEvaluationReport { readonly suiteVersion: string; readonly total: number; readonly passed: number; readonly criticalFailures: readonly AgentEvaluationCase[]; readonly releaseEligible: boolean; }

/** A release is ineligible if any critical agent-safety scenario fails. */
export function evaluateAgentRelease(cases: readonly AgentEvaluationCase[]): AgentEvaluationReport {
  if (!cases.length || cases.some((item) => !item.id || !item.category || !item.detail)) throw new AgentEvaluationError("Evaluation cases are invalid.");
  const criticalFailures = cases.filter((item) => item.critical && !item.passed);
  return frozen({ suiteVersion: "alloc-x-agent-evals-1", total: cases.length, passed: cases.filter((item) => item.passed).length, criticalFailures: frozen(criticalFailures), releaseEligible: criticalFailures.length === 0 });
}
export function assertAgentReleaseEligible(cases: readonly AgentEvaluationCase[]): AgentEvaluationReport { const report = evaluateAgentRelease(cases); if (!report.releaseEligible) throw new AgentEvaluationError(`Critical agent evaluation failures: ${report.criticalFailures.map((item) => item.id).join(", ")}.`); return report; }
export class AgentEvaluationError extends Error { constructor(message: string) { super(message); this.name = "AgentEvaluationError"; } }
function frozen<T>(value: T): T { return Object.freeze(value); }
