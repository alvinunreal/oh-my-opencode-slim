import type { AgentModelAssignment, AgentName } from '../types';
import type {
  RoutingExperiment,
  RoutingExperimentVariant,
  RoutingRuntimeMetrics,
} from './types';

export interface ExperimentResult {
  variantId: string;
  sampleCount: number;
  avgSuccessRate: number;
  avgLatencyMs: number;
  avgCostUsd: number;
}

function hashString(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index++) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

export class RoutingExperimentManager {
  private experiments = new Map<string, RoutingExperiment>();
  private metrics = new Map<string, RoutingRuntimeMetrics[]>();

  register(experiment: RoutingExperiment): void {
    const totalAllocation = Object.values(experiment.allocation).reduce(
      (sum, value) => sum + value,
      0,
    );
    if (Math.round(totalAllocation) !== 100) {
      throw new Error('Experiment allocation must sum to 100');
    }
    this.experiments.set(experiment.id, experiment);
  }

  pickVariant(
    experimentId: string,
    subjectId: string,
  ): RoutingExperimentVariant {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Unknown experiment: ${experimentId}`);
    }
    const bucket = hashString(`${experimentId}|${subjectId}`) % 100;
    let cursor = 0;
    for (const variant of experiment.variants) {
      cursor += experiment.allocation[variant.id] ?? 0;
      if (bucket < cursor) return variant;
    }
    return experiment.variants[0] as RoutingExperimentVariant;
  }

  applyVariantOverrides(
    assignments: Record<AgentName, AgentModelAssignment>,
    variant: RoutingExperimentVariant,
  ): Record<AgentName, AgentModelAssignment> {
    const output: Record<AgentName, AgentModelAssignment> = { ...assignments };
    if (!variant.assignmentOverrides) return output;
    for (const [agent, assignment] of Object.entries(
      variant.assignmentOverrides,
    )) {
      if (!assignment) continue;
      output[agent as AgentName] = assignment;
    }
    return output;
  }

  recordVariantMetrics(
    experimentId: string,
    variantId: string,
    metric: RoutingRuntimeMetrics,
  ): void {
    const key = `${experimentId}|${variantId}`;
    const current = this.metrics.get(key) ?? [];
    current.push(metric);
    this.metrics.set(key, current.slice(-2_000));
  }

  summarize(experimentId: string): ExperimentResult[] {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return [];

    return experiment.variants.map((variant) => {
      const key = `${experimentId}|${variant.id}`;
      const rows = this.metrics.get(key) ?? [];
      if (rows.length === 0) {
        return {
          variantId: variant.id,
          sampleCount: 0,
          avgSuccessRate: 0,
          avgLatencyMs: 0,
          avgCostUsd: 0,
        };
      }
      const aggregate = rows.reduce(
        (sum, row) => {
          return {
            successRate: sum.successRate + row.successRate,
            latencyMs: sum.latencyMs + row.avgLatencyMs,
            costUsd: sum.costUsd + row.avgCostUsd,
          };
        },
        { successRate: 0, latencyMs: 0, costUsd: 0 },
      );

      return {
        variantId: variant.id,
        sampleCount: rows.length,
        avgSuccessRate: aggregate.successRate / rows.length,
        avgLatencyMs: aggregate.latencyMs / rows.length,
        avgCostUsd: aggregate.costUsd / rows.length,
      };
    });
  }
}
