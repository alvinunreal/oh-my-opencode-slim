import type { AgentName } from '../types';
import type {
  RoutingDecisionExplanation,
  ScoredRoutingCandidate,
} from './types';

function summarizeTopFactors(candidate: ScoredRoutingCandidate): string[] {
  return [...candidate.components]
    .sort((left, right) => {
      return (
        Math.abs(right.normalizedScore * right.weight) -
        Math.abs(left.normalizedScore * left.weight)
      );
    })
    .slice(0, 3)
    .map((component) => {
      return `${component.name}=${component.normalizedScore.toFixed(1)}`;
    });
}

function tradeoffText(
  winner: ScoredRoutingCandidate,
  candidate: ScoredRoutingCandidate,
): string {
  const delta = winner.totalScore - candidate.totalScore;
  if (delta < 8) return 'near tie; pick based on latency/cost preference';
  if (delta < 20) return 'moderate score gap with meaningful tradeoffs';
  return 'clear score gap; alternative is fallback-only';
}

export function explainRoutingDecision(input: {
  agent: AgentName;
  ranked: ScoredRoutingCandidate[];
  alternatives: number;
}): RoutingDecisionExplanation | null {
  const selected = input.ranked[0];
  if (!selected) return null;

  const alternatives = input.ranked
    .slice(1, 1 + input.alternatives)
    .map((candidate) => {
      return {
        model: candidate.model.model,
        billingMode: candidate.billingMode,
        score: candidate.totalScore,
        tradeoff: tradeoffText(selected, candidate),
      };
    });

  const summary = `${selected.model.model} selected for ${input.agent} with score ${selected.totalScore.toFixed(
    1,
  )} (${selected.tier}).`;

  return {
    selectedModel: selected.model.model,
    selectedBillingMode: selected.billingMode,
    score: selected.totalScore,
    summary,
    topFactors: summarizeTopFactors(selected),
    alternatives,
  };
}
