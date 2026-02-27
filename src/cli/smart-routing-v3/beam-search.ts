import type {
  AgentModelAssignment,
  AgentName,
  DiscoveredModel,
} from '../types';
import { rankRoutingCandidates } from './scoring';
import type {
  PartialPlan,
  RoutingScoringContext,
  ScoredRoutingCandidate,
  SelectionConfig,
} from './types';

function diversityBonus(providerUsage: Map<string, number>): number {
  const counts = [...providerUsage.values()];
  if (counts.length === 0) return 0;
  const total = counts.reduce((sum, count) => sum + count, 0);
  const ideal = total / counts.length;
  if (ideal <= 0) return 0;
  const variance =
    counts.reduce((sum, count) => sum + (count - ideal) ** 2, 0) /
    counts.length;
  return Math.max(0, 1 - variance / (ideal * ideal));
}

export function rankProviderRepresentatives(input: {
  models: ReadonlyArray<DiscoveredModel>;
  agent: AgentName;
  context: RoutingScoringContext;
  maxPerProvider: number;
  maxProviders: number;
}): ScoredRoutingCandidate[] {
  const ranked = rankRoutingCandidates(
    input.models,
    input.agent,
    input.context,
  );
  const grouped = new Map<string, ScoredRoutingCandidate[]>();

  for (const candidate of ranked) {
    const provider = candidate.model.providerID;
    const items = grouped.get(provider) ?? [];
    if (items.length < input.maxPerProvider) {
      items.push(candidate);
      grouped.set(provider, items);
    }
  }

  const providerEntries = [...grouped.entries()]
    .map(([provider, candidates]) => ({
      provider,
      topScore: candidates[0]?.totalScore ?? -Infinity,
      candidates,
    }))
    .sort((left, right) => right.topScore - left.topScore)
    .slice(0, Math.max(1, input.maxProviders));

  return providerEntries
    .flatMap((entry) => entry.candidates)
    .sort((left, right) => right.totalScore - left.totalScore);
}

export function selectWithBeamSearch(input: {
  agents: AgentName[];
  models: ReadonlyArray<DiscoveredModel>;
  config: SelectionConfig;
  context: RoutingScoringContext;
}): Record<AgentName, AgentModelAssignment> {
  let beam: PartialPlan[] = [
    {
      assignments: {},
      providerUsage: new Map<string, number>(),
      totalScore: 0,
    },
  ];

  for (const agent of input.agents) {
    const nextBeam: PartialPlan[] = [];

    for (const plan of beam) {
      const contextual: RoutingScoringContext = {
        ...input.context,
        providerUsage: plan.providerUsage,
      };
      const ranked = rankProviderRepresentatives({
        models: input.models,
        agent,
        context: contextual,
        maxPerProvider: input.config.maxPerProviderPerAgent,
        maxProviders: input.config.maxProvidersPerAgent,
      });

      const candidates = ranked.slice(0, input.config.beamWidth);
      for (const candidate of candidates) {
        const assignments = {
          ...plan.assignments,
          [agent]: {
            model: candidate.model.model,
            billingMode: candidate.billingMode,
            confidence: Math.max(0, Math.min(1, candidate.totalScore / 120)),
            reasoning: candidate.components
              .slice(0, 3)
              .map(
                (component) =>
                  `${component.name}:${component.normalizedScore.toFixed(1)}`,
              )
              .join(', '),
          },
        };
        const providerUsage = new Map(plan.providerUsage);
        providerUsage.set(
          candidate.model.providerID,
          (providerUsage.get(candidate.model.providerID) ?? 0) + 1,
        );
        nextBeam.push({
          assignments,
          providerUsage,
          totalScore: plan.totalScore + candidate.totalScore,
        });
      }
    }

    beam = nextBeam
      .sort((left, right) => {
        const leftScore =
          left.totalScore +
          diversityBonus(left.providerUsage) * input.config.diversityWeight;
        const rightScore =
          right.totalScore +
          diversityBonus(right.providerUsage) * input.config.diversityWeight;
        return rightScore - leftScore;
      })
      .slice(0, input.config.beamWidth);
  }

  const winner = beam[0];
  if (!winner) {
    throw new Error('Beam search failed to produce a routing plan');
  }

  const output: Partial<Record<AgentName, AgentModelAssignment>> = {};
  for (const agent of input.agents) {
    const assignment = winner.assignments[agent];
    if (assignment) {
      output[agent] = assignment;
    }
  }

  return output as Record<AgentName, AgentModelAssignment>;
}

export function buildRankedAlternatives(input: {
  agent: AgentName;
  models: ReadonlyArray<DiscoveredModel>;
  context: RoutingScoringContext;
  max: number;
  maxPerProvider?: number;
  maxProviders?: number;
}): ScoredRoutingCandidate[] {
  return rankProviderRepresentatives({
    models: input.models,
    agent: input.agent,
    context: input.context,
    maxPerProvider: input.maxPerProvider ?? 2,
    maxProviders: input.maxProviders ?? Number.MAX_SAFE_INTEGER,
  })
    .slice(0, input.max)
    .map((candidate) => candidate);
}
