import type { Hooks, Plugin, ToolDefinition } from '@opencode-ai/plugin';
import {
  type AgentModelProjection,
  type AgentRuntimeProfiles,
  createAgentInferenceViews,
  createAgents,
  getAgentConfigsFromDefinitions,
  isSubagent,
  mergeHostAgentConfigs,
  projectAgentRuntimeState,
} from './agents';
import {
  type AgentDefinition,
  buildOrchestratorPrompt,
} from './agents/orchestrator';
import {
  buildResolvedAgentRegistry,
  type RegistryHostSnapshot,
  type ResolvedAgentRegistry,
} from './agents/registry';
import type { RegistryFactoryBridge } from './agents/registry-bridge';
import type { CompanionManager } from './companion/manager';
import { normalizeCompanionSessionStatus } from './companion/status';
import { deepMerge, type loadPluginConfig, type Preset } from './config';
import {
  BUILTIN_OPENCODE_SUBAGENTS_TO_DISABLE,
  DEFAULT_MAX_SESSION_METADATA_ENTRIES,
  TOAST_DURATION_MS,
} from './config/constants';
import type { ConfigLoadWarningKind } from './config/loader';
import { RuntimeConfig } from './config/runtime';
import {
  cloneConfigValue,
  type PluginConfigSnapshot,
  readPluginConfigSnapshot,
} from './config/snapshot';
import { getBuildInfo } from './generated/build-info';
import {
  HEALTH_CHECK,
  minimumExpectedAgentCount,
  minimumExpectedToolCount,
} from './health-check';
import type { createAbsolutePathRescueHook } from './hooks/absolute-path-rescue';
import type { createApplyPatchHook } from './hooks/apply-patch';
import type { createCacheMonitorHook } from './hooks/cache-monitor';
import { stripTaggedContents } from './hooks/cache-safe-injection';
import type { createChatHeadersHook } from './hooks/chat-headers';
import { isCommandEnabled } from './hooks/command-hook-utils';
import {
  COUNCIL_INJECT_METADATA_KEY,
  createCouncilInjectHook,
} from './hooks/council-inject';
import type { createCouncilSeatHook } from './hooks/council-seats';
import type { createDeepworkCommandHook } from './hooks/deepwork';
import {
  createDeepworkGoalHook,
  createDeepworkHeadGate,
  GOAL_POINTER_METADATA_KEY,
} from './hooks/deepwork-goal';
import type { ForegroundFallbackManager } from './hooks/foreground-fallback';
import { isImagePart, processImageAttachments } from './hooks/image-hook';
import { createMessageTransformView } from './hooks/message-transform-view';
import {
  createPhaseReminderHook,
  PHASE_REMINDER_METADATA_KEY,
} from './hooks/phase-reminder';
import type { createReflectCommandHook } from './hooks/reflect';
import type { createSearchPathGuardHook } from './hooks/search-path-guard';
import { SessionLifecycle } from './hooks/session-lifecycle';
import type { ToolLoopGuardHook } from './hooks/tool-loop-guard/hook';
import type { MessageWithParts } from './hooks/types';
import type { collapseInterviewHistory } from './interview/history';
import type { createInterviewService } from './interview/service';
import { retryMarketplaceLeases } from './marketplace/lease';
import type { MarketplaceRegistryImplementation } from './marketplace/registry-runtime';
import type { MarketplaceService } from './marketplace/service';
import {
  missingMarketplaceSkills,
  skillIdsFromResponse,
} from './marketplace/skills';
import { resolveDesiredMarketplacePackageIds } from './marketplace/status';
import { createBuiltinMcps, getOverriddenBuiltinMcpKeys } from './mcp';
import type { createAcpRunTool } from './tools/acp-run';
import type { createWebfetchTool } from './tools/smartfetch';
import {
  clearTuiAgentActivities,
  collectAgentColors,
  collectAgentDisplayNames,
  flushTuiSnapshotBatch,
  readTuiSessionParents,
  recordTuiAgentActivity,
  recordTuiAgentModel,
  recordTuiAgentModels,
  recordTuiSessionParent,
  withTuiSnapshotBatch,
} from './tui-state';
import {
  createDisplayNameMentionRewriter,
  normalizeAgentName,
  resolveRuntimeAgentName,
} from './utils/agent-variant';
import { isPluginDisabledByEnv } from './utils/env';
import {
  createEventDirectoryScope,
  type EventDirectoryScope,
} from './utils/event-directory-scope';
import { resolveEventSessionID } from './utils/event-session-id';
import {
  isInternalInitiatorPart,
  isNativeBackgroundTaskNotification,
} from './utils/internal-initiator';
import { probeJSDOM } from './utils/jsdom';
import { initLogger, log } from './utils/logger';
import {
  type ModelImageCapabilityCache,
  type ModelImageCapabilityDeps,
  modelAcceptsImageInput,
} from './utils/model-image-capability';
import { parseModelReference, withTimeout } from './utils/session';
import { SessionMetadataStore } from './utils/session-metadata';
import {
  collapseSystemInPlace,
  looksLikeMainChatRequest,
} from './utils/system-collapse';
import { parseModelRef } from './v2/adapters';
import { delegationWording } from './v2/delegation';
import {
  isInternalAdmission,
  recordInternalAdmission,
} from './v2/internal-admissions';
import type { SessionTeamBundle } from './v2/session-presets';

/**
 * Best-effort log to opencode's app logger.
 * Wrapped in try/catch to avoid deadlocking on opencode v1.4.8–v1.4.9
 * where client.app.log() during init triggers a middleware cycle.
 */
async function appLog(
  ctx: Parameters<Plugin>[0],
  level: 'error' | 'warn' | 'info',
  message: string,
): Promise<void> {
  try {
    await ctx.client.app.log({
      body: { service: 'oh-my-opencode-slim', level, message },
    });
  } catch {
    // client.app.log may deadlock or be unavailable; stderr is the
    // fallback
    const prefix =
      level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO';
    console.error(`[oh-my-opencode-slim] ${prefix}: ${message}`);
  }
}

// Debounce: only show the retained-inline image warning once per project
// every 60 seconds.
const lastImageRetainedToastByDir = new Map<string, number>();
const IMAGE_RETAINED_TOAST_DEBOUNCE_MS = 60_000;

type ModelChainEntry = { id: string; variant?: string };

/**
 * Build one complete fallback-chain generation — the chain table a fresh boot
 * with `rt`'s config would publish. Precedence mirrors the registry's
 * `modelCandidates` construction (registry.ts): configured chains
 * (`rt.modelArrays`) win, then declared `_modelArray` chains (definition-set
 * names: orchestrator overrides, config arrays invisible to the getter such
 * as disabled agents), then the registry's candidates for names outside the
 * definition set (marketplace agents, aliases, display names). Publishers
 * swap the published table's contents with this result in one synchronous
 * step (see publishChainGeneration).
 */
function buildChainGeneration(
  rt: RuntimeConfig,
  defs: readonly AgentDefinition[],
  candidates:
    | Readonly<Record<string, readonly { id: string; variant?: string }[]>>
    | undefined,
): Record<string, ModelChainEntry[]> {
  const copyEntries = (
    entries: readonly { id: string; variant?: string }[],
  ): ModelChainEntry[] =>
    entries.map(({ id, variant }) => ({
      id,
      ...(variant ? { variant } : {}),
    }));
  const table: Record<string, ModelChainEntry[]> = {};
  for (const [name, models] of Object.entries(rt.modelArrays)) {
    if (models.length > 0) table[name] = copyEntries(models);
  }
  for (const def of defs) {
    if (table[def.name] || (def._modelArray?.length ?? 0) <= 1) continue;
    table[def.name] = copyEntries(def._modelArray ?? []);
  }
  if (candidates) {
    const known = new Set(defs.map((def) => def.name));
    for (const [name, entries] of Object.entries(candidates)) {
      if (table[name] || known.has(name) || entries.length <= 1) continue;
      table[name] = copyEntries(entries);
    }
  }
  return table;
}

type DelegatedModelSelection = {
  agentName: string;
  entry: ModelChainEntry;
  /** Inherited children already start on the parent's live model. */
  inherited?: true;
};

/**
 * Independent children leave only providers confirmed down by the parent.
 * Explicit inheritance follows the parent's live model for either error scope.
 */
function selectDelegatedModel(input: {
  agentName: string;
  childChain: ModelChainEntry[] | undefined;
  followsParent: boolean;
  parentModel: string | undefined;
  activeFallback: ReturnType<ForegroundFallbackManager['getActiveFallback']>;
}): DelegatedModelSelection | undefined {
  const { agentName, childChain, parentModel, activeFallback } = input;
  if (!parentModel) return undefined;

  if (input.followsParent) {
    return {
      agentName,
      entry: childChain?.find((entry) => entry.id === parentModel) ?? {
        id: parentModel,
      },
      inherited: true,
    };
  }

  if (!childChain?.length || !activeFallback) return undefined;
  const { downProviders } = activeFallback;
  const primaryProvider = parseModelReference(childChain[0].id)?.providerID;
  if (!primaryProvider || !downProviders.has(primaryProvider)) return undefined;
  const entry = childChain.find((entry) => {
    const provider = parseModelReference(entry.id)?.providerID;
    return provider !== undefined && !downProviders.has(provider);
  });
  return entry ? { agentName, entry } : undefined;
}

// Module-level runtime preset tracking. Survives plugin re-inits triggered
// by client.config.update() → Instance.dispose(). When the plugin function
// re-runs, it checks this variable and applies the runtime preset instead
// of the config file's preset. State lives in RuntimeConfig.

/**
 * Result of the v2-only `v2.refreshProfiles` hook. `ok: true` carries the
 * freshly resolved inference profiles plus the sidebar projection that was
 * already written; `ok: false` carries the failure reason and guarantees no
 * state was swapped.
 */
export type V2ProfileRefreshResult =
  | {
      ok: true;
      profiles: AgentRuntimeProfiles;
      projection: AgentModelProjection;
      bundle: SessionTeamBundle;
      /** Resolved from the loader's fallback config, not a strict load. */
      fallback: boolean;
    }
  | { ok: false; reason: string };

/**
 * Config-load warning kinds that make a live profile refresh a hard failure.
 *
 * `loadPluginConfig` is deliberately non-fatal: malformed JSON or a schema
 * violation falls back to `{}` and reports through `onWarning`. A refresh
 * that ignored those warnings would report ok and swap the profile table +
 * sidebar projection to defaults (silently wiping every agent model). These
 * kinds therefore abort the refresh before any state is swapped; actionable
 * warning-only kinds (`missing-preset`, `normalized`) stay non-fatal.
 */
export const HARD_PROFILE_REFRESH_WARNING_KINDS: ReadonlySet<ConfigLoadWarningKind> =
  new Set(['invalid-json', 'invalid-schema', 'read-error']);

export const OhMyOpenCodeLite: Plugin = async (ctx) => {
  initLogger();
  log('[plugin] build info', getBuildInfo());

  if (isPluginDisabledByEnv()) {
    log('[plugin] disabled by OH_MY_OPENCODE_SLIM_DISABLE');
    return {};
  }

  // Directory scope (multi-instance): created inside the init try so every
  // exit path releases its live-directory claim (see the catch below).
  let eventDirectoryScope: EventDirectoryScope | undefined;

  // Observation-only prompt-cache watchdog. Created after runtime init and
  // only when `disabled_hooks` does not list "cache-monitor"; the event
  // path below uses optional chaining so a gated generation never calls
  // it. Every non-gated event of this location still reaches the monitor.
  let cacheMonitor: ReturnType<typeof createCacheMonitorHook> | undefined;

  // Declare variables that must survive the try/catch for the return
  // closure. These are set inside the try block.
  let config: ReturnType<typeof loadPluginConfig>;
  let startupConfigSnapshot: PluginConfigSnapshot;
  let runtime: RuntimeConfig;
  // Per-generation image capability cache; the config hook drops the
  // cached promise on config changes and each factory run starts fresh.
  const imageCapabilityCache: ModelImageCapabilityCache = {};
  let agentDefs: ReturnType<typeof createAgents>;
  const isOrchestratorAgent = (agent: string | undefined): boolean =>
    agent === 'orchestrator' ||
    (!!agent && resolveRuntimeAgentName(runtime, agent) === 'orchestrator');
  let agents: ReturnType<typeof getAgentConfigsFromDefinitions>;
  let resolvedAgentRegistry: ResolvedAgentRegistry | undefined;
  let latestHostSnapshot: RegistryHostSnapshot | undefined;
  let hostSnapshotProvenance: 'unknown' | 'clean' = 'unknown';
  let latestNativePermissionsByAgent: Readonly<
    Record<string, readonly import('./v2/types').V2PermissionRule[]>
  > = {};
  let registryRetired = false;
  let mcps: ReturnType<typeof createBuiltinMcps>;
  // MCP entries this hook itself injected on the previous config() pass.
  // A re-invoked config() can hand back the object we already mutated
  // (built-ins merged in); without this, those built-ins would be misread
  // as user-authored and pruned from the live export (issue #1290).
  let injectedMcps: Record<string, unknown> = {};
  const hostFlavor = 'v2';
  let instanceDisposed = false;
  let companionStartupAbort: AbortController | undefined;
  const marketplaceLeaseAbort = new AbortController();
  const sessionMetadata = new SessionMetadataStore({
    maxEntries: DEFAULT_MAX_SESSION_METADATA_ENTRIES,
    isOrchestratorAgent,
    onEvict: (sessionID) => {
      log('[session] evicted oldest session metadata', {
        threshold: DEFAULT_MAX_SESSION_METADATA_ENTRIES,
        droppedSessionId: sessionID,
      });
    },
  });
  const compactingSessionIds = new Set<string>();
  const ownedTuiActivitySessions = new Map<string, string>();
  // Busy/retry arrived before the session's agent was known. chat.message
  // latches the agent and flushes these so the spinner still starts. The
  // observed status is kept so the flushed activation records the right
  // sidebar detail (busy vs retry).
  const pendingTuiBusySessions = new Map<string, 'busy' | 'retry'>();
  const tuiActivityDirectory = (sessionID: string): string => {
    return sessionMetadata.getDirectory(sessionID) ?? ctx.directory;
  };
  // Server-side TUI state writes exist only for the sidebar surface. With
  // the sidebar disabled, every recorder call becomes a no-op: no snapshot
  // reads, no parent hydration, no state-file writes from this process.
  // (Pane wiring lives in the TUI entry and never reads these files.)
  const tuiWritesEnabled = (): boolean => runtime.sidebarEnabled;
  const projectLiveAgentModel = (
    sessionID: string,
    agentName: string,
    model: string,
    variant?: string,
  ): void => {
    if (!tuiWritesEnabled()) return;
    recordTuiAgentModel(
      { agentName, model, variant: variant ?? null, sessionID },
      tuiActivityDirectory(sessionID),
    );
  };
  // Busy/retry arrived before the session's agent was known. chat.message
  // latches the agent and flushes these so the spinner still starts. The
  // observed status is kept so the flushed activation records the right
  // sidebar detail (busy vs retry).
  const markTuiAgentActive = (
    sessionID: string,
    agentName: string,
    status?: 'busy' | 'retry',
  ): void => {
    if (!tuiWritesEnabled()) return;
    const directory = tuiActivityDirectory(sessionID);
    const details = status ? { status } : undefined;
    recordTuiAgentActivity(
      {
        sessionID,
        agentName,
        active: true,
        ...(details ? { details } : {}),
      },
      directory,
    );
    ownedTuiActivitySessions.set(sessionID, directory);
    void hydrateTuiSessionParent(sessionID, directory);
  };
  // Sessions whose child→parent link is missing ask the host and walk up
  // to a confirmed root. Only confirmed roots and in-flight lookups stay
  // in this set; a valid response without parentID is a final answer
  // (top-level chat).
  const hydratedTuiParents = new Set<string>();
  const hydrateTuiSessionParent = async (
    startSessionID: string,
    directory: string,
  ): Promise<void> => {
    if (!tuiWritesEnabled()) return;
    const sessionApi = (ctx as { client?: { session?: { get?: unknown } } })
      .client?.session;
    if (typeof sessionApi?.get !== 'function') return;
    const lookup = sessionApi.get as (input: {
      path: { id: string };
      query: { directory: string };
    }) => Promise<{ data?: unknown; error?: unknown; parentID?: unknown }>;
    const visited = new Set<string>();
    let parents = readTuiSessionParents(directory);
    let current = startSessionID;
    while (!visited.has(current)) {
      visited.add(current);
      const known = parents[current];
      if (known !== undefined) {
        current = known; // Persisted link; keep walking toward the root.
        continue;
      }
      if (hydratedTuiParents.has(current)) return;
      hydratedTuiParents.add(current);
      let parentID: unknown;
      try {
        // Call with the session object as receiver: the SDK's generated
        // method reads `this._client` (#595 class of regression).
        const response = await lookup.call(sessionApi, {
          path: { id: current },
          query: { directory },
        });
        if (response?.error !== undefined) {
          // HTTP error resolved instead of thrown: release the slot so a
          // later activity can retry.
          hydratedTuiParents.delete(current);
          return;
        }
        const info = response?.data;
        if (info === null || typeof info !== 'object') {
          // Malformed response outside the host contract: release the
          // slot rather than caching "confirmed root" on garbage.
          hydratedTuiParents.delete(current);
          return;
        }
        parentID = (info as { parentID?: unknown }).parentID;
      } catch {
        hydratedTuiParents.delete(current);
        return;
      }
      if (typeof parentID === 'string' && parentID !== current) {
        recordTuiSessionParent(current, parentID, directory);
        hydratedTuiParents.delete(current);
        current = parentID;
        parents = readTuiSessionParents(directory);
        continue;
      }
      if (parentID !== undefined && parentID !== null) {
        // Malformed non-string parent: release the slot so a later
        // activity can retry instead of caching a false confirmed root.
        hydratedTuiParents.delete(current);
      }
      // Valid response without a parent: confirmed root, stop.
      return;
    }
  };
  const markTuiAgentInactive = (sessionID: string): void => {
    pendingTuiBusySessions.delete(sessionID);
    if (!tuiWritesEnabled()) return;
    const directory =
      ownedTuiActivitySessions.get(sessionID) ??
      tuiActivityDirectory(sessionID);
    recordTuiAgentActivity({ sessionID, active: false }, directory);
    ownedTuiActivitySessions.delete(sessionID);
  };
  const clearTuiActivities = (): void => {
    if (!tuiWritesEnabled()) {
      ownedTuiActivitySessions.clear();
      return;
    }
    for (const [sessionID, directory] of ownedTuiActivitySessions) {
      recordTuiAgentActivity({ sessionID, active: false }, directory);
    }
    ownedTuiActivitySessions.clear();
  };
  let sessionLifecycle: SessionLifecycle | undefined;
  // Mirror of the runtime fallback switches, hoisted out of the try so the
  // returned hooks object can gate v2-only surfaces (retry registration).
  let fallbackRetryHookEnabled = false;

  let chatHeadersHook: ReturnType<typeof createChatHeadersHook> | undefined;
  let foregroundFallback: ForegroundFallbackManager | undefined;
  let foregroundFallbackChains: Record<string, ModelChainEntry[]> = {};
  let sessionTeamFor:
    | ((sessionID: string) => SessionTeamBundle | undefined)
    | undefined;
  let selectedMarketplacePackageIds: readonly string[] = [];
  let deepworkCommandHook:
    | ReturnType<typeof createDeepworkCommandHook>
    | undefined;
  let reflectCommandHook:
    | ReturnType<typeof createReflectCommandHook>
    | undefined;
  let phaseReminder: ReturnType<typeof createPhaseReminderHook> | undefined;
  let deepworkGoal: ReturnType<typeof createDeepworkGoalHook> | undefined;
  let councilInject: ReturnType<typeof createCouncilInjectHook> | undefined;
  let councilSeatHook: ReturnType<typeof createCouncilSeatHook> | undefined;
  let applyPatch: ReturnType<typeof createApplyPatchHook> | undefined;
  let searchPathGuard: ReturnType<typeof createSearchPathGuardHook> | undefined;
  let absolutePathRescue:
    | ReturnType<typeof createAbsolutePathRescueHook>
    | undefined;
  let toolLoopGuard: ToolLoopGuardHook | undefined;
  let jsonErrorRecoveryAfter:
    | ((i: unknown, o: unknown) => Promise<void>)
    | undefined;
  let releaseRuntimeConfig: (() => void) | undefined;
  let collapseActiveInterviewHistory:
    | typeof collapseInterviewHistory
    | undefined;
  let companionManager: CompanionManager | undefined;
  let interviewSubmitService:
    | ReturnType<typeof createInterviewService>
    | undefined;
  let acpRunTools: Record<string, ReturnType<typeof createAcpRunTool>>;
  let webfetch: ReturnType<typeof createWebfetchTool> | undefined;
  let tools: Record<string, ToolDefinition>;
  let rewriteDisplayNameMentions: ReturnType<
    typeof createDisplayNameMentionRewriter
  >;

  /** Swap the published chain table's contents in one synchronous step, then
   *  re-apply the model-switch disables through the manager's own method.
   *  Never rebind `foregroundFallbackChains`: the manager's chainSource
   *  aliases this record and sessions pin shallow copies of it — publishers
   *  replace entry arrays and never mutate them in place. */
  function publishChainGeneration(
    next: Record<string, ModelChainEntry[]>,
    rt: RuntimeConfig,
    isSwitched: (agentName: string) => boolean,
  ): void {
    for (const name of Object.keys(foregroundFallbackChains)) {
      if (!(name in next)) delete foregroundFallbackChains[name];
    }
    Object.assign(foregroundFallbackChains, next);
    // Keyed on the published table, not rt.modelArrays: a switched agent's
    // new generation may resolve its chain from _modelArray or registry
    // candidates after its config array disappears — the disable must
    // survive that source change.
    for (const name of Object.keys(foregroundFallbackChains)) {
      if (
        rt.combinedModelInheritanceSource(name) === undefined &&
        isSwitched(name)
      ) {
        foregroundFallback?.disableChain(name);
      }
    }
  }

  const liveSessionModel = (sessionID: string): string | undefined =>
    foregroundFallback?.getActiveFallback(sessionID)?.model ??
    sessionMetadata.getModel(sessionID);

  const resolveDelegatedModelForParent = (
    agentType: string,
    parentSessionID?: string,
    capturedBundle?: SessionTeamBundle | null,
  ): DelegatedModelSelection | undefined => {
    if (!parentSessionID) return undefined;
    const agentName = resolveRuntimeAgentName(runtime, agentType);
    const bundle =
      capturedBundle === undefined
        ? sessionTeamFor?.(parentSessionID)
        : capturedBundle;
    const inheritance = bundle
      ? (bundle.inheritance[agentType] ?? bundle.inheritance[agentName])
      : runtime.agent(agentName)?.inheritModelFrom;
    const followsParent =
      inheritance === 'orchestrator' || inheritance === 'session';
    return selectDelegatedModel({
      agentName,
      // Cross-generation rule: the child registers with the CURRENT chain
      // generation at launch (the same generation as its frozen profile),
      // while the parent's downProviders are provider names and carry over
      // across generations unchanged.
      childChain: bundle
        ? bundle.fallbackEnabled
          ? (bundle.chains[agentType] ?? bundle.chains[agentName])
          : undefined
        : foregroundFallbackChains[agentName],
      followsParent,
      // External-selection metadata deliberately ignores internal fallback
      // replays (#1079). Delegation needs the opposite view: the model
      // actually executing this parent turn, or children will be launched
      // back onto the provider the parent just escaped.
      parentModel: liveSessionModel(parentSessionID),
      activeFallback: foregroundFallback?.getActiveFallback(parentSessionID),
    });
  };

  try {
    // Directory scope (multi-instance): the host loads this plugin once per
    // location and broadcasts every event to every instance in the process.
    const directory = ctx.directory;
    eventDirectoryScope = createEventDirectoryScope(directory);
    log('[plugin] instance scope', { directory });

    startupConfigSnapshot =
      (
        ctx as Parameters<Plugin>[0] & {
          pluginConfigSnapshot?: PluginConfigSnapshot;
        }
      ).pluginConfigSnapshot ??
      readPluginConfigSnapshot(ctx.directory, { hostFlavor });
    for (const warning of startupConfigSnapshot.warnings) {
      log('[plugin] config warning', warning);
      console.warn(
        `[oh-my-opencode-slim] ${warning.path}: ${warning.message}`,
        warning.formatted ?? '',
      );
    }
    config = cloneConfigValue(startupConfigSnapshot.config);
    // Seed the per-directory runtime registry with the raw plugin file
    // config. The runtime preset reapplication below mutates `config` for
    // legacy consumers; RuntimeConfig keeps the pre-mutation snapshot and
    // derives preset/runtime state through its own getters.
    const runtimeConfig = RuntimeConfig.init(ctx.directory, config, hostFlavor);
    releaseRuntimeConfig = runtimeConfig.acquire();

    // Safety net: instance disposal reruns the plugin factory and rebuilds
    // factory-local state, while module-level runtime preset state may persist.
    // Reapply that persisted preset so each fresh generation creates agents
    // with the correct models.
    const previousRuntimePreset = runtimeConfig.getRuntimePreset();
    const runtimePreset = runtimeConfig.resolveRuntimePreset(config);
    if (runtimePreset) {
      config.preset = runtimePreset;
      // Re-merge runtime preset into config.agents (loadPluginConfig
      // already merged the config-file preset, not the runtime one).
      // Runtime preset is override so it wins over config-file preset.
      const presetAgents = config.presets?.[runtimePreset];
      if (!presetAgents) {
        throw new Error(
          `Resolved runtime preset '${runtimePreset}' is missing`,
        );
      }
      config.agents = deepMerge(config.agents, presetAgents);
    } else if (previousRuntimePreset) {
      // Preset was deleted from config since last switch - clear stale state
      runtimeConfig.setRuntimePreset(null);
    }

    runtime = RuntimeConfig.get(ctx.directory);

    // Observation-only prompt-cache watchdog: created once the runtime
    // config is known so `disabled_hooks: ["cache-monitor"]` skips
    // construction (and the implementation load) entirely (fail-open by
    // design: no creation, no call).
    if (!runtime.disabledHooks.has('cache-monitor')) {
      const { createCacheMonitorHook } = await import('./hooks/cache-monitor');
      cacheMonitor = createCacheMonitorHook();
    }

    // Sidebar master switch: with `sidebar: false` the server entry never
    // writes TUI state, so the previous generation's stale active-session
    // marks are left to the client surface that owns them.
    if (runtime.sidebarEnabled) {
      clearTuiAgentActivities(ctx.directory);
    }

    // lifecycle, native controls, AST-grep, final registration filter).
    const disabledToolNames = new Set(runtime.disabledTools);
    const activePresetName = runtime.getRuntimePreset() ?? config.preset;
    selectedMarketplacePackageIds = resolveDesiredMarketplacePackageIds(
      config,
      activePresetName,
    );
    rewriteDisplayNameMentions = createDisplayNameMentionRewriter(runtime);
    const delegation = delegationWording(hostFlavor);
    // Slash-command hooks are lifecycle-independent, but disabled commands
    // need neither a handler nor its captured state.
    const commandOptions = {
      disabledCommands: runtime.disabledCommands,
      disabledSkills: runtime.disabledSkills,
    };
    if (isCommandEnabled('deepwork', commandOptions)) {
      // Dynamically loaded: the command bundles the deepwork SKILL.md text,
      // so a disabled command must not pay for it.
      const { createDeepworkCommandHook } = await import('./hooks/deepwork');
      deepworkCommandHook = createDeepworkCommandHook();
    }
    if (isCommandEnabled('reflect', commandOptions)) {
      const { createReflectCommandHook } = await import('./hooks/reflect');
      reflectCommandHook = createReflectCommandHook();
    }
    agentDefs = createAgents(runtime, {
      projectDirectory: ctx.directory,
      hostFlavor,
    });
    agents = getAgentConfigsFromDefinitions(runtime, agentDefs);

    mcps = createBuiltinMcps(runtime.disabledMcps);
    const acpAgentEntries = Object.keys(runtime.acpAgents ?? {});
    acpRunTools =
      acpAgentEntries.length > 0
        ? {
            acp_run: (await import('./tools/acp-run')).createAcpRunTool(
              runtime.acpAgents,
            ),
          }
        : {};
    if (runtime.featureGates.webfetch) {
      const { createWebfetchTool } = await import('./tools/smartfetch');
      webfetch = createWebfetchTool(ctx);
    }
    sessionLifecycle = new SessionLifecycle(log);
    sessionLifecycle.onSessionDeleted((sessionID) => {
      compactingSessionIds.delete(sessionID);
    });

    // Initialize hooks and wrapPostToolHook helper for error isolation

    // Wrap tool.execute.after handlers with per-hook error isolation.
    // Preserves the old runPostToolHook behavior: one failing hook doesn't
    // block the rest.
    const wrapPostToolHook = (
      name: string,
      fn: (i: unknown, o: unknown) => Promise<void>,
    ): ((i: unknown, o: unknown) => Promise<void>) => {
      return async (i, o) => {
        try {
          await fn(i, o);
        } catch (error) {
          const meta = i as {
            tool?: string;
            sessionID?: string;
            callID?: string;
          };
          log('[plugin] post-tool hook failed open', {
            hook: name,
            tool: meta.tool,
            sessionID: meta.sessionID,
            callID: meta.callID,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
    };

    if (!runtime.disabledHooks.has('phase-reminder')) {
      phaseReminder = createPhaseReminderHook();
    }

    // Deepwork goal pointer: re-derives one state-neutral pointer from disk
    // truth every request so the session's router-head path survives
    // compaction. Gate: orchestrator session with an active head on disk.
    // Switch: list "deepwork-goal" in disabled_hooks (disabled = never
    // injected).
    if (!runtime.disabledHooks.has('deepwork-goal')) {
      const headGate = createDeepworkHeadGate(ctx.directory);
      deepworkGoal = createDeepworkGoalHook({
        isEligible: (sessionID) =>
          sessionMetadata.getAgent(sessionID) === 'orchestrator' &&
          headGate(sessionID),
      });
    }

    // Keyword-triggered Council Mode injection: per-message eligibility just
    // like the phase reminder, scoped to sessions with configured councillor
    // seats. The seat gate uses the same agentDefs the orchestrator prompt's
    // seat pointer lists; the injected block no longer enumerates seats (the
    // pointer already does), so the hook only needs the delegation wording.
    if (!runtime.disabledHooks.has('council-inject')) {
      const councilSeats = agentDefs
        .filter((a) => a.name.startsWith('councillor-'))
        .map((a) => a.name);
      // The block dispatches the seats in the orchestrator's `## Council`
      // roster; a delegation scope without `council` drops that roster, so
      // the procedure would target denied agents (issue #1591).
      const orchestratorPrompt = agentDefs.find(
        (a) => a.name === 'orchestrator',
      )?.config.prompt;
      if (
        councilSeats.length > 0 &&
        orchestratorPrompt?.includes('\n## Council\nSeats: ')
      ) {
        councilInject = createCouncilInjectHook({ wording: delegation });
      }
    }

    // disabled_hooks: "chat-headers" keeps the hook unregistered on both
    // hosts — the v2 bridge reads v1Hooks['chat.headers'] and skips the
    // model.request registration when the key is absent.
    if (!runtime.disabledHooks.has('chat-headers')) {
      const { createChatHeadersHook } = await import('./hooks/chat-headers');
      chatHeadersHook = createChatHeadersHook(ctx);
    }

    // Host retries switch models in place. Keep the retry hook registered
    // when the feature is off at startup so a session preset can enable it.
    const fallbackUserEnabled =
      runtime.fallback.enabled !== false &&
      !runtime.disabledHooks.has('foreground-fallback');
    const fallbackManagerNeeded = !runtime.disabledHooks.has(
      'foreground-fallback',
    );
    fallbackRetryHookEnabled = fallbackManagerNeeded;
    if (fallbackUserEnabled) {
      log(
        '[foreground-fallback] v2 replay fallback disabled (no atomic per-turn model switch); retry-hook steering active',
      );
    }
    // Startup generation: captured here and republished (contents swap) by
    // registry finalize and every successful profile refresh. The manager
    // aliases this record; see publishChainGeneration.
    foregroundFallbackChains = runtime.modelArrays;
    if (fallbackManagerNeeded) {
      // The handoff module is consumed only by this manager; load it in the
      // same breath (parallel, never when the manager is skipped) and only
      const fallbackModule = await import('./hooks/foreground-fallback');
      foregroundFallback = new fallbackModule.ForegroundFallbackManager({
        chains: foregroundFallbackChains,
        enabled: false,
        input: ctx,
        maxRetries: runtime.fallback.maxRetries,
        coordinator: sessionLifecycle,
        // A managed background-task session switching models mid-flight must
        // move its admission accounting (provider/model caps) to the new
        // model. No-op for unknown/non-task sessions; idempotent per model.
        onSessionModelChanged: (sessionID, model, detail) => {
          if (detail?.agentName) {
            projectLiveAgentModel(
              sessionID,
              resolveRuntimeAgentName(runtime, detail.agentName),
              model,
              detail.variant,
            );
          }
        },
        initialRetryDelayMs: runtime.fallback.initialRetryDelayMs,
        retryDelayMs: runtime.fallback.retryDelayMs,
        v2RetryEnabled: fallbackUserEnabled,
      });
    }

    // P0 cold gating: each on-demand tool guard is only constructed when
    // its disabled_hooks entry is absent, so a disabled guard performs no
    // construction work or per-tool-call work.
    if (!runtime.disabledHooks.has('apply-patch')) {
      const { createApplyPatchHook } = await import('./hooks/apply-patch');
      applyPatch = createApplyPatchHook(ctx);
    }

    if (!runtime.disabledHooks.has('search-path-guard')) {
      const { createSearchPathGuardHook } = await import(
        './hooks/search-path-guard'
      );
      searchPathGuard = createSearchPathGuardHook(ctx);
    }

    if (!runtime.disabledHooks.has('absolute-path-rescue')) {
      const { createAbsolutePathRescueHook } = await import(
        './hooks/absolute-path-rescue'
      );
      absolutePathRescue = createAbsolutePathRescueHook(ctx);
    }

    if (!runtime.disabledHooks.has('json-error-recovery')) {
      const { createJsonErrorRecoveryHook } = await import(
        './hooks/json-error-recovery/hook'
      );
      const jsonErrorRecoveryHook = createJsonErrorRecoveryHook(ctx);
      jsonErrorRecoveryAfter = wrapPostToolHook('json-error-recovery', (i, o) =>
        jsonErrorRecoveryHook['tool.execute.after'](i as never, o as never),
      );
    }
    if (!runtime.disabledHooks.has('tool-loop-guard')) {
      const { createToolLoopGuardHook } = await import(
        './hooks/tool-loop-guard/hook'
      );
      toolLoopGuard = createToolLoopGuardHook({ directory: ctx.directory });
    }

    // The hook only acts on council delegations carrying a final `Seats:`
    // line and never throws. Constructed (and its modules loaded) only when
    // a real council agent exists — no council, no seat machinery.
    // Council-inject stays independently switchable by disabled_hooks above.
    if (agentDefs.some((a) => a.name === 'council')) {
      const [seatHookModule, native] = await Promise.all([
        import('./hooks/council-seats'),
        import('./hooks/council-seats/native'),
      ]);
      councilSeatHook = seatHookModule.createCouncilSeatHook({
        resolveSeats: native.createNativeSeatResolver(ctx),
      });
    }
    if (runtime.interviewEnabled) {
      const { collapseInterviewHistory } = await import('./interview/history');
      collapseActiveInterviewHistory = collapseInterviewHistory;
    }
    if (runtime.companion?.enabled === true) {
      const { CompanionManager, companionSessionIdForDirectory } = await import(
        './companion/manager'
      );
      companionManager = new CompanionManager(
        companionSessionIdForDirectory(ctx.directory),
        ctx.directory,
        runtime.companion,
        hostFlavor,
        startupConfigSnapshot,
      );
    }
    const nativeControlNames = ['task_cancel', 'task_status', 'task_reply'];
    const nativeTaskTools: Record<string, ToolDefinition> = {};
    if (runtime.backgroundJobsMode === 'native') {
      if (nativeControlNames.some((name) => !disabledToolNames.has(name))) {
        const { createNativeTaskControlTools } = await import(
          './tools/native-task-control'
        );
        Object.assign(
          nativeTaskTools,
          Object.fromEntries(
            Object.entries(
              createNativeTaskControlTools({
                input: ctx,
                isDisposed: () => instanceDisposed,
              }),
            ).filter(([name]) => !disabledToolNames.has(name)),
          ),
        );
      }
      if (!disabledToolNames.has('task_report')) {
        const { createTaskReportTool } = await import('./tools/task-report');
        Object.assign(
          nativeTaskTools,
          createTaskReportTool({
            input: ctx,
            isDisposed: () => instanceDisposed,
          }),
        );
      }
    }

    // v2 hosts skip wait_for_user: the native `question` tool covers the
    // blocking boundary there. task_revive remains a v1-only recovery tool;
    // v2 resumes retained sessions through native subagent(sessionID, prompt).
    // v1 registration is unchanged; the generic disabled_tools filter below
    // still removes either tool when listed. The interview tool follows the
    // interviewEnabled master switch, disabled_commands and disabled_tools; a
    // tool-level off skips the implementation import below.
    const shouldRegisterInterview =
      runtime.interviewEnabled &&
      !runtime.disabledCommands.has('interview') &&
      !disabledToolNames.has('interview_submit_state');
    const interviewTools = shouldRegisterInterview
      ? (
          await import('./tools/interview-submit-state')
        ).createInterviewSubmitStateTool({
          service: () => {
            if (!interviewSubmitService) {
              throw new Error('interview service unavailable');
            }
            return interviewSubmitService;
          },
          maxQuestions: config.interview?.maxQuestions,
        })
      : {};
    // The AST-grep implementation loads only when at least one of its two
    // tools is enabled; both listed in disabled_tools keeps it out entirely.
    // Enabled entries keep their original registration positions/order.
    let astGrepTools: Record<string, ToolDefinition> = {};
    if (
      !disabledToolNames.has('ast_grep_search') ||
      !disabledToolNames.has('ast_grep_replace')
    ) {
      const astGrep = await import('./tools/ast-grep');
      astGrepTools = {
        ...(disabledToolNames.has('ast_grep_search')
          ? {}
          : { ast_grep_search: astGrep.ast_grep_search }),
        ...(disabledToolNames.has('ast_grep_replace')
          ? {}
          : { ast_grep_replace: astGrep.ast_grep_replace }),
      };
    }
    tools = {
      ...nativeTaskTools,
      ...interviewTools,
      ...acpRunTools,
      ...(webfetch ? { webfetch } : {}),
      ...astGrepTools,
    };
    if (disabledToolNames.size > 0) {
      tools = Object.fromEntries(
        Object.entries(tools).filter(([name]) => !disabledToolNames.has(name)),
      );
    }
  } catch (err) {
    releaseRuntimeConfig?.();
    // The scope claim must not outlive a failed init: a leaked live-directory
    // entry would keep other instances from ever reclaiming this location and
    // would block the last-instance wake reset.
    eventDirectoryScope?.release();
    // Plugin init failed: log visibly before re-throwing so the user
    // sees something actionable instead of a silent "loaded but empty".
    log('[plugin] FATAL: init failed', String(err));
    await appLog(
      ctx,
      'error',
      `INIT FAILED: ${String(err)}. Report at github.com/alvinunreal/oh-my-opencode-slim/issues/310`,
    );
    throw err;
  }

  // ── Probe jsdom (async, non-blocking) ───────────────────────────────
  // Don't await this; we don't want to block init. The warning will
  // appear shortly after startup if jsdom is broken. Skipped entirely when
  // the enhanced webfetch is unavailable (config switch or disabled_tools):
  // a disabled feature must not pay for the JSDOM load (the probe is the only
  // startup importer of jsdom).
  if (webfetch) {
    probeJSDOM().then((err) => {
      if (err) {
        const msg = `jsdom probe failed; webfetch tool will not work: ${err}`;
        log(`[plugin] WARN: ${msg}`);
        appLog(ctx, 'warn', msg).catch(() => {});
      }
    });
  }

  if (companionManager) {
    if (runtime.companion?.binaryPath?.trim()) {
      companionManager.onLoad();
    } else {
      const controller = new AbortController();
      companionStartupAbort = controller;
      void (async () => {
        try {
          const { ensureCompanionVersionForStartup } = await import(
            './companion/updater'
          );
          const result = await ensureCompanionVersionForStartup(
            runtime.companion,
            controller.signal,
          );
          if (result.status === 'installed') {
            log('[companion] startup update installed', result.version);
          } else if (result.status === 'failed') {
            log('[companion] startup update failed', result.error);
          }
        } catch (err) {
          log('[companion] startup update failed', String(err));
        } finally {
          companionStartupAbort = undefined;
        }
        if (!instanceDisposed) companionManager?.onLoad();
      })();
    }
  } else {
    // Disabled: no manager, but still prune this session's stale entry
    // (and any manager a previous enabled load left running). The light
    // runtime seam keeps a state-less disabled startup out of the manager
    // module entirely; only a persisted state file justifies loading it.
    const { companionSessionIdForDirectory, pruneDisabledCompanionRuntime } =
      await import('./companion/runtime');
    await pruneDisabledCompanionRuntime(
      companionSessionIdForDirectory(ctx.directory),
    );
  }

  function resolveTuiVariantForModel(
    agentName: string,
    model: string,
  ): string | undefined {
    const configEntry = runtime.agents()[agentName];
    const defaultVariant =
      typeof configEntry?.variant === 'string'
        ? configEntry.variant
        : undefined;
    // Sidebar is a current-generation surface: variants come from the
    // published chain table, so refreshed models resolve their variants too.
    const chain = foregroundFallbackChains[agentName];
    if (chain) {
      const match = chain.find((entry) => entry.id === model);
      return (
        match?.variant ?? (chain[0]?.id === model ? defaultVariant : undefined)
      );
    }

    if (
      typeof configEntry?.model === 'string' &&
      configEntry.model === model &&
      defaultVariant
    ) {
      return defaultVariant;
    }

    return undefined;
  }

  let registryBridge: RegistryFactoryBridge;
  // Marketplace kill switch (P2): when disabled, no service, no store, no
  // management tools, and no marketplace activation surface. Selected
  // package IDs are ignored. This is distinct from an empty per-preset
  // activation list, which keeps the service running with nothing selected.
  const marketplaceEnabled = runtime.marketplaceEnabled;
  let marketplaceSkillReader = async (): Promise<readonly string[]> =>
    skillIdsFromResponse(
      // The v1 SDK omits /skill, but its transport preserves host auth and in-process routing.
      await (
        ctx.client as unknown as {
          _client: {
            get(input: {
              url: string;
              query: { directory: string };
              throwOnError: true;
            }): Promise<unknown>;
          };
        }
      )._client.get({
        url: '/skill',
        query: { directory: ctx.directory },
        throwOnError: true,
      }),
      'name',
    );
  const readMarketplaceSkillIds = async (): Promise<readonly string[]> => {
    try {
      return await withTimeout(
        marketplaceSkillReader(),
        5_000,
        'Skill inventory timed out',
      );
    } catch (cause) {
      throw new Error('Could not verify the native skill inventory', { cause });
    }
  };
  let marketplaceImplementation: MarketplaceRegistryImplementation | undefined;
  let marketplaceService: MarketplaceService | undefined;
  if (marketplaceEnabled) {
    const { MarketplaceService } = await import('./marketplace/service');
    const implementation = await import('./marketplace/registry-runtime');
    marketplaceImplementation = implementation;
    marketplaceService = new MarketplaceService({
      projectDir: ctx.directory,
      hostFlavor,
      pluginVersion: getBuildInfo().version,
      getLivePackages: () => {
        if (registryRetired || !resolvedAgentRegistry) return undefined;
        return registryBridge.requireRegistry().marketplacePackages;
      },
      getPresetOverride: () => runtime.getRuntimePreset() ?? undefined,
      getDesiredState: (packageInspection, availableSkillNames) => {
        const snapshot = readPluginConfigSnapshot(ctx.directory, {
          hostFlavor,
        });
        const freshConfig = snapshot.config;
        const runtimePreset = runtime.resolveRuntimePreset(freshConfig);
        const desiredPackageIds = resolveDesiredMarketplacePackageIds(
          freshConfig,
          runtimePreset ?? undefined,
        );
        const invalid = snapshot.warnings.filter((warning) =>
          HARD_PROFILE_REFRESH_WARNING_KINDS.has(warning.kind),
        );
        if (invalid.length > 0) {
          return {
            packageIds: desiredPackageIds,
            error: `Plugin configuration is invalid: ${invalid.map((warning) => `${warning.kind} (${warning.path}): ${warning.message}`).join('; ')}`,
          };
        }
        if (hostSnapshotProvenance !== 'clean' || !latestHostSnapshot) {
          return {
            packageIds: desiredPackageIds,
            error:
              'The current host agent snapshot is not trustworthy for desired marketplace status',
          };
        }
        if (
          packageInspection.lockfileError ||
          packageInspection.operationalError
        ) {
          return {
            packageIds: desiredPackageIds,
            error:
              packageInspection.lockfileError ??
              packageInspection.operationalError ??
              'Marketplace package inspection is incomplete',
          };
        }
        const liveRequirements =
          resolvedAgentRegistry?.marketplaceRequiredSkills ?? [];
        const desiredRequirements = packageInspection.packages
          .filter(({ manifest }) => desiredPackageIds.includes(manifest.id))
          .map(({ manifest }) => ({
            packageId: manifest.id,
            skills: manifest.skills,
          }));
        if (
          [...liveRequirements, ...desiredRequirements].some(
            ({ skills }) => skills.length > 0,
          )
        ) {
          if (availableSkillNames === undefined) {
            return {
              packageIds: desiredPackageIds,
              error: 'Could not verify the native skill inventory',
            };
          }
          const missing = missingMarketplaceSkills(
            liveRequirements,
            availableSkillNames,
          );
          if (missing.length) {
            return {
              packageIds: desiredPackageIds,
              error: `Live marketplace skills unavailable: ${missing.join(', ')}`,
            };
          }
        }
        if (desiredPackageIds.length === 0) {
          return { packageIds: desiredPackageIds, packages: [] };
        }
        const installedPackages = new Map(
          packageInspection.packages.map((stored) => [
            stored.manifest.id,
            stored,
          ]),
        );
        const readOnlyActivationStore = {
          loadSelected(ids: readonly string[]) {
            const packages = new Map();
            const errors = new Map<string, Error>();
            for (const id of ids) {
              const stored = installedPackages.get(id);
              if (stored) packages.set(id, stored);
              else
                errors.set(id, new Error(`${id} is not installed or verified`));
            }
            return { packages, errors };
          },
        };
        const freshRuntime = RuntimeConfig.createDetached(
          ctx.directory,
          freshConfig,
          hostFlavor,
        );
        freshRuntime.captureHostConfig(latestHostSnapshot ?? {});
        if (runtimePreset) freshRuntime.setRuntimePreset(runtimePreset);
        const freshPluginMcps = createBuiltinMcps(freshRuntime.disabledMcps);
        try {
          const freshRegistry = buildResolvedAgentRegistry(freshRuntime, {
            hostSnapshot: latestHostSnapshot,
            nativePermissionsByAgent: latestNativePermissionsByAgent,
            projectDirectory: ctx.directory,
            hostFlavor,
            pluginMcps: freshPluginMcps,
            marketplace: {
              implementation,
              selectedPackageIds: desiredPackageIds,
              store: readOnlyActivationStore,
              pluginVersion: getBuildInfo().version,
              availableSkillNames,
            },
          });
          return {
            packageIds: desiredPackageIds,
            packages: freshRegistry.marketplacePackages,
          };
        } catch (error) {
          return {
            packageIds: desiredPackageIds,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  }
  registryBridge = {
    hasSelectedMarketplaceAgents: selectedMarketplacePackageIds.length > 0,
    setMarketplaceSkillReader(reader) {
      marketplaceSkillReader = reader;
    },
    async verifyMarketplaceSkills() {
      if (selectedMarketplacePackageIds.length === 0) return;
      const requirements =
        registryBridge.requireRegistry().marketplaceRequiredSkills;
      if (!requirements.some(({ skills }) => skills.length > 0)) return;
      const missing = missingMarketplaceSkills(
        requirements,
        await readMarketplaceSkillIds(),
      );
      if (missing.length)
        throw new Error(
          `Marketplace skills unavailable: ${missing.join(', ')}`,
        );
    },
    marketplaceService,
    finalize(hostSnapshot, nativePermissionsByAgent) {
      if (registryRetired) throw new Error('Agent registry is retired');
      if (!latestHostSnapshot) {
        latestHostSnapshot = structuredClone(hostSnapshot);
        latestNativePermissionsByAgent = structuredClone(
          nativePermissionsByAgent,
        );
        hostSnapshotProvenance = 'clean';
      }
      if (!resolvedAgentRegistry) {
        RuntimeConfig.get(ctx.directory).captureHostConfig(hostSnapshot);
        resolvedAgentRegistry = buildResolvedAgentRegistry(runtime, {
          hostSnapshot,
          definitions: agentDefs,
          projectDirectory: ctx.directory,
          hostFlavor,
          pluginMcps: mcps,
          nativePermissionsByAgent,
          ...(marketplaceImplementation && marketplaceService
            ? {
                marketplace: {
                  implementation: marketplaceImplementation,
                  selectedPackageIds: selectedMarketplacePackageIds,
                  store: marketplaceService.store,
                  pluginVersion: getBuildInfo().version,
                },
              }
            : {}),
          onHostModelSelected: (agentName) => {
            runtime.everModelSwitched(agentName);
          },
        });
        // Publish the finalized chain generation: marketplace candidates and
        // model-switch disables are merged by the shared publisher — the same
        // path every profile refresh republishes.
        publishChainGeneration(
          buildChainGeneration(
            runtime,
            agentDefs,
            resolvedAgentRegistry.modelCandidates,
          ),
          runtime,
          (name) => runtime.hasModelSwitched(name),
        );
      }
      return resolvedAgentRegistry;
    },
    requireRegistry() {
      if (registryRetired) throw new Error('Agent registry is retired');
      if (!resolvedAgentRegistry)
        throw new Error('Agent registry has not been finalized');
      return resolvedAgentRegistry;
    },
    prepareCommands(opencodeConfig) {
      const commandGate = {
        disabledCommands: runtime.disabledCommands,
        disabledSkills: runtime.disabledSkills,
      };
      if (isCommandEnabled('deepwork', commandGate)) {
        deepworkCommandHook?.registerCommand(opencodeConfig);
      }
      if (isCommandEnabled('reflect', commandGate)) {
        reflectCommandHook?.registerCommand(opencodeConfig);
      }
    },
    retire() {
      registryRetired = true;
    },
  };
  // Tool-level off for both controls skips the tool module; the marketplace
  // service and registry remain loaded because the feature itself is on.
  const marketplaceToolNamesEnabled =
    !runtime.disabledTools.includes('marketplace_inspect') ||
    !runtime.disabledTools.includes('marketplace_manage');
  if (marketplaceEnabled && marketplaceService && marketplaceToolNamesEnabled) {
    const { createMarketplaceTools, resolveFinalizedOrchestratorIdentities } =
      await import('./tools/marketplace');
    const marketplaceTools = createMarketplaceTools({
      service: marketplaceService,
      readSkillIds: readMarketplaceSkillIds,
      cwd: ctx.directory,
      getOrchestratorIdentities: () => {
        const registry = registryBridge.requireRegistry();
        return resolveFinalizedOrchestratorIdentities(registry);
      },
    });
    if (!runtime.disabledTools.includes('marketplace_inspect')) {
      tools.marketplace_inspect = marketplaceTools.marketplace_inspect;
    }
    if (!runtime.disabledTools.includes('marketplace_manage')) {
      tools.marketplace_manage = marketplaceTools.marketplace_manage;
    }
  }
  // Count the completed registration records once, after marketplace tools.
  const agentCount = Object.keys(agents).length;
  const toolCount = Object.keys(tools).length;
  const mcpCount = Object.keys(mcps).length;
  const mcpThreshold =
    runtime.disabledMcps.length > 0 ? 0 : HEALTH_CHECK.minMcps;
  const minAgents = minimumExpectedAgentCount(
    [...runtime.disabledAgents],
    Boolean(runtime.council),
  );
  const toolThreshold = minimumExpectedToolCount(
    runtime.disabledTools,
    Boolean(webfetch),
    hostFlavor,
    runtime.backgroundJobsMode,
  );
  if (
    agentCount < minAgents ||
    toolCount < toolThreshold ||
    mcpCount < mcpThreshold
  ) {
    const msg = [
      'Health check: registrations suspiciously low.',
      `  agents: ${agentCount} (expected >=${minAgents})`,
      `  tools:  ${toolCount} (expected >=${toolThreshold})`,
      `  mcps:   ${mcpCount} (expected >=${mcpThreshold})`,
      'This usually means a dependency failed to resolve (jsdom, etc).',
      'If you recently updated opencode, see:',
      '  github.com/alvinunreal/oh-my-opencode-slim/issues/310',
    ].join('\n');
    log(`[plugin] WARN: ${msg}`);
    await appLog(ctx, 'warn', msg);
  } else {
    log('[plugin] health check passed', {
      agents: agentCount,
      tools: toolCount,
      mcps: mcpCount,
    });
  }

  /**
   * Re-read the plugin config from disk and resolve ONLY the
   * inference/runtime profile fields (model, variant, temperature, provider
   * options) for each agent, plus the sidebar model projection. The v2
   * adapter consumes this through the `v2.refreshProfiles` hook when a
   * watched config file changes or a preset is applied.
   *
   * This is deliberately NOT a global agent reload: the session-frozen
   * surfaces (agent definitions, prompts, tools, permissions, skills, MCPs)
   * are never rebuilt and the host agent registry is never reloaded. The
   * running generation state (`config`, `runtime`, `agentDefs`, `agents`,
   * `finalHostAgentConfig`) is untouched — a throwaway `RuntimeConfig.createDetached`
   * view resolves the fresh file against the captured host layer. On success
   * the refresh republishes the complete next chain generation (config +
   * marketplace-merged, see buildChainGeneration) beside the sidebar write,
   * so chain consumers never serve a different generation than the profiles.
   * New child sessions receive the refreshed inference fields through the v2
   * session-profile bridge (and pin the chain generation at registration);
   * the sidebar is rewritten through the existing `recordTuiAgentModels`
   * writer.
   *
   * Returns a discriminated result; a failure never claims success and never
   * swaps state (the caller decides what to do with the reason). A config
   * load that produced `invalid-json`/`invalid-schema`/`read-error` warnings
   * is a hard failure: the loader would otherwise fall back to `{}` and the
   * "refresh" would report ok while wiping every profile/agent model.
   */
  const refreshProfilesFromDisk = async (options?: {
    /** Startup has no last-good table yet; use the loader's normal fallback
     * config so malformed user input remains non-fatal for this generation. */
    allowInvalidFallback?: boolean;
    presetName?: string;
    detached?: boolean;
    /** Startup generation already resolved these files and warnings. */
    configSnapshot?: PluginConfigSnapshot;
  }): Promise<V2ProfileRefreshResult> => {
    try {
      // Malformed config handling: collect warnings and abort BEFORE any
      // resolution or sidebar rewrite when the load is invalid. The loader
      // falls back to `{}` for invalid JSON/schema, which would otherwise
      // report a successful "refresh" that wipes every profile/model.
      const snapshot =
        options?.configSnapshot ??
        readPluginConfigSnapshot(ctx.directory, {
          hostFlavor,
          fresh: true,
          ...(options?.presetName ? { presetName: options.presetName } : {}),
        });
      const freshConfig = snapshot.config;
      const hardWarnings = snapshot.warnings.filter((warning) =>
        HARD_PROFILE_REFRESH_WARNING_KINDS.has(warning.kind),
      );
      // The loader omits each broken inheritance chain independently. Only
      // named, successfully resolved selections may ignore those unrelated
      // diagnostics; layer/schema/image-routing failures remain fatal. Keep
      // the normal watcher policy unchanged.
      const selectedResolved =
        options?.presetName &&
        Object.hasOwn(freshConfig.presets ?? {}, options.presetName);
      const blockingWarnings = hardWarnings.filter(
        (warning) =>
          !(
            options?.detached &&
            selectedResolved &&
            warning.kind === 'invalid-schema' &&
            warning.presetName !== undefined &&
            warning.presetName !== options.presetName
          ),
      );
      if (blockingWarnings.length > 0 && !options?.allowInvalidFallback) {
        const reason = `config load failed: ${blockingWarnings.map((warning) => `${warning.kind} (${warning.path}): ${warning.message}`).join('; ')}`;
        log('[plugin] runtime profile refresh from disk failed', reason);
        return { ok: false, reason };
      }
      if (
        options?.presetName &&
        !Object.hasOwn(freshConfig.presets ?? {}, options.presetName)
      ) {
        return { ok: false, reason: `Unknown preset: ${options.presetName}` };
      }
      const freshRuntime = RuntimeConfig.createDetached(
        ctx.directory,
        freshConfig,
        hostFlavor,
      );
      const hostSnapshot = runtime.host();
      if (hostSnapshot) {
        freshRuntime.captureHostConfig(hostSnapshot);
      }
      // Mirror factory init: a persisted runtime preset (in-session switch)
      // survives the reload and wins over the config-file preset.
      const runtimePresetName = options?.presetName
        ? undefined
        : runtime.getRuntimePreset();
      let runtimePreset: Preset | undefined;
      if (runtimePresetName && freshConfig.presets?.[runtimePresetName]) {
        freshRuntime.setRuntimePreset(runtimePresetName);
        runtimePreset = freshConfig.presets[runtimePresetName] as Preset;
      }
      const freshAgentViews = createAgentInferenceViews(freshRuntime, {
        projectDirectory: ctx.directory,
        hostFlavor,
      });
      const freshAgents = getAgentConfigsFromDefinitions(
        freshRuntime,
        freshAgentViews,
      );
      // Keep the finalized roster (including marketplace agents), but resolve
      // only inference overrides. No package/resource activation occurs here.
      const marketplaceInheritance: SessionTeamBundle['inheritance'] = {};
      for (const [name, registered] of Object.entries(
        resolvedAgentRegistry?.getSdkAgentProjection() ?? {},
      )) {
        const manifestBase =
          resolvedAgentRegistry?.marketplaceInferenceBase[name];
        if (Object.hasOwn(freshAgents, name) && !manifestBase) continue;
        const base = (manifestBase ?? registered) as Record<string, unknown>;
        const override = freshRuntime.agent(name);
        const inference: Record<string, unknown> = {};
        for (const field of [
          'model',
          'variant',
          'temperature',
          'options',
        ] as const) {
          const value =
            field === 'options'
              ? deepMerge(
                  base.options as Record<string, unknown> | undefined,
                  override?.options,
                )
              : (override?.[field] ?? base[field]);
          if (value !== undefined) inference[field] = value;
        }
        if (Array.isArray(inference.model)) {
          const head = inference.model[0];
          inference.model = typeof head === 'string' ? head : head?.id;
          if (
            typeof head === 'object' &&
            head?.variant &&
            override?.variant === undefined
          )
            inference.variant = head.variant;
        }
        const source =
          override?.inheritModelFrom ??
          (override?.model === undefined
            ? manifestBase?.inheritModelFrom
            : undefined);
        if (
          source &&
          (override?.model === undefined ||
            Array.isArray(override.model) ||
            freshRuntime.combinedModelInheritanceSource(name))
        ) {
          marketplaceInheritance[name] = source;
          delete inference.model;
          if (override?.variant === undefined) delete inference.variant;
        }
        (freshAgents as Record<string, unknown>)[name] = inference;
      }
      const hostInference = Object.fromEntries(
        Object.entries(hostSnapshot?.agent ?? {}).map(([name, config]) => {
          const host = config as Record<string, unknown>;
          const request = host.request as
            | { body?: Record<string, unknown> }
            | undefined;
          return [
            name,
            {
              ...host,
              ...(request?.body
                ? {
                    options: deepMerge(
                      host.options as Record<string, unknown> | undefined,
                      request.body,
                    ),
                  }
                : {}),
            },
          ];
        }),
      );
      const mergedAgents = mergeHostAgentConfigs(
        freshAgents as Record<string, Record<string, unknown>>,
        hostInference,
      );
      // Resolve builtin/orchestrator package sources only after the shared
      // host/display-name merge, using that same authoritative inference view.
      for (const [name, base] of Object.entries(
        resolvedAgentRegistry?.marketplaceInferenceBase ?? {},
      )) {
        if (!base.modelFrom || marketplaceInheritance[name]) continue;
        const target = mergedAgents[name];
        const source = mergedAgents[base.modelFrom];
        if (!target || !source) continue;
        for (const field of ['model', 'variant'] as const) {
          if (target[field] === undefined && source[field] !== undefined)
            target[field] = source[field];
        }
      }
      const { profiles, projection } = projectAgentRuntimeState({
        runtime: freshRuntime,
        agentDefs: freshAgentViews,
        agentConfigs: mergedAgents,
        runtimePreset,
      });
      const freshCandidates = resolvedAgentRegistry
        ? {
            ...resolvedAgentRegistry.modelCandidates,
            ...resolvedAgentRegistry.marketplaceManifestChains,
          }
        : undefined;
      const chains = buildChainGeneration(
        freshRuntime,
        freshAgentViews,
        freshCandidates,
      );
      const inheritance: SessionTeamBundle['inheritance'] = {};
      const registered = resolvedAgentRegistry?.getSdkAgentProjection();
      for (const name of Object.keys(profiles)) {
        // Runtime presets cannot register new agents or expand resource policy.
        if (registered && !Object.hasOwn(registered, name)) {
          delete profiles[name];
          delete chains[name];
          continue;
        }
        const effective = freshRuntime.agent(name);
        const source =
          marketplaceInheritance[name] ?? effective?.inheritModelFrom;
        if (
          source &&
          (effective?.model === undefined ||
            Array.isArray(effective.model) ||
            freshRuntime.combinedModelInheritanceSource(name))
        )
          inheritance[name] = source;
        if (marketplaceInheritance[name] && !profiles[name].model)
          profiles[name].sidebarModel = 'default';
        if (
          !freshRuntime.combinedModelInheritanceSource(name) &&
          runtime.hasModelSwitched(name)
        ) {
          chains[name] = [];
        }
      }
      // Display-name session identities share the canonical inference policy.
      for (const [identity, canonical] of Object.entries(
        resolvedAgentRegistry?.identities ?? {},
      )) {
        if (profiles[canonical]) profiles[identity] = profiles[canonical];
        if (chains[canonical]) chains[identity] = chains[canonical];
        if (inheritance[canonical])
          inheritance[identity] = inheritance[canonical];
      }
      const bundle: SessionTeamBundle = {
        presetName: freshRuntime.preset ?? null,
        fallbackEnabled: freshRuntime.fallback.enabled,
        profiles,
        chains,
        inheritance,
      };
      const fallback = blockingWarnings.length > 0;
      if (options?.detached)
        return { ok: true, profiles, projection, bundle, fallback };
      // Sidebar projection must land before the profiles are reported as
      // refreshed (the caller swaps only on an ok result).
      //
      // The refresh resolves inference fields for the core agent set only:
      // The inference view is marketplace-unaware, while the finalized registry
      // is the authoritative roster and already includes marketplace agents.
      // Union the fresh projection over the registry projection so a startup
      // or watcher refresh cannot shrink the roster and drop marketplace
      // agents from the sidebar; fresh core models still win. With the
      // sidebar disabled there is no projection to refresh — the chain
      // generation below still republishes.
      const registry = resolvedAgentRegistry;
      if (runtime.sidebarEnabled) {
        recordTuiAgentModels(
          {
            agentModels: {
              ...(registry?.tuiAgentModels ?? {}),
              ...projection.agentModels,
            },
            agentVariants: {
              ...(registry?.tuiAgentVariants ?? {}),
              ...projection.agentVariants,
            },
            agentDisplayNames: collectAgentDisplayNames(registry?.identities),
            agentColors: collectAgentColors(
              registry?.finalAgentConfig,
              registry?.agentNames,
            ),
          },
          ctx.directory,
        );
      }
      log('[plugin] runtime profiles refreshed from disk', {
        agents: Object.keys(profiles).length,
      });
      // Chain generation: republished beside the sidebar projection, only
      // after validation succeeded — profiles and chains always come from the
      // same generation (the caller swaps the profile table on this ok
      // result; an invalid refresh keeps the last-known-good generation).
      // Manifest chains overlay the startup candidates: a user override
      // removed since startup must fall back to the package's own chain,
      // not the stale merged candidates.
      publishChainGeneration(chains, freshRuntime, (name) =>
        runtime.hasModelSwitched(name),
      );
      return { ok: true, profiles, projection, bundle, fallback };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log('[plugin] runtime profile refresh from disk failed', reason);
      return { ok: false, reason };
    }
  };

  // Only the v2 bridge consumes this native provider/model#variant override.
  const resolveV2DelegatedModel = ({
    agentType,
    parentSessionID,
    bundle,
    parentModel,
  }: {
    agentType: string;
    parentSessionID: string;
    bundle?: SessionTeamBundle | null;
    parentModel?: { providerID: string; id: string; variant?: string };
  }) => {
    const agentName = resolveRuntimeAgentName(runtime, agentType);
    const profile = bundle?.profiles[agentType] ?? bundle?.profiles[agentName];
    const inheritance =
      bundle?.inheritance[agentType] ?? bundle?.inheritance[agentName];
    const selected = bundle
      ? selectDelegatedModel({
          agentName,
          childChain: bundle.fallbackEnabled
            ? (bundle.chains[agentType] ?? bundle.chains[agentName])
            : undefined,
          followsParent:
            inheritance === 'session' || inheritance === 'orchestrator',
          parentModel: parentModel
            ? `${parentModel.providerID}/${parentModel.id}`
            : liveSessionModel(parentSessionID),
          activeFallback:
            foregroundFallback?.getActiveFallback(parentSessionID),
        })
      : resolveDelegatedModelForParent(agentType, parentSessionID);
    let entry =
      selected?.entry ??
      (profile?.model
        ? {
            id: `${profile.model.providerID}/${profile.model.id}`,
            ...(profile.model.variant
              ? { variant: profile.model.variant }
              : {}),
          }
        : undefined);
    if (selected?.inherited && entry) {
      const variant =
        profile?.sidebarVariant ?? parentModel?.variant ?? entry.variant;
      entry = { id: entry.id, ...(variant ? { variant } : {}) };
    }
    return entry?.variant ? `${entry.id}#${entry.variant}` : entry?.id;
  };

  const hooks = {
    registryBridge,
    name: 'oh-my-opencode-slim',
    // v2-only extension hook: re-read the plugin config and resolve the
    // inference/runtime profiles for new child sessions + the sidebar.
    // Unknown to v1 hosts, consumed by src/v2/setup.ts.
    'v2.refreshProfiles': refreshProfilesFromDisk,
    'v2.resolveDelegatedModel': resolveV2DelegatedModel,
    'v2.setSessionTeamResolver': (resolver: typeof sessionTeamFor) => {
      sessionTeamFor = resolver;
    },
    'v2.pendingRefusalOutcome':
      foregroundFallback?.pendingRefusalOutcome.bind(foregroundFallback),
    'v2.session.retry': fallbackRetryHookEnabled
      ? (input: never, switchModel: never) =>
          foregroundFallback?.handleV2Retry(input, switchModel)
      : undefined,
    // v2-only extension hook: pin the chain generation in effect when a
    // child session registers — the same generation as its frozen profile.
    'v2.pinSessionChains': (
      sessionID: string,
      chains?: SessionTeamBundle['chains'],
      enabled?: boolean,
    ) => {
      foregroundFallback?.pinSessionChains(sessionID, chains, enabled);
    },
    // v2-only extension hook: release the pin when the admission that
    // captured it fails, so the retry pins the generation current then.
    'v2.releaseSessionChains': (sessionID: string) => {
      foregroundFallback?.releaseSessionChains(sessionID);
    },
    // v2 owns its own interview bridge/service; point the submit tool and
    // text-complete fallback at it so `/interview` state lands in the same
    // service that captured the session transcript.
    'v2.setInterviewService': (
      service: ReturnType<typeof createInterviewService>,
    ) => {
      interviewSubmitService = service;
    },
    'v2.noteExternalPromptIntent': (sessionID: string, messageID: string) =>
      foregroundFallback?.observeExternalPromptIntent(sessionID, messageID),

    agent: agents,

    tool: tools,

    mcp: mcps,

    config: async (opencodeConfig: Record<string, unknown>) => {
      // Host config may change model capability declarations; drop the
      // cached capability catalog so the next lookup re-resolves it.
      imageCapabilityCache.promise = undefined;
      const preMutationHostSnapshot = resolvedAgentRegistry
        ? undefined
        : (structuredClone(opencodeConfig) as RegistryHostSnapshot);
      if (preMutationHostSnapshot) {
        latestHostSnapshot = preMutationHostSnapshot;
        hostSnapshotProvenance = 'clean';
        RuntimeConfig.get(ctx.directory).captureHostConfig(
          preMutationHostSnapshot,
        );
      }
      // Force default_agent to the orchestrator's visible entry when unset,
      // and also when the user pointed it at an omos subagent name (opencode
      // rejects subagent names as default_agent with "default agent must be a
      // primary agent"). With a display name, the canonical 'orchestrator'
      // registration is a hidden alias, so default to its visible entry.
      // Other values (opencode's built-in 'build'/'plan', or a user-defined
      // primary agent) are respected. This guards against promptAsync calls
      // that omit the `agent` field from falling back to 'build' when the
      // orchestrator agent is temporarily unresolved.
      if (runtime.setDefaultAgent) {
        const existing = (opencodeConfig as { default_agent?: string })
          .default_agent;
        if (!existing || isSubagent(existing)) {
          const orchestratorAlias = agents.orchestrator as
            | {
                displayName?: string;
                hidden?: boolean;
              }
            | undefined;
          (opencodeConfig as { default_agent?: string }).default_agent =
            orchestratorAlias?.hidden && orchestratorAlias.displayName
              ? normalizeAgentName(orchestratorAlias.displayName)
              : 'orchestrator';
        }
      }

      // Finalize one generation-local registry from this real, pre-mutation
      // host snapshot. All later projections are clones of that frozen result.
      if (!resolvedAgentRegistry) {
        if (!preMutationHostSnapshot) {
          throw new Error(
            'Missing pre-mutation host snapshot for registry finalization',
          );
        }
        await retryMarketplaceLeases(
          () => registryBridge.finalize(preMutationHostSnapshot, {}),
          marketplaceLeaseAbort.signal,
        );
      }
      const registry = registryBridge.requireRegistry();

      // Refresh consumers that retain the startup SDK record, while keeping
      // the registry's authoritative snapshot immutable.
      const projectedAgents = registry.getSdkAgentProjection();
      for (const key of Object.keys(agents)) delete agents[key];
      Object.assign(agents, projectedAgents);
      const currentAgentConfig =
        opencodeConfig.agent && typeof opencodeConfig.agent === 'object'
          ? (opencodeConfig.agent as Record<string, unknown>)
          : {};
      opencodeConfig.agent = {
        ...currentAgentConfig,
        ...structuredClone(registry.managedAgentConfig),
      };
      // #1582: disable OpenCode's built-in subagents at runtime so slim's
      // agents are the only delegation targets, even without the installer.
      // A user-declared entry owns its key and is left untouched; an entry
      // that is exactly our injected shape is re-asserted, so a host that
      // hands the mutated object back can't out-stare a later user edit
      // (same class as the injectedMcps filter below).
      const mergedAgentConfig = opencodeConfig.agent as Record<string, unknown>;
      for (const name of BUILTIN_OPENCODE_SUBAGENTS_TO_DISABLE) {
        const existing = mergedAgentConfig[name];
        if (
          existing !== undefined &&
          !Bun.deepEquals(existing, { disable: true })
        )
          continue;
        mergedAgentConfig[name] = { disable: true };
      }
      const currentMcpConfig =
        opencodeConfig.mcp && typeof opencodeConfig.mcp === 'object'
          ? (opencodeConfig.mcp as Record<string, unknown>)
          : {};
      // Drop entries this hook injected on a previous pass: a re-invoked
      // config() may receive back the object we already mutated, and our
      // own built-ins must not be mistaken for user-authored entries.
      const hostMcpConfig = Object.fromEntries(
        Object.entries(currentMcpConfig).filter(
          ([name, value]) =>
            !Object.hasOwn(injectedMcps, name) ||
            !Bun.deepEquals(injectedMcps[name], value),
        ),
      );
      // User-authored MCP entries own their key (issue #1290): reconcile
      // the live export from the built-in set (not a one-way prune) so a
      // removed override comes back and v1/v2 registration both see it.
      // Merge user-wins for opencodeConfig.mcp: built-ins only fill keys
      // the user did not set.
      const effectiveMcps: Record<string, unknown> = structuredClone(
        registry.managedMcpConfig,
      );
      for (const name of getOverriddenBuiltinMcpKeys(
        effectiveMcps,
        hostMcpConfig,
      )) {
        delete effectiveMcps[name];
      }
      for (const key of Object.keys(mcps)) delete mcps[key];
      Object.assign(mcps, effectiveMcps);
      opencodeConfig.mcp = { ...effectiveMcps, ...hostMcpConfig };
      injectedMcps = effectiveMcps;
      if (runtime.sidebarEnabled) {
        recordTuiAgentModels(
          {
            agentModels: registry.tuiAgentModels,
            agentVariants: registry.tuiAgentVariants,
            agentDisplayNames: collectAgentDisplayNames(registry.identities),
            agentColors: collectAgentColors(
              registry.finalAgentConfig,
              registry.agentNames,
            ),
          },
          ctx.directory,
        );
      }

      // This is the source of truth for admission. It is intentionally
      // captured only after every host/plugin merge, model pass and
      // permission pass.
      const finalHostAgentConfig = opencodeConfig.agent as Record<
        string,
        unknown
      >;
      const compaction = finalHostAgentConfig.compaction as
        | { model?: unknown }
        | undefined;
      foregroundFallback?.setCompactionModelPinned(
        typeof compaction?.model === 'string' && compaction.model.length > 0,
      );

      registryBridge.prepareCommands(opencodeConfig);
    },

    event: (input) =>
      withTuiSnapshotBatch(async () => {
        if (input.event.type === 'server.instance.disposed') {
          instanceDisposed = true;
          companionStartupAbort?.abort();
          marketplaceLeaseAbort.abort();
        }
        // V1 token streams have no work in this fan-out.
        const streamEventType = (input.event as { type?: string } | undefined)
          ?.type;
        if (streamEventType === 'message.part.delta') {
          return;
        }

        eventDirectoryScope?.note(input.event);
        if (eventDirectoryScope?.isForeign(input.event)) {
          return;
        }

        const event = input.event as {
          type: string;
          // Raw v2 envelope: host time and payload.
          created?: unknown;
          data?: { sessionID?: unknown };
          properties?: {
            info?: {
              id?: string;
              role?: string;
              finish?: string;
              parentID?: string;
              summary?: boolean;
              title?: string;
              agent?: string;
              providerID?: string;
              modelID?: string;
              model?: {
                providerID?: string;
                modelID?: string;
              };
              sessionID?: string;
              directory?: string;
              time?: { created?: unknown; completed?: unknown };
            };
            sessionID?: string;
            id?: string;
            requestID?: string;
            status?: { type: string };
          };
        };

        // Session-scoped events (session.*) carry the session id in info.id;
        // message/step-scoped events (message.updated, step-finish) carry the
        // message id in info.id and the session id in info.sessionID. Resolve
        // by session so child activity refreshes the correct stuck timer.
        const eventSessionID = resolveEventSessionID(event);
        if (event.type === 'message.updated' && event.properties?.info) {
          foregroundFallback?.observeCompactionMessage(event.properties.info);
        }
        const rawStatus = event.properties?.status;
        const statusType =
          typeof rawStatus === 'string'
            ? rawStatus
            : typeof rawStatus === 'object' &&
                rawStatus !== null &&
                'type' in rawStatus &&
                typeof (rawStatus as { type?: unknown }).type === 'string'
              ? (rawStatus as { type: string }).type
              : undefined;
        // Publish before any awaited consumer can admit a newer run.
        const companionProperties = event.properties;
        const companionData = (
          input.event as { data?: Record<string, unknown> }
        ).data;
        const companionRequestId =
          typeof companionProperties?.id === 'string'
            ? companionProperties.id
            : typeof companionProperties?.requestID === 'string'
              ? companionProperties.requestID
              : typeof companionData?.id === 'string'
                ? companionData.id
                : typeof companionData?.requestID === 'string'
                  ? companionData.requestID
                  : undefined;

        if (
          event.type === 'permission.asked' ||
          event.type === 'question.asked'
        ) {
          companionManager?.onWaitingInput({
            sessionId: eventSessionID,
            kind: event.type === 'permission.asked' ? 'permission' : 'question',
            requestId: companionRequestId,
          });
        }

        if (
          event.type === 'permission.replied' ||
          event.type === 'question.replied' ||
          event.type === 'question.rejected'
        ) {
          companionManager?.onInputResolved({
            sessionId: eventSessionID,
            kind:
              event.type === 'permission.replied' ? 'permission' : 'question',
            requestId: companionRequestId,
          });
        }

        const companionStatus = normalizeCompanionSessionStatus(
          event.type,
          statusType,
        );
        if (eventSessionID && companionStatus) {
          companionManager?.onSessionStatus({
            sessionId: eventSessionID,
            agent: sessionMetadata.getAgent(eventSessionID),
            status: companionStatus,
          });
        }

        // cache-monitor is created only when its disabled_hooks entry is
        // absent; the optional chain keeps the event path fail-open either way.
        await cacheMonitor?.event(input);
        if (
          eventSessionID &&
          isOrchestratorAgent(sessionMetadata.getAgent(eventSessionID)) &&
          (event.type === 'session.idle' ||
            (event.type === 'session.status' && statusType === 'idle'))
        ) {
          toolLoopGuard?.resetTurn(eventSessionID);
        }
        if (eventSessionID && event.type === 'session.deleted') {
          toolLoopGuard?.resetSession(eventSessionID);
        }
        if (eventSessionID) {
          if (
            event.type === 'session.status' &&
            (statusType === 'busy' || statusType === 'retry')
          ) {
            sessionMetadata.markOrchestratorActive(eventSessionID);
            const agentName = sessionMetadata.getAgent(eventSessionID);
            if (agentName) {
              pendingTuiBusySessions.delete(eventSessionID);
              markTuiAgentActive(eventSessionID, agentName, statusType);
            } else {
              pendingTuiBusySessions.set(eventSessionID, statusType);
            }
          } else if (
            event.type === 'session.idle' ||
            (event.type === 'session.status' &&
              (statusType === 'idle' ||
                statusType === 'completed' ||
                statusType === 'stopped' ||
                statusType === 'error' ||
                statusType === 'failed')) ||
            event.type === 'session.deleted' ||
            event.type === 'session.error'
          ) {
            pendingTuiBusySessions.delete(eventSessionID);
            sessionMetadata.markOrchestratorIdle(eventSessionID);
            markTuiAgentInactive(eventSessionID);
          }
        }

        if (event.type === 'message.updated') {
          const info = event.properties?.info;
          const providerID =
            typeof info?.providerID === 'string'
              ? info.providerID
              : typeof info?.model?.providerID === 'string'
                ? info.model.providerID
                : undefined;
          const modelID =
            typeof info?.modelID === 'string'
              ? info.modelID
              : typeof info?.model?.modelID === 'string'
                ? info.model.modelID
                : undefined;
          // Track each session's current model so background task admission
          // can resolve the model a model-less subagent will inherit.
          if (
            typeof info?.sessionID === 'string' &&
            info.summary !== true &&
            providerID &&
            modelID
          ) {
            const model = `${providerID}/${modelID}`;
            // Accounting/fallback follows the model actually executing.
            // External selection tracking does not: a synthetic wake's
            // message.updated must not poison Plan/Build metadata (#1079).
            const internalAdmission =
              (typeof info.id === 'string' &&
                isInternalAdmission(info.sessionID, info.id)) ||
              (typeof info.parentID === 'string' &&
                isInternalAdmission(info.sessionID, info.parentID));
            if (!internalAdmission) {
              sessionMetadata.setModel(info.sessionID, model);
              companionManager?.onSessionModelChanged({
                sessionId: info.sessionID,
                model,
              });
            }
          }
          if (
            typeof info?.agent === 'string' &&
            typeof info.sessionID === 'string' &&
            providerID &&
            modelID
          ) {
            const agentName = resolveRuntimeAgentName(runtime, info.agent);
            const model = `${providerID}/${modelID}`;
            const observedVariant = (info as { variant?: unknown }).variant;
            if (runtime.sidebarEnabled) {
              recordTuiAgentModel(
                {
                  agentName,
                  model,
                  ...(typeof observedVariant === 'string'
                    ? { variant: observedVariant }
                    : {
                        fallbackVariant:
                          resolveTuiVariantForModel(agentName, model) ?? null,
                      }),
                  sessionID: info.sessionID,
                },
                (info?.sessionID &&
                  sessionMetadata.getDirectory(info.sessionID)) ??
                  ctx.directory,
              );
            }
          }
        }

        if (event.type === 'session.created') {
          const createdSessionId = event.properties?.info?.id;
          const createdSessionDir = event.properties?.info?.directory;
          const createdSessionParent = (
            event.properties as { info?: { parentID?: unknown } } | undefined
          )?.info?.parentID;
          if (
            runtime.sidebarEnabled &&
            createdSessionId &&
            typeof createdSessionParent === 'string'
          ) {
            // Persist the child→parent link so any process can resolve the
            // conversation root, surviving restarts and revives (#1147).
            recordTuiSessionParent(
              createdSessionId,
              createdSessionParent,
              createdSessionDir ?? ctx.directory,
            );
          }
          if (createdSessionId && createdSessionDir) {
            sessionMetadata.setDirectory(createdSessionId, createdSessionDir);
          }
        }

        // Commit this event's status projection before the fallback can
        // re-prompt: the re-prompt's busy event commits in its own scope,
        // and a still-staged "inactive" must not land after it (#1697).
        flushTuiSnapshotBatch();

        // Resolve identity before task error bookkeeping, but replay afterwards:
        // prompt admission may synchronously emit a busy event.
        await foregroundFallback?.preflightEvent(input.event);

        if (event.type === 'server.instance.disposed') {
          clearTuiActivities();
        }

        // Runtime model fallback for foreground agents (rate-limit detection).
        // Same ordering rule as above: commit staged state before re-prompt.
        flushTuiSnapshotBatch();
        await foregroundFallback?.handleEvent(input.event);

        if (input.event.type === 'session.deleted') {
          const props = input.event.properties as
            | { info?: { id?: string }; sessionID?: string }
            | undefined;
          const sessionID = props?.info?.id || props?.sessionID;

          if (sessionID) {
            sessionLifecycle?.dispatchSessionDeleted(sessionID);
          }
          companionManager?.onSessionDeleted(sessionID);
          if (sessionID) {
            sessionMetadata.delete(sessionID);
          }
        }
      }),

    dispose: async () => {
      eventDirectoryScope?.release();
      // Synchronous: v2 setup calls this directly and does not emit the
      // public server.instance.disposed event first.
      instanceDisposed = true;
      companionStartupAbort?.abort();
      marketplaceLeaseAbort.abort();
      registryBridge.retire();
      // Cancel pending initial-delay fallback timers so a reloaded
      // generation cannot observe one stale fallback call.
      foregroundFallback?.dispose();
      try {
        clearTuiActivities();
        // Explicitly release this generation's companion ownership: a
        // reloaded generation only replaces the active manager at its own
        // onLoad, and if it fails before that the detached companion would
        // survive until process exit. Idempotent (registerActiveManager's
        // replacement path and the process-exit listener tolerate repeats).
        await companionManager?.dispose();
      } finally {
        releaseRuntimeConfig?.();
      }
    },

    'tool.execute.before': async (input, output) => {
      // P0 cold gating: a guard constructed only when its disabled_hooks
      // entry is absent; the optional chain keeps the call free of the
      // runtime re-check that the old per-call gate performed.
      await applyPatch?.['tool.execute.before'](
        input as never,
        output as never,
      );
      // Rewrite guessed non-existing absolute paths BEFORE the search
      // guard: the guard blocks grep/glob on missing paths, so running
      // the rescue after it would never see a rescuable path (#1143).
      await absolutePathRescue?.['tool.execute.before'](
        input as never,
        output as never,
      );
      await searchPathGuard?.['tool.execute.before'](
        input as never,
        output as never,
      );
      await councilSeatHook?.['tool.execute.before'](
        input as never,
        output as never,
      );
      // Record a call only after all rejecting before-hooks have accepted it.
      // In particular, search-path-guard can reject grep/glob before the host
      // emits tool.execute.after; running the loop guard first would leave a
      // pending call-key entry with no completion to consume it.
      await toolLoopGuard?.['tool.execute.before'](
        input as never,
        output as never,
      );
    },

    'command.execute.before': async (input, output) => {
      // Registration gating alone cannot make a disabled command inert: with
      // a user-defined command of the same name, the dispatches below would
      // still replace its output. Every dispatch shares the command gates.
      const commandEnabled = (commandName: string): boolean =>
        isCommandEnabled(commandName, {
          disabledCommands: runtime.disabledCommands,
          disabledSkills: runtime.disabledSkills,
        });

      if (commandEnabled('deepwork')) {
        await deepworkCommandHook?.handleCommandExecuteBefore(
          input as {
            command: string;
            sessionID: string;
            arguments: string;
          },
          output as { parts: Array<{ type: string; text?: string }> },
        );
      }

      if (commandEnabled('reflect')) {
        await reflectCommandHook?.handleCommandExecuteBefore(
          input as {
            command: string;
            sessionID: string;
            arguments: string;
          },
          output as { parts: Array<{ type: string; text?: string }> },
        );
      }
    },

    ...(chatHeadersHook
      ? { 'chat.headers': chatHeadersHook['chat.headers'] }
      : {}),

    'chat.params': async () => {
      if (marketplaceEnabled) await registryBridge.verifyMarketplaceSkills();
    },

    // v1 compaction requests use the same message transform as normal turns.
    // v2 handles compaction in its separate session.compaction bridge.
    'experimental.session.compacting': async ({ sessionID }) => {
      compactingSessionIds.add(sessionID);
    },

    // Track which agent each session uses (needed for serve-mode prompt
    // injection)
    'chat.message': async (
      input: {
        sessionID: string;
        agent?: string;
        model?: {
          providerID: string;
          modelID: string;
          variant?: string;
        };
        variant?: string;
        parts?: unknown[];
        /** OpenCode chat.message message identity when present. */
        messageID?: string;
      },
      output?: {
        message?: {
          id?: string;
          agent?: string;
          role?: string;
          sessionID?: string;
          model?: {
            providerID: string;
            modelID: string;
            variant?: string;
          };
        };
        parts?: unknown[];
      },
    ) => {
      // A fresh user message proves no compaction transform is coming for a
      // pending mark (the host runs compacting → transform back to back):
      // drop it so a stale mark can never strip reminders from an ordinary
      // turn. Fails safe — worst case the summary keeps the boilerplate,
      // which is the pre-change behavior.
      compactingSessionIds.delete(input.sessionID);

      // #1079: internal admissions (lifecycle wakes, terminal
      // notifications) must not overwrite the user's tracked selection.
      // Without this filter, a synthetic orchestrator wake flips a
      // Plan/Build session's tracked agent back to 'orchestrator' and
      // task-management tooling keeps treating it as orchestrated.
      // Inspect BOTH part surfaces: `input.parts ?? output.parts` would
      // skip output when input carries an empty array. Also honor the
      // v2 admission tracker — agent-discovery forwards agent/model
      // without parts.
      const messageID = input.messageID ?? output?.message?.id;
      const inputParts = Array.isArray(input.parts) ? input.parts : [];
      const outputParts = Array.isArray(output?.parts) ? output.parts : [];
      const partsInternal = [...inputParts, ...outputParts].some(
        (part) =>
          isInternalInitiatorPart(part) ||
          isNativeBackgroundTaskNotification(part),
      );
      // v1 chat.message sees the internal parts but historically never
      // recorded the message id, so the later message.updated could not
      // classify the same admission (#1079 Oracle r2). Record it here
      // so assistant replies (parentID) and message.updated share the
      // registry the v2 shim already maintains.
      if (partsInternal && typeof messageID === 'string') {
        recordInternalAdmission(input.sessionID, messageID);
      }
      const internalAdmission =
        partsInternal ||
        (typeof messageID === 'string' &&
          isInternalAdmission(input.sessionID, messageID));
      if (!internalAdmission) {
        if (inputParts.length || outputParts.length) {
          foregroundFallback?.noteV2Prompt(input.sessionID);
        }
        const model = input.model ?? output?.message?.model;
        foregroundFallback?.noteExternalTurn(
          input.sessionID,
          // v2 retains its retry budget across external prompts.
          undefined,
          model ? `${model.providerID}/${model.modelID}` : undefined,
        );
      }

      const rawAgent = input.agent ?? output?.message?.agent;
      const agent = rawAgent
        ? resolveRuntimeAgentName(runtime, rawAgent)
        : undefined;

      if (
        agent &&
        output?.message &&
        typeof output.message.agent === 'string'
      ) {
        output.message.agent = agent;
      }

      if (agent) {
        foregroundFallback?.registerSessionAgent(input.sessionID, agent);
        if (!internalAdmission) {
          sessionMetadata.setAgent(input.sessionID, agent);
        }
        // Spinner follows session.status, not chat.message: v2 context
        // hooks re-deliver chat.message after idle and would otherwise
        // relight a finished row (and the parent of a background child).
        // An already-active session (busy under a stale/unknown agent)
        // refreshes the association so the row follows the real agent.
        if (
          pendingTuiBusySessions.has(input.sessionID) ||
          ownedTuiActivitySessions.has(input.sessionID)
        ) {
          const pendingStatus = pendingTuiBusySessions.get(input.sessionID);
          pendingTuiBusySessions.delete(input.sessionID);
          markTuiAgentActive(input.sessionID, agent, pendingStatus);
          companionManager?.onSessionStatus({
            sessionId: input.sessionID,
            agent,
            status: 'busy',
          });
        }
      }

      // chat.message carries the model selected for this message, and it
      // fires before the message.updated event that the event hook relies
      // on. Recording it here closes the early window where a session-
      // inheriting background task could be admitted before its parent's
      // model is known — admission then resolves the correct provider/model
      // cap immediately.
      const messageModel = input.model ?? output?.message?.model;
      if (
        messageModel &&
        typeof messageModel.providerID === 'string' &&
        typeof messageModel.modelID === 'string'
      ) {
        const model = `${messageModel.providerID}/${messageModel.modelID}`;
        if (!internalAdmission) {
          sessionMetadata.setModel(input.sessionID, model);
          const liveVariant =
            input.variant ??
            input.model?.variant ??
            output?.message?.model?.variant;
          companionManager?.onSessionModelChanged({
            sessionId: input.sessionID,
            model,
            ...(liveVariant ? { variant: liveVariant } : {}),
            variantObserved: true,
          });
          // Sidebar live-model projection. On v2 the prompt bridge and
          // confirmed fallback commits carry agent+model+variant together;
          // the usage-synthesized message.updated has none of them.
          // A missing variant is the live choice too (model default):
          // no policy fallback, or a variant-only re-selection could never
          // clear the row. No caller-side dedupe: updateSnapshot short-
          // circuits unchanged writes through its memo, which also keeps
          // this path in step with recordTuiAgentModels bulk replacement
          // and retries after a failed write.
          if (agent)
            projectLiveAgentModel(input.sessionID, agent, model, liveVariant);
        }
      }
      if (messageID) {
        toolLoopGuard?.observeNewUserMessage(input.sessionID, messageID, {
          internalAdmission,
        });
      }
    },

    // Inject orchestrator system prompt for serve-mode sessions. In serve
    // mode, the agent's prompt field may be absent from the agents
    // registry (built before plugin config hooks run). This hook injects
    // it at LLM call time. Uses the already-resolved prompt from
    // agentDefs (which has custom replacement or append prompts applied)
    // instead of rebuilding the default.
    'experimental.chat.system.transform': async (
      input: { sessionID?: string; agent?: unknown },
      output: { system: string[] },
    ): Promise<void> => {
      // Request-scoped agent when the host provides one (the v2 context
      // bridge forwards `event.agent`). v1 hosts only pass sessionID, so
      // there we fall back to the session's tracked agent — which is the
      // SESSION agent, not the request agent: auxiliary LLM requests
      // (title generation, compaction) run in the same session under
      // their own agent and must not receive orchestrator instructions.
      const requestAgent =
        typeof input.agent === 'string' && input.agent
          ? input.agent
          : undefined;
      const sessionAgent = input.sessionID
        ? sessionMetadata.getAgent(input.sessionID)
        : undefined;
      const targetAgentRaw = requestAgent ?? sessionAgent;
      const targetAgent = targetAgentRaw
        ? resolveRuntimeAgentName(runtime, targetAgentRaw)
        : undefined;
      if (
        targetAgent === 'orchestrator' &&
        (requestAgent !== undefined || looksLikeMainChatRequest(output.system))
      ) {
        const targetDef = agentDefs.find((a) => a.name === targetAgent);
        const finalizedName =
          resolvedAgentRegistry?.identities[targetAgent] ?? targetAgent;
        const finalizedConfig =
          (resolvedAgentRegistry?.finalAgentConfig[finalizedName] as
            | Record<string, unknown>
            | undefined) ??
          (resolvedAgentRegistry?.finalAgentConfig[targetAgent] as
            | Record<string, unknown>
            | undefined);
        const targetPrompt =
          typeof finalizedConfig?.prompt === 'string'
            ? finalizedConfig.prompt
            : typeof targetDef?.config?.prompt === 'string'
              ? targetDef.config.prompt
              : buildOrchestratorPrompt({
                  disabledAgents: runtime.disabledAgents,
                  hostFlavor,
                  routingBlock: runtime.routingBlock,
                });
        // Dedup by the EFFECTIVE prompt, not by default-prompt markers:
        // a custom replacement without `<Role>` previously slipped past
        // the marker check and was appended twice (P + host + P).
        const alreadyInjected =
          !!targetPrompt &&
          output.system.some(
            (s) => typeof s === 'string' && s.includes(targetPrompt),
          );
        if (!alreadyInjected && targetPrompt) {
          // Place the orchestrator prompt after AGENTS.md so the user's
          // behavioral rules (language, code conventions, etc.) retain
          // their intended priority. AGENTS.md is injected by OpenCode
          // core into system[0]; prepending the orchestrator prompt before
          // it buries user-defined rules under thousands of lines of
          // orchestration instructions.
          output.system[0] = `${output.system[0] || ''}\n\n${targetPrompt}`;
        }
      }

      // Collapse to single system message for provider compatibility.
      // Some providers (e.g. Qwen via VLLM/DashScope) reject multiple
      // system messages. Sub-hooks above may push additional entries; join
      // them back into one element so OpenCode emits a single system
      // message.
      collapseSystemInPlace(output.system);
    },

    // Inject phase reminder and filter available skills before sending to
    // API (doesn't show in UI)
    'experimental.chat.messages.transform': async (
      input: Record<string, never>,
      output: { messages: unknown[] },
      hints?: { model?: { providerID: string; id: string } },
    ): Promise<void> => {
      const typedOutput = output as { messages: MessageWithParts[] };
      let view = createMessageTransformView(typedOutput.messages);
      const sessionID = view.sessionID;
      if (
        sessionID &&
        interviewSubmitService?.getActiveInterviewId(sessionID)
      ) {
        // The kickoff is the one deliberate rewrite; later turns must remain
        // byte-stable so each request can reuse the provider cache prefix.
        collapseActiveInterviewHistory?.(typedOutput.messages);
        view = createMessageTransformView(typedOutput.messages);
      }
      // Claim the mark synchronously: overlapping requests for this session
      // must not both strip reminders after their first asynchronous step.
      const compacting = sessionID
        ? compactingSessionIds.delete(sessionID)
        : false;

      for (const message of view.userMessages) {
        for (const part of message.parts) {
          if (part.type !== 'text' || typeof part.text !== 'string') {
            continue;
          }
          part.text = rewriteDisplayNameMentions(part.text);
        }
      }

      // Strip image parts from orchestrator messages when @observer is
      // available. When the orchestrator's model doesn't support image
      // input, the API call fails before the LLM can respond. We replace
      // image bytes with a text nudge so the orchestrator delegates to
      // @observer instead.
      // auto routing keys on the model that will actually serve this
      // request: vision-capable models keep image parts inline (native
      // read); only non-vision chains fall back to the observer relay.
      // On v2 the context bridge passes the request model as `hints.model`
      // (the host resolves it before the context hook, and a per-request
      // router may swap it) — that beats the session's last-recorded model.
      // v1 hosts have no such seam, so the fallback chain and session
      // metadata remain the source there.
      const hintModel = hints?.model
        ? { providerID: hints.model.providerID, id: hints.model.id }
        : undefined;
      const turnModelRef =
        hintModel ??
        (sessionID
          ? parseModelRef(
              foregroundFallback?.getActiveFallback(sessionID)?.model ??
                sessionMetadata.getModel(sessionID),
            )
          : undefined);
      const hasImageParts =
        runtime.imageRouting !== 'direct' &&
        !!turnModelRef &&
        view.userMessages.some((message) => message.parts.some(isImagePart));
      const acceptsImages =
        turnModelRef && hasImageParts
          ? await modelAcceptsImageInput(turnModelRef, {
              client: ctx.client,
              modelDomain: (
                ctx as {
                  experimental_v2?: ModelImageCapabilityDeps;
                }
              ).experimental_v2?.modelDomain,
              cache: imageCapabilityCache,
            })
          : undefined;
      const imageResult = processImageAttachments({
        messages: typedOutput.messages,
        workDir: ctx.directory,
        imageRouting: runtime.imageRouting,
        disabledAgents: runtime.disabledAgents,
        modelAcceptsImages: acceptsImages,
        log,
        view,
      });
      if (imageResult) {
        const now = Date.now();
        const last = lastImageRetainedToastByDir.get(ctx.directory) ?? 0;
        if (now - last > IMAGE_RETAINED_TOAST_DEBOUNCE_MS) {
          ctx.client.tui
            .showToast({
              body: {
                title: 'Images retained inline',
                message:
                  'Observer is disabled, so image attachments remain inline and may require a vision-capable orchestrator. Enable observer or set image_routing to "direct".',
                variant: 'warning',
                duration: TOAST_DURATION_MS,
              },
            })
            .then(() => {
              // Only advance the debounce window on a successful toast
              // so a failed attempt doesn't suppress the next warning.
              // Greptile: "Failed Toast Starts Debounce Window".
              lastImageRetainedToastByDir.set(ctx.directory, now);
            })
            .catch(() => {});
        }
      }

      if (phaseReminder) {
        await phaseReminder['experimental.chat.messages.transform'](
          input as never,
          typedOutput as never,
          view,
        );
      }
      if (councilInject) {
        await councilInject['experimental.chat.messages.transform'](
          input as never,
          typedOutput as never,
          view,
        );
      }
      // Ordering contract: the goal pointer is the trailing-most volatile
      // message — nothing appends after it, so re-entered transforms and the
      // trailing-zone strip stay ordered.
      if (deepworkGoal) {
        await deepworkGoal['experimental.chat.messages.transform'](
          input as never,
          typedOutput as never,
          createMessageTransformView(typedOutput.messages),
        );
      }
      if (compacting) {
        stripTaggedContents(typedOutput.messages, [
          PHASE_REMINDER_METADATA_KEY,
          COUNCIL_INJECT_METADATA_KEY,
          GOAL_POINTER_METADATA_KEY,
        ]);
      }
    },

    'tool.execute.after':
      jsonErrorRecoveryAfter || toolLoopGuard
        ? async (input, output) => {
            await jsonErrorRecoveryAfter?.(input, output);
            await toolLoopGuard?.['tool.execute.after'](
              input as never,
              output as never,
            );
          }
        : undefined,
  } as Hooks & {
    'v2.pendingRefusalOutcome':
      | ForegroundFallbackManager['pendingRefusalOutcome']
      | undefined;
    'v2.refreshProfiles': typeof refreshProfilesFromDisk;
    'v2.resolveDelegatedModel': typeof resolveV2DelegatedModel;
    'v2.setSessionTeamResolver': (resolver: typeof sessionTeamFor) => void;
    'v2.pinSessionChains': (
      sessionID: string,
      chains?: SessionTeamBundle['chains'],
      enabled?: boolean,
    ) => void;
    'v2.releaseSessionChains': (sessionID: string) => void;
    'v2.noteExternalPromptIntent'?: (
      sessionID: string,
      messageID: string,
    ) => void;
  };

  return hooks;
};
