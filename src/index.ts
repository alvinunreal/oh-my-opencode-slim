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
import { buildOrchestratorPrompt } from './agents/orchestrator';
import {
  buildResolvedAgentRegistry,
  type RegistryHostSnapshot,
  type ResolvedAgentRegistry,
} from './agents/registry';
import type { RegistryFactoryBridge } from './agents/registry-bridge';
import {
  type BackgroundJobEvictedSession,
  type BackgroundJobLifecycle,
  type BackgroundJobRecord,
  type ContextFile,
  createBackgroundJobLifecycle,
  isPrunableEvictedSession,
} from './background-jobs';
import { CompanionManager } from './companion/manager';
import { ensureCompanionVersion } from './companion/updater';
import { deepMerge, loadPluginConfig, type Preset } from './config';
import {
  DEFAULT_MAX_SESSION_METADATA_ENTRIES,
  SMARTFETCH_SECONDARY_SESSION_TITLE,
  TOAST_DURATION_MS,
} from './config/constants';
import type { ConfigLoadWarningKind } from './config/loader';
import { RuntimeConfig } from './config/runtime';
import { getBuildInfo } from './generated/build-info';
import { HEALTH_CHECK, minimumExpectedToolCount } from './health-check';
import {
  COUNCIL_INJECT_METADATA_KEY,
  createAbsolutePathRescueHook,
  createApplyPatchHook,
  createAutoUpdateCheckerHook,
  createCacheMonitorHook,
  createChatHeadersHook,
  createCouncilInjectHook,
  createDeepworkCommandHook,
  createDeepworkGuardHook,
  createJsonErrorRecoveryHook,
  createLoopCommandHook,
  createOrchestratorWakeScheduler,
  createPhaseReminderHook,
  createReflectCommandHook,
  createSearchPathGuardHook,
  createTaskSessionManagerHook,
  createToolLoopGuardHook,
  ForegroundFallbackManager,
  type ForegroundFallbackModel,
  formatChildInputWaitDelta,
  formatStoppedJobDelta,
  SessionLifecycle,
  stoppedJobRecoveryReason,
} from './hooks';
import { stripTaggedContent } from './hooks/cache-safe-injection';
import { isCommandEnabled } from './hooks/command-hook-utils';
import { processImageAttachments } from './hooks/image-hook';
import { clearAllWakeSessions } from './hooks/orchestrator-wake/wake-gate';
import { PHASE_REMINDER_METADATA_KEY } from './hooks/phase-reminder';
import type { ChildInputWaitRecord } from './hooks/task-session-manager/child-input-wait';
import {
  clearChildInputWaitsForSession,
  getChildInputWait,
  listChildInputWaits,
} from './hooks/task-session-manager/child-input-wait';
import { createBackgroundFallbackHandoff } from './hooks/task-session-manager/fallback-observation-transfer';
import { createRevivedRunTracker } from './hooks/task-session-manager/revived-run-tracker';
import {
  createAliasAuthority,
  createSessionRecovery,
} from './hooks/task-session-manager/session-recovery';
import type { ToolLoopGuardHook } from './hooks/tool-loop-guard/hook';
import {
  findLatestUserMessage,
  isMessageWithParts,
  type MessageWithParts,
} from './hooks/types';
import { createInterviewManager } from './interview';
import { discoverPreflightSkills } from './marketplace/preflight';
import { MarketplaceService } from './marketplace/service';
import { resolveDesiredMarketplacePackageIds } from './marketplace/status';
import { createBuiltinMcps, getOverriddenBuiltinMcpKeys } from './mcp';
import {
  ast_grep_replace,
  ast_grep_search,
  createAcpRunTool,
  createCancelTaskTool,
  createMarketplaceTools,
  createTaskMessageTool,
  createTaskReplyTool,
  createTaskResultTool,
  createTaskReviveTool,
  createTaskStatusTool,
  createWaitForUserTool,
  createWebfetchTool,
  resolveFinalizedOrchestratorIdentities,
} from './tools';
import { pickAgentModelRef } from './tools/smartfetch/secondary-model';
import {
  applyActivityEvent,
  resolveEventSessionID,
  TaskActivityTracker,
} from './tools/task-activity';
import {
  clearTuiAgentActivities,
  clearTuiSessionAlias,
  readTuiSnapshot,
  recordTuiAgentActivity,
  recordTuiAgentModel,
  recordTuiAgentModels,
  recordTuiSessionParent,
  type TuiSessionDetails,
  updateTuiSessionDetails,
} from './tui-state';
import {
  type BackgroundTaskConcurrency,
  createDisplayNameMentionRewriter,
  normalizeAgentName,
  resolveRuntimeAgentName,
} from './utils';
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
import { registerPendingSessionPrune } from './utils/pending-session-prunes';
import { withTimeout } from './utils/session';
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
import { delegationWording } from './v2/delegation';
import {
  isInternalAdmission,
  recordInternalAdmission,
} from './v2/internal-admissions';

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

type DelegatedModelSelection = {
  agentName: string;
  entry: ModelChainEntry;
  /** The parent runs a real fallback that should move this child. */
  route: boolean;
  /** Inherited children already start on the parent's live model. */
  inherited?: true;
};

function modelProvider(model: string): string | undefined {
  const separator = model.indexOf('/');
  return separator > 0 ? model.slice(0, separator) : undefined;
}

/**
 * Pick the child-chain entry that best matches a parent's live fallback.
 * Once the parent has moved past its primary, exact model matches win,
 * then the working provider, then the first child entry outside the
 * providers already exhausted by the parent. Explicit inheritance stays live.
 */
function selectDelegatedModel(input: {
  agentName: string;
  childChain: ModelChainEntry[] | undefined;
  followsParent: boolean;
  parentModel: string | undefined;
  parentChain: ModelChainEntry[] | undefined;
}): DelegatedModelSelection | undefined {
  const { agentName, childChain, parentChain, parentModel } = input;
  if (!parentModel) return undefined;
  const parentIndex =
    parentChain?.findIndex((entry) => entry.id === parentModel) ?? -1;
  const exact =
    childChain?.findIndex((entry) => entry.id === parentModel) ?? -1;

  if (input.followsParent) {
    return {
      agentName,
      entry: childChain?.[exact] ?? { id: parentModel },
      route: parentIndex > 0,
      inherited: true,
    };
  }

  if (!childChain?.length || !parentChain || parentIndex <= 0) return undefined;

  if (exact >= 0) {
    return { agentName, entry: childChain[exact], route: exact > 0 };
  }

  const activeProvider = modelProvider(parentModel);
  if (activeProvider) {
    const sameProvider = childChain.findIndex(
      (entry) => modelProvider(entry.id) === activeProvider,
    );
    if (sameProvider >= 0) {
      return {
        agentName,
        entry: childChain[sameProvider],
        route: sameProvider > 0,
      };
    }
  }

  const exhaustedProviders = new Set(
    parentChain
      .slice(0, parentIndex)
      .map((entry) => modelProvider(entry.id))
      .filter((provider): provider is string => provider !== undefined),
  );
  if (activeProvider) exhaustedProviders.delete(activeProvider);
  const viable = childChain.findIndex((entry) => {
    const provider = modelProvider(entry.id);
    return provider === undefined || !exhaustedProviders.has(provider);
  });
  return viable >= 0
    ? { agentName, entry: childChain[viable], route: viable > 0 }
    : undefined;
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
 * warning-only kinds (`missing-preset`, `deprecated-key`, `normalized`)
 * stay non-fatal.
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

  // Observation-only prompt-cache watchdog; safe to create before config
  // loads and must see every event of this location, so it sits outside the
  // try block. `disabled_hooks: ["cache-monitor"]` gates the per-event call
  // below; creation stays here so the pre-config event path needs no
  // undefined handling.
  const cacheMonitor = createCacheMonitorHook();

  // Declare variables that must survive the try/catch for the return
  // closure. These are set inside the try block.
  let config: ReturnType<typeof loadPluginConfig>;
  let runtime: RuntimeConfig;
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
  let autoUpdateChecker: ReturnType<typeof createAutoUpdateCheckerHook>;
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
  // smartfetch's temporary secondary-model sessions run under the default
  // agent; they must never reach the sidebar, metadata or session hooks.
  const internalSessionIds = new Set<string>();
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
  // Sidebar activity scoping (#1147): every active session and the visible
  // route session resolve their conversation root against the persistent
  // sessionParents index at render time. The recorder only persists the
  // child→parent links; roots are never stored per-activity, so a
  // late-learned link re-roots everything consistently. Process identity
  // cannot scope this because v2 daemons are shared across windows.
  const markTuiAgentActive = (
    sessionID: string,
    agentName: string,
    status?: 'busy' | 'retry',
  ): void => {
    const directory = tuiActivityDirectory(sessionID);
    // Alias from an already-registered board record (launch may have
    // arrived before or after busy; both orders converge here or via the
    // coordinator's identity listener).
    const alias = backgroundJobs?.get(sessionID)?.alias;
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
    const sessionApi = (ctx as { client?: { session?: { get?: unknown } } })
      .client?.session;
    if (typeof sessionApi?.get !== 'function') return;
    const lookup = sessionApi.get as (input: {
      path: { id: string };
      query: { directory: string };
    }) => Promise<{ data?: unknown; error?: unknown; parentID?: unknown }>;
    const visited = new Set<string>();
    let current = startSessionID;
    while (!visited.has(current)) {
      visited.add(current);
      const snapshot = readTuiSnapshot(directory);
      const known = snapshot.sessionParents[current];
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
    const directory =
      ownedTuiActivitySessions.get(sessionID) ??
      tuiActivityDirectory(sessionID);
    recordTuiAgentActivity({ sessionID, active: false }, directory);
    ownedTuiActivitySessions.delete(sessionID);
  };
  const clearTuiActivities = (): void => {
    for (const [sessionID, directory] of ownedTuiActivitySessions) {
      recordTuiAgentActivity({ sessionID, active: false }, directory);
    }
    ownedTuiActivitySessions.clear();
  };
  clearTuiAgentActivities(ctx.directory);
  let sessionLifecycle: SessionLifecycle;

  let chatHeadersHook: ReturnType<typeof createChatHeadersHook> | undefined;
  let foregroundFallback: ForegroundFallbackManager;
  let foregroundFallbackChains: Record<string, ForegroundFallbackModel[]> = {};
  let selectedMarketplacePackageIds: readonly string[] = [];
  let deepworkCommandHook: ReturnType<typeof createDeepworkCommandHook>;
  let deepworkGuardHook: ReturnType<typeof createDeepworkGuardHook>;
  let reflectCommandHook: ReturnType<typeof createReflectCommandHook>;
  let loopCommandHook: ReturnType<typeof createLoopCommandHook>;
  let taskSessionManagerHook: ReturnType<typeof createTaskSessionManagerHook>;
  let phaseReminder: ReturnType<typeof createPhaseReminderHook> | undefined;
  let councilInject: ReturnType<typeof createCouncilInjectHook> | undefined;
  let applyPatch: ReturnType<typeof createApplyPatchHook>;
  let searchPathGuard: ReturnType<typeof createSearchPathGuardHook>;
  let absolutePathRescue: ReturnType<typeof createAbsolutePathRescueHook>;
  let jsonErrorRecovery: ReturnType<typeof createJsonErrorRecoveryHook>;
  let toolLoopGuard: ToolLoopGuardHook;
  let deepworkGuardAfter: (i: unknown, o: unknown) => Promise<void>;
  let jsonErrorRecoveryAfter: (i: unknown, o: unknown) => Promise<void>;
  let taskSessionManagerAfter: (i: unknown, o: unknown) => Promise<void>;
  let backgroundJobs: BackgroundJobLifecycle;
  /** Set together with backgroundJobs; lets the init-failure path dispose
   * the assembled lifecycle even when a later init step throws. */
  let assembledLifecycle: BackgroundJobLifecycle | undefined;
  let tuiReusableProjection:
    | ReturnType<typeof createTuiReusableProjection>
    | undefined;
  let backgroundTaskConcurrency: BackgroundTaskConcurrency;
  let admissionRuntimeLease: AdmissionRuntimeLease | undefined;
  let finalHostAgentConfig: Record<string, unknown> | undefined;
  let interviewManager: ReturnType<typeof createInterviewManager>;
  let companionManager: CompanionManager;
  let taskCancelTools: ReturnType<typeof createCancelTaskTool>;
  let taskMessageTools: ReturnType<typeof createTaskMessageTool>;
  let taskReplyTools: ReturnType<typeof createTaskReplyTool>;
  let taskResultTools: ReturnType<typeof createTaskResultTool>;
  let taskReviveTools: ReturnType<typeof createTaskReviveTool>;
  let revivedRunTracker: ReturnType<typeof createRevivedRunTracker>;
  let markRevivedRunPending: (taskID: string) => void = () => {};
  let markRevivedRunSettled: (taskID: string) => void = () => {};
  let getRevivedContextFiles = (_taskID: string): ContextFile[] => [];
  let pruneRevivedContext = () => {};
  let taskStatusTools: ReturnType<typeof createTaskStatusTool>;
  const taskActivityTracker = new TaskActivityTracker();
  let waitForUserTools: ReturnType<typeof createWaitForUserTool>;
  let acpRunTools: Record<string, ReturnType<typeof createAcpRunTool>>;
  let webfetch: ReturnType<typeof createWebfetchTool>;
  let tools: Record<string, ToolDefinition>;
  let rewriteDisplayNameMentions: ReturnType<
    typeof createDisplayNameMentionRewriter
  >;

  // Counters for post-init health check (set inside try, checked outside)
  let toolCount = 0;

  // The wake scheduler is created AFTER the task-session-manager hook (see
  // the try block below): the hook's onChildInputWait closes over
  // queueChildInputWaitWake, which drops notifications that arrive before
  // the scheduler exists. The ask stays recorded in the sidecar and
  // task_status still surfaces it, so the parent can answer via task_reply.
  // In practice the scheduler is created synchronously in the same init,
  // before any host event can arrive.
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
        detail: formatChildInputWaitDetail(wait),
      }),
      `${record.taskID}:${wait.requestID}`,
    );
  }

  /**
   * Inline detail lines for a child input-wait wake delta: the ask content
   * the parent needs to answer (question text + options, or permission
   * summary).
   */
  function formatChildInputWaitDetail(wait: ChildInputWaitRecord): string {
    const lines = [`request: ${wait.requestID}`, `kind: ${wait.kind}`];
    if (wait.kind === 'permission') {
      lines.push(`permission: ${wait.permission ?? 'unknown'}`);
      if (wait.patterns && wait.patterns.length > 0) {
        lines.push(`patterns: ${wait.patterns.join(', ')}`);
      }
      return lines.join('\n');
    }
    if (!wait.questions || wait.questions.length === 0) {
      lines.push('(no question text captured)');
      return lines.join('\n');
    }
    for (const entry of wait.questions) {
      lines.push(`question: ${entry.question || entry.header}`);
      for (const option of entry.options) {
        lines.push(
          `option: ${option.label}${option.description ? ` — ${option.description}` : ''}`,
        );
      }
    }
    return lines.join('\n');
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

  const resolveDelegatedModelForParent = (
    agentType: string,
    parentSessionID?: string,
  ): DelegatedModelSelection | undefined => {
    if (!parentSessionID) return undefined;
    const agentName = resolveRuntimeAgentName(runtime, agentType);
    const parentAgentRaw = sessionMetadata.getAgent(parentSessionID);
    const parentAgent = parentAgentRaw
      ? resolveRuntimeAgentName(runtime, parentAgentRaw)
      : undefined;
    const inheritance = runtime.agent(agentName)?.inheritModelFrom;
    const followsParent =
      inheritance === 'orchestrator' || inheritance === 'session';
    return selectDelegatedModel({
      agentName,
      childChain: runtime.modelArrays[agentName],
      followsParent,
      // External-selection metadata deliberately ignores internal fallback
      // replays (#1079). Delegation needs the opposite view: the model
      // actually executing this parent turn, or children will be launched
      // back onto the provider the parent just escaped.
      parentModel:
        foregroundFallback?.getActiveFallbackModel(parentSessionID) ??
        sessionMetadata.getModel(parentSessionID),
      parentChain: parentAgent ? runtime.modelArrays[parentAgent] : undefined,
    });
  };

  const registerV1DelegatedIntent = (
    parentID: string,
    childID: string | undefined,
    agentType: string,
  ) => {
    const selected = resolveDelegatedModelForParent(agentType, parentID);
    if (selected?.route && (childID || !selected.inherited)) {
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
    config = loadPluginConfig(ctx.directory, { hostFlavor });
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
    const activePresetName = runtime.getRuntimePreset() ?? config.preset;
    selectedMarketplacePackageIds = resolveDesiredMarketplacePackageIds(
      config,
      activePresetName,
    );
    rewriteDisplayNameMentions = createDisplayNameMentionRewriter(runtime);
    // Host flavor marker ('v2' on OpenCode v2 hosts, set by the v2 client
    // shim; absent on v1). Threads the native delegation vocabulary into
    // prompt assembly so v2 prompts say subagent(...)/agent directly.
    const delegation = delegationWording(hostFlavor);
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
    const webfetchModel = runtime.webfetch?.model;
    const webfetchModels = (() => {
      if (!webfetchModel) return undefined;
      const entries = Array.isArray(webfetchModel)
        ? webfetchModel
        : [webfetchModel];
      type ModelRefInput = string | { id: string; variant?: string };
      const models: Array<{ id: string; variant?: string }> = [];
      for (const entry of entries as ModelRefInput[]) {
        const id = typeof entry === 'string' ? entry : entry.id;
        if (!id) continue;
        models.push({
          id,
          ...(typeof entry === 'object' && entry.variant
            ? { variant: entry.variant }
            : {}),
        });
      }
      return models.length > 0 ? models : undefined;
    })();
    webfetch = createWebfetchTool(ctx, {
      binaryDir: undefined,
      imageRouting: () => runtime.imageRouting,
      webfetchModels,
      explorerModel: pickAgentModelRef(runtime.agent('explorer')?.model),
      librarianModel: pickAgentModelRef(runtime.agent('librarian')?.model),
      smallModelRef: () => runtime.smallModel(),
    });
    // One deep module: board (state machine) + terminal gate + wall-clock
    // supervisor + lifecycle policy, composed in one place. Deferred-closure
    // references below (backgroundJobs inside onEvictedSession/onRunning)
    // only run after init completes, mirroring the previous wiring order.
    backgroundJobs = createBackgroundJobLifecycle({
      maxReusablePerAgent: runtime.backgroundJobs.maxSessionsPerAgent,
      maxContextLines: runtime.backgroundJobs.maxContextLines,
      readContextMinLines: runtime.backgroundJobs.readContextMinLines,
      readContextMaxFiles: runtime.backgroundJobs.readContextMaxFiles,
      delegationTool: delegation.tool,
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
                  isTracked: (taskID) => backgroundJobs.isTracked(taskID),
                }),
              );
            },
          }
        : {}),
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
        revivedRunTracker?.isObservationPending(taskID, generation) ?? false,
      onRunning: (record) => {
        if (record.background)
          backgroundTaskConcurrency.restoreTask(
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
          backgroundJobs.onLaunch(record);
      },
      wallClockTimeoutMs: runtime.backgroundJobs.wallClockTimeoutMs,
      abortGraceMs: runtime.backgroundJobs.abortGraceMs,
      abort: (taskID) =>
        ctx.client.session.abort({
          path: { id: taskID },
        }),
    });
    assembledLifecycle = backgroundJobs;
    admissionRuntimeLease = acquireAdmissionRuntime(
      ctx.directory,
      runtime.backgroundJobs.concurrency,
    );
    backgroundTaskConcurrency = admissionRuntimeLease.backgroundTaskConcurrency;

    // Project launch identity (alias↔session) into TUI state so the
    // clickable sidebar can label active subagent sessions. Best-effort:
    // a failed tui-state write must never fail a launch.
    //
    // Each generation must retract its own projected sections on dispose:
    // a reload reuses this PID, so the startup dead-owner sweep retains
    // the previous generation's entries until explicitly removed.
    tuiReusableProjection = createTuiReusableProjection({
      board: backgroundJobs,
      projectDir: ctx.directory,
    });
    backgroundJobs.addLaunchIdentityListener((event) => {
      const directory = tuiActivityDirectory(event.taskID);
      if (event.kind === 'registered') {
        if (event.parentSessionID && event.parentSessionID !== event.taskID) {
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
    backgroundJobs.addTerminalOutcomeListener((record) => {
      const current = backgroundJobs.get(record.taskID);
      if (
        current?.generation !== record.generation ||
        current.terminalRevision !== record.terminalRevision ||
        current.state === 'running'
      )
        return;
      backgroundJobs.addContext(
        record.taskID,
        getRevivedContextFiles(record.taskID),
      );
      markRevivedRunSettled(record.taskID);
      pruneRevivedContext();
      backgroundJobs.onTerminal(record);
      backgroundTaskConcurrency.releaseTask(record.taskID);
    });
    revivedRunTracker = createRevivedRunTracker({
      input: ctx,
      backgroundJobs,
      resolveSelection: lifecycleSelectionResolver,
      onRegister: (taskID) => markRevivedRunPending(taskID),
      onSettled: (taskID) => markRevivedRunSettled(taskID),
      contextFilesForPrompt: (taskID) => getRevivedContextFiles(taskID),
      pruneContext: () => pruneRevivedContext(),
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
      onOwnershipReleased: (parentSessionID, taskID, generation) => {
        void orchestratorWakeScheduler
          ?.triggerTerminalPublicationWake(parentSessionID, taskID, generation)
          ?.catch(() => undefined);
      },
    });
    backgroundJobs.addTerminalOutcomeListener((record) => {
      revivedRunTracker.onTerminal(record);
      markTuiAgentInactive(record.taskID);
    });
    // Pane lifecycle runs in the client (TUI) process, never here: the server
    // entry only keeps its own sidebar activity bookkeeping.
    backgroundJobs.addTerminalStateListener((taskID) => {
      markTuiAgentInactive(taskID);
    });

    sessionLifecycle = new SessionLifecycle(log);
    sessionLifecycle.onSessionDeleted((sessionID) => {
      compactingSessionIds.delete(sessionID);
    });

    // Initialize auto-update checker hook
    autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
      autoUpdate: runtime.autoUpdate,
      companion: runtime.companion,
    });

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
    const backgroundFallbackHandoff = createBackgroundFallbackHandoff({
      backgroundJobs,
      revivedRunTracker,
    });
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
    const fallbackEnabled = fallbackUserEnabled && hostFlavor !== 'v2';
    const v2RetryEnabled = fallbackUserEnabled;
    if (fallbackUserEnabled && hostFlavor === 'v2') {
      // Deterministic notice: no timestamps or per-call ids. Do not log when
      // the user explicitly disabled fallback, including via disabled_hooks.
      log(
        '[foreground-fallback] v2 replay fallback disabled (no atomic per-turn model switch); retry-hook steering active',
      );
    }
    foregroundFallbackChains = runtime.modelArrays;
    foregroundFallback = new ForegroundFallbackManager(
      foregroundFallbackChains,
      fallbackEnabled,
      ctx,
      runtime.fallback.maxRetries,
      sessionLifecycle,
      // A managed background-task session switching models mid-flight must
      // move its admission accounting (provider/model caps) to the new
      // model. No-op for unknown/non-task sessions; idempotent per model.
      (sessionID, model) =>
        backgroundTaskConcurrency.migrateTask(sessionID, model),
      runtime.fallback.initialRetryDelayMs,
      runtime.fallback.retryDelayMs,
      backgroundFallbackHandoff,
      // Generation fence captured BEFORE any await in the fallback
      // preparation, and ONLY for confirmed BACKGROUND children:
      // undefined for foreground/unmanaged sessions means "observation
      // handoff not applicable" — never a wildcard — so a stale-
      // generation rejection can be distinguished from a legitimate
      // foreground fallback.
      (sessionID) => {
        const record = backgroundJobs.get(sessionID);
        return record?.state === 'running' && record.background === true
          ? record.generation
          : undefined;
      },
      (sessionID) => backgroundJobs.hasRunning(sessionID),
      v2RetryEnabled,
    );

    deepworkCommandHook = createDeepworkCommandHook();
    reflectCommandHook = createReflectCommandHook();
    loopCommandHook = createLoopCommandHook();
    const recoverRetainedSession = createSessionRecovery({
      input: ctx,
      backgroundJobs,
      isDisposed: () => instanceDisposed,
      hostFlavor,
    });
    const aliasAuthority = createAliasAuthority({
      input: ctx,
      board: backgroundJobs,
      isDisposed: () => instanceDisposed,
    });
    taskSessionManagerHook = createTaskSessionManagerHook(ctx, {
      backgroundJobs,
      strategy: runtime.backgroundJobs.strategy,
      maxSessionsPerAgent: runtime.backgroundJobs.maxSessionsPerAgent,
      maxRetainedSnapshots: runtime.backgroundJobs.maxRetainedSnapshots,
      readContextMinLines: runtime.backgroundJobs.readContextMinLines,
      readContextMaxFiles: runtime.backgroundJobs.readContextMaxFiles,
      boardInjection: runtime.backgroundJobs.boardInjection,
      backgroundTaskConcurrency,
      pendingCallTracker: admissionRuntimeLease.pendingCallTracker,
      getModelForAgent: (agentType: string, parentSessionID?: string) => {
        const delegated = resolveDelegatedModelForParent(
          agentType,
          parentSessionID,
        );
        if (delegated) return delegated.entry.id;

        // Admission must use the config after the host has merged all of its
        // agent layers. The direct lookup preserves display-name keys; the
        // resolved lookup handles canonical names and legacy aliases.
        return (
          resolvePrimaryModelFromFinalHostConfig(agentType) ??
          (parentSessionID
            ? sessionMetadata.getModel(parentSessionID)
            : undefined)
        );
      },
      sameProviderPolicy: runtime.backgroundJobs.sameProviderPolicy,
      getSessionModel: (sessionID) =>
        foregroundFallback.getActiveFallbackModel(sessionID) ??
        sessionMetadata.getModel(sessionID),
      hostFlavor,
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
        foregroundFallback.isFallbackInProgress(sessionID),
      willAttemptFallback: (sessionID) =>
        foregroundFallback.willAttemptFallback(sessionID),
      coordinator: sessionLifecycle,
      revivedRunTracker,
      onChildInputWait: (notification) => {
        if (runtime.backgroundJobs.childInputWake === false) return;
        const record = backgroundJobs.get(notification.taskID);
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
    markRevivedRunPending = taskSessionManagerHook.markRevivedRunPending;
    markRevivedRunSettled = taskSessionManagerHook.clearRevivedRunPending;
    getRevivedContextFiles = taskSessionManagerHook.contextFilesForTask;
    pruneRevivedContext = taskSessionManagerHook.pruneTaskContext;

    orchestratorWakeScheduler = createOrchestratorWakeScheduler(ctx, {
      config: runtime.backgroundJobs.orchestratorWake,
      boardInjectionEnabled: runtime.backgroundJobs.boardInjection,
      shouldManageSession: (sessionID) =>
        sessionMetadata.getAgent(sessionID) === 'orchestrator',
      hasInputWait: (sessionID) =>
        taskSessionManagerHook.hasInputWait(sessionID),
      isFallbackInProgress: (sessionID) =>
        foregroundFallback.isFallbackInProgress(sessionID),
      resolveSelection: lifecycleSelectionResolver,
      isStoppedJobRecoveryCurrent: (taskID, generation) => {
        const record = backgroundJobs.get(taskID);
        return (
          record?.generation === generation &&
          record.state === 'stopped' &&
          record.terminalUnreconciled
        );
      },
      isChildInputWaitCurrent: (taskID, requestID) => {
        const record = backgroundJobs.get(taskID);
        return (
          record?.state === 'running' &&
          getChildInputWait(taskID, requestID) !== undefined
        );
      },
      hasPendingDelegatedWork: (sessionID) =>
        backgroundJobs.hasRunning(sessionID) ||
        backgroundJobs.hasTerminalUnreconciled(sessionID),
      coordinator: sessionLifecycle,
    });
    backgroundJobs.addTerminalOutcomeListener((record) => {
      // A placeholder is not delegated work; its stop is not recoverable
      // by the parent until a task launch has attributed the session.
      if (record.provisional === true) return;
      // A child's terminal state resolves any of its open input waits: the
      // ask is gone with the run, so a queued wake must not fire for it.
      clearChildInputWaitsForSession(record.taskID);
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
        revivedRunTracker.willNotifyParent(record.taskID, record.generation)
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
      orchestratorWakeScheduler?.triggerStoppedJobRecovery(
        record.parentSessionID,
        // Self-contained stop facts: the recovery wake is an
        // internal-initiator message, so under `checkpoint-compatible` it
        // cannot create a board snapshot and any retained snapshot predates
        // this stop (issue #1051).
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
    backgroundJobs.addTerminalOutcomeListener((record) => {
      if (record.state !== 'completed' && record.state !== 'error') return;
      // Revived-run ownership: when the tracker will deliver this run's
      // <task> result itself (notifyParent), a publication wake beside
      // it would queue a SECOND admission to the idle parent — the
      // double-notify the exactly-once notification contract forbids.
      // Scoped to the exact (taskID, generation) the tracker owns;
      // non-revived publications are unaffected.
      if (
        revivedRunTracker.willNotifyParent(record.taskID, record.generation)
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
      // the parent even while it sits idle, so a plugin wake beside it
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
      // host-side, the job falls back to the passive display channel on
      // the parent's next activity — board injection when enabled, or
      // nothing until the next task_status/task_result pull otherwise.
      if (record.terminalRevision === 1) {
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
      void orchestratorWakeScheduler
        ?.triggerTerminalPublicationWake(
          record.parentSessionID,
          record.taskID,
          record.generation,
        )
        ?.catch(() => undefined);
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

    // Only orchestrator sessions receive phase reminders.
    const shouldInjectOrchestratorReminder = (sessionID: string) =>
      sessionMetadata.getAgent(sessionID) === 'orchestrator';

    if (!runtime.disabledHooks.has('phase-reminder')) {
      phaseReminder = createPhaseReminderHook({
        shouldInject: shouldInjectOrchestratorReminder,
      });
    }

    // Keyword-triggered Council Mode injection: same gate pattern as the
    // phase reminder, scoped to sessions with configured councillor seats.
    // The seat list comes from the same agentDefs the orchestrator prompt's
    // seat pointer uses; the councillor- prefix is reserved (custom/ACP
    // name validation rejects it), so the two can never disagree.
    if (!runtime.disabledHooks.has('council-inject')) {
      const councilSeats = agentDefs
        .filter((a) => a.name.startsWith('councillor-'))
        .map((a) => a.name);
      if (councilSeats.length > 0) {
        councilInject = createCouncilInjectHook({
          seats: councilSeats,
          wording: delegation,
        });
      }
    }

    applyPatch = createApplyPatchHook(ctx);

    searchPathGuard = createSearchPathGuardHook(ctx);

    absolutePathRescue = createAbsolutePathRescueHook(ctx);

    deepworkGuardHook = createDeepworkGuardHook(ctx);
    jsonErrorRecovery = createJsonErrorRecoveryHook(ctx);
    toolLoopGuard = createToolLoopGuardHook();

    // Pre-created wrapped handlers for tool.execute.after (error-isolated)
    deepworkGuardAfter = wrapPostToolHook('deepwork-guard', (i, o) =>
      deepworkGuardHook['tool.execute.after'](i as never, o as never),
    );
    jsonErrorRecoveryAfter = wrapPostToolHook('json-error-recovery', (i, o) =>
      jsonErrorRecovery['tool.execute.after'](i as never, o as never),
    );
    taskSessionManagerAfter = wrapPostToolHook('task-session-manager', (i, o) =>
      taskSessionManagerHook['tool.execute.after'](i as never, o as never),
    );
    interviewManager = createInterviewManager(ctx, config);
    companionManager = new CompanionManager(
      `proc_${process.pid}`,
      ctx.directory,
      runtime.companion,
      hostFlavor,
    );
    taskCancelTools = createCancelTaskTool({
      input: ctx,
      backgroundJobs,
      shouldManageSession: (sessionID) =>
        sessionMetadata.getAgent(sessionID) === 'orchestrator' ||
        sessionMetadata.isTaskManaged(sessionID),
      recoverRetainedSession,
      resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
      isDisposed: () => instanceDisposed,
    });
    taskMessageTools = createTaskMessageTool({
      input: ctx,
      backgroundJobs,
      promptMessageIDFor: (taskID, generation) =>
        revivedRunTracker.promptMessageIDFor(taskID, generation),
      resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
      isDisposed: () => instanceDisposed,
    });
    taskReplyTools = createTaskReplyTool({
      input: ctx,
      backgroundJobs,
      resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
      isDisposed: () => instanceDisposed,
    });
    taskResultTools = createTaskResultTool({
      input: ctx,
      backgroundJobs,
      resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
      isDisposed: () => instanceDisposed,
    });
    taskReviveTools = createTaskReviveTool({
      ...(hostFlavor !== 'v2' && { registerIntent: registerV1DelegatedIntent }),
      input: ctx,
      backgroundJobs,
      shouldManageSession: (sessionID) =>
        sessionMetadata.getAgent(sessionID) === 'orchestrator' ||
        sessionMetadata.isTaskManaged(sessionID),
      revivedRunTracker,
      recoverRetainedSession,
      isDisposed: () => instanceDisposed,
      resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
    });
    taskStatusTools = createTaskStatusTool({
      input: ctx,
      backgroundJobs,
      activityTracker: taskActivityTracker,
      resolveCanonicalTaskRef: aliasAuthority.resolveCanonical,
      isDisposed: () => instanceDisposed,
    });
    waitForUserTools = createWaitForUserTool({
      shouldManageSession: (sessionID) =>
        sessionMetadata.getAgent(sessionID) === 'orchestrator' ||
        sessionMetadata.isTaskManaged(sessionID),
      resolveAgentName: (agent) => resolveRuntimeAgentName(runtime, agent),
      registerSessionAsOrchestrator: (sessionID) => {
        sessionMetadata.markTaskManaged(sessionID);
      },
      beginUserWait: (sessionID) => {
        taskSessionManagerHook.beginUserWait(sessionID);
        orchestratorWakeScheduler?.suppress(sessionID);
      },
      waitForUserGuardEnabled: runtime.backgroundJobs.waitForUserGuard,
      hasOutstandingBackgroundTasks: (sessionID) =>
        runtime.backgroundJobs.orchestratorWake.enabled &&
        backgroundJobs.hasRunning(sessionID),
    });

    const shouldRegisterWebfetch = runtime.webfetch.enabled !== false;
    tools = {
      ...taskCancelTools,
      ...taskMessageTools,
      ...taskReplyTools,
      ...taskResultTools,
      ...taskReviveTools,
      ...taskStatusTools,
      ...waitForUserTools,
      ...acpRunTools,
      ...(shouldRegisterWebfetch ? { webfetch } : {}),
      ast_grep_search,
      ast_grep_replace,
    };
    if (runtime.disabledTools.length > 0) {
      const disabledTools = new Set(runtime.disabledTools);
      tools = Object.fromEntries(
        Object.entries(tools).filter(([name]) => !disabledTools.has(name)),
      );
    }

    toolCount =
      Object.keys(tools).length +
      ['marketplace_inspect', 'marketplace_manage'].filter(
        (name) => !runtime.disabledTools.includes(name),
      ).length;
  } catch (err) {
    assembledLifecycle?.dispose();
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

  // ── Health check: validate registrations ────────────────────────────
  const agentCount = Object.keys(agents).length;
  const mcpCount = Object.keys(mcps).length;
  // Skip MCP threshold when user explicitly disabled all built-in MCPs
  const mcpThreshold =
    runtime.disabledMcps.length > 0 ? 0 : HEALTH_CHECK.minMcps;
  const toolThreshold = minimumExpectedToolCount(
    runtime.disabledTools,
    runtime.webfetch.enabled !== false,
  );
  if (
    agentCount < HEALTH_CHECK.minAgents ||
    toolCount < toolThreshold ||
    mcpCount < mcpThreshold
  ) {
    const msg = [
      'Health check: registrations suspiciously low.',
      `  agents: ${agentCount} (expected >=${HEALTH_CHECK.minAgents})`,
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

  // ── Probe jsdom (async, non-blocking) ───────────────────────────────
  // Don't await this; we don't want to block init. The warning will
  // appear shortly after startup if jsdom is broken.
  probeJSDOM().then((err) => {
    if (err) {
      const msg = `jsdom probe failed; webfetch tool will not work: ${err}`;
      log(`[plugin] WARN: ${msg}`);
      appLog(ctx, 'warn', msg).catch(() => {});
    }
  });

  if (runtime.companion?.enabled === true) {
    try {
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

  companionManager.onLoad();

  function resolveTuiVariantForModel(
    agentName: string,
    model: string,
  ): string | undefined {
    const configEntry = runtime.agents()[agentName];
    const defaultVariant =
      typeof configEntry?.variant === 'string'
        ? configEntry.variant
        : undefined;
    const chain = runtime.modelArrays[agentName];
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
  const marketplaceService = new MarketplaceService({
    projectDir: ctx.directory,
    hostFlavor,
    pluginVersion: getBuildInfo().version,
    getLivePackages: () => {
      if (registryRetired || !resolvedAgentRegistry) return undefined;
      return registryBridge.requireRegistry().marketplacePackages;
    },
    getPresetOverride: () => runtime.getRuntimePreset() ?? undefined,
    getDesiredState: (packageInspection) => {
      const freshConfig = loadPluginConfig(ctx.directory, {
        silent: true,
        hostFlavor,
      });
      const runtimePreset = runtime.resolveRuntimePreset(freshConfig);
      const desiredPackageIds = resolveDesiredMarketplacePackageIds(
        freshConfig,
        runtimePreset ?? undefined,
      );
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
            selectedPackageIds: desiredPackageIds,
            store: readOnlyActivationStore,
            pluginVersion: getBuildInfo().version,
            availableSkillNames: discoverPreflightSkills(
              freshRuntime,
              ctx.directory,
            ),
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
          marketplace: {
            selectedPackageIds: selectedMarketplacePackageIds,
            store: marketplaceService.store,
            pluginVersion: getBuildInfo().version,
            availableSkillNames: selectedMarketplacePackageIds.length
              ? discoverPreflightSkills(runtime, ctx.directory)
              : [],
          },
          onHostModelSelected: (agentName) => {
            runtime.everModelSwitched(agentName);
          },
        });
        for (const [name, candidates] of Object.entries(
          resolvedAgentRegistry.modelCandidates,
        )) {
          if (candidates.length > 1) {
            foregroundFallbackChains[name] = candidates.map(
              ({ id, variant }) => ({
                id,
                ...(variant ? { variant } : {}),
              }),
            );
          }
        }
        for (const [agentName, models] of Object.entries(runtime.modelArrays)) {
          if (
            models.length > 0 &&
            runtime.combinedModelInheritanceSource(agentName) === undefined &&
            runtime.hasModelSwitched(agentName)
          ) {
            foregroundFallback.disableChain(agentName);
          }
        }
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
      if (isCommandEnabled('interview', commandGate)) {
        interviewManager.registerCommand(opencodeConfig);
      }
      if (isCommandEnabled('deepwork', commandGate)) {
        deepworkCommandHook.registerCommand(opencodeConfig);
      }
      if (isCommandEnabled('reflect', commandGate)) {
        reflectCommandHook.registerCommand(opencodeConfig);
      }
      if (isCommandEnabled('loop', commandGate)) {
        loopCommandHook.registerCommand(opencodeConfig);
      }
    },
    retire() {
      registryRetired = true;
    },
  };
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
  toolCount = Object.keys(tools).length;

  /**
   * Re-read the plugin config from disk and resolve ONLY the
   * inference/runtime profile fields (model, variant, temperature, provider
   * options) for each agent, plus the sidebar model projection. The v2
   * adapter consumes this through the `v2.refreshProfiles` hook when a
   * watched config file changes or a preset is applied.
   *
   * This is deliberately NOT a global agent reload: the session-frozen
   * surfaces (agent definitions, prompts, tools, permissions, skills, MCPs)
   * are never rebuilt and the host agent registry is never reloaded. It is
   * read-only on factory-local state — a throwaway `RuntimeConfig.create`
   * view resolves the fresh file against the captured host layer, so running
   * generation state (`config`, `runtime`, `agentDefs`, `agents`,
   * `finalHostAgentConfig`) is untouched. New child sessions receive the
   * refreshed inference fields through the v2 session-profile bridge; the
   * sidebar is rewritten through the existing `recordTuiAgentModels` writer.
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
  }): Promise<V2ProfileRefreshResult> => {
    try {
      // Malformed config handling: collect warnings and abort BEFORE any
      // resolution or sidebar rewrite when the load is invalid. The loader
      // falls back to `{}` for invalid JSON/schema, which would otherwise
      // report a successful "refresh" that wipes every profile/model.
      const hardWarnings: string[] = [];
      const freshConfig = loadPluginConfig(ctx.directory, {
        hostFlavor,
        silent: true,
        onWarning: (warning) => {
          if (HARD_PROFILE_REFRESH_WARNING_KINDS.has(warning.kind)) {
            hardWarnings.push(
              `${warning.kind} (${warning.path}): ${warning.message}`,
            );
          }
        },
      });
      if (hardWarnings.length > 0 && !options?.allowInvalidFallback) {
        const reason = `config load failed: ${hardWarnings.join('; ')}`;
        log('[plugin] runtime profile refresh from disk failed', reason);
        return { ok: false, reason };
      }
      const freshRuntime = RuntimeConfig.create(ctx.directory, freshConfig);
      const hostSnapshot = runtime.host();
      if (hostSnapshot) {
        freshRuntime.captureHostConfig(hostSnapshot);
      }
      // Mirror factory init: a persisted runtime preset (in-session switch)
      // survives the reload and wins over the config-file preset.
      const runtimePresetName = runtime.getRuntimePreset();
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
      const mergedAgents = mergeHostAgentConfigs(
        freshAgents as Record<string, Record<string, unknown>>,
        hostSnapshot?.agent,
      );
      const { profiles, projection } = projectAgentRuntimeState({
        runtime: freshRuntime,
        agentDefs: freshAgentDefs,
        agentConfigs: mergedAgents,
        runtimePreset,
      });
      // Sidebar projection must land before the profiles are reported as
      // refreshed (the caller swaps only on an ok result).
      //
      // The refresh resolves inference fields for the core agent set only:
      // `createAgents()` is marketplace-unaware, while the finalized registry
      // is the authoritative roster and already includes marketplace agents.
      // Union the fresh projection over the registry projection so a startup
      // or watcher refresh cannot shrink the roster and drop marketplace
      // agents from the sidebar; fresh core models still win.
      const registry = resolvedAgentRegistry;
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
        },
        ctx.directory,
      );
      log('[plugin] runtime profiles refreshed from disk', {
        agents: Object.keys(profiles).length,
      });
      return { ok: true, profiles, projection };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log('[plugin] runtime profile refresh from disk failed', reason);
      return { ok: false, reason };
    }
  };

  const hooks = {
    registryBridge,
    name: 'oh-my-opencode-slim',
    // v2-only extension hook: re-read the plugin config and resolve the
    // inference/runtime profiles for new child sessions + the sidebar.
    // Unknown to v1 hosts, consumed by src/v2/setup.ts.
    'v2.refreshProfiles': refreshProfilesFromDisk,
    // v2's native override accepts provider/model#variant. Follow the parent's
    // real fallback using the child's chain, including its configured variant.
    // Explicit inheritance stays live; only the v2 bridge consumes this override.
    'v2.resolveDelegatedModel': ({
      agentType,
      parentSessionID,
    }: {
      agentType: string;
      parentSessionID: string;
    }) => {
      const entry = resolveDelegatedModelForParent(
        agentType,
        parentSessionID,
      )?.entry;
      return entry?.variant ? `${entry.id}#${entry.variant}` : entry?.id;
    },
    'v2.session.retry':
      foregroundFallback.handleV2Retry.bind(foregroundFallback),

    agent: agents,

    tool: tools,

    mcp: mcps,

    config: async (opencodeConfig: Record<string, unknown>) => {
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
      recordTuiAgentModels(
        {
          agentModels: registry.tuiAgentModels,
          agentVariants: registry.tuiAgentVariants,
        },
        ctx.directory,
      );

      // This is the source of truth for admission. It is intentionally
      // captured only after every host/plugin merge, model pass and
      // permission pass.
      finalHostAgentConfig = opencodeConfig.agent as Record<string, unknown>;

      registryBridge.prepareCommands(opencodeConfig);
    },

    event: async (input) => {
      if (input.event.type === 'server.instance.disposed') {
        instanceDisposed = true;
        backgroundJobs?.dispose();
      }
      // Token-stream deltas fire on every reasoning/text chunk. Slim has no
      // work for them; skip the rest of the fan-out. v2 names:
      // session.next.{text,reasoning}.delta.
      const streamEventType = (input.event as { type?: string } | undefined)
        ?.type;
      if (
        streamEventType === 'message.part.delta' ||
        streamEventType === 'session.next.text.delta' ||
        streamEventType === 'session.next.reasoning.delta'
      ) {
        return;
      }

      // Directory scope (multi-instance): process only this location's
      // events. Unresolved events fall through (fail-open).
      eventDirectoryScope?.note(input.event);
      if (eventDirectoryScope?.isForeign(input.event)) return;

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
      if (
        eventSessionID &&
        event.type === 'session.created' &&
        event.properties?.info?.title === SMARTFETCH_SECONDARY_SESSION_TITLE
      ) {
        internalSessionIds.add(eventSessionID);
      }
      if (eventSessionID && internalSessionIds.has(eventSessionID)) {
        if (event.type !== 'session.deleted') return;
        internalSessionIds.delete(eventSessionID);
      }
      if (!runtime.disabledHooks.has('cache-monitor')) {
        await cacheMonitor.event(input);
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
      if (
        eventSessionID &&
        sessionMetadata.getAgent(eventSessionID) === 'orchestrator' &&
        (event.type === 'session.idle' ||
          (event.type === 'session.status' && statusType === 'idle'))
      ) {
        toolLoopGuard.resetTurn(eventSessionID);
      }
      if (eventSessionID && event.type === 'session.deleted') {
        toolLoopGuard.resetSession(eventSessionID);
      }
      if (eventSessionID) {
        applyActivityEvent(taskActivityTracker, event);
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
            companionManager.onSessionModelChanged({
              sessionId: info.sessionID,
              model,
            });
          }
          // Managed background-task sessions are identified by their session
          // ID. If the model serving one changed (fallback re-prompt, runtime
          // switch), migrate the admission accounting so provider/model caps
          // keep tracking the model actually in use. No-op for other
          // sessions and idempotent when the model is unchanged.
          backgroundTaskConcurrency.migrateTask(info.sessionID, model);
        }
        if (typeof info?.agent === 'string' && providerID && modelID) {
          const agentName = resolveRuntimeAgentName(runtime, info.agent);
          const model = `${providerID}/${modelID}`;
          const variant = resolveTuiVariantForModel(agentName, model);
          recordTuiAgentModel(
            {
              agentName,
              model,
              variant: variant ?? null,
            },
            (info?.sessionID && sessionMetadata.getDirectory(info.sessionID)) ??
              ctx.directory,
          );
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
          backgroundJobs.noteSessionCreated(freshID, createdAt);
        }
        if (createdSessionId && typeof createdSessionParent === 'string') {
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

      // Invalidate task continuations before the instance-disposed cleanup
      // (the former multiplexer event handling moved to the client process
      // with the pane lifecycle; the server never touches panes).
      await taskSessionManagerHook.event(
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

      await orchestratorWakeScheduler.event(
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

      // Runtime model fallback for foreground agents (rate-limit detection)
      await foregroundFallback.handleEvent(input.event);

      // Handle auto-update checking
      await autoUpdateChecker.event(input);

      await interviewManager.handleEvent(
        input as {
          event: { type: string; properties?: Record<string, unknown> };
        },
      );

      const companionProperties = event.properties;
      const companionData = (input.event as { data?: Record<string, unknown> })
        .data;
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
        companionManager.onWaitingInput(companionRequestId);
      }

      if (
        event.type === 'permission.replied' ||
        event.type === 'question.replied' ||
        event.type === 'question.rejected'
      ) {
        companionManager.onInputResolved();
      }

      if (input.event.type === 'session.status') {
        const props = input.event.properties as
          | { sessionID?: string; status?: { type?: string } | string }
          | undefined;
        const sessionID = props?.sessionID;
        const rawCompanionStatus = props?.status;
        const companionStatus =
          typeof rawCompanionStatus === 'string'
            ? rawCompanionStatus
            : typeof rawCompanionStatus === 'object' &&
                rawCompanionStatus !== null &&
                'type' in rawCompanionStatus &&
                typeof (rawCompanionStatus as { type?: unknown }).type ===
                  'string'
              ? (rawCompanionStatus as { type: string }).type
              : undefined;
        const job = sessionID ? backgroundJobs.get(sessionID) : undefined;
        companionManager.onSessionStatus({
          sessionId: sessionID,
          agent: sessionID ? sessionMetadata.getAgent(sessionID) : undefined,
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
          sessionLifecycle.dispatchSessionDeleted(sessionID);
        }
        companionManager.onSessionDeleted(sessionID);
        if (sessionID) {
          v1InternalSelectionOverrides.delete(sessionID);
          sessionMetadata.delete(sessionID);
        }
      }
    },

    dispose: async () => {
      eventDirectoryScope?.release();
      // Synchronous: v2 setup calls this directly and does not emit the
      // public server.instance.disposed event first.
      instanceDisposed = true;
      registryBridge.retire();
      backgroundJobs.dispose();
      // Cancel pending initial-delay fallback timers so a reloaded
      // generation cannot observe one stale fallback call.
      foregroundFallback.dispose();
      await taskSessionManagerHook.event({
        event: { type: 'server.instance.disposed' },
      });
      await orchestratorWakeScheduler.event({
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
      await interviewManager.dispose();
      clearTuiActivities();
      tuiReusableProjection?.dispose();
      // Explicitly release this generation's companion ownership: a
      // reloaded generation only replaces the active manager at its own
      // onLoad, and if it fails before that the detached companion would
      // survive until process exit. Idempotent (registerActiveManager's
      // replacement path and the process-exit listener tolerate repeats).
      companionManager.onExit();
      // Release only this generation's ownership. The admission runtime
      // defers final scheduler/tracker teardown by one macrotask so an
      // immediate config-update re-init can retain active and queued calls.
      admissionRuntimeLease?.release();
    },

    'tool.execute.before': async (input, output) => {
      if (!runtime.disabledHooks.has('apply-patch')) {
        await applyPatch['tool.execute.before'](
          input as never,
          output as never,
        );
      }
      // Rewrite guessed non-existing absolute paths BEFORE the search
      // guard: the guard blocks grep/glob on missing paths, so running
      // the rescue after it would never see a rescuable path (#1143).
      if (!runtime.disabledHooks.has('absolute-path-rescue')) {
        await absolutePathRescue['tool.execute.before'](
          input as never,
          output as never,
        );
      }
      if (!runtime.disabledHooks.has('search-path-guard')) {
        await searchPathGuard['tool.execute.before'](
          input as never,
          output as never,
        );
      }
      await deepworkGuardHook['tool.execute.before'](
        input as never,
        output as never,
      );
      await taskSessionManagerHook['tool.execute.before'](
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
      if (!runtime.disabledHooks.has('tool-loop-guard')) {
        await toolLoopGuard['tool.execute.before'](
          input as never,
          output as never,
        );
      }
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

      if (commandEnabled('interview')) {
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
        await deepworkCommandHook.handleCommandExecuteBefore(
          input as {
            command: string;
            sessionID: string;
            arguments: string;
          },
          output as { parts: Array<{ type: string; text?: string }> },
        );
      }

      if (commandEnabled('reflect')) {
        await reflectCommandHook.handleCommandExecuteBefore(
          input as {
            command: string;
            sessionID: string;
            arguments: string;
          },
          output as { parts: Array<{ type: string; text?: string }> },
        );
      }

      if (commandEnabled('loop')) {
        await loopCommandHook.handleCommandExecuteBefore(
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
      if (internalSessionIds.has(input.sessionID)) return;
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
        foregroundFallback.observeExternalTurn(input.sessionID);
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
      const routedChildModel = routedChild?.route
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
        log('[delegation] routed v1 child to active fallback model', {
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
          ? (foregroundFallback.getActiveFallbackModel(input.sessionID) ??
            sessionMetadata.getModel(input.sessionID))
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
        foregroundFallback.observeContinuationModel(
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
        foregroundFallback.registerSessionAgent(input.sessionID, agent);
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
        }
        companionManager.onSessionStatus({
          sessionId: input.sessionID,
          agent,
          status: 'busy',
        });
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
          companionManager.onSessionModelChanged({
            sessionId: input.sessionID,
            model,
            ...(liveVariant ? { variant: liveVariant } : {}),
            variantObserved: true,
          });
        }
        backgroundTaskConcurrency.migrateTask(input.sessionID, model);
      }
      taskSessionManagerHook.observeChatMessage(input, output);
      orchestratorWakeScheduler.observeChatMessage(input, output);
      if (messageID) {
        toolLoopGuard.observeNewUserMessage(input.sessionID, messageID);
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
              : buildOrchestratorPrompt(
                  runtime.disabledAgents,
                  undefined,
                  true,
                  true,
                  hostFlavor,
                  runtime.backgroundJobs.boardInjection,
                );
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
      // Claim the mark synchronously: overlapping requests for this session
      // must not both strip reminders after their first asynchronous step.
      const sessionID =
        findLatestUserMessage(typedOutput.messages)?.info.sessionID ??
        typedOutput.messages.find(isMessageWithParts)?.info.sessionID;
      const compacting = sessionID
        ? compactingSessionIds.delete(sessionID)
        : false;

      for (const message of typedOutput.messages) {
        if (!isMessageWithParts(message)) {
          continue;
        }
        if (message.info.role !== 'user') {
          continue;
        }
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
      const imageResult = processImageAttachments({
        messages: typedOutput.messages,
        workDir: ctx.directory,
        imageRouting: runtime.imageRouting,
        disabledAgents: runtime.disabledAgents,
        log,
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
      await taskSessionManagerHook['experimental.chat.messages.transform'](
        input as never,
        typedOutput as never,
      );
      if (phaseReminder) {
        await phaseReminder['experimental.chat.messages.transform'](
          input as never,
          typedOutput as never,
        );
      }
      if (councilInject) {
        await councilInject['experimental.chat.messages.transform'](
          input as never,
          typedOutput as never,
        );
      }
      await taskSessionManagerHook.injectBackgroundJobBoard(input, typedOutput);
      if (compacting) {
        stripTaggedContent(typedOutput.messages, PHASE_REMINDER_METADATA_KEY);
        stripTaggedContent(typedOutput.messages, COUNCIL_INJECT_METADATA_KEY);
      }
    },

    'tool.execute.after': async (input, output) => {
      await deepworkGuardAfter(input, output);
      if (!runtime.disabledHooks.has('json-error-recovery')) {
        await jsonErrorRecoveryAfter(input, output);
      }
      if (!runtime.disabledHooks.has('tool-loop-guard')) {
        await toolLoopGuard['tool.execute.after'](
          input as never,
          output as never,
        );
      }
      await taskSessionManagerAfter(input, output);
    },
  } as Hooks & {
    'v2.refreshProfiles': typeof refreshProfilesFromDisk;
    'v2.resolveDelegatedModel': (input: {
      agentType: string;
      parentSessionID: string;
    }) => string | undefined;
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
