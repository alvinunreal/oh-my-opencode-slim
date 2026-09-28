import type { AgentOverrideConfig, JevConfig } from '../../config/schema';
import { JevClient, resolveJevApiKey } from './client';
import {
  applyRoutePolicy,
  modelLaddersFromConfig,
  type PolicyOptions,
} from './policy';
import { buildRouteQuestions } from './questions';
import { JevRouteStore } from './store';
import type {
  JevRouteInput,
  JevRouteResult,
  JevSpecialist,
} from './types';

export { JevClient, resolveJevApiKey } from './client';
export {
  agentNameForSpecialist,
  applyRoutePolicy,
  escalateTier,
  modelLaddersFromConfig,
  resolveAgentModelLadder,
  resolveModelForRoute,
  toModelEntries,
} from './policy';
export { buildRouteQuestions } from './questions';
export {
  JevRouteStore,
  toDelegationModelArg,
  type JevRouteRecord,
} from './store';
export * from './types';

export type JevRouterOptions = {
  config: JevConfig;
  agents: () => Record<string, AgentOverrideConfig | undefined>;
  disabledAgents?: () => ReadonlySet<string>;
  fetchImpl?: typeof fetch;
  /** Test seam: override process.env for API key resolution. */
  env?: NodeJS.ProcessEnv;
  /** Shared cache so the dispatch hook can apply the selected model. */
  store?: JevRouteStore;
  /** Test seam: override time provider for TTL. */
  now?: () => number;
};

const ALL_SPECIALISTS: JevSpecialist[] = [
  'explorer',
  'librarian',
  'oracle',
  'designer',
  'fixer',
  'observer',
  'council',
  'direct',
];

/**
 * High-level entry: call SystemOne and apply confidence-gated policy.
 *
 * Specialist = task type. Model strength = complexity/risk ladder on that
 * same agent. Fail-open on any transport/parse failure.
 */
export class JevRouter {
  private readonly config: JevConfig;
  private readonly agents: JevRouterOptions['agents'];
  private readonly disabledAgents: JevRouterOptions['disabledAgents'];
  private readonly fetchImpl?: typeof fetch;
  private readonly env?: NodeJS.ProcessEnv;
  readonly store: JevRouteStore;

  constructor(options: JevRouterOptions) {
    this.config = options.config;
    this.agents = options.agents;
    this.disabledAgents = options.disabledAgents;
    this.fetchImpl = options.fetchImpl;
    this.env = options.env;
    this.store = options.store ?? new JevRouteStore(options.now ? { now: options.now } : undefined);
  }

  private allowedSpecialists(): JevSpecialist[] {
    const disabled = this.disabledAgents?.() ?? new Set<string>();
    return ALL_SPECIALISTS.filter((name) => {
      if (name === 'direct') return true;
      return !disabled.has(name);
    });
  }

  async route(input: JevRouteInput): Promise<JevRouteResult> {
    const sessionID = input.sessionID ?? '';
    const failed = (reason: string, error: string): JevRouteResult => {
      const result: JevRouteResult = {
        status: 'error',
        recommendation: reason,
        error,
      };
      // Invalidate any earlier decision: the orchestrator was told to fall
      // back to default models, so a stale entry must not inject the old one.
      this.store.clear(sessionID);
      return result;
    };

    const apiKey = resolveJevApiKey({
      apiKey: this.config.apiKey,
      apiKeyEnv: this.config.apiKeyEnv,
      env: this.env,
    });
    if (!apiKey) {
      return failed(
        'Jev API key missing (set jev.apiKey or TYPESAFE_API_KEY). Use prompt-based role routing.',
        'missing_api_key',
      );
    }

    const allowed =
      input.allowedSpecialists?.filter((s) =>
        this.allowedSpecialists().includes(s),
      ) ?? this.allowedSpecialists();

    const state = input.state.slice(0, this.config.maxStateChars);
    const taskKey =
      input.taskKey ?? state.slice(0, 256);
    const questions = buildRouteQuestions({ allowedSpecialists: allowed });

    try {
      const client = new JevClient({
        baseUrl: this.config.baseUrl,
        model: this.config.model,
        apiKey,
        timeoutMs: this.config.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      const response = await client.systemOne({ state, questions });
      const agents = this.agents();
      const policyOptions: PolicyOptions = {
        acceptConfidence: this.config.acceptConfidence,
        escalateConfidence: this.config.escalateConfidence,
        agents,
        modelLadders: modelLaddersFromConfig(this.config),
        allowedSpecialists: allowed,
      };
      const result = applyRoutePolicy(
        response,
        { state, allowedSpecialists: allowed },
        policyOptions,
      );
      // Cache per task so parallel lanes keep their own decision and a
      // later failure clears rather than preserves a stale model.
      this.store.record(sessionID, taskKey, result);
      return result;
    } catch (err) {
      return failed(
        'Jev call failed; use prompt-based role routing. ' +
          (err instanceof Error ? err.message : String(err)),
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Master gate: the Jev dispatch regime is active ONLY when the user has
 * explicitly enabled it AND configured a Jev model. Otherwise the plugin
 * keeps the original orchestrator routing (role prompt + default models).
 */
export function isJevRoutingActive(
  config: JevConfig | undefined,
  options?: { env?: NodeJS.ProcessEnv },
): boolean {
  if (!config) return false;
  if (config.enabled === false) return false;
  // Require an explicitly configured model (non-empty after trim).
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  if (!model) return false;
  // Need a usable key; without it the tool would only fail-open every time.
  const apiKey = resolveJevApiKey({
    apiKey: config.apiKey,
    apiKeyEnv: config.apiKeyEnv,
    env: options?.env,
  });
  return Boolean(apiKey);
}
