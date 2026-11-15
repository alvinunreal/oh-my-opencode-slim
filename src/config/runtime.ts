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
  DEFAULT_CHILD_INPUT_WAKE_KINDS,
  DEFAULT_DISABLED_AGENTS,
  DEFAULT_MAX_SESSIONS_PER_AGENT,
  type ImageRouting,
  PROTECTED_AGENTS,
  resolveImageRouting,
  SUBAGENT_NAMES,
} from './constants';
import type { CouncilConfig } from './council-schema';
import { resolveEffectiveAgentOverrides } from './effective-agent-overrides';
import { type FeatureGates, resolveFeatureGates } from './feature-gates';
import {
  deepMerge,
  mergeAgentOverrides,
  PresetResolutionError,
  resolvePreset,
} from './loader';
import { discoverProjectLocalSkillNames } from './project-skills';
import {
  type AcpAgentsConfig,
  type AgentOverrideConfig,
  type BackgroundJobsConfig,
  type CompanionConfig,
  type FailoverConfig,
  type MultiplexerConfig,
  MultiplexerConfigStrictSchema,
  type ResolvedPluginConfig,
} from './schema';
import {
  getCustomAgentNames,
  legacyAliasesFor,
  lookupWithAliases,
} from './utils';

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
const reloadState = new Map<
  string,
  { hostFlavor?: string; preset: string | null; switchedModels: Set<string> }
>();

const DEFAULT_MULTIPLEXER: MultiplexerConfig =
  MultiplexerConfigStrictSchema.parse({});

const DEFAULT_BACKGROUND_JOBS: BackgroundJobsConfig = {
  mode: 'managed',
  maxSessionsPerAgent: DEFAULT_MAX_SESSIONS_PER_AGENT,
  wallClockTimeoutMs: 0,
  stopConfirmationMs: 5_000,
  concurrency: {
    defaultConcurrency: 0,
    providerConcurrency: {},
    modelConcurrency: {},
  },
  sameProviderPolicy: {},
  waitForUserGuard: true,
  childInputWake: true,
  childInputWakeKinds: { ...DEFAULT_CHILD_INPUT_WAKE_KINDS },
  pruneEvictedSessions: false,
};

const DEFAULT_FALLBACK: FailoverConfig = {
  enabled: true,
  maxRetries: 3,
  initialRetryDelayMs: 0,
  retryDelayMs: 500,
  continuationPolicy: 'retry-primary',
};

/** Shared frozen empty projection so no-ACP generations return one ref. */
const EMPTY_ACP_AGENTS: AcpAgentsConfig = Object.freeze({});

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

  private constructor(
    private readonly directory: string,
    private hostFlavor?: string,
  ) {}

  /**
   * Seed (or re-seed) the plugin file layer for a directory. Re-seeding
   * preserves runtime state (preset switch, model switches) so plugin reloads
   * keep behavior stable, matching the previous module-level singleton.
   */
  static init(
    directory: string,
    pluginConfig: ResolvedPluginConfig,
    hostFlavor?: string,
  ): RuntimeConfig {
    const existing = RuntimeConfig.get(directory);
    if ((existing.hostFlavor === 'v2') !== (hostFlavor === 'v2')) {
      // A directory may be reused by the other adapter in this process; its
      // host snapshot and saved overrides belong to the previous host.
      const instance = new RuntimeConfig(directory, hostFlavor);
      instance.seedPlugin(pluginConfig, hostFlavor);
      registry.set(directory, instance);
      return instance;
    }
    existing.seedPlugin(pluginConfig, hostFlavor);
    return existing;
  }

  /** Create an isolated runtime snapshot for read-only status projections. */
  static createDetached(
    directory: string,
    pluginConfig: ResolvedPluginConfig,
    hostFlavor?: string,
  ): RuntimeConfig {
    const instance = new RuntimeConfig(directory, hostFlavor);
    instance.seedPlugin(pluginConfig, hostFlavor);
    return instance;
  }

  /** Lazy per-directory accessor; creates an empty instance if unseeded. */
  static get(directory: string): RuntimeConfig {
    let instance = registry.get(directory);
    if (!instance) {
      instance = new RuntimeConfig(directory);
      const saved = reloadState.get(directory);
      if (saved) {
        instance.hostFlavor = saved.hostFlavor;
        instance.runtimePresetName = saved.preset;
        instance.switchedModels = saved.switchedModels;
        reloadState.delete(directory);
      }
      registry.set(directory, instance);
    }
    return instance;
  }

  /** Remove a directory from the registry (plugin re-init / dispose). */
  static reset(directory: string): void {
    registry.delete(directory);
    reloadState.delete(directory);
  }

  /** Retain this generation until its owner disposes or initialization fails. */
  acquire(): () => void {
    if (registry.get(this.directory) !== this) {
      throw new Error('Cannot acquire an unregistered runtime config');
    }
    this.owners += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.owners -= 1;
      if (this.owners !== 0 || registry.get(this.directory) !== this) return;
      if (this.runtimePresetName || this.switchedModels.size > 0) {
        reloadState.set(this.directory, {
          hostFlavor: this.hostFlavor,
          preset: this.runtimePresetName,
          switchedModels: new Set(this.switchedModels),
        });
      }
      registry.delete(this.directory);
    };
  }

  private owners = 0;
  private pluginConfig: ResolvedPluginConfig | undefined;
  private featureGatesCache: Readonly<FeatureGates> | undefined;
  private hostSnapshot: HostConfigSnapshot | undefined;
  private runtimePresetName: string | null = null;
  private switchedModels = new Set<string>();
  private localSkillNamesCache: readonly string[] | undefined;
  private agentsCache: Record<string, AgentOverrideConfig> | undefined;
  // Memoized disabled-* sets: computed once per instance per config
  // generation (re-seeding clears them) instead of allocating a fresh Set
  // on every hot-path read.
  private disabledAgentsCache: ReadonlySet<string> | undefined;
  private disabledHooksCache: ReadonlySet<string> | undefined;
  private disabledCommandsCache: ReadonlySet<string> | undefined;
  private acpAgentsCache: AcpAgentsConfig | undefined;

  private seedPlugin(
    pluginConfig: ResolvedPluginConfig,
    hostFlavor?: string,
  ): void {
    const featureGates = resolveFeatureGates(pluginConfig, hostFlavor);
    this.pluginConfig = deepFreeze(clonePlain(pluginConfig));
    this.hostFlavor = hostFlavor;
    this.featureGatesCache = featureGates;
    this.localSkillNamesCache = undefined;
    this.agentsCache = undefined;
    this.disabledAgentsCache = undefined;
    this.disabledHooksCache = undefined;
    this.disabledCommandsCache = undefined;
    this.acpAgentsCache = undefined;
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
  get plugin(): ResolvedPluginConfig | undefined {
    return this.pluginConfig;
  }

  /**
   * Immutable projection of every optional-subsystem switch. Cached for the
   * current config generation; unseeded instances expose the defaults.
   */
  get featureGates(): Readonly<FeatureGates> {
    this.featureGatesCache ??= resolveFeatureGates(
      this.pluginConfig,
      this.hostFlavor,
    );
    return this.featureGatesCache;
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
  agents(
    defaultSkills: Readonly<Record<string, readonly string[]>> = {},
  ): Record<string, AgentOverrideConfig> {
    if (Object.keys(defaultSkills).length === 0) {
      return clonePlain(this.cachedAgents());
    }
    return this.resolveAgents(defaultSkills);
  }

  private cachedAgents(): Record<string, AgentOverrideConfig> {
    this.agentsCache ??= deepFreeze(this.resolveAgents({}));
    return this.agentsCache;
  }

  private resolveAgents(
    defaultSkills: Readonly<Record<string, readonly string[]>>,
  ): Record<string, AgentOverrideConfig> {
    let base = mergeAgentOverrides({}, this.pluginConfig?.agents ?? {});
    const filePreset = this.pluginConfig?.preset
      ? this.resolvedPresetAgents(this.pluginConfig.preset)
      : undefined;
    if (filePreset) {
      base = mergeAgentOverrides(filePreset, base);
    }
    const runtimePreset = this.runtimePresetAgents();
    const merged = runtimePreset
      ? mergeAgentOverrides(base, runtimePreset)
      : base;
    return resolveEffectiveAgentOverrides(
      merged,
      () => this.projectLocalSkillNames(),
      defaultSkills,
    );
  }

  /**
   * Effective override for one agent, alias-aware, with seed precedence
   * host override > runtime override > plugin file.
   */
  agent(name: string): AgentOverrideConfig | undefined {
    const merged = clonePlain(
      this.aliasAwareOverride(this.cachedAgents(), name),
    );
    const hostLayer = this.hostAgent(name) ?? this.hostLegacyAgent(name);
    if (!hostLayer) {
      return merged;
    }
    const hostOverride =
      merged?.model === undefined && merged?.inheritModelFrom !== undefined
        ? Object.fromEntries(
            Object.entries(hostLayer).filter(([key]) => key !== 'model'),
          )
        : hostLayer;
    return deepMerge(
      merged as Record<string, unknown> | undefined,
      hostOverride as Record<string, unknown> | undefined,
    ) as AgentOverrideConfig | undefined;
  }

  /** Disabled agent names, minus protected agents. Legacy alias names
   * (e.g. `librarian`) canonicalize onto their merged agent. */
  get disabledAgents(): ReadonlySet<string> {
    if (this.disabledAgentsCache !== undefined) return this.disabledAgentsCache;
    const userDisabled = this.pluginConfig?.disabled_agents;
    const disabledSource = Array.isArray(userDisabled)
      ? userDisabled
      : DEFAULT_DISABLED_AGENTS;
    const disabled = new Set<string>();
    for (const name of disabledSource) {
      const canonical = AGENT_ALIASES[name] ?? name;
      if (!PROTECTED_AGENTS.has(canonical)) {
        disabled.add(canonical);
      }
    }
    this.disabledAgentsCache = disabled;
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

  /** Hook names disabled via config; empty when none are configured. */
  get disabledHooks(): ReadonlySet<string> {
    if (this.disabledHooksCache === undefined) {
      const value = this.pluginConfig?.disabled_hooks;
      this.disabledHooksCache = new Set(Array.isArray(value) ? value : []);
    }
    return this.disabledHooksCache;
  }

  /** Command names disabled via config; empty when none are configured. */
  get disabledCommands(): ReadonlySet<string> {
    if (this.disabledCommandsCache === undefined) {
      const value = this.pluginConfig?.disabled_commands;
      this.disabledCommandsCache = new Set(Array.isArray(value) ? value : []);
    }
    return this.disabledCommandsCache;
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
    return {
      ...this.resolveChildInputWake(
        this.pluginConfig?.backgroundJobs ?? DEFAULT_BACKGROUND_JOBS,
      ),
      mode: this.featureGates.backgroundJobsMode,
    };
  }

  private resolveChildInputWake(
    backgroundJobs: BackgroundJobsConfig,
  ): BackgroundJobsConfig {
    if (backgroundJobs.childInputWake !== false) return backgroundJobs;
    // #1504: master switch off silences every kind. The scheduler's per-kind
    // gate stays the only runtime gate; the stored config stays raw.
    return {
      ...backgroundJobs,
      childInputWakeKinds: {
        permission: false,
        question: false,
      },
    };
  }

  get fallback(): FailoverConfig {
    return this.pluginConfig?.fallback ?? DEFAULT_FALLBACK;
  }

  /**
   * Active ACP wrapper projection for the current generation: configured
   * agents whose normalized name is not disabled, or a frozen empty object
   * when `acp_run` itself is disabled or no wrapper remains. The raw
   * configured record stays available at `plugin.acpAgents`.
   *
   * Consumers gate ACP registration/roster/catalog on this projection, so a
   * generation with no callable wrapper never constructs the ACP tool or
   * exposes wrapper entries. Names are trimmed exactly like the agent factory
   * (`normalizeCustomAgentName`) so `acpAgents[name]` lookups and disabled
   * matching agree; the configured values are kept as authored.
   */
  get acpAgents(): AcpAgentsConfig {
    if (this.acpAgentsCache !== undefined) return this.acpAgentsCache;
    if (this.disabledTools.includes('acp_run')) {
      this.acpAgentsCache = EMPTY_ACP_AGENTS;
      return this.acpAgentsCache;
    }
    const disabled = this.disabledAgents;
    const active: Record<string, AcpAgentsConfig[string]> = {};
    for (const [rawName, config] of Object.entries(
      this.pluginConfig?.acpAgents ?? {},
    )) {
      // Normalize exactly like the agent factory's wrapper names so
      // `acpAgents[name]` lookups and disabled matching agree; configured
      // values stay untouched.
      const name = rawName.trim();
      if (name.length === 0 || disabled.has(name)) continue;
      active[name] = config;
    }
    this.acpAgentsCache =
      Object.keys(active).length === 0
        ? EMPTY_ACP_AGENTS
        : Object.freeze(active);
    return this.acpAgentsCache;
  }

  get companion(): CompanionConfig | undefined {
    return this.pluginConfig?.companion;
  }

  get council(): CouncilConfig | undefined {
    return this.pluginConfig?.council;
  }

  /**
   * Update checker switch: enabled unless `autoUpdate: false` or the
   * `auto-update-checker` hook is disabled. Both are independent off
   * switches for the same update hook.
   */
  get updateCheckerEnabled(): boolean {
    return this.featureGates.updateChecker;
  }

  /**
   * Resolved background-task lifecycle mode.
   *
   * Only V1 `managed` constructs the board-shaped lifecycle. V2 defaults to
   * `native`, with host delegation controls and independent reply/report
   * tools; `off` registers no OMOS task tools.
   */
  get backgroundJobsMode(): FeatureGates['backgroundJobsMode'] {
    return this.featureGates.backgroundJobsMode;
  }

  /** True only for the managed lifecycle (`mode: "managed"`). */
  get backgroundJobsEnabled(): boolean {
    return this.featureGates.managedJobs;
  }

  get interviewEnabled(): boolean {
    return this.featureGates.interview;
  }

  get sidebarEnabled(): boolean {
    return this.featureGates.sidebar;
  }

  /**
   * v2 live config-file watcher switch. Distinct from model refresh
   * capability: `false` only stops v2 from watching config files on disk —
   * explicit /preset writes still refresh the current generation where
   * applicable.
   */
  get liveConfigRefresh(): boolean {
    return this.featureGates.liveConfigRefresh;
  }

  /**
   * Root-level marketplace kill switch. Distinct from per-preset `marketplace`
   * activation lists: an empty list still activates no agents while the
   * service/store and tool factories stay initialized; `false` ignores any
   * selected package IDs and the manager/store are not initialized at all.
   */
  get marketplaceEnabled(): boolean {
    return this.featureGates.marketplace;
  }

  get stripOrchestratorModel(): boolean {
    return this.pluginConfig?.stripOrchestratorModel === true;
  }

  get routingBlock(): boolean {
    return this.pluginConfig?.routingBlock !== false;
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
    const agents = this.cachedAgents();
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
        typeof entry === 'string' ? { id: entry } : { ...entry },
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
   * The dynamic model source of an agent that combines a fallback model
   * chain (`model: [...]`) with `inheritModelFrom`, or undefined when the
   * agent's model is fully static. Combined agents follow the live
   * session/orchestrator model; the configured chain only serves as the
   * failure fallback, so a runtime `/model` pick must not disable it.
   * Reads the plugin-layer override (agents()), never the host layer, so a
   * host-persisted scalar model cannot mask the configured array.
   */
  combinedModelInheritanceSource(
    name: string,
  ): 'session' | 'orchestrator' | undefined {
    const override = this.aliasAwareOverride(this.cachedAgents(), name);
    if (
      !Array.isArray(override?.model) ||
      override.model.length === 0 ||
      override.inheritModelFrom === undefined
    ) {
      return undefined;
    }
    return override.inheritModelFrom;
  }

  /**
   * Primary model from the active preset (orchestrator model, else first
   * subagent model). Was getConfigPrimaryModel in src/agents/index.ts.
   */
  get primaryModel(): string | undefined {
    const activePreset = this.preset
      ? this.resolvedPresetAgents(this.preset)
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

  private hostLegacyAgent(name: string): HostAgentConfig | undefined {
    return hostLegacyAgent(this.hostSnapshot?.agent, name);
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
    this.agentsCache = undefined;
    const presets = this.pluginConfig?.presets;
    if (!name || !presets || !Object.hasOwn(presets, name)) {
      this.runtimePresetName = null;
      return;
    }
    try {
      resolvePreset(name, presets);
      this.runtimePresetName = name;
    } catch {
      this.runtimePresetName = null;
    }
  }

  getRuntimePreset(): string | null {
    return this.runtimePresetName;
  }

  /** Return the runtime override only when it resolves in this config snapshot. */
  resolveRuntimePreset(
    pluginConfig: ResolvedPluginConfig | undefined = this.pluginConfig,
  ): string | null {
    const name = this.runtimePresetName;
    if (!name || !pluginConfig?.presets?.[name]) return null;
    try {
      resolvePreset(name, pluginConfig.presets);
      return name;
    } catch {
      return null;
    }
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
    return this.resolvedPresetAgents(name);
  }

  private resolvedPresetAgents(
    name: string,
  ): Record<string, AgentOverrideConfig> | undefined {
    const presets = this.pluginConfig?.presets;
    if (!presets || !Object.hasOwn(presets, name)) {
      return undefined;
    }
    try {
      return resolvePreset(name, presets);
    } catch (error) {
      // Loader warnings carry the detailed chain. Runtime can be initialized
      // directly in tests or by embedders, so do not select a partial chain.
      if (!(error instanceof PresetResolutionError)) {
        throw error;
      }
      return undefined;
    }
  }

  private projectLocalSkillNames(): readonly string[] {
    if (this.localSkillNamesCache === undefined) {
      this.localSkillNamesCache = discoverProjectLocalSkillNames(
        this.directory,
        this.hostFlavor,
      );
    }
    return this.localSkillNamesCache;
  }

  /** Alias-aware override lookup inside a merged agents record. */
  private aliasAwareOverride(
    agents: Record<string, AgentOverrideConfig>,
    name: string,
  ): AgentOverrideConfig | undefined {
    return lookupWithAliases(agents, name);
  }
}

/**
 * Host agent entry under a pre-rename plugin agent name (e.g. host
 * `agent.librarian` keeps feeding the merged `explorer`). Host-native
 * alias namespaces (v2 `explore`) are excluded: those entries describe
 * the host's own agent, never the plugin's.
 */
export function hostLegacyAgent(
  hostAgents: Record<string, HostAgentConfig> | undefined,
  name: string,
): HostAgentConfig | undefined {
  if (!hostAgents) return undefined;
  for (const legacyName of legacyAliasesFor(name)) {
    if (legacyName === 'explore') continue;
    const entry = hostAgents[legacyName];
    if (entry) return entry;
  }
  return undefined;
}
