import type { AgentName, BillingMode, DiscoveredModel } from '../types';
import type {
  RoutingScoringContext,
  ScoreComponent,
  ScoredRoutingCandidate,
} from './types';

const ROLE_WEIGHTS: Record<
  AgentName,
  {
    reasoning: number;
    toolcall: number;
    attachment: number;
    context: number;
    speed: number;
    cost: number;
  }
> = {
  orchestrator: {
    reasoning: 24,
    toolcall: 20,
    attachment: 2,
    context: 12,
    speed: 4,
    cost: 4,
  },
  oracle: {
    reasoning: 28,
    toolcall: 10,
    attachment: 2,
    context: 16,
    speed: 2,
    cost: 2,
  },
  designer: {
    reasoning: 10,
    toolcall: 14,
    attachment: 20,
    context: 8,
    speed: 4,
    cost: 4,
  },
  explorer: {
    reasoning: 2,
    toolcall: 24,
    attachment: 2,
    context: 6,
    speed: 18,
    cost: 10,
  },
  librarian: {
    reasoning: 8,
    toolcall: 22,
    attachment: 2,
    context: 22,
    speed: 6,
    cost: 8,
  },
  fixer: {
    reasoning: 10,
    toolcall: 20,
    attachment: 2,
    context: 10,
    speed: 14,
    cost: 8,
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function inferBillingMode(model: DiscoveredModel): BillingMode {
  if (model.providerID === 'nanogpt') {
    if (model.nanoGptAccess === 'subscription') {
      return 'subscription';
    }
    if (model.nanoGptAccess === 'paid') {
      return 'paygo';
    }
    if (model.nanoGptAccess === 'visible') {
      return 'subscription';
    }
  }

  const input = model.costInput ?? 0;
  const output = model.costOutput ?? 0;
  return input === 0 && output === 0 ? 'subscription' : 'paygo';
}

function asContextScore(contextLimit: number): number {
  return clamp((Math.min(contextLimit, 1_000_000) / 1_000_000) * 100, 0, 100);
}

function asSpeedScore(model: DiscoveredModel): number {
  const text = `${model.model} ${model.name}`.toLowerCase();
  if (/nano|flash|mini|lite|haiku|fast/.test(text)) return 85;
  if (/turbo|small/.test(text)) return 70;
  if (/opus|pro|thinking/.test(text)) return 35;
  return 55;
}

function asCostScore(model: DiscoveredModel): number {
  const blended = (model.costInput ?? 0) * 0.7 + (model.costOutput ?? 0) * 0.3;
  if (blended <= 0) return 100;
  return clamp(100 - blended * 3.5, 0, 100);
}

function billingPolicyScore(
  billingMode: BillingMode,
  context: RoutingScoringContext,
): number {
  if (context.policy.mode === 'subscription-only') {
    return billingMode === 'subscription' ? 24 : -200;
  }
  if (context.policy.mode === 'paygo-only') {
    return billingMode === 'paygo' ? 18 : -120;
  }
  return billingMode === 'subscription' ? 10 : 0;
}

function quotaPressureScore(
  billingMode: BillingMode,
  context: RoutingScoringContext,
): number {
  if (billingMode !== 'subscription') return 0;

  const dailyBudget = context.policy.subscriptionBudget?.dailyRequests;
  const monthlyBudget = context.policy.subscriptionBudget?.monthlyRequests;
  const dailyPct =
    typeof dailyBudget === 'number' && dailyBudget > 0
      ? context.quotaStatus.dailyRemaining / dailyBudget
      : 1;
  const monthlyPct =
    typeof monthlyBudget === 'number' && monthlyBudget > 0
      ? context.quotaStatus.monthlyRemaining / monthlyBudget
      : 1;
  const pct = Math.min(dailyPct, monthlyPct);

  if (pct < 0.1) return -36;
  if (pct < 0.25) return -24;
  if (pct < 0.5) return -10;
  return 0;
}

function diversityScore(
  model: DiscoveredModel,
  context: RoutingScoringContext,
): number {
  const usage = context.providerUsage.get(model.providerID) ?? 0;
  if (usage >= 3) return -18;
  if (usage >= 2) return -8;
  if (usage === 0) return 6;
  return 0;
}

function externalSignalScore(model: DiscoveredModel): number {
  const text = model.model.toLowerCase();
  if (text.includes('deprecated')) return -80;
  if (model.status === 'deprecated') return -80;
  if (model.status === 'alpha') return -8;
  if (model.status === 'beta') return 4;
  return 10;
}

function modelPreferenceScore(model: DiscoveredModel): number {
  const text = `${model.model} ${model.name}`.toLowerCase();

  const isGemini3 = /gemini[-_ ]?3/.test(text);
  const isGemini25Flash = /gemini-2\.5-flash/.test(text);
  const isGlm5 = /glm[-_ ]?5/.test(text);
  const isGlm47Flash = /glm-4\.7-flash/.test(text);
  const isMinimaxM25 = /minimax[-_ ]?m2\.5/.test(text);
  const isMinimaxM21 = /minimax[-_ ]?m2\.1/.test(text);

  return (
    (isGemini3 ? 14 : 0) +
    (isGemini25Flash ? -6 : 0) +
    (isGlm5 ? 10 : 0) +
    (isGlm47Flash ? -4 : 0) +
    (isMinimaxM25 ? 8 : 0) +
    (isMinimaxM21 ? -6 : 0)
  );
}

function chutesMonthlyPacingScore(
  model: DiscoveredModel,
  agent: AgentName,
  context: RoutingScoringContext,
): number {
  if (model.providerID !== 'chutes') return 0;
  const pacing = context.chutesPacing;
  if (!pacing) return 0;

  const budget = pacing.monthlyBudget;
  const used = pacing.monthlyUsed ?? 0;
  const ratio =
    typeof budget === 'number' && budget > 0
      ? Math.max(0, Math.min(1.5, used / budget))
      : 0;

  const costScore = asCostScore(model);
  const qualityScore = model.reasoning ? 100 : model.toolcall ? 75 : 45;
  const rolePriority =
    agent === 'oracle' || agent === 'orchestrator'
      ? 1.2
      : agent === 'designer'
        ? 1
        : 0.85;

  if (pacing.mode === 'quality-first') {
    const qualityBonus = (qualityScore / 100) * 12 * rolePriority;
    if (ratio >= 0.95) return qualityBonus - 16;
    if (ratio >= 0.85) return qualityBonus - 8;
    return qualityBonus;
  }

  if (pacing.mode === 'balanced') {
    if (ratio < 0.7) return 4;
    const pressurePenalty = (ratio - 0.7) * 30;
    const efficiencyBonus = (costScore / 100) * 10;
    return efficiencyBonus - pressurePenalty;
  }

  const economyBonus = (costScore / 100) * 18;
  const qualityPenalty = ((100 - qualityScore) / 100) * -4;
  if (ratio >= 0.6) {
    return economyBonus + qualityPenalty + 4;
  }
  return economyBonus + qualityPenalty;
}

function nanoGptMonthlyPacingScore(
  model: DiscoveredModel,
  context: RoutingScoringContext,
): number {
  if (model.providerID !== 'nanogpt') return 0;

  const monthlyBudget = context.policy.subscriptionBudget?.monthlyRequests;
  if (typeof monthlyBudget !== 'number' || monthlyBudget <= 0) return 0;

  const remainingPct = clamp(
    context.quotaStatus.monthlyRemaining / monthlyBudget,
    0,
    1,
  );
  const text = `${model.model} ${model.name}`.toLowerCase();
  const premium = /gpt-5|opus|pro|thinking|reasoning|large/.test(text);
  const economy = /mini|nano|flash|lite|small/.test(text);

  if (remainingPct > 0.5) {
    if (premium) return 8;
    if (economy) return 2;
    return 4;
  }

  if (remainingPct > 0.25) {
    if (premium) return 2;
    if (economy) return 6;
    return 3;
  }

  if (remainingPct > 0.1) {
    if (premium) return -8;
    if (economy) return 9;
    return 1;
  }

  if (premium) return -16;
  if (economy) return 12;
  return -2;
}

export function scoreRoutingCandidate(
  model: DiscoveredModel,
  agent: AgentName,
  context: RoutingScoringContext,
): ScoredRoutingCandidate {
  const role = ROLE_WEIGHTS[agent];
  const billingMode = inferBillingMode(model);

  const reasoningBase = model.reasoning ? 100 : 0;
  const toolcallBase = model.toolcall ? 100 : 0;
  const attachmentBase = model.attachment ? 100 : 0;
  const contextBase = asContextScore(model.contextLimit);
  const speedBase = asSpeedScore(model);
  const costBase = asCostScore(model);

  const components: ScoreComponent[] = [
    {
      name: 'roleFit',
      weight: 1,
      value: 0,
      normalizedScore:
        (reasoningBase * role.reasoning) / 100 +
        (toolcallBase * role.toolcall) / 100 +
        (attachmentBase * role.attachment) / 100 +
        (contextBase * role.context) / 100,
      description: `Role capability alignment for ${agent}`,
    },
    {
      name: 'latencyFit',
      weight: 0.6,
      value: speedBase,
      normalizedScore: (speedBase * role.speed) / 100,
      description: 'Speed preference for this role',
    },
    {
      name: 'costFit',
      weight: 0.7,
      value: costBase,
      normalizedScore: (costBase * role.cost) / 100,
      description: 'Cost efficiency contribution',
    },
    {
      name: 'billingPolicyFit',
      weight: 1.1,
      value: 0,
      normalizedScore: billingPolicyScore(billingMode, context),
      description: `Policy ${context.policy.mode} vs ${billingMode}`,
    },
    {
      name: 'quotaPressure',
      weight: 0.9,
      value: 0,
      normalizedScore: quotaPressureScore(billingMode, context),
      description: 'Subscription quota pressure impact',
    },
    {
      name: 'chutesMonthlyPacing',
      weight: 0.9,
      value: 0,
      normalizedScore: chutesMonthlyPacingScore(model, agent, context),
      description: 'Chutes monthly pacing adjustment',
    },
    {
      name: 'nanoGptMonthlyPacing',
      weight: 0.9,
      value: 0,
      normalizedScore: nanoGptMonthlyPacingScore(model, context),
      description: 'NanoGPT monthly pacing adjustment',
    },
    {
      name: 'diversityAdjustment',
      weight: 0.8,
      value: 0,
      normalizedScore: diversityScore(model, context),
      description: 'Provider concentration balancing',
    },
    {
      name: 'modelMaturity',
      weight: 0.5,
      value: 0,
      normalizedScore: externalSignalScore(model),
      description: 'Model status and maturity score',
    },
    {
      name: 'modelPreference',
      weight: 0.6,
      value: 0,
      normalizedScore: modelPreferenceScore(model),
      description: 'Version-aware model preference adjustment',
    },
  ];

  const totalScore = components.reduce(
    (sum, component) => sum + component.normalizedScore * component.weight,
    0,
  );

  const tier =
    totalScore >= 80
      ? 'optimal'
      : totalScore >= 55
        ? 'acceptable'
        : totalScore >= 35
          ? 'suboptimal'
          : 'unsuitable';

  return {
    agent,
    model,
    billingMode,
    totalScore: Math.round(totalScore * 1000) / 1000,
    components,
    tier,
  };
}

export function rankRoutingCandidates(
  models: ReadonlyArray<DiscoveredModel>,
  agent: AgentName,
  context: RoutingScoringContext,
): ScoredRoutingCandidate[] {
  return models
    .map((model) => scoreRoutingCandidate(model, agent, context))
    .sort((left, right) => {
      if (left.totalScore !== right.totalScore) {
        return right.totalScore - left.totalScore;
      }
      const providerDiff = left.model.providerID.localeCompare(
        right.model.providerID,
      );
      if (providerDiff !== 0) return providerDiff;
      return left.model.model.localeCompare(right.model.model);
    });
}
