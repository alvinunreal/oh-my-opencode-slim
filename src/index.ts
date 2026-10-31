import type { Hooks, Plugin, ToolDefinition } from '@opencode-ai/plugin';
import {
  type AdmissionRuntimeLease,
  acquireAdmissionRuntime,
} from './admission-runtime';
import {
  type AgentModelProjection,
  type AgentRuntimeProfiles,
  createAgents,
  getAgentConfigsFromDefinitions,
  isSubagent,
  mergeHostAgentConfigs,
  projectAgentRuntimeState,
  resolvePrimaryModelValue,
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
import { roleHasWriteCapability } from './agents/role-definitions';
import type { CompanionManager } from './companion/manager';
import { normalizeCompanionSessionStatus } from './companion/status';
import { deepMerge, type loadPluginConfig, type Preset } from './config';
import {
  BUILTIN_OPENCODE_SUBAGENTS_TO_DISABLE,
  DEFAULT_MAX_SESSION_METADATA_ENTRIES,
  TOAST_DURATION_MS,
} from './config/constants';
import type { ConfigLoadWarning, ConfigLoadWarningKind } from './config/loader';
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
import {
  COUNCIL_INJECT_METADATA_KEY,
  createAbsolutePathRescueHook,
  createApplyPatchHook,
  createAutoUpdateCheckerHook,
  createCacheMonitorHook,
  createChatHeadersHook,
  createCouncilInjectHook,
  createDeepworkCommandHook,
  createDeepworkGoalHook,
  createDeepworkHeadGate,
  createJsonErrorRecoveryHook,
  createOrchestratorWakeScheduler,
  createPhaseReminderHook,
  createReflectCommandHook,
  createSearchPathGuardHook,
  createTaskSessionManagerHook,
  createToolLoopGuardHook,
  ForegroundFallbackManager,
  formatChildInputWaitDelta,
  formatCompletedJobDelta,
  formatStoppedJobDelta,
  GOAL_POINTER_METADATA_KEY,
  HOST_ATTRIBUTED_STOP_OUTCOME,
  SessionLifecycle,
  stoppedJobRecoveryReason,
} from './hooks';
import { stripTaggedContents } from './hooks/cache-safe-injection';
import { isCommandEnabled } from './hooks/command-hook-utils';
import { createCouncilSeatHook } from './hooks/council-seats';
import { createManagedSeatResolver } from './hooks/council-seats/managed';
import { createNativeSeatResolver } from './hooks/council-seats/native';
import { isImagePart, processImageAttachments } from './hooks/image-hook';
import { createMessageTransformView } from './hooks/message-transform-view';
import { clearAllWakeSessions } from './hooks/orchestrator-wake/wake-gate';
import { PHASE_REMINDER_METADATA_KEY } from './hooks/phase-reminder';
import type { ChildInputWaitRecord } from './hooks/task-session-manager/child-input-wait';
import {
  clearChildInputWaitsForSession,
  formatChildInputWaitDetail,
  getChildInputWait,
  listChildInputWaits,
} from './hooks/task-session-manager/child-input-wait';
import { createBackgroundFallbackHandoff } from './hooks/task-session-manager/fallback-observation-transfer';
import { createRevivedRunTracker } from './hooks/task-session-manager/revived-run-tracker';
import {
  createAliasAuthority,
  createSessionRecovery,
  recoverSubagentSessionsAtStartup,
} from './hooks/task-session-manager/session-recovery';
import type { ToolLoopGuardHook } from './hooks/tool-loop-guard/hook';
import type { MessageWithParts } from './hooks/types';
import type { createInterviewManager } from './interview';
import type { collapseInterviewHistory } from './interview/history';
import { discoverPreflightSkills } from './marketplace/preflight';
import type { MarketplaceRegistryImplementation } from './marketplace/registry-runtime';
import type { MarketplaceService } from './marketplace/service';
import { resolveDesiredMarketplacePackageIds } from './marketplace/status';
import { createBuiltinMcps, getOverriddenBuiltinMcpKeys } from './mcp';
import {
  ast_grep_replace,
  ast_grep_search,
  createAcpRunTool,
  createCancelTaskTool,
  createInterviewSubmitStateTool,
  createTaskMessageTool,
  createTaskReplyTool,
  createTaskReviveTool,
  createTaskStatusTool,
  createWaitForUserTool,
  createWebfetchTool,
} from './tools';
import {
  applyActivityEvent,
  resolveEventSessionID,
  TaskActivityTracker,
} from './tools/task-activity';
import {
  clearTuiAgentActivities,
  clearTuiSessionAlias,
  collectAgentDisplayNames,
  flushTuiSnapshotBatch,
  readTuiSessionParents,
  recordTuiAgentActivity,
  recordTuiAgentModel,
  recordTuiAgentModels,
  recordTuiSessionParent,
  type TuiSessionDetails,
  updateTuiSessionDetails,
  withTuiSnapshotBatch,
} from './tui-state';
import {
  BackgroundJobBoard,
  BackgroundJobSupervisor,
  type BackgroundTaskConcurrency,
  createDisplayNameMentionRewriter,
  markPersistedBackgroundChildDelivered,
  normalizeAgentName,
  resolveRuntimeAgentName,
} from './utils';
import type {
  BackgroundJobEvictedSession,
  BackgroundJobRecord,
  ContextFile,
} from './utils/background-job-board';
import { isPrunableEvictedSession } from './utils/background-job-board';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
} from './utils/background-job-terminal-gate';
import { isPluginDisabledByEnv } from './utils/env';
import {
  createEventDirectoryScope,
  type EventDirectoryScope,
  hasLiveInstances,
} from './utils/event-directory-scope';
import { pruneEvictedHostSession } from './utils/evicted-session-prune';
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
import { registerPendingSessionPrune } from './utils/pending-session-prunes';
import { parseModelReference, withTimeout } from './utils/session';
import { SessionMetadataStore } from './utils/session-metadata';
import { DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS } from './utils/session-runtime-status';
import {
  createSessionSelectionReader,
  modelFromMetadataString,
  resolveCurrentSelection,
} from './utils/session-selection';
import {
  collapseSystemInPlace,
  looksLikeMainChatRequest,
} from './utils/system-collapse';
import { createTuiReusableProjection } from './utils/tui-reusable-projection';
import { createV2Setup } from './v2';
import { parseModelRef } from './v2/adapters';
import {
  type BackgroundDefaultFlipState,
  createBackgroundDefaultFlipState,
  delegationWording,
} from './v2/delegation';
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
  // Host flavor ('v2' on OpenCode v2 hosts via the client shim, undefined on
  // v1). Survives the try block so prompt-assembly hooks can use it.
  let hostFlavor: string | undefined;
  let instanceDisposed = false;
  // v1 task() has no model override. Prompts claim these bounded intentions
  // from host state, never from asynchronous session.created delivery.
  const MAX_PENDING_V1_DELEGATED_INTENTS = 32;
  const v1DelegatedIntents: {
    parentID: string;
    agentName: string;
    childID?: string;
  }[] = [];
  let autoUpdateChecker:
    | ReturnType<typeof createAutoUpdateCheckerHook>
    | undefined;
  const v1InternalSelectionOverrides = new Map<
    string,
    {
      agent?: string;
      model?: { providerID: string; modelID: string };
      modelText?: string;
      variant?: string;
    }
  >();
  const sessionMetadata = new SessionMetadataStore({
    maxEntries: DEFAULT_MAX_SESSION_METADATA_ENTRIES,
    onEvict: (sessionID) => {
      v1InternalSelectionOverrides.delete(sessionID);
      log('[session] evicted oldest session metadata', {
        threshold: DEFAULT_MAX_SESSION_METADATA_ENTRIES,
        droppedSessionId: sessionID,
      });
    },
  });
  const compactingSessionIds = new Set<string>();
  const ownedTuiActivitySessions = new Map<string, string>();
  // #1079: lifecycle continuations (orchestrator wake, terminal
  // notifications) resolve the session's CURRENT agent/model at send
  // time instead of hardcoding `orchestrator`. Host-persisted selection
  // normally wins; when a v1 unpinned internal continuation has temporarily
  // overwritten it, preserve the exact policy-selected continuation until
  // the next real operator admission.
  const lifecycleSelectionReader = createSessionSelectionReader(
    ctx.client,
    ctx.directory,
  );
  const lifecycleSelectionResolver = async (sessionID: string) => {
    const resolved = await resolveCurrentSelection(
      sessionID,
      lifecycleSelectionReader,
      sessionMetadata,
    );
    const internalOverride = v1InternalSelectionOverrides.get(sessionID);
    if (!internalOverride) return resolved;

    // v1 computes an unpinned synthetic continuation from the static agent
    // primary and persists that choice before chat.message runs. While that
    // host selection is known to be internal, preserve the exact selection
    // chosen for that continuation. A later external admission clears the
    // override and makes the host authoritative again.
    const agent = internalOverride.agent ?? resolved.agent;
    const modelText = internalOverride.modelText;
    const model = internalOverride.model ?? resolved.model;
    return {
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(internalOverride.variant
        ? { variant: internalOverride.variant }
        : modelText && agent
          ? { variant: resolveTuiVariantForModel(agent, modelText) }
          : resolved.variant
            ? { variant: resolved.variant }
            : {}),
      provenance: 'observed-external' as const,
    };
  };
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
    // Alias from an already-registered board record (launch may have
    // arrived before or after busy; both orders converge here or via the
    // coordinator's identity listener).
    const alias = backgroundJobBoard?.get(sessionID)?.alias;
    const details: TuiSessionDetails = {
      ...(alias ? { alias } : {}),
      ...(status ? { status } : {}),
    };
    recordTuiAgentActivity(
      {
        sessionID,
        agentName,
        active: true,
        ...(Object.keys(details).length > 0 ? { details } : {}),
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
  let taskSessionManagerHook:
    | ReturnType<typeof createTaskSessionManagerHook>
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
  let jsonErrorRecoveryAfter: (i: unknown, o: unknown) => Promise<void> =
    async () => {};
  let taskSessionManagerAfter: (i: unknown, o: unknown) => Promise<void> =
    async () => {};
  let backgroundJobBoard: BackgroundJobBoard | undefined;
  // Shared by task management and control tools; initialized only with
  // managed lifecycle.
  let recoverRetainedSession:
    | ReturnType<typeof createSessionRecovery>
    | undefined;
  let aliasAuthority: ReturnType<typeof createAliasAuthority> | undefined;
  let tuiReusableProjection:
    | ReturnType<typeof createTuiReusableProjection>
    | undefined;
  let backgroundJobSupervisor: BackgroundJobSupervisor | undefined;
  let backgroundTaskConcurrency: BackgroundTaskConcurrency | undefined;
  let admissionRuntimeLease: AdmissionRuntimeLease | undefined;
  let finalHostAgentConfig: Record<string, unknown> | undefined;
  let interviewManager: ReturnType<typeof createInterviewManager> | undefined;
  let collapseActiveInterviewHistory:
    | typeof collapseInterviewHistory
    | undefined;
  let companionManager: CompanionManager | undefined;
  let revivedRunTracker: ReturnType<typeof createRevivedRunTracker> | undefined;
  let terminalGate: BackgroundJobTerminalGate | undefined;
  let markRevivedRunPending: (taskID: string) => void = () => {};
  let markRevivedRunSettled: (taskID: string) => void = () => {};
  let getRevivedContextFiles = (_taskID: string): ContextFile[] => [];
  let pruneRevivedContext = () => {};
  let taskActivityTracker: TaskActivityTracker | undefined;
  let interviewSubmitService:
    | ReturnType<typeof createInterviewManager>['service']
    | undefined;
  let acpRunTools: Record<string, ReturnType<typeof createAcpRunTool>>;
  let webfetch: ReturnType<typeof createWebfetchTool> | undefined;
  const isFallbackPending = (taskID: string): boolean =>
    hostFlavor !== 'v2' &&
    !!(
      foregroundFallback?.isFallbackInProgress(taskID) ||
      taskSessionManagerHook?.hasDeferredError(taskID)
    );
  let tools: Record<string, ToolDefinition>;
  // task_* / wait_for_user registrations produced by the lifecycle block;
  // empty when the managed background-task lifecycle is disabled.
  let lifecycleTaskTools: Record<string, ToolDefinition> = {};
  let rewriteDisplayNameMentions: ReturnType<
    typeof createDisplayNameMentionRewriter
  >;

  // Counters for post-init health check (set inside try, checked outside)

  // The wake scheduler is created AFTER the task-session-manager hook (see
  // the try block below): the hook's onChildInputWait closes over
  // queueChildInputWaitWake, which drops notifications that arrive before
  // the scheduler exists. The ask stays recorded in the sidecar and
  // task_status still surfaces it, so the parent can answer via task_reply.
  // In practice the scheduler is created synchronously in the same init,
  // before any host event can arrive. On v2 no scheduler exists (council
  // 2026-10-23): asks are pull-only by design — task_status surfaces them,
  // the host UI routes the reply.
  let orchestratorWakeScheduler:
    | ReturnType<typeof createOrchestratorWakeScheduler>
    | undefined;
  function queueChildInputWaitWake(
    record: BackgroundJobRecord,
    wait: ChildInputWaitRecord,
  ): void {
    orchestratorWakeScheduler?.triggerChildInputWaitWake(
      record.parentSessionID,
      formatChildInputWaitDelta({
        alias: record.alias,
        taskID: record.taskID,
        kind: wait.kind,
        requestID: wait.requestID,
        detail: formatChildInputWaitDetail(wait, hostFlavor),
      }),
      `${record.taskID}:${wait.requestID}`,
      wait.kind,
    );
  }

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

  const resolvePrimaryModelFromFinalHostConfig = (
    agentType: string,
  ): string | undefined => {
    const readModel = (entry: unknown): string | undefined => {
      if (entry === null || typeof entry !== 'object') return undefined;
      return resolvePrimaryModelValue((entry as Record<string, unknown>).model);
    };

    // v2 finalizes the host snapshot directly through the registry bridge, so
    // it does not run the v1 config() projection assignment below. Prefer the
    // generation-local finalized projection in both runtimes; the config-hook
    // projection remains a fallback only before registry finalization.
    const finalAgentConfig =
      resolvedAgentRegistry?.finalAgentConfig ?? finalHostAgentConfig;
    const directModel = readModel(finalAgentConfig?.[agentType]);
    if (directModel) return directModel;

    const resolvedName = resolveRuntimeAgentName(runtime, agentType);
    return readModel(finalAgentConfig?.[resolvedName]);
  };

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
        ? hostFlavor === 'v2'
          ? sessionTeamFor?.(parentSessionID)
          : undefined
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

  const getModelForAgent = (agentType: string, parentSessionID?: string) => {
    const bundle =
      hostFlavor === 'v2' && parentSessionID
        ? sessionTeamFor?.(parentSessionID)
        : undefined;
    const delegated = resolveDelegatedModelForParent(
      agentType,
      parentSessionID,
      bundle ?? null,
    );
    if (delegated) return delegated.entry.id;
    // One admission view, after the host's agent layers have been finalized.
    if (bundle && parentSessionID) {
      const profile =
        bundle.profiles[agentType] ??
        bundle.profiles[resolveRuntimeAgentName(runtime, agentType)];
      return profile?.model
        ? `${profile.model.providerID}/${profile.model.id}`
        : liveSessionModel(parentSessionID);
    }
    return (
      resolvePrimaryModelFromFinalHostConfig(agentType) ??
      (parentSessionID ? sessionMetadata.getModel(parentSessionID) : undefined)
    );
  };

  const registerV1DelegatedIntent = (
    parentID: string,
    childID: string | undefined,
    agentType: string,
  ) => {
    const selected = resolveDelegatedModelForParent(agentType, parentID);
    if (selected && (childID || !selected.inherited)) {
      // A resume retry replaces its own unclaimed intention.
      const stale = v1DelegatedIntents.findIndex(
        (intent) => childID && intent.childID === childID,
      );
      if (stale >= 0) v1DelegatedIntents.splice(stale, 1);
      v1DelegatedIntents.push({
        parentID,
        agentName: selected.agentName,
        ...(childID ? { childID } : {}),
      });
      if (v1DelegatedIntents.length > MAX_PENDING_V1_DELEGATED_INTENTS)
        v1DelegatedIntents.shift();
    }
  };

  // Per-instance pairing state for the background-default flip (v2): the
  // setup arms it only after its description rewrite verifiably landed,
  // so prose and mechanism state one contract per location. Inert on v1
  // (hostFlavor gate) and until armed.
  const backgroundDefaultFlip = createBackgroundDefaultFlipState();
  try {
    // Directory scope (multi-instance): the host loads this plugin once per
    // location and broadcasts every event to every instance in the process.
    const directory = ctx.directory;
    eventDirectoryScope = createEventDirectoryScope(directory);
    log('[plugin] instance scope', { directory });

    // Read the host flavor marker before config load: it bounds project
    // config discovery, and v2 hosts derive leaner background-job defaults
    // (see loadPluginConfig), so the flavor must be known when the config
    // is first resolved — and on every later in-session reload.
    hostFlavor = (ctx as Parameters<Plugin>[0] & { hostFlavor?: string })
      .hostFlavor;
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
    RuntimeConfig.init(ctx.directory, config, hostFlavor);

    // Safety net: instance disposal reruns the plugin factory and rebuilds
    // factory-local state, while module-level runtime preset state may persist.
    // Reapply that persisted preset so each fresh generation creates agents
    // with the correct models.
    const runtimeConfig = RuntimeConfig.get(ctx.directory);
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
    // construction entirely (fail-open by design: no creation, no call).
    if (!runtime.disabledHooks.has('cache-monitor')) {
      cacheMonitor = createCacheMonitorHook();
    }

    // Sidebar master switch: with `sidebar: false` the server entry never
    // writes TUI state, so the previous generation's stale active-session
    // marks are left to the client surface that owns them.
    if (runtime.sidebarEnabled) {
      clearTuiAgentActivities(ctx.directory);
    }

    // Master switch for the OMOS managed background-task lifecycle. When
    // false, nothing board-shaped is constructed: no job board, admission
    // lease, TUI projection, terminal gate, supervisor, revived-run
    // tracker, session recovery, alias authority, task-session-manager
    // hook, wake scheduler, or task_* / wait_for_user tool factories. The
    // native OpenCode task/subagent machinery stays completely untouched.
    const lifecycleEnabled = runtime.backgroundJobsEnabled;
    if (lifecycleEnabled) {
      taskActivityTracker = new TaskActivityTracker();
    }
    const activePresetName = runtime.getRuntimePreset() ?? config.preset;
    selectedMarketplacePackageIds = runtime.marketplaceEnabled
      ? resolveDesiredMarketplacePackageIds(config, activePresetName)
      : [];
    rewriteDisplayNameMentions = createDisplayNameMentionRewriter(runtime);
    // Host flavor marker ('v2' on OpenCode v2 hosts, set by the v2 client
    // shim; absent on v1). Threads the native delegation vocabulary into
    // prompt assembly so v2 prompts say subagent(...)/agent directly.
    const delegation = delegationWording(hostFlavor);
    // Slash-command hooks are lifecycle-independent, but disabled commands
    // need neither a handler nor its captured state.
    const commandOptions = {
      disabledCommands: runtime.disabledCommands,
      disabledSkills: runtime.disabledSkills,
    };
    if (isCommandEnabled('deepwork', commandOptions)) {
      deepworkCommandHook = createDeepworkCommandHook();
    }
    if (isCommandEnabled('reflect', commandOptions)) {
      reflectCommandHook = createReflectCommandHook();
    }
    agentDefs = createAgents(runtime, {
      projectDirectory: ctx.directory,
      hostFlavor,
    });
    agents = getAgentConfigsFromDefinitions(runtime, agentDefs);

    mcps = createBuiltinMcps(runtime.disabledMcps);
    acpRunTools =
      Object.keys(runtime.acpAgents ?? {}).length > 0
        ? { acp_run: createAcpRunTool(runtime.acpAgents) }
        : {};
    webfetch =
      runtime.webfetch.enabled !== false
        ? createWebfetchTool(ctx, { binaryDir: undefined })
        : undefined;
    sessionLifecycle = new SessionLifecycle(log);
    sessionLifecycle.onSessionDeleted((sessionID) => {
      compactingSessionIds.delete(sessionID);
    });

    if (runtime.backgroundJobsEnabled) {
      backgroundJobBoard = new BackgroundJobBoard({
        maxReusablePerAgent: runtime.backgroundJobs.maxSessionsPerAgent,
        deferNumberedAliases: true,
        // Terminal-session GC (#1387 P2): when a retention trim evicts a
        // terminal or retained-stopped record, remove the underlying host
        // child session — but only a background, non-provisional child this
        // plugin launched itself (never foreground children, unattributed
        // placeholders, or adopted/restored/rehydrated sessions), and only
        // after bounded host reads confirm its parentID still matches the
        // record's parent and it is idle, and the board does not track it
        // again. A parked child-input wait blocks removal. The prune is
        // fire-and-forget so the synchronous board never awaits it; the
        // delete has a deadline so the pending-prune fence always settles.
        ...(runtime.backgroundJobs.pruneEvictedSessions
          ? {
              onEvictedSession: (evicted: BackgroundJobEvictedSession) => {
                if (!isPrunableEvictedSession(evicted)) return;
                if (listChildInputWaits(evicted.taskID).length > 0) return;
                // Same-tick: the prune (parent read + delete) starts and is
                // registered in one synchronous step with no await in
                // between, so a task_revive can never observe a
                // started-but-unregistered prune and adopt the session the
                // delete is about to remove (#1387 race).
                registerPendingSessionPrune(
                  evicted.taskID,
                  pruneEvictedHostSession({
                    session: ctx.client.session,
                    directory: ctx.directory,
                    evicted,
                    readTimeoutMs: DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS,
                    deleteTimeoutMs: DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS,
                    isTracked: (taskID) =>
                      backgroundJobBoard?.isTracked(taskID) ?? false,
                  }),
                );
              },
            }
          : {}),
      });
      recoverRetainedSession = createSessionRecovery({
        input: ctx,
        backgroundJobBoard: backgroundJobBoard!,
        isDisposed: () => instanceDisposed,
        hostFlavor,
      });
      aliasAuthority = createAliasAuthority({
        input: ctx,
        board: backgroundJobBoard!,
        isDisposed: () => instanceDisposed,
      });

      admissionRuntimeLease = acquireAdmissionRuntime(
        ctx.directory,
        runtime.backgroundJobs.concurrency,
      );
      backgroundTaskConcurrency =
        admissionRuntimeLease.backgroundTaskConcurrency;

      // Project launch identity (alias↔session) into TUI state so the
      // clickable sidebar can label active subagent sessions. Best-effort:
      // a failed tui-state write must never fail a launch.
      //
      // Each generation must retract its own projected sections on dispose:
      // a reload reuses this PID, so the startup dead-owner sweep retains
      // the previous generation's entries until explicitly removed.
      // Sidebar projection and its launch-identity writes exist only for
      // the sidebar surface; disabled means no state file, no locks, no
      // parent/alias hydration from this process.
      if (runtime.sidebarEnabled) {
        tuiReusableProjection = createTuiReusableProjection({
          board: backgroundJobBoard,
          projectDir: ctx.directory,
        });
        backgroundJobBoard.addLaunchIdentityListener((event) => {
          const directory = tuiActivityDirectory(event.taskID);
          if (event.kind === 'registered') {
            if (
              event.parentSessionID &&
              event.parentSessionID !== event.taskID
            ) {
              recordTuiSessionParent(
                event.taskID,
                event.parentSessionID,
                directory,
              );
            }
            updateTuiSessionDetails(
              event.taskID,
              { alias: event.alias },
              directory,
            );
          } else {
            clearTuiSessionAlias(event.taskID, directory);
          }
        });
      }
      terminalGate = createBackgroundJobTerminalGate({
        backgroundJobBoard: backgroundJobBoard,
        input: ctx,
        // Configurable stop-confirmation grace (backgroundJobs.
        // stopConfirmationMs); the default equals
        // STOP_CONFIRMATION_GRACE_MS, so unset config keeps v1 behavior.
        graceMs: runtime.backgroundJobs.stopConfirmationMs,
        baselineFor: (taskID, generation) =>
          revivedRunTracker?.baselineFor(taskID, generation),
        promptMessageIDFor: (taskID, generation) =>
          revivedRunTracker?.promptMessageIDFor(taskID, generation),
        // Local in-process integration: host and plugin timestamps share Unix ms.
        hostOutcomeClock: 'shared-unix-ms',
        attemptStartedAtFor: (taskID, generation) =>
          revivedRunTracker?.attemptStartedAtFor(taskID, generation),
        observationRevisionFor: (taskID, generation) =>
          revivedRunTracker?.revisionFor(taskID, generation),
        isObservationPending: (taskID, generation) =>
          (foregroundFallback?.isFallbackInProgress(taskID) ?? false) ||
          (taskSessionManagerHook?.hasDeferredError(taskID) ?? false) ||
          (revivedRunTracker?.isObservationPending(taskID, generation) ??
            false),
        onRunning: (record) => {
          if (record.background)
            backgroundTaskConcurrency?.restoreTask(
              record.taskID,
              sessionMetadata.getModel(record.taskID) ??
                resolvePrimaryModelFromFinalHostConfig(record.agent) ??
                sessionMetadata.getModel(record.parentSessionID),
            );
          if (
            !revivedRunTracker?.promptMessageIDFor(
              record.taskID,
              record.generation,
            )
          )
            backgroundJobSupervisor?.onLaunch(record);
        },
        // A task the gate gives up on stays `running` on the board forever
        // (its termination can never be confirmed on hosts that cannot read
        // terminal evidence). Keep its admission slot only for as long as it
        // is genuinely in flight: without this, `defaultConcurrency` such
        // tasks wedge every later background launch on `await ticket.ready`.
        onGiveUp: (taskID) => backgroundTaskConcurrency?.releaseTask(taskID),
      });
      backgroundJobSupervisor = new BackgroundJobSupervisor({
        backgroundJobBoard,
        wallClockTimeoutMs: runtime.backgroundJobs.wallClockTimeoutMs,
        abort: (taskID) =>
          ctx.client.session.abort({
            path: { id: taskID },
          }),
      });
      backgroundJobBoard!.addTerminalOutcomeListener((record) => {
        revivedRunTracker!.onTerminal(record);
        const current = backgroundJobBoard!.get(record.taskID);
        if (
          current?.generation !== record.generation ||
          current.terminalRevision !== record.terminalRevision ||
          current.state === 'running'
        )
          return;
        backgroundJobBoard!.addContext(
          record.taskID,
          getRevivedContextFiles(record.taskID),
        );
        markRevivedRunSettled(record.taskID);
        pruneRevivedContext();
        backgroundJobSupervisor!.onTerminal(record);
        backgroundTaskConcurrency?.releaseTask(record.taskID);
      });
      revivedRunTracker = createRevivedRunTracker({
        input: ctx,
        backgroundJobBoard: backgroundJobBoard,
        terminalGate,
        backgroundJobSupervisor,
        resolveSelection: lifecycleSelectionResolver,
        onRegister: (taskID) => markRevivedRunPending(taskID),
        onSettled: (taskID) => markRevivedRunSettled(taskID),
        contextFilesForPrompt: (taskID) => getRevivedContextFiles(taskID),
        pruneContext: () => pruneRevivedContext(),
        onNotificationAccepted: (taskID, runStartedAt) => {
          markPersistedBackgroundChildDelivered(
            taskID,
            Date.now(),
            runStartedAt ?? backgroundJobBoard!.get(taskID)?.runStartedAt,
          );
        },
        // Degraded-fallback wiring (revived-lineage strand): when every
        // tracker notification attempt has failed, the publication this
        // tracker suppressed in the terminal-outcome listener would
        // otherwise never reach the idle parent. Re-emit it DIRECTLY
        // through the wake scheduler — never through the listener's
        // suppression chain: a revived lineage has no native notifier, so
        // the first-publication-native-owned (and tracker-owned) skips
        // must not apply to this fallback. The scheduler's own guards
        // (canSchedule, one-flight wake gate, publication throttle) still
        // apply, correctly.
        onOwnershipReleased: (
          parentSessionID,
          taskID,
          generation,
          runStartedAt,
        ) => {
          void (async () => {
            const record = backgroundJobBoard!.get(taskID);
            const delivered =
              await orchestratorWakeScheduler?.triggerTerminalPublicationWake(
                parentSessionID,
                taskID,
                generation,
                record?.terminalRevision,
              );
            if (delivered === true) {
              markPersistedBackgroundChildDelivered(
                taskID,
                Date.now(),
                runStartedAt ?? record?.runStartedAt,
              );
            }
          })().catch(() => undefined);
        },
      });
      backgroundJobBoard!.addTerminalOutcomeListener((record) => {
        revivedRunTracker!.onTerminal(record);
        // Sidebar activity bookkeeping only: pane lifecycle runs in the client
        // (TUI) process, never here.
        markTuiAgentInactive(record.taskID);
      });

      taskSessionManagerHook = createTaskSessionManagerHook(ctx, {
        terminalGate,
        // Flip mechanism half reads the per-instance box declared above.
        isBackgroundDefaultFlipArmed: backgroundDefaultFlip.isArmed,
        // Host flavor marker; v1 hosts are structurally boardless (issue
        // #1647): the machine board is never rendered.
        hostFlavor,
        maxSessionsPerAgent: runtime.backgroundJobs.maxSessionsPerAgent,
        backgroundJobBoard: backgroundJobBoard,
        backgroundJobSupervisor,
        backgroundTaskConcurrency,
        pendingCallTracker: admissionRuntimeLease.pendingCallTracker,
        // The stale-timestamp retirement fallback must not ack a run whose
        // completed-job push is still queued undelivered (its own observed
        // push retires it; acking first fences the answer out forever).
        hasUndeliveredTerminalPush: (parentSessionID, taskID, generation) =>
          orchestratorWakeScheduler?.hasPendingCompletedPush(
            parentSessionID,
            taskID,
            generation,
          ) === true,
        getModelForAgent,
        sameProviderPolicy: runtime.backgroundJobs.sameProviderPolicy,
        getSessionModel: liveSessionModel,
        recoverRetainedSession,
        resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
        isDisposed: () => instanceDisposed,
        shouldManageSession: (sessionID) =>
          sessionMetadata.getAgent(sessionID) === 'orchestrator' ||
          sessionMetadata.isTaskManaged(sessionID),
        registerSessionAsOrchestrator: (sessionID) => {
          // Membership in task management, not a selection rewrite (#1079).
          sessionMetadata.markTaskManaged(sessionID);
        },
        isFallbackInProgress: (sessionID) =>
          foregroundFallback?.isFallbackInProgress(sessionID) ?? false,
        willAttemptFallback: (sessionID) =>
          foregroundFallback?.willAttemptFallback(sessionID) ?? false,
        fallbackFailureReason: (sessionID) =>
          foregroundFallback?.fallbackFailureReason(sessionID) ??
          'Model fallback is disabled.',
        coordinator: sessionLifecycle,
        revivedRunTracker,
        onChildInputWait: (notification) => {
          const record = backgroundJobBoard!.get(notification.taskID);
          if (record?.state !== 'running') {
            return;
          }
          const wait = getChildInputWait(
            notification.taskID,
            notification.requestID,
          );
          if (!wait) return;
          queueChildInputWaitWake(record, wait);
        },
      });
      markRevivedRunPending = taskSessionManagerHook!.markRevivedRunPending;
      markRevivedRunSettled = taskSessionManagerHook!.clearRevivedRunPending;
      getRevivedContextFiles = taskSessionManagerHook!.contextFilesForTask;
      pruneRevivedContext = taskSessionManagerHook!.pruneTaskContext;

      // v2: the host's native background notifier owns terminal delivery —
      // steer reaches a busy parent at its next step boundary, restart
      // recovery re-delivers from the durable KV job marker, and the inbox
      // dedupes by message ID — and child permission/question asks are a
      // host UI boundary the host does not route to the parent agent. No
      // plugin wake machinery exists on v2 (council 2026-10-23): no
      // scheduler is created, so every trigger call no-ops through the
      // undefined optional chain, and asks stay in the sidecar for
      // task_status pull. v1 keeps the scheduler.
      orchestratorWakeScheduler =
        hostFlavor === 'v2'
          ? undefined
          : createOrchestratorWakeScheduler(ctx, {
              // v1 honors the configured key.
              config: {
                ...runtime.backgroundJobs.orchestratorWake,
                periodicWakeEnabled:
                  runtime.backgroundJobs.orchestratorWake.periodicWakeEnabled ??
                  true,
              },
              // The machine board is never rendered, so wake annotations always point
              // at the pull channel (`task_status`).
              childInputWakeKinds: runtime.backgroundJobs.childInputWakeKinds,
              shouldManageSession: (sessionID) =>
                sessionMetadata.getAgent(sessionID) === 'orchestrator',
              hasInputWait: (sessionID) =>
                taskSessionManagerHook!.hasInputWait(sessionID),
              isFallbackInProgress: (sessionID) =>
                foregroundFallback?.isFallbackInProgress(sessionID) ?? false,
              resolveSelection: lifecycleSelectionResolver,
              // C2 writer-lane predicate: the queued child's agent from the board
              // record, graded by its role's write permission data. A missing
              // record/agent reads as writer (fail-safe, verdict defaults to
              // attaching the verification sentence).
              isWriterLaneTask: (taskID) =>
                roleHasWriteCapability(backgroundJobBoard!.get(taskID)?.agent),
              isStoppedJobRecoveryCurrent: (taskID, generation) => {
                const record = backgroundJobBoard!.get(taskID);
                return (
                  record?.generation === generation &&
                  record.state === 'stopped' &&
                  record.terminalUnreconciled
                );
              },
              // A queued completed-job result stays actionable only while the record
              // is still the SAME run's terminal publication: a reopened record (or
              // one that published again) must not be reported from a stale delta.
              isCompletedJobCurrent: (taskID, generation) => {
                const record = backgroundJobBoard!.get(taskID);
                return (
                  record?.generation === generation &&
                  record.terminalUnreconciled === true &&
                  (record.state === 'completed' || record.state === 'error')
                );
              },
              isChildInputWaitCurrent: (taskID, requestID) => {
                const record = backgroundJobBoard!.get(taskID);
                return (
                  record?.state === 'running' &&
                  getChildInputWait(taskID, requestID) !== undefined
                );
              },
              hasPendingDelegatedWork: (sessionID) =>
                backgroundJobBoard!.hasRunning(sessionID) ||
                backgroundJobBoard!.hasTerminalUnreconciled(sessionID),
              isPublicationCurrent: (publication) => {
                const record = backgroundJobBoard!.get(publication.taskID);
                return (
                  record !== undefined &&
                  record.state !== 'running' &&
                  record.terminalUnreconciled === true &&
                  record.generation === publication.generation &&
                  (publication.terminalRevision === undefined ||
                    record.terminalRevision === publication.terminalRevision)
                );
              },
              onPublicationAccepted: (publication) => {
                const record = backgroundJobBoard!.get(publication.taskID);
                markPersistedBackgroundChildDelivered(
                  publication.taskID,
                  Date.now(),
                  record?.runStartedAt,
                );
              },
              coordinator: sessionLifecycle,
            });
      // A restarted plugin starts with an empty board. If the parent stays idle
      // it never transforms history, so restore owned children here from host
      // state instead of waiting for the next parent request. Verification is
      // in the scanner: parent launch evidence is required before adoption.
      void recoverSubagentSessionsAtStartup({
        input: ctx,
        backgroundJobBoard: backgroundJobBoard,
        shouldManageSession: (sessionID) =>
          sessionMetadata.getAgent(sessionID) === 'orchestrator' ||
          sessionMetadata.isTaskManaged(sessionID),
        hostFlavor,
        isDisposed: () => instanceDisposed,
        registerParentSession: (sessionID) => {
          // Membership in task management, matching the transform path.
          sessionMetadata.markTaskManaged(sessionID);
        },
        backgroundTaskConcurrency,
        getModelForAgent,
        onRecoveredTerminal: async (parentSessionID, taskID) => {
          const record = backgroundJobBoard!.get(taskID);
          if (!record) return false;
          return (
            (await orchestratorWakeScheduler?.triggerTerminalPublicationWake(
              parentSessionID,
              taskID,
              record.generation,
              record.terminalRevision,
            )) === true
          );
        },
      }).catch((error: unknown) => {
        log('[task-session-manager] startup subagent recovery failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      backgroundJobBoard!.addTerminalOutcomeListener((record) => {
        // A placeholder is not delegated work; its stop is not recoverable
        // by the parent until a task launch has attributed the session.
        if (record.provisional === true) return;
        // A child's terminal state resolves any of its open input waits: the
        // ask is gone with the run, so a queued wake must not fire for it and
        // task_status must not show it after a restart. Runs on both hosts —
        // the ask store has no run-generation fence of its own.
        clearChildInputWaitsForSession(record.taskID);
        // v2 has no wake machinery (no scheduler): native delivery owns
        // stops for job-backed runs, and the plugin does not push one for
        // a non-job run (council 2026-10-23).
        if (hostFlavor === 'v2') return;
        if (record.state !== 'stopped' || !record.terminalUnreconciled) return;
        // Symmetric tracker suppression (M4): when the revived-run tracker
        // owns this generation's delivery — it already delivered the run's
        // terminal <task> notification — a recovery wake beside it would
        // queue a second admission for a lineage the parent already heard
        // from. Scoped like the publication listener's check: a stop that
        // is the generation's FIRST publication has no tracker delivery
        // beside it (the tracker only delivers completed/error), so the
        // recovery wake stays that stop's one and only notification.
        if (
          record.terminalRevision > 1 &&
          revivedRunTracker!.willNotifyParent(record.taskID, record.generation)
        ) {
          log('[orchestrator-wake] stopped-job recovery wake skipped', {
            sessionID: record.parentSessionID,
            taskID: record.taskID,
            generation: record.generation,
            trigger: 'stopped-job-recovery',
            verdict: 'skipped',
            reason: 'revived-tracker-owns-delivery',
          });
          return;
        }
        // Host-attributed double-delivery gate: a stop the host itself
        // reported (interrupted/cancelled — the terminal gate's own result
        // summary, same anchor as stoppedJobRecoveryReason) is already
        // delivered to the parent by the host's native notifier for a
        // tool-launched generation, so a recovery wake beside it would
        // queue a second admission for one stop. The revived-run tracker is
        // the complementary view: when it owns this generation's delivery
        // (task_revive lineage), omos stays the wake's author and the skip
        // does not apply. Tracker without a record for this (taskID,
        // generation) reads as false → only host-attributed stops fall to
        // the native side (error-safe: at worst a redundant wake is
        // dropped); every other stop keeps its recovery wake.
        // First-publication only (terminalRevision === 1): the native
        // observer is armed per tool-launched run, and every
        // tool-launched relaunch resets the revision (board recordLaunch
        // bumps the generation and zeroes terminalRevision), so a
        // revision-1 host-attributed stop is always a fresh tool-launched
        // run the native notifier covers. A later publication (rev > 1)
        // means the child ran again WITHOUT a tool launch — e.g. a direct
        // prompt after completion — where no native observer exists for
        // the new run and this recovery wake is the only notification the
        // parent gets. Skipping there would lose the stop entirely.
        if (
          record.terminalRevision === 1 &&
          record.recoveredAtStartup !== true &&
          HOST_ATTRIBUTED_STOP_OUTCOME.test(record.resultSummary ?? '') &&
          !revivedRunTracker!.willNotifyParent(record.taskID, record.generation)
        ) {
          log('[orchestrator-wake] stopped-job recovery wake skipped', {
            sessionID: record.parentSessionID,
            taskID: record.taskID,
            generation: record.generation,
            trigger: 'stopped-job-recovery',
            verdict: 'skipped',
            reason: 'native-delivers-host-attributed-stop',
          });
          return;
        }
        orchestratorWakeScheduler?.triggerStoppedJobRecovery(
          record.parentSessionID,
          // Self-contained stop facts (issue #1051): the recovery wake is an
          // internal-initiator turn, and internal-initiator turns place no
          // board, so the wake must carry the stop facts itself.
          formatStoppedJobDelta({
            alias: record.alias,
            taskID: record.taskID,
            generation: record.generation,
            state: record.state,
            reason: stoppedJobRecoveryReason(record),
          }),
          `${record.taskID}:${record.generation}`,
        );
      });
      // Terminal-publication wake: completed/error publications reaching an
      // IDLE parent (state-disjoint from the stopped recovery listener
      // above — stopped+terminalUnreconciled vs completed|error). A busy
      // parent is skipped inside the trigger: the native steer already
      // delivered the first completion, so a queued wake would
      // double-notify.
      backgroundJobBoard!.addTerminalOutcomeListener((record) => {
        revivedRunTracker!.onTerminal(record);
        // tool relaunch re-arms the native observer, and a direct-prompt
        // rev>1 run is out of plugin scope (council 2026-10-23).
        if (hostFlavor === 'v2') return;
        // Unattributed child sessions are not delegated work, just as in
        // stopped-job recovery; their owner controls parent notifications.
        if (record.provisional === true) return;
        if (record.state !== 'completed' && record.state !== 'error') return;
        // Revived-run ownership: when the tracker will deliver this run's
        // <task> result itself (notifyParent), a publication wake beside
        // it would queue a SECOND admission to the idle parent — the
        // double-notify the exactly-once notification contract forbids.
        // Scoped to the exact (taskID, generation) the tracker owns;
        // non-revived publications are unaffected.
        if (
          revivedRunTracker!.willNotifyParent(record.taskID, record.generation)
        ) {
          log('[orchestrator-wake] terminal publication wake skipped', {
            sessionID: record.parentSessionID,
            taskID: record.taskID,
            generation: record.generation,
            trigger: 'terminal-publication',
            verdict: 'skipped',
            reason: 'revived-tracker-owns-delivery',
          });
          return;
        }
        // First-publication ownership (live-verified on a 2.0.8 host): the
        // native notifier delivers a run's FIRST terminal publication to
        // the parent even while it sits idle, so a plugin push beside it
        // would double-notify. On v2 EVERY plugin task launch AND relaunch
        // is a host `subagent` tool call that arms the host's native
        // background notifier — a relaunch re-arms it with a fresh
        // `started_at`, defeating the notify dedupe — so the native
        // contract covers the FIRST publication (terminalRevision 1) of
        // EVERY generation, not just the original launch. Only later
        // revisions of the same generation (rev>1: a child
        // self-continuation, a direct prompt to the child session) have no
        // native notifier and remain the plugin's to deliver (v1 behaves
        // the same: the native task tool arms notifyBackgroundResult per
        // background call). Edge: if a native delivery is ever lost
        // host-side, the job falls back to the stale-terminal display on
        // the parent's next activity, or stays silent until the next
        // task_status pull.
        // A startup-adopted row was launched before this plugin instance
        // existed, so no native observer survives to deliver its first
        // publication. The plugin owns that wake.
        if (
          record.terminalRevision === 1 &&
          record.recoveredAtStartup !== true
        ) {
          // The native notifier owns this publication. Native ownership alone
          // is not proof of delivery, so nothing is acknowledged here: the
          // next restart's history scan either finds a trusted current-run
          // delivery or re-owns this terminal outcome.

          log('[orchestrator-wake] terminal publication wake skipped', {
            sessionID: record.parentSessionID,
            taskID: record.taskID,
            generation: record.generation,
            trigger: 'terminal-publication',
            verdict: 'skipped',
            reason: 'first-publication-native-owned',
          });
          return;
        }
        // v1 is structurally boardless: the board no longer carries later
        // terminal results. Push ONE self-contained `<completed-job>` delta
        // through the bounded delta queue (durable across a busy parent and
        // the publication throttle) instead of the drop-prone publication
        // wake. The fence in the part metadata retires exactly this
        // publication when the parent observes it.
        if (
          runtime.backgroundJobs.orchestratorWake.wakeOnTerminalPublication ===
          false
        ) {
          return;
        }
        const state =
          record.terminalState === 'completed' ||
          record.terminalState === 'error'
            ? record.terminalState
            : record.state === 'completed' || record.state === 'error'
              ? record.state
              : undefined;
        if (!state) return;
        orchestratorWakeScheduler?.triggerCompletedJobPublication(
          record.parentSessionID,
          formatCompletedJobDelta({
            alias: record.alias,
            taskID: record.taskID,
            state,
            resultSummary: record.resultSummary ?? state,
          }),
          `${record.taskID}:${record.generation}`,
          {
            taskID: record.taskID,
            generation: record.generation,
            terminalRevision: record.terminalRevision,
            state,
          },
        );
      });
    }

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
      if (councilSeats.length > 0) {
        councilInject = createCouncilInjectHook({ wording: delegation });
      }
    }

    if (!runtime.disabledHooks.has('auto-update-checker')) {
      // Initialize auto-update checker hook
      autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
        autoUpdate: runtime.autoUpdate,
        companion: runtime.companion,
      });
    }

    // disabled_hooks: "chat-headers" keeps the hook unregistered on both
    // hosts — the v2 bridge reads v1Hooks['chat.headers'] and skips the
    // model.request registration when the key is absent.
    if (!runtime.disabledHooks.has('chat-headers')) {
      chatHeadersHook = createChatHeadersHook(ctx);
    }

    // Initialize foreground fallback manager for runtime model switching.
    // Agents without a chain (e.g. councillor, owned by CouncilManager) are
    // left alone — FG only aborts/re-prompts when it has a model to switch to.
    // The observation handoff brackets the re-prompt admission for
    // BACKGROUND children (false-stop incident): prepare() defers the stop
    // gate before the await, admit() enrolls the run tracker after host
    // acceptance, reject() withdraws on failure; see
    // fallback-observation-transfer.ts.
    // Lifecycle off: the manager is still constructed (v2 retry steering
    // depends on it) but the board-derived deps pass undefined instead of
    // false-returning stubs — no board, no supervisor, no handoff exists
    // to observe, so the manager stays honest about the absent surface.
    const backgroundFallbackHandoff = lifecycleEnabled
      ? createBackgroundFallbackHandoff({
          backgroundJobBoard: backgroundJobBoard!,
          revivedRunTracker: revivedRunTracker!,
        })
      : undefined;
    // The current v2 host interface has no per-turn/atomic conditional
    // switch, so an in-flight REPLAY (abort + re-prompt) can commit on the
    // host after a newer user turn has taken over — the replay path stays
    // disabled on v2 (a3ac0bee). The retry-hook steering path performs no
    // replay: it mutates the host's in-flight retry decision and switches
    // the model in place via session.switchModel, so the a3ac0bee race
    // cannot occur. Steering is host-agnostic (only v2 hosts invoke the
    // hook) and follows the same user switches as the replay path
    // (fallback.enabled / disabled_hooks).
    const fallbackUserEnabled =
      runtime.fallback.enabled !== false &&
      !runtime.disabledHooks.has('foreground-fallback');
    // v2 can enable fallback per session through a live config refresh
    // (pinned bundle `fallbackEnabled`), so keep the manager and its retry
    // hook unless the hook itself is disabled; it stays cheap while every
    // path is off (handleEvent early-returns).
    const fallbackManagerNeeded =
      fallbackUserEnabled ||
      (hostFlavor === 'v2' &&
        !runtime.disabledHooks.has('foreground-fallback'));
    fallbackRetryHookEnabled = fallbackManagerNeeded;
    const fallbackEnabled = fallbackUserEnabled && hostFlavor !== 'v2';
    const v2RetryEnabled = fallbackUserEnabled;
    if (fallbackUserEnabled && hostFlavor === 'v2') {
      // Deterministic notice: no timestamps or per-call ids. Do not log when
      // the user explicitly disabled fallback, including via disabled_hooks.
      log(
        '[foreground-fallback] v2 replay fallback disabled (no atomic per-turn model switch); retry-hook steering active',
      );
    }
    // Startup generation: captured here and republished (contents swap) by
    // registry finalize and every successful profile refresh. The manager
    // aliases this record; see publishChainGeneration.
    foregroundFallbackChains = runtime.modelArrays;
    foregroundFallback = fallbackManagerNeeded
      ? new ForegroundFallbackManager(
          foregroundFallbackChains,
          fallbackEnabled,
          ctx,
          runtime.fallback.maxRetries,
          sessionLifecycle,
          // A managed background-task session switching models mid-flight must
          // move its admission accounting (provider/model caps) to the new
          // model. No-op for unknown/non-task sessions; idempotent per model.
          // Undefined when the lifecycle is off: no admission runtime exists.
          lifecycleEnabled
            ? (sessionID, model) =>
                backgroundTaskConcurrency?.migrateTask(sessionID, model)
            : undefined,
          runtime.fallback.initialRetryDelayMs,
          runtime.fallback.retryDelayMs,
          backgroundFallbackHandoff,
          // Identify confirmed background children even after cancellation or
          // termination, so handoff preparation rejects a delayed stale replay.
          // Undefined remains exclusive to foreground/unmanaged sessions, and
          // is the honest value when no board exists.
          lifecycleEnabled
            ? (sessionID) => {
                const record = backgroundJobBoard?.get(sessionID);
                return record?.background === true
                  ? record.generation
                  : undefined;
              }
            : undefined,
          lifecycleEnabled
            ? (sessionID) => backgroundJobBoard?.hasRunning(sessionID) ?? false
            : undefined,
          v2RetryEnabled,
        )
      : undefined;

    // P0 cold gating: each on-demand tool guard is only constructed when
    // its disabled_hooks entry is absent, so a disabled guard performs no
    // construction work or per-tool-call work.
    if (!runtime.disabledHooks.has('apply-patch')) {
      applyPatch = createApplyPatchHook(ctx);
    }

    if (!runtime.disabledHooks.has('search-path-guard')) {
      searchPathGuard = createSearchPathGuardHook(ctx);
    }

    if (!runtime.disabledHooks.has('absolute-path-rescue')) {
      absolutePathRescue = createAbsolutePathRescueHook(ctx);
    }

    if (!runtime.disabledHooks.has('json-error-recovery')) {
      const jsonErrorRecoveryHook = createJsonErrorRecoveryHook(ctx);
      jsonErrorRecoveryAfter = wrapPostToolHook('json-error-recovery', (i, o) =>
        jsonErrorRecoveryHook['tool.execute.after'](i as never, o as never),
      );
    }
    if (!runtime.disabledHooks.has('tool-loop-guard')) {
      toolLoopGuard = createToolLoopGuardHook({ directory: ctx.directory });
    }

    // Pre-created wrapped handler for tool.execute.after (error-isolated).
    if (taskSessionManagerHook) {
      taskSessionManagerAfter = wrapPostToolHook(
        'task-session-manager',
        (i, o) =>
          taskSessionManagerHook!['tool.execute.after'](i as never, o as never),
      );
    }
    // Council seat assembly: the managed resolver runs against the board
    // while the lifecycle owns it; without the lifecycle the native resolver
    // resolves seat refs through the host client and no board is involved.
    // The hook only acts on council delegations carrying a final `Seats:`
    // line and never throws.
    councilSeatHook = createCouncilSeatHook({
      resolveSeats: lifecycleEnabled
        ? createManagedSeatResolver(backgroundJobBoard!)
        : createNativeSeatResolver(ctx),
    });
    if (runtime.interviewEnabled) {
      const { collapseInterviewHistory } = await import('./interview/history');
      collapseActiveInterviewHistory = collapseInterviewHistory;
      // v2 owns its bridge; the submit tool resolves its service after the
      // setup handoff. v1 alone loads the legacy command/event owner.
      if (hostFlavor !== 'v2') {
        const { createInterviewManager } = await import('./interview');
        interviewManager = createInterviewManager(ctx, config);
        interviewSubmitService = interviewManager.service;
      }
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
    if (lifecycleEnabled) {
      // Invariant: the lifecycle block above initialized the shared recovery
      // and alias state. Checked once here so TypeScript narrows it for the
      // control-tool registrations below, instead of `!` at every option.
      if (!recoverRetainedSession || !aliasAuthority) {
        throw new Error(
          'managed lifecycle enabled without recovery/alias state',
        );
      }
      const taskCancelTools = createCancelTaskTool({
        input: ctx,
        backgroundJobBoard: backgroundJobBoard!,
        terminalGate,
        shouldManageSession: (sessionID) =>
          sessionMetadata.getAgent(sessionID) === 'orchestrator' ||
          sessionMetadata.isTaskManaged(sessionID),
        recoverRetainedSession,
        resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
        isDisposed: () => instanceDisposed,
      });
      const taskReplyTools = createTaskReplyTool({
        input: ctx,
        backgroundJobBoard: backgroundJobBoard!,
        resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
        isDisposed: () => instanceDisposed,
      });
      const taskStatusTools = createTaskStatusTool({
        input: ctx,
        backgroundJobBoard: backgroundJobBoard!,
        activityTracker: taskActivityTracker,
        terminalGate,
        resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
        isDisposed: () => instanceDisposed,
      });
      const taskReviveTools = createTaskReviveTool({
        isFallbackPending,
        ...(hostFlavor !== 'v2' && {
          registerIntent: registerV1DelegatedIntent,
        }),
        terminalGate,
        input: ctx,
        backgroundJobBoard: backgroundJobBoard!,
        shouldManageSession: (sessionID) =>
          sessionMetadata.getAgent(sessionID) === 'orchestrator' ||
          sessionMetadata.isTaskManaged(sessionID),
        backgroundJobSupervisor: backgroundJobSupervisor!,
        revivedRunTracker: revivedRunTracker!,
        recoverRetainedSession,
        isDisposed: () => instanceDisposed,
        resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
      });
      const waitForUserTools = createWaitForUserTool({
        shouldManageSession: (sessionID) =>
          sessionMetadata.getAgent(sessionID) === 'orchestrator' ||
          sessionMetadata.isTaskManaged(sessionID),
        resolveAgentName: (agent) => resolveRuntimeAgentName(runtime, agent),
        registerSessionAsOrchestrator: (sessionID) => {
          sessionMetadata.markTaskManaged(sessionID);
        },
        beginUserWait: (sessionID) => {
          taskSessionManagerHook?.beginUserWait(sessionID);
          orchestratorWakeScheduler?.suppress(sessionID);
        },
        waitForUserGuardEnabled: runtime.backgroundJobs.waitForUserGuard,
        hasOutstandingBackgroundTasks: (sessionID) =>
          runtime.backgroundJobs.orchestratorWake.enabled &&
          (backgroundJobBoard?.hasRunning(sessionID) ?? false),
      });
      const taskMessageTools =
        hostFlavor !== 'v2' && !runtime.disabledTools.includes('task_message')
          ? createTaskMessageTool({
              input: ctx,
              backgroundJobBoard: backgroundJobBoard!,
              resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
              isDisposed: () => instanceDisposed,
            })
          : {};
      lifecycleTaskTools = {
        ...taskCancelTools,
        ...taskMessageTools,
        ...taskReplyTools,
        // Keep master's v1 registration order (cache-stable tool list).
        ...(hostFlavor !== 'v2' ? taskReviveTools : {}),
        ...taskStatusTools,
        ...(hostFlavor !== 'v2' ? waitForUserTools : {}),
      };
    }

    // v2 hosts skip wait_for_user: the native `question` tool covers the
    // blocking boundary there. task_revive remains a v1-only recovery tool;
    // v2 resumes retained sessions through native subagent(sessionID, prompt).
    // v1 registration is unchanged; the generic disabled_tools filter below
    // still removes either tool when listed. The interview tool follows the
    // interviewEnabled master switch in addition to disabled_commands.
    const shouldRegisterWebfetch = runtime.webfetch.enabled !== false;
    const shouldRegisterInterview =
      runtime.interviewEnabled && !runtime.disabledCommands.has('interview');
    const interviewTools = shouldRegisterInterview
      ? createInterviewSubmitStateTool({
          service: () => {
            if (!interviewSubmitService) {
              throw new Error('interview service unavailable');
            }
            return interviewSubmitService;
          },
          maxQuestions: config.interview?.maxQuestions,
        })
      : {};
    tools = {
      ...lifecycleTaskTools,
      ...interviewTools,
      ...acpRunTools,
      ...(shouldRegisterWebfetch && webfetch ? { webfetch } : {}),
      ast_grep_search,
      ast_grep_replace,
    };
    if (runtime.disabledTools.length > 0) {
      const disabledTools = new Set(runtime.disabledTools);
      tools = Object.fromEntries(
        Object.entries(tools).filter(([name]) => !disabledTools.has(name)),
      );
    }
  } catch (err) {
    terminalGate?.dispose();
    admissionRuntimeLease?.release();
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
  // the enhanced webfetch is disabled: a disabled feature must not pay for
  // the JSDOM load (the probe is the only startup importer of jsdom).
  if (runtime.webfetch.enabled !== false) {
    probeJSDOM().then((err) => {
      if (err) {
        const msg = `jsdom probe failed; webfetch tool will not work: ${err}`;
        log(`[plugin] WARN: ${msg}`);
        appLog(ctx, 'warn', msg).catch(() => {});
      }
    });
  }

  if (runtime.companion?.enabled === true) {
    try {
      const { ensureCompanionVersion } = await import('./companion/updater');
      const companionResult = await ensureCompanionVersion({
        config: runtime.companion,
        downloadTimeoutMs: 3_000,
        lockTimeoutMs: 500,
      });
      if (companionResult.status === 'installed') {
        log('[companion] updated before startup', companionResult.version);
      } else if (companionResult.status === 'failed') {
        log('[companion] startup update failed', companionResult.error);
      }
    } catch (err) {
      log('[companion] startup update failed', String(err));
    }
  }

  if (companionManager) {
    companionManager.onLoad();
  } else {
    // Disabled: no manager, but still prune this session's stale entry
    // (and any manager a previous enabled load left running).
    const { companionSessionIdForDirectory, pruneDisabledCompanionSession } =
      await import('./companion/manager');
    pruneDisabledCompanionSession(
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
      getDesiredState: (packageInspection) => {
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
        const availableSkillNames = discoverPreflightSkills(
          freshRuntime,
          ctx.directory,
        );
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
                  availableSkillNames: selectedMarketplacePackageIds.length
                    ? discoverPreflightSkills(runtime, ctx.directory)
                    : [],
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
      if (
        (isCommandEnabled('interview', commandGate) ||
          isCommandEnabled('implement', commandGate)) &&
        interviewManager
      ) {
        interviewManager.registerCommand(opencodeConfig, {
          interview: isCommandEnabled('interview', commandGate),
          implement: isCommandEnabled('implement', commandGate),
        });
      }
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
  if (marketplaceEnabled && marketplaceService) {
    const { createMarketplaceTools, resolveFinalizedOrchestratorIdentities } =
      await import('./tools/marketplace');
    const marketplaceTools = createMarketplaceTools({
      service: marketplaceService,
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
    runtime.webfetch.enabled !== false,
    hostFlavor,
    runtime.backgroundJobsEnabled,
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
   * `finalHostAgentConfig`) is untouched — a throwaway `RuntimeConfig.create`
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
      const freshAgentDefs = createAgents(freshRuntime, {
        projectDirectory: ctx.directory,
        hostFlavor,
      });
      const freshAgents = getAgentConfigsFromDefinitions(
        freshRuntime,
        freshAgentDefs,
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
        agentDefs: freshAgentDefs,
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
        freshAgentDefs,
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
      if (options?.detached) return { ok: true, profiles, projection, bundle };
      // Sidebar projection must land before the profiles are reported as
      // refreshed (the caller swaps only on an ok result).
      //
      // The refresh resolves inference fields for the core agent set only:
      // `createAgents()` is marketplace-unaware, while the finalized registry
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
      return { ok: true, profiles, projection, bundle };
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

  // A child can move to another live location while its task board stays
  // with the delegating parent. Only task observation crosses that boundary;
  // the destination retains ownership of permissions, profiles and tools.
  // Without the managed lifecycle there is no board to track, so the
  // handler stays inert.
  const observeForeignTaskEvent: NonNullable<Hooks['event']> = async (
    input,
  ) => {
    if (instanceDisposed) return;
    if (!taskSessionManagerHook || !backgroundJobBoard) return;
    const taskEvent = input as Parameters<
      (typeof taskSessionManagerHook)['event']
    >[0];
    const sessionID = resolveEventSessionID(taskEvent.event);
    if (sessionID && backgroundJobBoard.isTracked(sessionID)) {
      await taskSessionManagerHook.event(taskEvent);
    }
  };

  const hooks = {
    registryBridge,
    name: 'oh-my-opencode-slim',
    // v2-only extension hook: re-read the plugin config and resolve the
    // inference/runtime profiles for new child sessions + the sidebar.
    // Unknown to v1 hosts, consumed by src/v2/setup.ts.
    'v2.refreshProfiles': refreshProfilesFromDisk,
    'v2.foreignTaskEvent': observeForeignTaskEvent,
    'v2.resolveDelegatedModel': resolveV2DelegatedModel,
    'v2.setSessionTeamResolver': (resolver: typeof sessionTeamFor) => {
      sessionTeamFor = resolver;
    },
    // Per-instance background-default flip handle: v2 setup arms it after
    // its description rewrite verifies and disarms it with its teardown.
    'v2.backgroundDefaultFlip': backgroundDefaultFlip,
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
      service: ReturnType<typeof createInterviewManager>['service'],
    ) => {
      interviewSubmitService = service;
    },
    // v2-only extension handle (consumed by src/v2/setup.ts's executor
    // wrapper): register a delegated `subagent` launch from its STRUCTURED
    // executor result, forwarding to the task-session-manager's shared fence
    // pipeline (marks the pending handled-by-wrapper for the exact-once gate).
    // No-op when the managed lifecycle is disabled (no fence pipeline).
    'v2.registerDelegatedLaunchFromStructured': (
      input: Parameters<
        NonNullable<
          NonNullable<
            typeof taskSessionManagerHook
          >['v2.registerDelegatedLaunchFromStructured']
        >
      >[0],
    ) =>
      taskSessionManagerHook?.['v2.registerDelegatedLaunchFromStructured'](
        input,
      ),
    // v2-only extension handle (consumed by src/v2/setup.ts's prompt
    // bridge): feed the prompt identity the host prepared for a session
    // into the shared pending-call tracker. The awaited `session.prompt`
    // hook carries the eventual inbox messageID and precedes every delayed
    // chat.message / context forward, but it runs BEFORE the admission
    // commits — so this is earliest capture, not proof of admission. Only
    // the native outcome lane may stamp from it. No-op when the managed
    // lifecycle is disabled (no lease).
    'v2.notePromptAdmission': (sessionID: string, messageID: string) =>
      admissionRuntimeLease?.pendingCallTracker.noteAdmission(
        sessionID,
        messageID,
      ),

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
        registryBridge.finalize(preMutationHostSnapshot, {});
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
          },
          ctx.directory,
        );
      }

      // This is the source of truth for admission. It is intentionally
      // captured only after every host/plugin merge, model pass and
      // permission pass.
      finalHostAgentConfig = opencodeConfig.agent as Record<string, unknown>;

      registryBridge.prepareCommands(opencodeConfig);
    },

    event: (input) =>
      withTuiSnapshotBatch(async () => {
        if (input.event.type === 'server.instance.disposed') {
          instanceDisposed = true;
          terminalGate?.dispose();
        }
        // Token streams have no work in this fan-out. The v2 Interview
        // bridge consumes text deltas independently before dispatching here.
        const streamEventType = (input.event as { type?: string } | undefined)
          ?.type;
        if (
          streamEventType === 'message.part.delta' ||
          streamEventType === 'session.text.delta' ||
          streamEventType === 'session.reasoning.delta'
        ) {
          return;
        }

        // Directory-local handling stays scoped; moved children still reach
        // their task owner. Unresolved events fall through (fail-open).
        eventDirectoryScope?.note(input.event);
        if (eventDirectoryScope?.isForeign(input.event)) {
          await observeForeignTaskEvent(input);
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
              parentID?: string;
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
        // cache-monitor is created only when its disabled_hooks entry is
        // absent; the optional chain keeps the event path fail-open either way.
        await cacheMonitor?.event(input);
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
        if (
          eventSessionID &&
          sessionMetadata.getAgent(eventSessionID) === 'orchestrator' &&
          (event.type === 'session.idle' ||
            (event.type === 'session.status' && statusType === 'idle'))
        ) {
          toolLoopGuard?.resetTurn(eventSessionID);
        }
        if (eventSessionID && event.type === 'session.deleted') {
          toolLoopGuard?.resetSession(eventSessionID);
        }
        if (eventSessionID) {
          if (taskActivityTracker) {
            applyActivityEvent(
              taskActivityTracker,
              event,
              Date.now(),
              eventSessionID,
            );
          }
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
          if (typeof info?.sessionID === 'string' && providerID && modelID) {
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
            // Managed background-task sessions are identified by their session
            // ID. If the model serving one changed (fallback re-prompt, runtime
            // switch), migrate the admission accounting so provider/model caps
            // keep tracking the model actually in use. No-op for other
            // sessions and idempotent when the model is unchanged.
            backgroundTaskConcurrency?.migrateTask(info.sessionID, model);
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
          // v2 hands over the raw envelope before its mapped shapes: without
          // `info`, take the session and the host creation time from it.
          const info = event.properties?.info;
          const freshID = info
            ? info.id
            : (event.data?.sessionID ?? event.properties?.sessionID);
          const createdAt = info ? info.time?.created : event.created;
          if (typeof freshID === 'string' && typeof createdAt === 'number') {
            backgroundJobBoard?.noteSessionCreated(freshID, createdAt);
          }
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

        // Invalidate task continuations before the instance-disposed cleanup
        // (the former multiplexer event handling moved to the client process
        // with the pane lifecycle; the server never touches panes).
        await taskSessionManagerHook?.event(
          input as {
            event: {
              type: string;
              properties?: { info?: { id?: string }; sessionID?: string };
            };
          },
        );
        if (event.type === 'server.instance.disposed') {
          clearTuiActivities();
        }

        await orchestratorWakeScheduler?.event(
          input as {
            event: {
              type: string;
              properties?: {
                info?: { id?: string };
                sessionID?: string;
                status?: { type?: string };
              };
            };
          },
        );

        // Runtime model fallback for foreground agents (rate-limit detection).
        // Same ordering rule as above: commit staged state before re-prompt.
        flushTuiSnapshotBatch();
        await foregroundFallback?.handleEvent(input.event);

        // Handle auto-update checking; the checker only exists when its
        // disabled_hooks entry is absent.
        await autoUpdateChecker?.event(input);

        await interviewManager?.handleEvent(
          input as {
            event: { type: string; properties?: Record<string, unknown> };
          },
        );

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
          companionManager?.onWaitingInput(companionRequestId);
        }

        if (
          event.type === 'permission.replied' ||
          event.type === 'question.replied' ||
          event.type === 'question.rejected'
        ) {
          companionManager?.onInputResolved();
        }

        const companionStatus = normalizeCompanionSessionStatus(
          event.type,
          statusType,
        );
        if (eventSessionID && companionStatus) {
          const job = backgroundJobBoard?.get(eventSessionID);
          companionManager?.onSessionStatus({
            sessionId: eventSessionID,
            agent: sessionMetadata.getAgent(eventSessionID),
            status: companionStatus,
            jobFinished: job !== undefined && job.state !== 'running',
          });
        }

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
            v1InternalSelectionOverrides.delete(sessionID);
            sessionMetadata.delete(sessionID);
          }
        }
      }),

    dispose: async () => {
      eventDirectoryScope?.release();
      // Synchronous: v2 setup calls this directly and does not emit the
      // public server.instance.disposed event first.
      instanceDisposed = true;
      registryBridge.retire();
      terminalGate?.dispose();
      // Cancel pending initial-delay fallback timers so a reloaded
      // generation cannot observe one stale fallback call.
      foregroundFallback?.dispose();
      await taskSessionManagerHook?.event({
        event: { type: 'server.instance.disposed' },
      });
      await orchestratorWakeScheduler?.event({
        event: { type: 'server.instance.disposed' },
      });
      // The wake gate is process-global (globalThis + Symbol.for) and survives
      // module re-entry, so a reloaded generation would otherwise inherit the
      // previous generation's no-progress caps. Clear it only when this was the
      // last live instance: disposing one of several locations must not wipe
      // the other locations' wake state.
      if (!hasLiveInstances()) clearAllWakeSessions();
      v1InternalSelectionOverrides.clear();
      v1DelegatedIntents.length = 0;
      await interviewManager?.dispose();
      clearTuiActivities();
      tuiReusableProjection?.dispose();
      // Explicitly release this generation's companion ownership: a
      // reloaded generation only replaces the active manager at its own
      // onLoad, and if it fails before that the detached companion would
      // survive until process exit. Idempotent (registerActiveManager's
      // replacement path and the process-exit listener tolerate repeats).
      companionManager?.onExit();
      // Release only this generation's ownership. The admission runtime
      // defers final scheduler/tracker teardown by one macrotask so an
      // immediate config-update re-init can retain active and queued calls.
      admissionRuntimeLease?.release();
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
      await taskSessionManagerHook?.['tool.execute.before'](
        input as never,
        output as never,
      );
      // Council seat assembly: acts only on a council delegation whose
      // prompt carries a final `Seats:` line, and never throws. Runs after
      // the task-session-manager's before-hook so lifecycle fencing (task
      // resume validation) precede the assembly rewrite.
      await councilSeatHook?.['tool.execute.before'](
        input as never,
        output as never,
      );
      if (
        hostFlavor !== 'v2' &&
        input.tool.toLowerCase() === 'task' &&
        output.args !== null &&
        typeof output.args === 'object' &&
        !Array.isArray(output.args)
      ) {
        const args = output.args as Record<string, unknown>;
        if (typeof args.subagent_type === 'string') {
          // Keep the canonical specialist name for host permissions and lookup.
          registerV1DelegatedIntent(
            input.sessionID,
            typeof args.task_id === 'string' ? args.task_id : undefined,
            args.subagent_type,
          );
        }
      }
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

      const slashCommand = (input as { command?: string }).command;
      if (
        ((slashCommand === 'interview' && commandEnabled('interview')) ||
          (slashCommand === 'implement' && commandEnabled('implement'))) &&
        interviewManager
      ) {
        await interviewManager.handleCommandExecuteBefore(
          input as {
            command: string;
            sessionID: string;
            arguments: string;
          },
          output as { parts: Array<{ type: string; text?: string }> },
        );
      }

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

    // v1 compaction requests use the same message transform as normal turns.
    // v2 handles compaction in its separate session.compaction bridge.
    'experimental.session.compacting': async ({ sessionID }) => {
      compactingSessionIds.add(sessionID);
    },

    // v1-only interview fallback: capture a printed <interview_state> block
    // through the shared apply step, then strip it from the saved/visible
    // text. v2 has no equivalent hook.
    'experimental.text.complete': async (input, output) => {
      if (!interviewSubmitService) return;
      try {
        output.text = await interviewSubmitService.completeInterviewText(
          input.sessionID,
          output.text,
          input.messageID,
        );
      } catch (err) {
        log('[plugin] interview text completion failed', String(err));
      }
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
      // V1-only: v1 has no prompt hook, so chat.message is the admission
      // gate; on v2 the awaited `session.prompt` hook feeds the tracker
      // earlier, and this delayed forward would only re-bind a live pending.
      if (hostFlavor !== 'v2' && typeof messageID === 'string') {
        admissionRuntimeLease?.pendingCallTracker.noteAdmission(
          input.sessionID,
          messageID,
        );
      }
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
        const model = input.model ?? output?.message?.model;
        foregroundFallback?.observeExternalTurn(
          input.sessionID,
          model ? `${model.providerID}/${model.modelID}` : undefined,
        );
      }

      // v1 confirms the session before publishing it, but saves this user
      // message after chat.message. Only an empty host transcript can claim
      // a creation intention; task_id resumes claim their explicit child ID.
      const childAgentRaw = input.agent ?? output?.message?.agent;
      let childRoute: (typeof v1DelegatedIntents)[number] | undefined;
      if (hostFlavor !== 'v2' && !internalAdmission && childAgentRaw) {
        const agentName = resolveRuntimeAgentName(runtime, childAgentRaw);
        childRoute = v1DelegatedIntents.find(
          (route) =>
            route.childID === input.sessionID && route.agentName === agentName,
        );
        if (
          !childRoute &&
          !sessionMetadata.getAgent(input.sessionID) &&
          v1DelegatedIntents.some(
            (route) => !route.childID && route.agentName === agentName,
          )
        ) {
          const controller = new AbortController();
          try {
            const request = {
              path: { id: input.sessionID },
              query: { directory: ctx.directory },
              throwOnError: true as const,
              signal: controller.signal,
            };
            const [{ data: session }, { data: messages }] = await withTimeout(
              Promise.all([
                ctx.client.session.get(request),
                ctx.client.session.messages({
                  ...request,
                  query: { ...request.query, limit: 1 },
                }),
              ]),
              DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS,
              'Host delegated child lookup timed out',
            );
            if (Array.isArray(messages) && messages.length === 0) {
              childRoute = v1DelegatedIntents.find(
                (route) =>
                  !route.childID &&
                  route.parentID === session?.parentID &&
                  route.agentName === agentName,
              );
            }
          } catch (error) {
            controller.abort();
            log('[delegation] child lookup failed', {
              sessionID: input.sessionID,
              error: String(error),
            });
          }
        }
        if (childRoute)
          v1DelegatedIntents.splice(v1DelegatedIntents.indexOf(childRoute), 1);
      }
      const routedChild =
        childRoute &&
        resolveDelegatedModelForParent(
          childRoute.agentName,
          childRoute.parentID,
        );
      const routedChildModel = routedChild
        ? modelFromMetadataString(routedChild.entry.id)
        : undefined;
      // A child already on the routed model (inherited from the parent)
      // keeps its message untouched, including the inherited variant.
      if (
        routedChild &&
        routedChildModel &&
        output?.message &&
        (output.message.model?.providerID !== routedChildModel.providerID ||
          output.message.model?.modelID !== routedChildModel.modelID)
      ) {
        output.message.model = {
          ...routedChildModel,
          ...(routedChild.entry.variant
            ? { variant: routedChild.entry.variant }
            : {}),
        };
        log('[delegation] routed v1 child model', {
          sessionID: input.sessionID,
          parentSessionID: childRoute?.parentID,
          agent: routedChild.agentName,
          model: routedChild.entry.id,
        });
      }

      // OpenCode v1's native background notifier does not pin a model. The
      // host therefore constructs (and persists) this synthetic message on
      // the agent's static primary before exposing chat.message, even when
      // the parent is already running on a fallback. Rewrite the message to
      // the policy-selected model: either retry the last external selection
      // or retain the confirmed fallback. Remember the exact selection so
      // later Slim lifecycle continuations use the same policy decision.
      const unpinnedV1InternalContinuation =
        hostFlavor !== 'v2' && internalAdmission && input.model === undefined;
      const trackedAgent = unpinnedV1InternalContinuation
        ? sessionMetadata.getAgent(input.sessionID)
        : undefined;
      const trackedModelText = unpinnedV1InternalContinuation
        ? runtime.fallback.continuationPolicy === 'stick-to-fallback'
          ? liveSessionModel(input.sessionID)
          : sessionMetadata.getModel(input.sessionID)
        : undefined;
      const trackedModel = modelFromMetadataString(trackedModelText);
      let rewroteInternalSelection = false;
      if (output?.message && unpinnedV1InternalContinuation) {
        if (trackedAgent && output.message.agent !== trackedAgent) {
          output.message.agent = trackedAgent;
          rewroteInternalSelection = true;
        }
        if (
          trackedModel &&
          (output.message.model?.providerID !== trackedModel.providerID ||
            output.message.model?.modelID !== trackedModel.modelID)
        ) {
          const variant = trackedAgent
            ? resolveTuiVariantForModel(trackedAgent, trackedModelText ?? '')
            : undefined;
          output.message.model = {
            ...trackedModel,
            ...(variant ? { variant } : {}),
          };
          rewroteInternalSelection = true;
        }
      }
      if (
        output?.message &&
        trackedModel &&
        trackedModelText &&
        output.message.model?.providerID === trackedModel.providerID &&
        output.message.model?.modelID === trackedModel.modelID
      ) {
        // The continuation policy changed (or confirmed) the model actually
        // serving this turn. Keep fallback state in sync so a task delegated
        // before the next external admission follows that model rather than
        // a stale fallback from the preceding turn.
        foregroundFallback?.observeContinuationModel(
          input.sessionID,
          trackedModelText,
        );
      }
      if (rewroteInternalSelection) {
        v1InternalSelectionOverrides.set(input.sessionID, {
          ...(trackedAgent ? { agent: trackedAgent } : {}),
          ...(trackedModel ? { model: trackedModel } : {}),
          ...(trackedModelText ? { modelText: trackedModelText } : {}),
          ...(output?.message?.model?.variant
            ? { variant: output.message.model.variant }
            : {}),
        });
        log('[fallback] applied v1 internal continuation model policy', {
          sessionID: input.sessionID,
          agent: trackedAgent,
          model: trackedModelText,
          policy: runtime.fallback.continuationPolicy,
        });
      } else if (!internalAdmission) {
        v1InternalSelectionOverrides.delete(input.sessionID);
      }

      const rawAgent =
        (unpinnedV1InternalContinuation ? trackedAgent : undefined) ??
        input.agent ??
        output?.message?.agent;
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
      const messageModel =
        (routedChild ? routedChildModel : undefined) ??
        input.model ??
        output?.message?.model;
      if (
        messageModel &&
        typeof messageModel.providerID === 'string' &&
        typeof messageModel.modelID === 'string'
      ) {
        const model = `${messageModel.providerID}/${messageModel.modelID}`;
        if (!internalAdmission) {
          sessionMetadata.setModel(input.sessionID, model);
          const liveVariant =
            routedChild?.entry.variant ??
            input.variant ??
            input.model?.variant ??
            output?.message?.model?.variant;
          companionManager?.onSessionModelChanged({
            sessionId: input.sessionID,
            model,
            ...(liveVariant ? { variant: liveVariant } : {}),
            variantObserved: true,
          });
          // Sidebar live-model projection. On v2 the prompt bridge
          // (createSessionPromptBridge) is the only event-sourced carrier of
          // agent+model+variant together — the usage-synthesized
          // message.updated has none of them — so the projection rides this
          // hook. A missing variant is the live choice too (model default):
          // no policy fallback, or a variant-only re-selection could never
          // clear the row. No caller-side dedupe: updateSnapshot short-
          // circuits unchanged writes through its memo, which also keeps
          // this path in step with recordTuiAgentModels bulk replacement
          // and retries after a failed write.
          if (runtime.sidebarEnabled && agent) {
            recordTuiAgentModel(
              {
                agentName: agent,
                model,
                variant: liveVariant ?? null,
                sessionID: input.sessionID,
              },
              tuiActivityDirectory(input.sessionID),
            );
          }
        }
        backgroundTaskConcurrency?.migrateTask(input.sessionID, model);
      }
      taskSessionManagerHook?.observeChatMessage(input, output);
      orchestratorWakeScheduler?.observeChatMessage(input, output);
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
      const isOrchestratorRequest =
        requestAgent !== undefined
          ? requestAgent === 'orchestrator'
          : sessionAgent === 'orchestrator' &&
            looksLikeMainChatRequest(output.system);
      if (isOrchestratorRequest) {
        const orchestratorDef = agentDefs.find(
          (a) => a.name === 'orchestrator',
        );
        const finalizedOrchestratorName =
          resolvedAgentRegistry?.identities.orchestrator ?? 'orchestrator';
        const finalizedOrchestrator =
          (resolvedAgentRegistry?.finalAgentConfig[finalizedOrchestratorName] as
            | Record<string, unknown>
            | undefined) ??
          (resolvedAgentRegistry?.finalAgentConfig.orchestrator as
            | Record<string, unknown>
            | undefined);
        const orchestratorPrompt =
          typeof finalizedOrchestrator?.prompt === 'string'
            ? finalizedOrchestrator.prompt
            : typeof orchestratorDef?.config?.prompt === 'string'
              ? orchestratorDef.config.prompt
              : buildOrchestratorPrompt({
                  disabledAgents: runtime.disabledAgents,
                  waitForUser:
                    runtime.backgroundJobsEnabled &&
                    !runtime.disabledTools.includes('wait_for_user'),
                  wakeScheduler:
                    runtime.backgroundJobsEnabled &&
                    runtime.backgroundJobs.orchestratorWake.enabled,
                  hostFlavor,
                  routingBlock: runtime.routingBlock,
                });
        // Dedup by the EFFECTIVE prompt, not by default-prompt markers:
        // a custom replacement without `<Role>` previously slipped past
        // the marker check and was appended twice (P + host + P).
        const alreadyInjected =
          !!orchestratorPrompt &&
          output.system.some(
            (s) => typeof s === 'string' && s.includes(orchestratorPrompt),
          );
        if (!alreadyInjected && orchestratorPrompt) {
          // Place the orchestrator prompt after AGENTS.md so the user's
          // behavioral rules (language, code conventions, etc.) retain
          // their intended priority. AGENTS.md is injected by OpenCode
          // core into system[0]; prepending the orchestrator prompt before
          // it buries user-defined rules under thousands of lines of
          // orchestration instructions.
          output.system[0] = `${output.system[0] || ''}\n\n${orchestratorPrompt}`;
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
      // auto routing keys on the turn's model: vision-capable models keep
      // image parts inline (native read); only non-vision chains fall back
      // to the observer relay. chat.message records the turn's model just
      // before this handler runs; the fallback chain covers mid-session
      // model switches.
      // `input` is an empty shell in this handler; use the sessionID
      // extracted from the messages above.
      const turnModelRef = sessionID
        ? parseModelRef(
            foregroundFallback?.getActiveFallback(sessionID)?.model ??
              sessionMetadata.getModel(sessionID),
          )
        : undefined;
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

      // Repair session mappings before the phase-reminder gate.
      if (taskSessionManagerHook) {
        await taskSessionManagerHook['experimental.chat.messages.transform'](
          input as never,
          typedOutput as never,
          view,
        );
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
      await taskSessionManagerHook?.injectBackgroundJobBoard(
        input,
        typedOutput,
      );
      // Ordering contract: the goal pointer is the trailing-most volatile
      // message — nothing appends after it, so re-entered transforms and the
      // board's own trailing-zone strip stay ordered.
      if (deepworkGoal) {
        // Board tail stripping/appending may preserve the array length while
        // replacing a message, so rebuild at this structural seam.
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

    'tool.execute.after': async (input, output) => {
      await jsonErrorRecoveryAfter(input, output);
      await toolLoopGuard?.['tool.execute.after'](
        input as never,
        output as never,
      );
      if (taskSessionManagerHook) await taskSessionManagerAfter(input, output);
    },
  } as Hooks & {
    'v2.foreignTaskEvent': typeof observeForeignTaskEvent;
    'v2.refreshProfiles': typeof refreshProfilesFromDisk;
    'v2.resolveDelegatedModel': typeof resolveV2DelegatedModel;
    'v2.setSessionTeamResolver': (resolver: typeof sessionTeamFor) => void;
    'v2.backgroundDefaultFlip': BackgroundDefaultFlipState;
    'v2.pinSessionChains': (
      sessionID: string,
      chains?: SessionTeamBundle['chains'],
      enabled?: boolean,
    ) => void;
    'v2.releaseSessionChains': (sessionID: string) => void;
    'v2.registerDelegatedLaunchFromStructured': NonNullable<
      NonNullable<
        typeof taskSessionManagerHook
      >['v2.registerDelegatedLaunchFromStructured']
    >;
    'v2.notePromptAdmission': (sessionID: string, messageID: string) => void;
  };

  return hooks;
};

export default {
  id: 'oh-my-opencode-slim',
  // NOTE: do not add a `tui` key here. OpenCode v1.18.23+ (and v2's
  // byte-identical readV1Plugin) validate the default export of a server
  // plugin module: `tui`, when present, must be a function and must not
  // coexist with `server` — a boolean marker makes the whole plugin fail
  // to load with "invalid tui export". The TUI entry is discovered
  // separately by hosts through the package.json `./tui` export
  // (dist/tui2.js), never through this module.
  server: OhMyOpenCodeLite,
  setup: createV2Setup(),
};

export type {
  AgentName,
  AgentOverrideConfig,
  McpName,
  MultiplexerConfig,
  MultiplexerLayout,
  MultiplexerType,
  PluginConfig,
} from './config';
export type { RemoteMcpConfig } from './mcp';
