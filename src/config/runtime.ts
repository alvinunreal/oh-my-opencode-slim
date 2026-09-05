/**
 * Runtime configuration interface for oh-my-opencode-slim.
 *
 * Single typed access point for everything the plugin reads from config at
 * runtime: the plugin file layer (loadPluginConfig result), the host config
 * layer (opencode.json snapshot captured by the config hook BEFORE it mutates
 * the host config), and runtime overrides (preset switching and model-switch
 * tracking).
 *
 * One instance per directory, created once per process. Seeded by
 * RuntimeConfig.init() at plugin factory start (plugin layer) and by
 * captureHostConfig() at the top of the config hook (host layer).
 *
 * Cache-safety contract: getters feed construction and hooks, never prompt
 * assembly. This module must never expose volatile text for prompts; any
 * prompt-injecting consumer must go through src/hooks/cache-safe-injection.ts.
 */
import {
  AGENT_ALIASES,
  ALL_AGENT_NAMES,
  DEFAULT_DISABLED_AGENTS,
  DEFAULT_MAX_CONTEXT_LINES,
  DEFAULT_MAX_RETAINED_SNAPSHOTS,
  DEFAULT_MAX_SESSIONS_PER_AGENT,
  DEFAULT_READ_CONTEXT_MAX_FILES,
  DEFAULT_READ_CONTEXT_MIN_LINES,
  type ImageRouting,
  PROTECTED_AGENTS,
  resolveImageRouting,
  SUBAGENT_NAMES,
} from './constants';
import type { CouncilConfig } from './council-schema';
import { deepMerge } from './loader';
import type {
  AcpAgentsConfig,
  AgentOverrideConfig,
  BackgroundJobsConfig,
  CompanionConfig,
  FailoverConfig,
  MultiplexerConfig,
  PluginConfig,
  WebfetchConfig,
} from './schema';
import { getCustomAgentNames } from './utils';

/** A single agent entry from the host opencode.json config. */
export interface HostAgentConfig {
  model?: unknown;
  variant?: unknown;
  temperature?: unknown;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Snapshot of the host opencode config captured before mutation. */
export interface HostConfigSnapshot {
  default_agent?: string;
  agent?: Record<string, HostAgentConfig>;
  mcp?: Record<string, unknown>;
  small_model?: unknown;
  provider?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Per-directory registry backing the singleton instances. */
const registry = new Map<string, RuntimeConfig>();

const DEFAULT_MULTIPLEXER: MultiplexerConfig = {
  type: 'none',
  layout: 'main-vertical',
  main_pane_size: 60,
  zellij_pane_mode: 'agent-tab',
};

const DEFAULT_BACKGROUND_JOBS: BackgroundJobsConfig = {
  strategy: 'latest',
  maxSessionsPerAgent: DEFAULT_MAX_SESSIONS_PER_AGENT,
  maxContextLines: DEFAULT_MAX_CONTEXT_LINES,
  readContextMinLines: DEFAULT_READ_CONTEXT_MIN_LINES,
  readContextMaxFiles: DEFAULT_READ_CONTEXT_MAX_FILES,
  maxRetainedSnapshots: DEFAULT_MAX_RETAINED_SNAPSHOTS,
  orchestratorWake: { enabled: true, intervalMs: 300_000 },
  wallClockTimeoutMs: 0,
  abortGraceMs: 10_000,
  concurrency: {
    defaultConcurrency: 0,
    providerConcurrency: {},
    modelConcurrency: {},
  },
  waitForUserGuard: true,
};

const DEFAULT_FALLBACK: FailoverConfig = {
  enabled: true,
  maxRetries: 3,
  initialRetryDelayMs: 0,
  retryDelayMs: 500,
};

/** First model from an override's model field (string or array). */
function primaryModelFromOverride(
  override: AgentOverrideConfig | undefined,
): string | undefined {
  const model = override?.model;
  if (typeof model === 'string') {
    return model;
  }
  if (Array.isArray(model) && model.length > 0) {
    const first = model[0];
    return typeof first === 'string' ? first : first?.id;
  }
  return undefined;
}

/**
 * Merge agent layers while allowing an explicit inheritance policy to clear a
 * model supplied by a lower-precedence layer. A missing `model` normally
 * means "keep the lower layer", but `inheritModelFrom` is an intentional
 * request to use another source instead.
 */
function mergeAgentOverrides(
  base: Record<string, AgentOverrideConfig>,
  override: Record<string, AgentOverrideConfig>,
): Record<string, AgentOverrideConfig> {
  const merged = deepMerge(base, override) ?? base;
  for (const [name, agentOverride] of Object.entries(override)) {
    if (
      agentOverride.model !== undefined ||
      agentOverride.inheritModelFrom === undefined
    ) {
      continue;
    }
    const resolvedName = AGENT_ALIASES[name] ?? name;
    // A canonical key in the same layer remains authoritative over its
    // legacy alias. Otherwise, apply the alias directive to the canonical
    // lower-layer entry so getOverrideFromAgents sees the effective policy.
    if (resolvedName !== name && Object.hasOwn(override, resolvedName)) {
      continue;
    }
    const entry = merged[resolvedName] ?? merged[name];
    if (entry) {
      const updatedEntry = { ...entry };
      delete updatedEntry.model;
      if (resolvedName !== name) {
        updatedEntry.inheritModelFrom = agentOverride.inheritModelFrom;
      }
      merged[resolvedName] = updatedEntry;
    }
  }
  return merged;
}

/** Recursive clone of plain JSON data (drops prototypes, no functions). */
function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => clonePlain(entry)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = clonePlain(entry);
    }
    return out as unknown as T;
  }
  return value;
}

/** Deep-freeze plain JSON data so snapshot consumers cannot mutate it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Runtime configuration interface: one typed instance per directory.
 *
 * Seed precedence for merged surfaces (host override > runtime override >
 * plugin file) mirrors the config hook's final application order.
 */
export class RuntimeConfig {
  /** Cache-safety marker: never expose volatile text for prompt assembly. */
  readonly isCacheSafe = true as const;

  private constructor() {}

  /**
   * Seed (or re-seed) the plugin file layer for a directory. Re-seeding
   * preserves runtime state (preset switch, model switches) so plugin reloads
   * keep behavior stable, matching the previous module-level singleton.
   */
  static init(directory: string, pluginConfig: PluginConfig): RuntimeConfig {
    const existing = registry.get(directory);
    if (existing) {
      existing.seedPlugin(pluginConfig);
      return existing;
    }
    const instance = new RuntimeConfig();
    instance.seedPlugin(pluginConfig);
    registry.set(directory, instance);
    return instance;
  }

  /** Lazy per-directory accessor; creates an empty instance if unseeded. */
  static get(directory: string): RuntimeConfig {
    let instance = registry.get(directory);
    if (!instance) {
      instance = new RuntimeConfig();
      registry.set(directory, instance);
    }
    return instance;
  }

  /** Remove a directory from the registry (plugin re-init / dispose). */
  static reset(directory: string): void {
    registry.delete(directory);
  }

  private pluginConfig: PluginConfig | undefined;
  private hostSnapshot: HostConfigSnapshot | undefined;
  private runtimePresetName: string | null = null;
  private switchedModels = new Set<string>();

  private seedPlugin(pluginConfig: PluginConfig): void {
    this.pluginConfig = deepFreeze(clonePlain(pluginConfig));
  }

  /**
   * Capture the host opencode config snapshot. MUST be called at the top of
   * the config hook, BEFORE any mutation of opencodeConfig, or consumers see
   * post-merge state (double-application risk).
   */
  captureHostConfig(opencodeConfig: Record<string, unknown>): void {
    this.hostSnapshot = clonePlain(opencodeConfig) as HostConfigSnapshot;
  }

  // ---------------------------------------------------------------------
  // (1) plugin config surface
  // ---------------------------------------------------------------------

  /** Frozen snapshot of the plugin config as loaded at factory start. */
  get plugin(): PluginConfig | undefined {
    return this.pluginConfig;
  }

  /** Active preset name: runtime override wins over the config-file preset. */
  get preset(): string | undefined {
    return this.runtimePresetName ?? this.pluginConfig?.preset;
  }

  /**
   * Merged agent overrides with seed precedence: runtime preset override >
   * plugin file (root agents override the config-file preset). Mirrors the
   * loader's preset merge so this is correct even when seeded with a raw
   * (not yet loader-merged) plugin config.
   */
  agents(): Record<string, AgentOverrideConfig> {
    let base = this.pluginConfig?.agents ?? {};
    const filePreset = this.pluginConfig?.preset
      ? this.pluginConfig.presets?.[this.pluginConfig.preset]
      : undefined;
    if (filePreset) {
      base = mergeAgentOverrides(filePreset, base);
    }
    const runtimePreset = this.runtimePresetAgents();
    if (!runtimePreset) {
      return base;
    }
    return mergeAgentOverrides(base, runtimePreset);
  }

  /**
   * Effective override for one agent, alias-aware, with seed precedence
   * host override > runtime override > plugin file.
   */
  agent(name: string): AgentOverrideConfig | undefined {
    const merged = this.aliasAwareOverride(this.agents(), name);
    const hostLayer = this.hostAgent(name);
    if (!hostLayer) {
      return merged;
    }
    return deepMerge(
      merged as Record<string, unknown> | undefined,
      hostLayer as Record<string, unknown> | undefined,
    ) as AgentOverrideConfig | undefined;
  }

  /** Disabled agent names, minus protected agents. */
  get disabledAgents(): ReadonlySet<string> {
    const userDisabled = this.pluginConfig?.disabled_agents;
    const disabledSource = Array.isArray(userDisabled)
      ? userDisabled
      : DEFAULT_DISABLED_AGENTS;
    const disabled = new Set<string>();
    for (const name of disabledSource) {
      if (!PROTECTED_AGENTS.has(name)) {
        disabled.add(name);
      }
    }
    return disabled;
  }

  get disabledTools(): readonly string[] {
    const value = this.pluginConfig?.disabled_tools;
    return Array.isArray(value) ? value : [];
  }

  get disabledSkills(): readonly string[] {
    const value = this.pluginConfig?.disabled_skills;
    return Array.isArray(value) ? value : [];
  }

  /** Custom agent names declared in config.agents (was getCustomAgentNames). */
  get customAgentNames(): string[] {
    return getCustomAgentNames(this.pluginConfig);
  }

  get disabledMcps(): readonly string[] {
    return this.pluginConfig?.disabled_mcps ?? [];
  }

  /** Final resolved image routing (explicit value or legacy conditional). */
  get imageRouting(): ImageRouting {
    return resolveImageRouting(
      this.pluginConfig?.image_routing,
      !this.disabledAgents.has('observer'),
    );
  }

  get multiplexer(): MultiplexerConfig {
    return this.pluginConfig?.multiplexer ?? DEFAULT_MULTIPLEXER;
  }

  get backgroundJobs(): BackgroundJobsConfig {
    return this.pluginConfig?.backgroundJobs ?? DEFAULT_BACKGROUND_JOBS;
  }

  get fallback(): FailoverConfig {
    return this.pluginConfig?.fallback ?? DEFAULT_FALLBACK;
  }

  get webfetch(): WebfetchConfig {
    return this.pluginConfig?.webfetch ?? { enabled: true };
  }

  get acpAgents(): AcpAgentsConfig {
    return this.pluginConfig?.acpAgents ?? {};
  }

  get companion(): CompanionConfig | undefined {
    return this.pluginConfig?.companion;
  }

  get council(): CouncilConfig | undefined {
    return this.pluginConfig?.council;
  }

  get autoUpdate(): boolean {
    return this.pluginConfig?.autoUpdate ?? true;
  }

  get stripOrchestratorModel(): boolean {
    return this.pluginConfig?.stripOrchestratorModel === true;
  }

  get setDefaultAgent(): boolean {
    return this.pluginConfig?.setDefaultAgent !== false;
  }

  get compactSidebar(): boolean {
    return this.pluginConfig?.compactSidebar ?? true;
  }

  /**
   * Agent name → model array (id + optional variant), derived once from
   * array-configured models. Was modelArrayMap in src/index.ts (built from
   * created agentDefs: disabled agents excluded, alias-aware, variants
   * preserved, plus multi-model councillor chains from council config).
   */
  get modelArrays(): Record<string, Array<{ id: string; variant?: string }>> {
    const arrays: Record<string, Array<{ id: string; variant?: string }>> = {};
    const disabled = this.disabledAgents;
    const agents = this.agents();
    const names = new Set<string>([
      ...ALL_AGENT_NAMES,
      ...getCustomAgentNames(this.pluginConfig),
    ]);
    for (const name of names) {
      if (disabled.has(name)) {
        continue;
      }
      const override = this.aliasAwareOverride(agents, name);
      if (!Array.isArray(override?.model) || override.model.length === 0) {
        continue;
      }
      arrays[name] = override.model.map((entry) =>
        typeof entry === 'string' ? { id: entry } : entry,
      );
    }

    // Multi-model councillors attach _modelArray in buildCouncillorAgents
    // (src/agents/council-agents.ts), which is outside the agents() record.
    // Mirror that derivation so the config hook's model-resolution pass
    // covers councillor chains exactly as the original agentDefs loop did.
    const presetName = this.council?.default_preset ?? 'default';
    const preset = this.council?.presets?.[presetName];
    if (preset) {
      for (const [seat, cfg] of Object.entries(preset)) {
        if (seat === 'master') {
          continue;
        }
        const agentName = `councillor-${seat}`;
        if (disabled.has(agentName) || cfg.models.length <= 1) {
          continue;
        }
        arrays[agentName] = cfg.models;
      }
    }
    return arrays;
  }

  /**
   * Agent name → model chain (ids only), derived from modelArrays.
   * Was runtimeChains in src/index.ts (alias-aware, disabled excluded,
   * councillor chains included).
   */
  get runtimeChains(): Record<string, string[]> {
    const chains: Record<string, string[]> = {};
    for (const [name, models] of Object.entries(this.modelArrays)) {
      chains[name] = models.map((entry) => entry.id);
    }
    return chains;
  }

  /**
   * Primary model from the active preset (orchestrator model, else first
   * subagent model). Was getConfigPrimaryModel in src/agents/index.ts.
   */
  get primaryModel(): string | undefined {
    const activePreset = this.preset
      ? this.pluginConfig?.presets?.[this.preset]
      : undefined;
    if (!activePreset) {
      return undefined;
    }
    const orchestratorModel = primaryModelFromOverride(
      activePreset.orchestrator,
    );
    if (orchestratorModel) {
      return orchestratorModel;
    }
    for (const name of SUBAGENT_NAMES) {
      const model = primaryModelFromOverride(activePreset[name]);
      if (model) {
        return model;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------
  // (2) host config surface
  // ---------------------------------------------------------------------

  /** The captured host opencode config snapshot (pre-mutation). */
  host(): HostConfigSnapshot | undefined {
    return this.hostSnapshot;
  }

  /** The host's opencode.json agent entry for one agent. */
  hostAgent(name: string): HostAgentConfig | undefined {
    return this.hostSnapshot?.agent?.[name];
  }

  /** The host's top-level small_model, when configured. */
  smallModel(): string | undefined {
    const value = this.hostSnapshot?.small_model;
    return typeof value === 'string' ? value : undefined;
  }

  /** The host's top-level mcp record, when configured. */
  hostMcp(): Record<string, unknown> | undefined {
    return this.hostSnapshot?.mcp;
  }

  // ---------------------------------------------------------------------
  // (3) runtime overrides
  // ---------------------------------------------------------------------

  /**
   * Activate a runtime preset (replaces setActiveRuntimePreset). A name that
   * does not exist in plugin.presets clears the selection (stale-state
   * guard, mirrors the previous config-hook reset branch).
   */
  setRuntimePreset(name: string | null): void {
    if (name && this.pluginConfig?.presets?.[name]) {
      this.runtimePresetName = name;
    } else {
      this.runtimePresetName = null;
    }
  }

  getRuntimePreset(): string | null {
    return this.runtimePresetName;
  }

  /** Record that an agent's model was switched at runtime. */
  everModelSwitched(name: string): void {
    this.switchedModels.add(name);
  }

  hasModelSwitched(name: string): boolean {
    return this.switchedModels.has(name);
  }

  // ---------------------------------------------------------------------
  // private helpers
  // ---------------------------------------------------------------------

  private runtimePresetAgents():
    | Record<string, AgentOverrideConfig>
    | undefined {
    const name = this.runtimePresetName;
    if (!name) {
      return undefined;
    }
    return this.pluginConfig?.presets?.[name];
  }

  /** Alias-aware override lookup inside a merged agents record. */
  private aliasAwareOverride(
    agents: Record<string, AgentOverrideConfig>,
    name: string,
  ): AgentOverrideConfig | undefined {
    return (
      agents[name] ??
      agents[
        Object.keys(AGENT_ALIASES).find((key) => AGENT_ALIASES[key] === name) ??
          ''
      ]
    );
  }
}
