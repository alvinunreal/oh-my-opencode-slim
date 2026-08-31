import type { Plugin, ToolDefinition } from '@opencode-ai/plugin';
import {
  applyModelInheritanceToConfig,
  createAgents,
  getAgentConfigs,
  isSubagent,
} from './agents';
import { buildOrchestratorPrompt } from './agents/orchestrator';
import { CompanionManager } from './companion/manager';
import { ensureCompanionVersion } from './companion/updater';
import { deepMerge, loadPluginConfig, type MultiplexerConfig } from './config';
import { parseList } from './config/agent-mcps';
import {
  AGENT_ALIASES,
  DEFAULT_MAX_SESSION_METADATA_ENTRIES,
  TOAST_DURATION_MS,
} from './config/constants';
import { RuntimeConfig } from './config/runtime';
import { applyOrchestratorModelConfig } from './config/strip-orchestrator-model';
import { HEALTH_CHECK, minimumExpectedToolCount } from './health-check';
import {
  createApplyPatchHook,
  createAutoUpdateCheckerHook,
  createCacheMonitorHook,
  createChatHeadersHook,
  createDeepworkCommandHook,
  createFilterAvailableSkillsHook,
  createJsonErrorRecoveryHook,
  createLoopCommandHook,
  createOrchestratorWakeScheduler,
  createPhaseReminderHook,
  createPostFileToolNudgeHook,
  createReflectCommandHook,
  createTaskSessionManagerHook,
  createToolLoopGuardHook,
  ForegroundFallbackManager,
  SessionLifecycle,
} from './hooks';
import { processImageAttachments } from './hooks/image-hook';
import { createRevivedRunTracker } from './hooks/task-session-manager/revived-run-tracker';
import type { ToolLoopGuardHook } from './hooks/tool-loop-guard/hook';
import { isMessageWithParts, type MessageWithParts } from './hooks/types';
import { handleTaskSessionEvent } from './index-event';
import { createInterviewManager } from './interview';
import { createBuiltinMcps } from './mcp';
import {
  getMultiplexer,
  MultiplexerSessionManager,
  startAvailabilityCheck,
} from './multiplexer';
import {
  ast_grep_replace,
  ast_grep_search,
  createAcpRunTool,
  createCancelTaskTool,
  createTaskMessageTool,
  createTaskResultTool,
  createTaskReviveTool,
  createTaskStatusTool,
  createWaitForUserTool,
  createWebfetchTool,
} from './tools';
import { pickAgentModelRef } from './tools/smartfetch/secondary-model';
import {
  applyActivityEvent,
  resolveEventSessionID,
  TaskActivityTracker,
} from './tools/task-activity';
import {
  clearTuiAgentActivities,
  recordTuiAgentActivity,
  recordTuiAgentModel,
  recordTuiAgentModels,
} from './tui-state';
import {
  BackgroundJobBoard,
  BackgroundJobCoordinator,
  BackgroundJobSupervisor,
  createDisplayNameMentionRewriter,
  resolveRuntimeAgentName,
} from './utils';
import type { ContextFile } from './utils/background-job-board';
import { isPluginDisabledByEnv } from './utils/env';
import { initLogger, log } from './utils/logger';
import { SessionMetadataStore } from './utils/session-metadata';
import { collapseSystemInPlace } from './utils/system-collapse';
import { createV2Setup } from './v2';

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

// Debounce: only show image-skipped toast once per 60 seconds per project
const lastImageSkippedToastByDir = new Map<string, number>();
const IMAGE_SKIPPED_DEBOUNCE_MS = 60_000;

/**
 * Probe jsdom at init time so the first webfetch call doesn't fail
 * silently. Logs a warning if jsdom can't be imported or instantiated,
 * but does not throw; the plugin works without webfetch.
 */
async function probeJSDOM(): Promise<string | null> {
  try {
    const { JSDOM } = await import('jsdom');
    new JSDOM('<!DOCTYPE html><html><body>test</body></html>');
    return null;
  } catch (err) {
    return String(err);
  }
}

// Module-level runtime preset tracking. Survives plugin re-inits triggered
// by client.config.update() → Instance.dispose(). When the plugin function
// re-runs, it checks this variable and applies the runtime preset instead
// of the config file's preset. State lives in RuntimeConfig.

/**
 * Decide whether multiplexer pane management initializes for a plugin
 * input. v1 hosts (hostFlavor absent) keep the exact env-based
 * conditions — configured type, resolvable multiplexer, inside-session
 * env marker; v2 hosts, marked `hostFlavor: 'v2'` by the v2 client shim,
 * are gated off before any multiplexer initialization runs.
 */
export function shouldEnableMultiplexer(input: {
  hostFlavor?: string;
  multiplexerConfig: MultiplexerConfig;
}): boolean {
  if ((input as { hostFlavor?: string }).hostFlavor === 'v2') {
    log('[v2] multiplexer disabled on v2 host');
    return false;
  }
  // Get multiplexer instance for capability checks (v1 path, unchanged)
  const multiplexer = getMultiplexer(input.multiplexerConfig);
  return (
    input.multiplexerConfig.type !== 'none' &&
    multiplexer !== null &&
    multiplexer.isInsideSession()
  );
}

/**
 * Config handed to MultiplexerSessionManager. The manager is created
 * unconditionally (its lifecycle hooks are wired into the job coordinator),
 * but it self-gates only on env (inside tmux/zellij) — which would
 * incorrectly self-enable on a v2 host running inside tmux. v2 hosts are
 * therefore forced to type 'none', which disables every manager path (all
 * its public methods no-op when `enabled` is false). v1 hosts receive the
 * real config object unchanged.
 */
export function sessionManagerMultiplexerConfig(
  hostFlavor: string | undefined,
  config: MultiplexerConfig,
): MultiplexerConfig {
  return hostFlavor === 'v2' ? { ...config, type: 'none' } : config;
}

export const OhMyOpenCodeLite: Plugin = async (ctx) => {
  const sessionId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  initLogger(sessionId);

  if (isPluginDisabledByEnv()) {
    log('[plugin] disabled by OH_MY_OPENCODE_SLIM_DISABLE');
    return {};
  }

  // Observation-only prompt-cache watchdog; safe to create before config
  // loads and must see every event, so it sits outside the try block.
  const cacheMonitor = createCacheMonitorHook();

  // Declare variables that must survive the try/catch for the return
  // closure. These are set inside the try block.
  let config: ReturnType<typeof loadPluginConfig>;
  let runtime: RuntimeConfig;
  let agentDefs: ReturnType<typeof createAgents>;
  let agents: ReturnType<typeof getAgentConfigs>;
  let mcps: ReturnType<typeof createBuiltinMcps>;
  let multiplexerConfig: MultiplexerConfig;
  let multiplexerEnabled: boolean;
  let multiplexerSessionManager: MultiplexerSessionManager;
  let autoUpdateChecker: ReturnType<typeof createAutoUpdateCheckerHook>;
  const sessionMetadata = new SessionMetadataStore({
    maxEntries: DEFAULT_MAX_SESSION_METADATA_ENTRIES,
    onEvict: (sessionID) => {
      log('[session] evicted oldest session metadata', {
        threshold: DEFAULT_MAX_SESSION_METADATA_ENTRIES,
        droppedSessionId: sessionID,
      });
    },
  });
  const ownedTuiActivitySessions = new Map<string, string>();
  const tuiActivityDirectory = (sessionID: string): string => {
    return sessionMetadata.getDirectory(sessionID) ?? ctx.directory;
  };
  const markTuiAgentActive = (sessionID: string, agentName: string): void => {
    const directory = tuiActivityDirectory(sessionID);
    recordTuiAgentActivity({ sessionID, agentName, active: true }, directory);
    ownedTuiActivitySessions.set(sessionID, directory);
  };
  const markTuiAgentInactive = (sessionID: string): void => {
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

  let chatHeadersHook: ReturnType<typeof createChatHeadersHook>;
  let foregroundFallback: ForegroundFallbackManager;
  let deepworkCommandHook: ReturnType<typeof createDeepworkCommandHook>;
  let reflectCommandHook: ReturnType<typeof createReflectCommandHook>;
  let loopCommandHook: ReturnType<typeof createLoopCommandHook>;
  let taskSessionManagerHook: ReturnType<typeof createTaskSessionManagerHook>;
  let orchestratorWakeScheduler: ReturnType<
    typeof createOrchestratorWakeScheduler
  >;
  let phaseReminder: ReturnType<typeof createPhaseReminderHook>;
  let filterAvailableSkills: ReturnType<typeof createFilterAvailableSkillsHook>;
  let postFileToolNudge: ReturnType<typeof createPostFileToolNudgeHook>;
  let applyPatch: ReturnType<typeof createApplyPatchHook>;
  let jsonErrorRecovery: ReturnType<typeof createJsonErrorRecoveryHook>;
  let toolLoopGuard: ToolLoopGuardHook;
  let postFileToolNudgeAfter: (i: unknown, o: unknown) => Promise<void>;
  let jsonErrorRecoveryAfter: (i: unknown, o: unknown) => Promise<void>;
  let taskSessionManagerAfter: (i: unknown, o: unknown) => Promise<void>;
  let backgroundJobBoard: BackgroundJobBoard;
  let backgroundJobSupervisor: BackgroundJobSupervisor;
  let interviewManager: ReturnType<typeof createInterviewManager>;
  let companionManager: CompanionManager;
  let taskCancelTools: ReturnType<typeof createCancelTaskTool>;
  let taskMessageTools: ReturnType<typeof createTaskMessageTool>;
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

  try {
    config = loadPluginConfig(ctx.directory);
    // Seed the per-directory runtime registry with the raw plugin file
    // config. The runtime preset reapplication below mutates `config` for
    // legacy consumers; RuntimeConfig keeps the pre-mutation snapshot and
    // derives preset/runtime state through its own getters.
    RuntimeConfig.init(ctx.directory, config);

    // Safety net: instance disposal reruns the plugin factory and rebuilds
    // factory-local state, while module-level runtime preset state may persist.
    // Reapply that persisted preset so each fresh generation creates agents
    // with the correct models.
    const runtimePreset = RuntimeConfig.get(ctx.directory).getRuntimePreset();
    if (runtimePreset && config.presets?.[runtimePreset]) {
      config.preset = runtimePreset;
      // Re-merge runtime preset into config.agents (loadPluginConfig
      // already merged the config-file preset, not the runtime one).
      // Runtime preset is override so it wins over config-file preset.
      const presetAgents = config.presets[runtimePreset];
      config.agents = deepMerge(config.agents, presetAgents);
    } else if (runtimePreset) {
      // Preset was deleted from config since last switch - clear stale state
      RuntimeConfig.get(ctx.directory).setRuntimePreset(null);
    }

    runtime = RuntimeConfig.get(ctx.directory);
    rewriteDisplayNameMentions = createDisplayNameMentionRewriter(runtime);
    agentDefs = createAgents(runtime, { projectDirectory: ctx.directory });
    agents = getAgentConfigs(runtime, { projectDirectory: ctx.directory });

    // Parse multiplexer config with defaults
    multiplexerConfig = runtime.multiplexer;

    const hostFlavor = (ctx as Parameters<Plugin>[0] & { hostFlavor?: string })
      .hostFlavor;

    multiplexerEnabled = shouldEnableMultiplexer({
      hostFlavor,
      multiplexerConfig,
    });

    log('[plugin] initialized with multiplexer config', {
      multiplexerConfig,
      enabled: multiplexerEnabled,
      directory: ctx.directory,
    });

    // Start background availability check if enabled
    if (multiplexerEnabled) {
      startAvailabilityCheck(multiplexerConfig);
    }

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
      webfetchModels,
      explorerModel: pickAgentModelRef(runtime.agent('explorer')?.model),
      librarianModel: pickAgentModelRef(runtime.agent('librarian')?.model),
      smallModelRef: () => runtime.smallModel(),
    });
    backgroundJobBoard = new BackgroundJobBoard({
      maxReusablePerAgent: runtime.backgroundJobs.maxSessionsPerAgent,
      maxContextLines: runtime.backgroundJobs.maxContextLines,
      readContextMinLines: runtime.backgroundJobs.readContextMinLines,
      readContextMaxFiles: runtime.backgroundJobs.readContextMaxFiles,
    });

    // Initialize coordinator as the sole writer to the board
    const backgroundJobCoordinator = new BackgroundJobCoordinator(
      backgroundJobBoard,
    );
    backgroundJobSupervisor = new BackgroundJobSupervisor({
      backgroundJobStore: backgroundJobCoordinator,
      wallClockTimeoutMs: runtime.backgroundJobs.wallClockTimeoutMs,
      abortGraceMs: runtime.backgroundJobs.abortGraceMs,
      abort: (taskID) =>
        ctx.client.session.abort({
          path: { id: taskID },
        }),
    });
    backgroundJobCoordinator.addTerminalOutcomeListener((record) => {
      backgroundJobSupervisor.onTerminal(record);
    });
    revivedRunTracker = createRevivedRunTracker({
      input: ctx,
      backgroundJobBoard: backgroundJobCoordinator,
      backgroundJobSupervisor,
      onRegister: (taskID) => markRevivedRunPending(taskID),
      onSettled: (taskID) => markRevivedRunSettled(taskID),
      contextFilesForPrompt: (taskID) => getRevivedContextFiles(taskID),
      pruneContext: () => pruneRevivedContext(),
    });
    backgroundJobCoordinator.addTerminalOutcomeListener((record) => {
      revivedRunTracker.onTerminal(record);
    });

    // Initialize MultiplexerSessionManager to handle OpenCode's built-in
    // Task tool sessions. On v2 hosts the multiplexer is host-gated off
    // (shouldEnableMultiplexer), so the manager's config is forced to
    // 'none' — otherwise its env-based self-gate could re-enable pane
    // management inside tmux/zellij on a v2 host.
    multiplexerSessionManager = new MultiplexerSessionManager(
      ctx,
      sessionManagerMultiplexerConfig(hostFlavor, multiplexerConfig),
      backgroundJobCoordinator,
    );
    backgroundJobCoordinator.addTerminalStateListener((taskID) => {
      void multiplexerSessionManager.closeSessionFromCoordinator(taskID);
    });
    backgroundJobCoordinator.addTerminalOutcomeListener((record) => {
      if (record.deadlineExceededAt === undefined) return;
      void multiplexerSessionManager.closeSessionPermanentlyFromCoordinator(
        record.taskID,
      );
    });

    sessionLifecycle = new SessionLifecycle(log);

    // Initialize auto-update checker hook
    autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
      autoUpdate: runtime.autoUpdate,
      companion: runtime.companion,
    });

    chatHeadersHook = createChatHeadersHook(ctx);

    // Initialize foreground fallback manager for runtime model switching.
    // Agents without a chain (e.g. councillor, owned by CouncilManager) are
    // left alone — FG only aborts/re-prompts when it has a model to switch to.
    foregroundFallback = new ForegroundFallbackManager(
      runtime.runtimeChains,
      runtime.fallback.enabled !== false,
      ctx,
      runtime.fallback.maxRetries,
      sessionLifecycle,
      backgroundJobCoordinator,
    );

    deepworkCommandHook = createDeepworkCommandHook();
    reflectCommandHook = createReflectCommandHook();
    loopCommandHook = createLoopCommandHook();
    taskSessionManagerHook = createTaskSessionManagerHook(ctx, {
      strategy: runtime.backgroundJobs.strategy,
      maxSessionsPerAgent: runtime.backgroundJobs.maxSessionsPerAgent,
      maxRetainedSnapshots: runtime.backgroundJobs.maxRetainedSnapshots,
      readContextMinLines: runtime.backgroundJobs.readContextMinLines,
      readContextMaxFiles: runtime.backgroundJobs.readContextMaxFiles,
      backgroundJobBoard: backgroundJobCoordinator,
      backgroundJobSupervisor,
      shouldManageSession: (sessionID) =>
        sessionMetadata.getAgent(sessionID) === 'orchestrator',
      registerSessionAsOrchestrator: (sessionID) => {
        sessionMetadata.setAgent(sessionID, 'orchestrator');
      },
      isFallbackInProgress: (sessionID) =>
        foregroundFallback.isFallbackInProgress(sessionID),
      willAttemptFallback: (sessionID) =>
        foregroundFallback.willAttemptFallback(sessionID),
      coordinator: sessionLifecycle,
      revivedRunTracker,
    });
    markRevivedRunPending = taskSessionManagerHook.markRevivedRunPending;
    markRevivedRunSettled = taskSessionManagerHook.clearRevivedRunPending;
    getRevivedContextFiles = taskSessionManagerHook.contextFilesForTask;
    pruneRevivedContext = taskSessionManagerHook.pruneTaskContext;

    orchestratorWakeScheduler = createOrchestratorWakeScheduler(ctx, {
      config: runtime.backgroundJobs.orchestratorWake,
      shouldManageSession: (sessionID) =>
        sessionMetadata.getAgent(sessionID) === 'orchestrator',
      hasInputWait: (sessionID) =>
        taskSessionManagerHook.hasInputWait(sessionID),
      isFallbackInProgress: (sessionID) =>
        foregroundFallback.isFallbackInProgress(sessionID),
      coordinator: sessionLifecycle,
    });
    backgroundJobCoordinator.addTerminalOutcomeListener((record) => {
      if (record.state !== 'stopped' || !record.terminalUnreconciled) return;
      orchestratorWakeScheduler.triggerStoppedJobRecovery(
        record.parentSessionID,
      );
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

    // Both message transforms share this gate so a rejected nudge cannot be
    // followed by a phase reminder in the same outgoing turn.
    const shouldInjectOrchestratorReminder = (sessionID: string) =>
      sessionMetadata.getAgent(sessionID) === 'orchestrator';

    phaseReminder = createPhaseReminderHook({
      shouldInject: shouldInjectOrchestratorReminder,
    });

    filterAvailableSkills = createFilterAvailableSkillsHook(ctx, runtime);

    postFileToolNudge = createPostFileToolNudgeHook({
      shouldInject: shouldInjectOrchestratorReminder,
      coordinator: sessionLifecycle,
    });

    applyPatch = createApplyPatchHook(ctx);

    jsonErrorRecovery = createJsonErrorRecoveryHook(ctx);
    toolLoopGuard = createToolLoopGuardHook();

    // Pre-created wrapped handlers for tool.execute.after (error-isolated)
    postFileToolNudgeAfter = wrapPostToolHook('post-file-tool-nudge', (i, o) =>
      postFileToolNudge['tool.execute.after'](i as never, o as never),
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
    );
    taskCancelTools = createCancelTaskTool({
      input: ctx,
      backgroundJobBoard: backgroundJobCoordinator,
      shouldManageSession: (sessionID) =>
        sessionMetadata.getAgent(sessionID) === 'orchestrator',
    });
    taskMessageTools = createTaskMessageTool({
      input: ctx,
      backgroundJobBoard: backgroundJobCoordinator,
    });
    taskResultTools = createTaskResultTool({
      input: ctx,
      backgroundJobBoard: backgroundJobCoordinator,
    });
    taskReviveTools = createTaskReviveTool({
      input: ctx,
      backgroundJobBoard: backgroundJobCoordinator,
      shouldManageSession: (sessionID) =>
        sessionMetadata.getAgent(sessionID) === 'orchestrator',
      backgroundJobSupervisor,
      revivedRunTracker,
    });
    taskStatusTools = createTaskStatusTool({
      input: ctx,
      backgroundJobBoard: backgroundJobCoordinator,
      activityTracker: taskActivityTracker,
    });
    waitForUserTools = createWaitForUserTool({
      shouldManageSession: (sessionID) =>
        sessionMetadata.getAgent(sessionID) === 'orchestrator',
      resolveAgentName: (agent) => resolveRuntimeAgentName(runtime, agent),
      registerSessionAsOrchestrator: (sessionID) => {
        sessionMetadata.setAgent(sessionID, 'orchestrator');
      },
      beginUserWait: (sessionID) => {
        taskSessionManagerHook.beginUserWait(sessionID);
        orchestratorWakeScheduler.suppress(sessionID);
      },
      waitForUserGuardEnabled: runtime.backgroundJobs.waitForUserGuard,
      hasOutstandingBackgroundTasks: (sessionID) =>
        runtime.backgroundJobs.orchestratorWake.enabled &&
        backgroundJobCoordinator.hasRunning(sessionID),
    });

    const shouldRegisterWebfetch = runtime.webfetch.enabled !== false;
    tools = {
      ...taskCancelTools,
      ...taskMessageTools,
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

    toolCount = Object.keys(tools).length;
  } catch (err) {
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
    const chainMatches = runtime.modelArrays[agentName]?.filter(
      (entry) => entry.id === model,
    );
    if (chainMatches) {
      if (chainMatches.length === 1) {
        return chainMatches[0].variant ?? defaultVariant;
      }
      return undefined;
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

  return {
    name: 'oh-my-opencode-slim',

    agent: agents,

    tool: tools,

    mcp: mcps,

    config: async (opencodeConfig: Record<string, unknown>) => {
      // Capture the host opencode config BEFORE any mutation so runtime
      // consumers can distinguish host-provided values from plugin-applied
      // ones (host override > runtime override > plugin file).
      RuntimeConfig.get(ctx.directory).captureHostConfig(opencodeConfig);

      // Force default_agent to 'orchestrator' when unset, and also when the
      // user pointed it at an omos subagent name (opencode rejects subagent
      // names as default_agent with "default agent must be a primary agent").
      // Other values (opencode's built-in 'build'/'plan', or a user-defined
      // primary agent) are respected. This guards against promptAsync calls
      // that omit the `agent` field from falling back to 'build' when the
      // orchestrator agent is temporarily unresolved.
      if (runtime.setDefaultAgent) {
        const existing = (opencodeConfig as { default_agent?: string })
          .default_agent;
        if (!existing || isSubagent(existing)) {
          (opencodeConfig as { default_agent?: string }).default_agent =
            'orchestrator';
        }
      }

      // Merge Agent configs - per-agent shallow merge to preserve
      // user-supplied fields (e.g. tools, permission) from opencode.json
      if (!opencodeConfig.agent) {
        opencodeConfig.agent = { ...agents };
      } else {
        for (const [name, pluginAgent] of Object.entries(agents)) {
          const existing = (opencodeConfig.agent as Record<string, unknown>)[
            name
          ] as Record<string, unknown> | undefined;
          // User explicitly picked a model via /model → disable fallback.
          // Only marks the agent if the model differs from the chain primary.
          // Once marked, stays disabled even if user switches back to chain[0].
          if (existing && typeof existing.model === 'string') {
            const primary = runtime.modelArrays[name]?.[0]?.id;
            if (primary && existing.model !== primary) {
              runtime.everModelSwitched(name);
            }
            if (runtime.hasModelSwitched(name)) {
              foregroundFallback.disableChain(name);
            }
          }
          if (existing) {
            // Shallow merge: plugin defaults first, user overrides win
            (opencodeConfig.agent as Record<string, unknown>)[name] = {
              ...pluginAgent,
              ...existing,
            };
          } else {
            (opencodeConfig.agent as Record<string, unknown>)[name] = {
              ...pluginAgent,
            };
          }
        }
      }
      const configAgent = opencodeConfig.agent as Record<string, unknown>;
      applyModelInheritanceToConfig(configAgent, runtime);

      // Model resolution for foreground agents: use _modelArray entries
      // to pick the first model for startup-time selection.
      //
      // Runtime failover on API errors (e.g. rate limits
      // mid-conversation) is handled separately by
      // ForegroundFallbackManager via the event hook.
      if (Object.keys(runtime.modelArrays).length > 0) {
        for (const [agentName, models] of Object.entries(runtime.modelArrays)) {
          if (models.length === 0) continue;

          // Use the first model in the model array. Not all providers
          // require entries in opencodeConfig.provider - some are loaded
          // automatically by opencode (e.g. github-copilot, openrouter).
          // We cannot distinguish these from truly unconfigured providers
          // at config-hook time, so we cannot gate on the provider config
          // keys. Runtime failover is handled separately by
          // ForegroundFallbackManager.
          const chosen = models[0];
          const entry = configAgent[agentName] as
            | Record<string, unknown>
            | undefined;
          if (entry) {
            // Only apply model array resolution if no user-selected model
            // exists. A user-selected model (via /model command) takes
            // precedence over the config's fallback chain to preserve
            // runtime selections and avoid breaking provider cache.
            if (entry.model === undefined) {
              entry.model = chosen.id;
              if (chosen.variant) {
                entry.variant = chosen.variant;
              }
            }
          } else {
            // Agent exists in slim but not in opencodeConfig.agent -
            // create entry
            (configAgent as Record<string, unknown>)[agentName] = {
              model: chosen.id,
              ...(chosen.variant ? { variant: chosen.variant } : {}),
            };
          }
          log('[plugin] resolved model from array', {
            agent: agentName,
            model: chosen.id,
            variant: chosen.variant,
          });
        }
      }

      // Runtime preset override: instance disposal recreates the plugin
      // factory and its factory-local state, while module-level runtime
      // preset data may persist. Apply that persisted selection after normal
      // model resolution for the current generation.
      const runtimePresetName = runtime.getRuntimePreset();
      if (runtimePresetName && config.presets?.[runtimePresetName]) {
        const runtimePreset = config.presets[runtimePresetName];
        for (const [agentName, override] of Object.entries(runtimePreset)) {
          // Resolve legacy alias keys (e.g. "explore" → "explorer")
          // so presets using aliases work in this path.
          const resolvedName = AGENT_ALIASES[agentName] ?? agentName;
          const entry = configAgent[resolvedName] as
            | Record<string, unknown>
            | undefined;
          if (!entry) continue;

          if (typeof override.model === 'string') {
            entry.model = override.model;
          } else if (
            Array.isArray(override.model) &&
            override.model.length > 0
          ) {
            const first = override.model[0];
            entry.model = typeof first === 'string' ? first : first.id;
            // Extract inline variant from array-form model entry
            if (typeof first !== 'string' && first.variant) {
              entry.variant = first.variant;
            }
          }
          // Explicitly set or clear scalar fields so switching from
          // Preset A (which sets a field) to Preset B (which doesn't)
          // doesn't leave stale values behind.
          if (typeof override.variant === 'string') {
            entry.variant = override.variant;
          } else if ('variant' in override) {
            delete entry.variant;
          }
          if (typeof override.temperature === 'number') {
            entry.temperature = override.temperature;
          } else if ('temperature' in override) {
            delete entry.temperature;
          }
          if (
            override.options &&
            typeof override.options === 'object' &&
            !Array.isArray(override.options)
          ) {
            entry.options = override.options;
          } else if ('options' in override) {
            delete entry.options;
          }
          log('[plugin] runtime preset override', {
            preset: runtimePresetName,
            agent: agentName,
            model: entry.model as string,
          });
        }
      }

      // Capture the resolved model state before optionally removing the
      // orchestrator model from the SDK config, so the TUI keeps showing the
      // configured model rather than a fallback or "default".
      const tuiAgentModels: Record<string, string> = {};
      const tuiAgentVariants: Record<string, string> = {};
      for (const agentDef of agentDefs) {
        if (
          agentDef.name === 'council' ||
          agentDef.name === 'councillor' ||
          agentDef.name.startsWith('councillor-')
        )
          continue;

        const entry = configAgent[agentDef.name] as
          | Record<string, unknown>
          | undefined;
        const resolvedModel =
          typeof entry?.model === 'string'
            ? entry.model
            : runtime.runtimeChains[agentDef.name]?.[0]
              ? runtime.runtimeChains[agentDef.name][0]
              : typeof agentDef.config.model === 'string'
                ? agentDef.config.model
                : undefined;
        const resolvedVariant =
          typeof entry?.variant === 'string'
            ? entry.variant
            : typeof agentDef.config.variant === 'string'
              ? agentDef.config.variant
              : undefined;

        tuiAgentModels[agentDef.name] = resolvedModel ?? 'default';
        if (resolvedVariant) {
          tuiAgentVariants[agentDef.name] = resolvedVariant;
        }
      }
      recordTuiAgentModels(
        {
          agentModels: tuiAgentModels,
          agentVariants: tuiAgentVariants,
        },
        ctx.directory,
      );

      applyOrchestratorModelConfig({
        agents: configAgent,
        enabled: runtime.stripOrchestratorModel,
        presets: runtime.plugin?.presets,
        configPreset: runtime.preset,
        runtimePreset: runtimePresetName,
      });

      // Merge MCP configs
      const configMcp = opencodeConfig.mcp as
        | Record<string, unknown>
        | undefined;
      if (!configMcp) {
        opencodeConfig.mcp = { ...mcps };
      } else {
        Object.assign(configMcp, mcps);
      }

      // Get all MCP names from the merged config (built-in + custom)
      const mergedMcpConfig = opencodeConfig.mcp as
        | Record<string, unknown>
        | undefined;
      const allMcpNames = Object.keys(mergedMcpConfig ?? mcps);

      // For each agent, create permission rules based on their mcps list
      for (const [agentName, agentConfig] of Object.entries(agents)) {
        const agentMcps = (agentConfig as { mcps?: string[] })?.mcps;
        if (!agentMcps) continue;

        // Get or create agent permission config
        if (!configAgent[agentName]) {
          configAgent[agentName] = { ...agentConfig };
        }
        const agentConfigEntry = configAgent[agentName] as Record<
          string,
          unknown
        >;
        const agentPermission = (agentConfigEntry.permission ?? {}) as Record<
          string,
          unknown
        >;

        // Parse mcps list with wildcard and exclusion support
        const allowedMcps = parseList(agentMcps, allMcpNames);

        // Create permission rules for each MCP
        // MCP tools are named as <server>_<tool>, so we use <server>_*
        for (const mcpName of allMcpNames) {
          const sanitizedMcpName = mcpName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const permissionKey = `${sanitizedMcpName}_*`;
          const action = allowedMcps.includes(mcpName) ? 'allow' : 'deny';

          // Only set if not already defined by user
          if (!(permissionKey in agentPermission)) {
            agentPermission[permissionKey] = action;
          }
        }

        // Update agent config with permissions
        agentConfigEntry.permission = agentPermission;
      }

      interviewManager.registerCommand(opencodeConfig);
      deepworkCommandHook.registerCommand(opencodeConfig);
      reflectCommandHook.registerCommand(opencodeConfig);
      loopCommandHook.registerCommand(opencodeConfig);
    },

    event: async (input) => {
      await cacheMonitor.event(input);

      const event = input.event as {
        type: string;
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
      const statusType = event.properties?.status?.type;
      if (eventSessionID) {
        applyActivityEvent(taskActivityTracker, event);
        if (
          event.type === 'session.status' &&
          (statusType === 'busy' || statusType === 'retry')
        ) {
          sessionMetadata.markOrchestratorActive(eventSessionID);
          const agentName = sessionMetadata.getAgent(eventSessionID);
          if (agentName) {
            markTuiAgentActive(eventSessionID, agentName);
          }
        } else if (
          event.type === 'session.idle' ||
          (event.type === 'session.status' && statusType === 'idle') ||
          event.type === 'session.deleted'
        ) {
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
        if (createdSessionId && createdSessionDir) {
          sessionMetadata.setDirectory(createdSessionId, createdSessionDir);
        }
      }

      await handleTaskSessionEvent(
        input as {
          event: {
            type: string;
            properties?: { info?: { id?: string }; sessionID?: string };
          };
        },
        taskSessionManagerHook.event,
        async () => {
          // Handle multiplexer pane spawning for OpenCode's Task tool sessions
          await multiplexerSessionManager.onSessionCreated(event);

          // Handle session status/idle events for pane cleanup early so child panes
          // close promptly even if later hooks do additional work on idle.
          await multiplexerSessionManager.onSessionStatus(event);

          // Handle session.deleted events for pane cleanup
          await multiplexerSessionManager.onSessionDeleted(event);
        },
        async () => {
          await multiplexerSessionManager.cleanupOnInstanceDisposed();
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

      if (
        event.type === 'permission.asked' ||
        event.type === 'question.asked'
      ) {
        companionManager.onWaitingInput();
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
          | { sessionID?: string; status?: { type?: string } }
          | undefined;
        const sessionID = props?.sessionID;
        companionManager.onSessionStatus({
          sessionId: sessionID,
          agent: sessionID ? sessionMetadata.getAgent(sessionID) : undefined,
          status: props?.status?.type,
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
          sessionMetadata.delete(sessionID);
        }
      }
    },

    dispose: async () => {
      await taskSessionManagerHook.event({
        event: { type: 'server.instance.disposed' },
      });
      await orchestratorWakeScheduler.event({
        event: { type: 'server.instance.disposed' },
      });
      await interviewManager.dispose();
      await multiplexerSessionManager.cleanupOnInstanceDisposed();
      clearTuiActivities();
    },

    'tool.execute.before': async (input, output) => {
      await toolLoopGuard['tool.execute.before'](
        input as never,
        output as never,
      );
      await applyPatch['tool.execute.before'](input as never, output as never);
      await taskSessionManagerHook['tool.execute.before'](
        input as never,
        output as never,
      );
    },

    'command.execute.before': async (input, output) => {
      await interviewManager.handleCommandExecuteBefore(
        input as {
          command: string;
          sessionID: string;
          arguments: string;
        },
        output as { parts: Array<{ type: string; text?: string }> },
      );

      await deepworkCommandHook.handleCommandExecuteBefore(
        input as {
          command: string;
          sessionID: string;
          arguments: string;
        },
        output as { parts: Array<{ type: string; text?: string }> },
      );

      await reflectCommandHook.handleCommandExecuteBefore(
        input as {
          command: string;
          sessionID: string;
          arguments: string;
        },
        output as { parts: Array<{ type: string; text?: string }> },
      );

      await loopCommandHook.handleCommandExecuteBefore(
        input as {
          command: string;
          sessionID: string;
          arguments: string;
        },
        output as { parts: Array<{ type: string; text?: string }> },
      );
    },

    'chat.headers': chatHeadersHook['chat.headers'],

    // Track which agent each session uses (needed for serve-mode prompt
    // injection)
    'chat.message': async (
      input: {
        sessionID: string;
        agent?: string;
        model?: {
          providerID: string;
          modelID: string;
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
        foregroundFallback.registerSessionAgent(input.sessionID, agent);
        sessionMetadata.setAgent(input.sessionID, agent);
        markTuiAgentActive(input.sessionID, agent);
        // A chat message means this session is actively working. This also
        // covers the race where session.status busy fires before the
        // session's agent is known.
        companionManager.onSessionStatus({
          sessionId: input.sessionID,
          agent,
          status: 'busy',
        });
      }
      taskSessionManagerHook.observeChatMessage(input, output);
      orchestratorWakeScheduler.observeChatMessage(input, output);
    },

    // Inject orchestrator system prompt for serve-mode sessions. In serve
    // mode, the agent's prompt field may be absent from the agents
    // registry (built before plugin config hooks run). This hook injects
    // it at LLM call time. Uses the already-resolved prompt from
    // agentDefs (which has custom replacement or append prompts applied)
    // instead of rebuilding the default.
    'experimental.chat.system.transform': async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      const agentName = input.sessionID
        ? sessionMetadata.getAgent(input.sessionID)
        : undefined;
      if (agentName === 'orchestrator') {
        const alreadyInjected = output.system.some(
          (s) =>
            typeof s === 'string' &&
            s.includes('<Role>') &&
            s.includes('orchestrator'),
        );
        if (!alreadyInjected) {
          // Place the orchestrator prompt after AGENTS.md so the user's
          // behavioral rules (language, code conventions, etc.) retain
          // their intended priority. AGENTS.md is injected by OpenCode
          // core into system[0]; prepending the orchestrator prompt before
          // it buries user-defined rules under thousands of lines of
          // orchestration instructions.
          const orchestratorDef = agentDefs.find(
            (a) => a.name === 'orchestrator',
          );
          const orchestratorPrompt =
            typeof orchestratorDef?.config?.prompt === 'string'
              ? orchestratorDef.config.prompt
              : buildOrchestratorPrompt(runtime.disabledAgents);
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
        const last = lastImageSkippedToastByDir.get(ctx.directory) ?? 0;
        if (now - last > IMAGE_SKIPPED_DEBOUNCE_MS) {
          ctx.client.tui
            .showToast({
              body: {
                title: 'Images skipped',
                message:
                  'Observer agent is disabled, so images can\'t be analyzed. Set image_routing to "direct" to send images to your model, or enable observer.',
                variant: 'warning',
                duration: TOAST_DURATION_MS,
              },
            })
            .then(() => {
              // Only advance the debounce window on a successful toast
              // so a failed attempt doesn't suppress the next warning.
              // Greptile: "Failed Toast Starts Debounce Window".
              lastImageSkippedToastByDir.set(ctx.directory, now);
            })
            .catch(() => {});
        }
      }

      // Repair session mappings before reminder gates; nudge metadata precedes phase dedup.
      await taskSessionManagerHook['experimental.chat.messages.transform'](
        input as never,
        typedOutput as never,
      );
      await postFileToolNudge['experimental.chat.messages.transform'](
        input as never,
        typedOutput as never,
      );
      await phaseReminder['experimental.chat.messages.transform'](
        input as never,
        typedOutput as never,
      );
      await filterAvailableSkills['experimental.chat.messages.transform'](
        input as never,
        typedOutput as never,
      );
      await taskSessionManagerHook.injectBackgroundJobBoard(input, typedOutput);
    },

    'tool.execute.after': async (input, output) => {
      await postFileToolNudgeAfter(input, output);
      await jsonErrorRecoveryAfter(input, output);
      await toolLoopGuard['tool.execute.after'](
        input as never,
        output as never,
      );
      await taskSessionManagerAfter(input, output);
    },
  };
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
