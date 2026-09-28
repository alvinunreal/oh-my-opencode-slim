import type { AgentOverrideConfig, JevConfig } from '../../config/schema';
import type {
  JevChoiceAnswer,
  JevNoulAnswer,
  JevRouteInput,
  JevRouteResult,
  JevScoreAnswer,
  JevSpecialist,
  JevSystemOneResponse,
  ModelEntry,
  ModelTier,
} from './types';
import { MODEL_TIERS } from './types';

const TIER_ORDER: Record<ModelTier, number> = {
  fast: 0,
  balanced: 1,
  max: 2,
};

export function escalateTier(tier: ModelTier): ModelTier {
  const idx = TIER_ORDER[tier];
  return MODEL_TIERS[Math.min(idx + 1, MODEL_TIERS.length - 1)];
}

/** Normalize agent model config into ModelEntry[]. */
export function toModelEntries(value: unknown): ModelEntry[] {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: ModelEntry[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry) {
      out.push({ id: entry });
    } else if (
      entry &&
      typeof entry === 'object' &&
      'id' in entry &&
      typeof (entry as { id: unknown }).id === 'string'
    ) {
      const obj = entry as { id: string; variant?: string };
      out.push(obj.variant ? { id: obj.id, variant: obj.variant } : { id: obj.id });
    }
  }
  return out;
}

export function agentNameForSpecialist(specialist: JevSpecialist): string {
  return specialist === 'direct' ? 'orchestrator' : specialist;
}

/**
 * Quality ladder for ONE agent (task-type specialist).
 *
 * Priority:
 * 1. `jev.modelLadders[agent]` — explicit [fast, balanced, max] list
 * 2. The agent's own single model — SAME model at every tier
 *
 * A `model: [...]` array is an ordered FAILOVER chain (preferred head,
 * fallbacks after), never a quality ladder; it is NOT stepped through by
 * complexity. Selecting max must never promote a fallback above the
 * preferred head — the agent keeps its primary model at every tier unless
 * an explicit strength ladder names another entry.
 */
export function resolveAgentModelLadder(
  specialist: JevSpecialist,
  agents: Record<string, AgentOverrideConfig | undefined>,
  modelLadders?: Record<string, ModelEntry[] | undefined>,
): ModelEntry[] {
  const agentName = agentNameForSpecialist(specialist);
  const fromLadders = modelLadders?.[agentName];
  if (fromLadders && fromLadders.length > 0) return fromLadders;

  // Failover chains stay intact: only the head (preferred model) is used.
  const own = toModelEntries(agents[agentName]?.model);
  return own.slice(0, 1);
}

/**
 * Pick the model for a specialist at a given strength tier.
 * Always stays on that specialist's own ladder — never another agent's model,
 * and never a failover entry from its own chain.
 *
 * Without an explicit `jev.modelLadders[agent]` ladder, the agent uses its
 * primary (failover head) model at every tier. Multi-entry ladders index
 * fast → head, max → tail, balanced → middle.
 */
export function resolveModelForRoute(
  specialist: JevSpecialist,
  tier: ModelTier,
  agents: Record<string, AgentOverrideConfig | undefined>,
  modelLadders?: Record<string, ModelEntry[] | undefined>,
): ModelEntry | undefined {
  const ladder = resolveAgentModelLadder(specialist, agents, modelLadders);
  if (ladder.length === 0) return undefined;
  if (ladder.length === 1) return ladder[0];

  const idx =
    tier === 'fast'
      ? 0
      : tier === 'max'
        ? ladder.length - 1
        : Math.floor((ladder.length - 1) / 2);
  return ladder[idx];
}

function asChoice(answer: unknown): JevChoiceAnswer | undefined {
  if (
    answer &&
    typeof answer === 'object' &&
    (answer as { type?: string }).type === 'choice' &&
    typeof (answer as { choice?: unknown }).choice === 'string'
  ) {
    return answer as JevChoiceAnswer;
  }
  return undefined;
}

function asScore(answer: unknown): JevScoreAnswer | undefined {
  if (
    answer &&
    typeof answer === 'object' &&
    (answer as { type?: string }).type === 'score' &&
    typeof (answer as { score?: unknown }).score === 'number'
  ) {
    return answer as JevScoreAnswer;
  }
  return undefined;
}

function asNoul(answer: unknown): JevNoulAnswer | undefined {
  if (
    answer &&
    typeof answer === 'object' &&
    (answer as { type?: string }).type === 'noul' &&
    typeof (answer as { noul?: unknown }).noul === 'number'
  ) {
    return answer as JevNoulAnswer;
  }
  return undefined;
}

export type PolicyOptions = {
  acceptConfidence: number;
  escalateConfidence: number;
  agents: Record<string, AgentOverrideConfig | undefined>;
  /** Optional per-agent [fast, balanced, max] ladders from jev.modelLadders. */
  modelLadders?: Record<string, ModelEntry[] | undefined>;
  allowedSpecialists?: readonly JevSpecialist[];
};

/**
 * Turn a SystemOne response into a routing recommendation.
 *
 * Separation of concerns:
 * - specialist = TASK TYPE (which agent role owns the work)
 * - model tier = STRENGTH (fast/balanced/max) on that same agent's ladder
 *
 * Complexity/risk never switch the agent. High complexity means a stronger
 * model for the same specialist, not a different specialist.
 */
export function applyRoutePolicy(
  response: JevSystemOneResponse,
  _input: JevRouteInput,
  options: PolicyOptions,
): JevRouteResult {
  const specialistAns = asChoice(response.answers?.specialist);
  const complexityAns = asScore(response.answers?.complexity);
  const riskAns = asScore(response.answers?.risk);
  const needsExternal = asNoul(response.answers?.needs_external);
  const needsVisual = asNoul(response.answers?.needs_visual);

  if (!specialistAns) {
    return {
      status: 'error',
      recommendation:
        'Jev response missing specialist choice; use prompt-based role routing.',
      error: 'missing_specialist_answer',
    };
  }

  const confidence = specialistAns.confidence;
  const rawSpecialist = specialistAns.choice as JevSpecialist;
  const allowed = options.allowedSpecialists;
  const specialistAllowed = !allowed || allowed.includes(rawSpecialist);

  // Task-type only. Noul signals fill a missing/soft role — they never
  // replace a confident, already-justified specialist (a fixer task with a
  // screenshot must stay on fixer).
  let specialist: JevSpecialist | undefined = specialistAllowed
    ? rawSpecialist
    : undefined;

  // Visual/external signals only fill an unassigned lane. Any confident
  // choice — including a soft but real specialist pick — stands: a fixer
  // task with a screenshot stays on fixer.
  const isUnassigned = !specialist || specialist === 'direct';

  if (isUnassigned) {
    if (needsVisual && needsVisual.noul >= 0.7) {
      const visualTarget = (
        !allowed || allowed.includes('designer')
          ? 'designer'
          : !allowed || allowed.includes('observer')
            ? 'observer'
            : undefined
      );
      if (visualTarget) specialist = visualTarget;
    } else if (
      needsExternal &&
      needsExternal.noul >= 0.7 &&
      (!allowed || allowed.includes('librarian'))
    ) {
      specialist = 'librarian';
    }
  }

  // Strength tier: complexity/risk pick model strength ONLY.
  const complexity = complexityAns?.score ?? 1;
  const risk = riskAns?.score ?? 1;
  let tier: ModelTier =
    complexity >= 1.5 || risk >= 1.5
      ? 'max'
      : complexity <= 0.5 && risk <= 0.5
        ? 'fast'
        : 'balanced';

  const base = {
    confidence,
    probabilities: specialistAns.probabilities,
    complexity,
    risk,
    modelTier: tier,
  } as const;

  const resolve = (t: ModelTier) =>
    specialist
      ? resolveModelForRoute(specialist, t, options.agents, options.modelLadders)
      : undefined;

  if (confidence < options.escalateConfidence || !specialist) {
    // Still resolve the model when a specialist is known, so requirement
    // "same agent, strength by complexity" holds even on the degraded path.
    const model = specialist ? resolve(tier) : undefined;
    return {
      ...base,
      status: 'low_confidence',
      specialist,
      modelTier: tier,
      model,
      recommendation: specialist
        ? `low_confidence (${confidence.toFixed(2)}): consider @${specialist} with ${model ? `model ${model.id}` : `strength ${tier}`} but keep prompt routing authoritative.`
        : `low_confidence (${confidence.toFixed(2)}): ignore Jev specialist and use prompt-based role routing.`,
    };
  }

  if (confidence < options.acceptConfidence) {
    // Same specialist; only raise model strength one step.
    tier = escalateTier(tier);
    const model = resolve(tier);
    return {
      ...base,
      status: 'ok',
      specialist,
      modelTier: tier,
      model,
      recommendation: buildRecommendation(
        specialist,
        tier,
        model,
        confidence,
        true,
      ),
    };
  }

  const model = resolve(tier);
  return {
    ...base,
    status: 'ok',
    specialist,
    modelTier: tier,
    model,
    recommendation: buildRecommendation(
      specialist,
      tier,
      model,
      confidence,
      false,
    ),
  };
}

function buildRecommendation(
  specialist: JevSpecialist,
  tier: ModelTier,
  model: ModelEntry | undefined,
  confidence: number,
  escalated: boolean,
): string {
  const modelPart = model
    ? `model ${model.id}${model.variant ? ` (variant ${model.variant})` : ''}`
    : `strength ${tier} (no model on this agent's ladder)`;
  const flag = escalated ? ' [strength escalated]' : '';
  return `Keep @${specialist} (task-type specialist) with ${modelPart}${flag} · confidence ${confidence.toFixed(2)}`;
}

/** Convenience: load ladders from JevConfig into typed entries. */
export function modelLaddersFromConfig(
  config: Pick<JevConfig, 'modelLadders'> | undefined,
): Record<string, ModelEntry[]> | undefined {
  if (!config?.modelLadders) return undefined;
  const out: Record<string, ModelEntry[]> = {};
  for (const [name, value] of Object.entries(config.modelLadders)) {
    out[name] = toModelEntries(value);
  }
  return out;
}
