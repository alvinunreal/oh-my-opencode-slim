import type { Plugin, ToolDefinition } from '@opencode-ai/plugin';
import { createAgents, getAgentConfigs, getDisabledAgents } from './agents';
import { buildOrchestratorPrompt } from './agents/orchestrator';
import { CompanionManager } from './companion/manager';
import { ensureCompanionVersion } from './companion/updater';
import {
  type AgentOverrideConfig,
  deepMerge,
  loadPluginConfig,
  type MultiplexerConfig,
} from './config';
import { parseList } from './config/agent-mcps';
import { AGENT_ALIASES } from './config/constants';
import {
  getActiveRuntimePreset,
  getPreviousRuntimePreset,
  setActiveRuntimePreset,
} from './config/runtime-preset';
import { CouncilManager } from './council';
import {
  createApplyPatchHook,
  createAutoUpdateCheckerHook,
  createChatHeadersHook,
  createDeepworkCommandHook,
  createDelegateTaskRetryHook,
  createFilterAvailableSkillsHook,
  createJsonErrorRecoveryHook,
  createLoopCommandHook,
  createPhaseReminderHook,
  createPostFileToolNudgeHook,
  createReflectCommandHook,
  createTaskSessionManagerHook,
  ForegroundFallbackManager,
  SessionLifecycle,
} from './hooks';
import { processImageAttachments } from './hooks/image-hook';
import type { MessageWithParts } from './hooks/types';
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
  createCouncilTool,
  createPresetManager,
  createWebfetchTool,
} from './tools';
import { recordTuiAgentModel, recordTuiAgentModels } from './tui-state';
import {
  BackgroundJobBoard,
  BackgroundJobCoordinator,
  createDisplayNameMentionRewriter,
  resolveRuntimeAgentName,
} from './utils';
import { isPluginDisabledByEnv } from './utils/env';
import { initLogger, log } from './utils/logger';
import { SubagentDepthTracker } from './utils/subagent-depth';
import { collapseSystemInPlace } from './utils/system-collapse';

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

/** Minimum expected registrations for a healthy plugin load. */
const HEALTH_CHECK = {
  minAgents: 5,
  // Default tool set when council and ACP agents are not configured:
  // cancel_task, webfetch, ast_grep_search, ast_grep_replace.
  minTools: 4,
  minMcps: 1,
} as const;

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
// of the config file's preset. State lives in config/runtime-preset.ts.

const OhMyOpenCodeLite: Plugin = async (ctx) => {
  const sessionId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  initLogger(sessionId);

  if (isPluginDisabledByEnv()) {
    log('[plugin] disabled by OH_MY_OPENCODE_SLIM_DISABLE');
    return {};
  }

  // Declare variables that must survive the try/catch for the return
  // closure. These are set inside the try block.
  let config: ReturnType<typeof loadPluginConfig>;
  let disabledAgents: Set<string>;
  let agentDefs: ReturnType<typeof createAgents>;
  let agents: ReturnType<typeof getAgentConfigs>;
  let mcps: ReturnType<typeof createBuiltinMcps>;
  let modelArrayMap: Record<string, Array<{ id: string; variant?: string }>>;
  let runtimeChains: Record<string, string[]>;
  let multiplexerConfig: MultiplexerConfig;
  let multiplexerEnabled: boolean;
  let depthTracker: SubagentDepthTracker;
  let multiplexerSessionManager: MultiplexerSessionManager;
  let autoUpdateChecker: ReturnType<typeof createAutoUpdateCheckerHook>;
  let sessionAgentMap: Map<string, string>;
  let sessionLifecycle: SessionLifecycle;

  let chatHeadersHook: ReturnType<typeof createChatHeadersHook>;
  let foregroundFallback: ForegroundFallbackManager;
  let deepworkCommandHook: ReturnType<typeof createDeepworkCommandHook>;
  let reflectCommandHook: ReturnType<typeof createReflectCommandHook>;
  let loopCommandHook: ReturnType<typeof createLoopCommandHook>;
  let taskSessionManagerHook: ReturnType<typeof createTaskSessionManagerHook>;
  let phaseReminder: ReturnType<typeof createPhaseReminderHook>;
  let filterAvailableSkills: ReturnType<typeof createFilterAvailableSkillsHook>;
  let postFileToolNudge: ReturnType<typeof createPostFileToolNudgeHook>;
  let delegateTaskRetry: ReturnType<typeof createDelegateTaskRetryHook>;
  let applyPatch: ReturnType<typeof createApplyPatchHook>;
  let jsonErrorRecovery: ReturnType<typeof createJsonErrorRecoveryHook>;
  let postFileToolNudgeAfter: (i: unknown, o: unknown) => Promise<void>;
  let delegateTaskRetryAfter: (i: unknown, o: unknown) => Promise<void>;
  let jsonErrorRecoveryAfter: (i: unknown, o: unknown) => Promise<void>;
  let taskSessionManagerAfter: (i: unknown, o: unknown) => Promise<void>;
  let backgroundJobBoard: BackgroundJobBoard;
  let interviewManager: ReturnType<typeof createInterviewManager>;
  let presetManager: ReturnType<typeof createPresetManager>;
  let companionManager: CompanionManager;
  let councilTools: ReturnType<typeof createCouncilTool>;
  let cancelTaskTools: ReturnType<typeof createCancelTaskTool>;
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

    // Safety net: if a runtime preset was set via /preset command and
    // OpenCode ever fully re-runs the plugin function (not just the
    // config() hook), override config.preset so agents are created with
    // the correct models. Currently only the config() hook re-runs after
    // Instance.dispose(), so this is a defensive guard.
    const runtimePreset = getActiveRuntimePreset();
    if (runtimePreset && config.presets?.[runtimePreset]) {
      config.preset = runtimePreset;
      // Re-merge runtime preset into config.agents (loadPluginConfig
      // already merged the config-file preset, not the runtime one).
      // Runtime preset is override so it wins over config-file preset.
      const presetAgents = config.presets[runtimePreset];
      config.agents = deepMerge(config.agents, presetAgents);
    } else if (runtimePreset) {
      // Preset was deleted from config since last switch - clear stale state
      setActiveRuntimePreset(null);
    }

    disabledAgents = getDisabledAgents(config);
    rewriteDisplayNameMentions = createDisplayNameMentionRewriter(config);
    agentDefs = createAgents(config, { projectDirectory: ctx.directory });
    agents = getAgentConfigs(config, { projectDirectory: ctx.directory });

    // Build model array map and runtime fallback chains from _modelArray
    // entries (when the user configures model as an array in
    // agents.<name>.model). A single pass populates both data structures.
    modelArrayMap = {} as Record<
      string,
      Array<{ id: string; variant?: string }>
    >;
    runtimeChains = {} as Record<string, string[]>;
    for (const agentDef of agentDefs) {
      if (agentDef._modelArray?.length) {
        modelArrayMap[agentDef.name] = agentDef._modelArray;
        runtimeChains[agentDef.name] = agentDef._modelArray.map((m) => m.id);
      }
    }

    // Parse multiplexer config with defaults
    multiplexerConfig = {
      type: config.multiplexer?.type ?? 'none',
      layout: config.multiplexer?.layout ?? 'main-vertical',
      main_pane_size: config.multiplexer?.main_pane_size ?? 60,
      zellij_pane_mode: config.multiplexer?.zellij_pane_mode ?? 'agent-tab',
    };

    // Get multiplexer instance for capability checks
    const multiplexer = getMultiplexer(multiplexerConfig);
    multiplexerEnabled =
      multiplexerConfig.type !== 'none' &&
      multiplexer !== null &&
      multiplexer.isInsideSession();

    log('[plugin] initialized with multiplexer config', {
      multiplexerConfig,
      enabled: multiplexerEnabled,
      directory: ctx.directory,
    });

    // Start background availability check if enabled
    if (multiplexerEnabled) {
      startAvailabilityCheck(multiplexerConfig);
    }

    depthTracker = new SubagentDepthTracker();

    // Initialize council tools (only when council is configured)
    councilTools = config.council
      ? createCouncilTool(
          ctx,
          new CouncilManager(ctx, config, depthTracker, multiplexerEnabled),
        )
      : {};

    mcps = createBuiltinMcps(config.disabled_mcps, config.websearch);
    acpRunTools =
      Object.keys(config.acpAgents ?? {}).length > 0
        ? { acp_run: createAcpRunTool(config.acpAgents) }
        : {};
    webfetch = createWebfetchTool(ctx);
    backgroundJobBoard = new BackgroundJobBoard({
      maxReusablePerAgent: config.backgroundJobs?.maxSessionsPerAgent ?? 2,
      readContextMinLines: config.backgroundJobs?.readContextMinLines ?? 10,
      readContextMaxFiles: config.backgroundJobs?.readContextMaxFiles ?? 8,
    });

    // Initialize coordinator as the sole writer to the board
    const backgroundJobCoordinator = new BackgroundJobCoordinator(
      backgroundJobBoard,
    );

    // Initialize MultiplexerSessionManager to handle OpenCode's built-in
    // Task tool sessions
    multiplexerSessionManager = new MultiplexerSessionManager(
      ctx,
      multiplexerConfig,
      backgroundJobCoordinator,
    );
    backgroundJobCoordinator.addTerminalStateListener((taskID) => {
      void multiplexerSessionManager.closeSessionFromCoordinator(taskID);
    });

    sessionLifecycle = new SessionLifecycle(log);

    // Initialize auto-update checker hook
    autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
      autoUpdate: config.autoUpdate ?? true,
      companion: config.companion,
    });

    // Track session → agent mapping for serve-mode system prompt injection
    sessionAgentMap = new Map<string, string>();

    chatHeadersHook = createChatHeadersHook(ctx);

    // Initialize foreground fallback manager for runtime model switching.
    // Enabled by default even without fallback chains — the manager can still
    // abort rate-limited sessions after maxRetries to prevent infinite freezes.
    foregroundFallback = new ForegroundFallbackManager(
      ctx.client,
      runtimeChains,
      config.fallback?.enabled !== false,
      config.fallback?.maxRetries ?? 3,
      sessionLifecycle,
    );

    deepworkCommandHook = createDeepworkCommandHook();
    reflectCommandHook = createReflectCommandHook();
    loopCommandHook = createLoopCommandHook();
    taskSessionManagerHook = createTaskSessionManagerHook(ctx, {
      maxSessionsPerAgent: config.backgroundJobs?.maxSessionsPerAgent ?? 2,
      readContextMinLines: config.backgroundJobs?.readContextMinLines ?? 10,
      readContextMaxFiles: config.backgroundJobs?.readContextMaxFiles ?? 8,
      backgroundJobBoard: backgroundJobCoordinator,
      shouldManageSession: (sessionID) =>
        sessionAgentMap.get(sessionID) === 'orchestrator',
      isFallbackInProgress: (sessionID) =>
        foregroundFallback.isFallbackInProgress(sessionID),
      coordinator: sessionLifecycle,
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

    phaseReminder = createPhaseReminderHook(sessionLifecycle);

    filterAvailableSkills = createFilterAvailableSkillsHook(ctx, config);

    postFileToolNudge = createPostFileToolNudgeHook({
      shouldInject: (sessionID) =>
        sessionAgentMap.get(sessionID) === 'orchestrator',
      coordinator: sessionLifecycle,
    });

    delegateTaskRetry = createDelegateTaskRetryHook(ctx);

    applyPatch = createApplyPatchHook(ctx);

    jsonErrorRecovery = createJsonErrorRecoveryHook(ctx);

    // Pre-created wrapped handlers for tool.execute.after (error-isolated)
    postFileToolNudgeAfter = wrapPostToolHook('post-file-tool-nudge', (i, o) =>
      postFileToolNudge['tool.execute.after'](i as never, o as never),
    );
    delegateTaskRetryAfter = wrapPostToolHook('delegate-task-retry', (i, o) =>
      delegateTaskRetry['tool.execute.after'](i as never, o as never),
    );
    jsonErrorRecoveryAfter = wrapPostToolHook('json-error-recovery', (i, o) =>
      jsonErrorRecovery['tool.execute.after'](i as never, o as never),
    );
    taskSessionManagerAfter = wrapPostToolHook('task-session-manager', (i, o) =>
      taskSessionManagerHook['tool.execute.after'](i as never, o as never),
    );
    interviewManager = createInterviewManager(ctx, config);
    presetManager = createPresetManager(ctx, config);
    companionManager = new CompanionManager(
      `proc_${process.pid}`,
      ctx.directory,
      config.companion,
    );
    cancelTaskTools = createCancelTaskTool({
      client: ctx.client,
      backgroundJobBoard: backgroundJobCoordinator,
      shouldManageSession: (sessionID) =>
        sessionAgentMap.get(sessionID) === 'orchestrator',
    });

    tools = {
      ...councilTools,
      ...cancelTaskTools,
      ...acpRunTools,
      webfetch,
      ast_grep_search,
      ast_grep_replace,
    };
    if (config.disabled_tools && config.disabled_tools.length > 0) {
      const disabledTools = new Set(config.disabled_tools);
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
    config.disabled_mcps && config.disabled_mcps.length > 0
      ? 0
      : HEALTH_CHECK.minMcps;

  if (
    agentCount < HEALTH_CHECK.minAgents ||
    toolCount < HEALTH_CHECK.minTools ||
    mcpCount < mcpThreshold
  ) {
    const msg = [
      'Health check: registrations suspiciously low.',
      `  agents: ${agentCount} (expected >=${HEALTH_CHECK.minAgents})`,
      `  tools:  ${toolCount} (expected >=${HEALTH_CHECK.minTools})`,
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

  if (config.companion?.enabled === true) {
    try {
      const companionResult = await ensureCompanionVersion({
        config: config.companion,
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
    const configEntry = config.agents?.[agentName];
    const defaultVariant =
      typeof configEntry?.variant === 'string'
        ? configEntry.variant
        : undefined;
    const chainMatches = modelArrayMap[agentName]?.filter(
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
      // Only set default_agent if not already configured by the user
      // and the plugin config doesn't explicitly disable this behavior
      if (
        config.setDefaultAgent !== false &&
        !(opencodeConfig as { default_agent?: string }).default_agent
      ) {
        (opencodeConfig as { default_agent?: string }).default_agent =
          'orchestrator';
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

      // Model resolution for foreground agents: use _modelArray entries
      // to pick the first model for startup-time selection.
      //
      // Runtime failover on API errors (e.g. rate limits
      // mid-conversation) is handled separately by
      // ForegroundFallbackManager via the event hook.
      if (Object.keys(modelArrayMap).length > 0) {
        for (const [agentName, models] of Object.entries(modelArrayMap)) {
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

      // Runtime preset override: if /preset switched to a runtime preset,
      // override the model/variant/temperature from the preset's agent
      // config. This runs after the normal model resolution because the
      // config() hook re-runs with stale modelArrayMap after dispose(),
      // but the runtime preset data is in the captured `config` closure.
      const runtimePresetName = getActiveRuntimePreset();
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

        // Reset agents from the previous preset that aren't in the new one.
        // The stale model resolution above overwrites the reset values sent
        // by preset-manager, so we re-apply them here from config-file
        // baseline.
        const prevPresetName = getPreviousRuntimePreset();
        if (prevPresetName && config.presets?.[prevPresetName]) {
          const prevPreset = config.presets[prevPresetName];
          // Build resolved key set from new preset for correct comparison
          // (handles alias keys like "explore" → "explorer")
          const newPresetResolved = new Set(
            Object.keys(runtimePreset).map((k) => AGENT_ALIASES[k] ?? k),
          );
          for (const agentName of Object.keys(prevPreset)) {
            const resolvedName = AGENT_ALIASES[agentName] ?? agentName;
            if (newPresetResolved.has(resolvedName)) continue; // new preset handles it
            const entry = configAgent[resolvedName] as
              | Record<string, unknown>
              | undefined;
            if (!entry) continue;
            // Reset to config-file baseline. Use the previous preset's
            // override to identify which fields to clear even when the
            // baseline doesn't define them.
            const baseline = config.agents?.[resolvedName];
            const prevOverride = prevPreset[agentName] as
              | AgentOverrideConfig
              | undefined;
            if (typeof baseline?.model === 'string') {
              entry.model = baseline.model;
            }
            if (typeof baseline?.variant === 'string') {
              entry.variant = baseline.variant;
            } else if (prevOverride && 'variant' in prevOverride) {
              delete entry.variant;
            }
            if (typeof baseline?.temperature === 'number') {
              entry.temperature = baseline.temperature;
            } else if (prevOverride && 'temperature' in prevOverride) {
              delete entry.temperature;
            }
            if (
              baseline?.options &&
              typeof baseline.options === 'object' &&
              !Array.isArray(baseline.options)
            ) {
              entry.options = baseline.options;
            } else if (prevOverride && 'options' in prevOverride) {
              delete entry.options;
            }
            log('[plugin] runtime preset reset from previous', {
              previousPreset: prevPresetName,
              agent: resolvedName,
              model: entry.model as string,
            });
          }
        }
      }

      const tuiAgentModels: Record<string, string> = {};
      const tuiAgentVariants: Record<string, string> = {};
      for (const agentDef of agentDefs) {
        if (agentDef.name === 'councillor') continue;

        const entry = configAgent[agentDef.name] as
          | Record<string, unknown>
          | undefined;
        const resolvedModel =
          typeof entry?.model === 'string'
            ? entry.model
            : runtimeChains[agentDef.name]?.[0]
              ? runtimeChains[agentDef.name][0]
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
      recordTuiAgentModels({
        agentModels: tuiAgentModels,
        agentVariants: tuiAgentVariants,
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
      presetManager.registerCommand(opencodeConfig);
    },

    event: async (input) => {
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
          };
          sessionID?: string;
          id?: string;
          requestID?: string;
          status?: { type: string };
        };
      };

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
          const agentName = resolveRuntimeAgentName(config, info.agent);
          const model = `${providerID}/${modelID}`;
          const variant = resolveTuiVariantForModel(agentName, model);
          recordTuiAgentModel({
            agentName,
            model,
            variant: variant ?? null,
          });
        }
      }

      if (event.type === 'session.created') {
        const childSessionId = event.properties?.info?.id;
        const parentSessionId = event.properties?.info?.parentID;
        if (depthTracker && childSessionId && parentSessionId) {
          depthTracker.registerChild(parentSessionId, childSessionId);
        }
      }

      // Handle multiplexer pane spawning for OpenCode's Task tool sessions
      await multiplexerSessionManager.onSessionCreated(event);

      // Handle session status/idle events for pane cleanup early so child panes
      // close promptly even if later hooks do additional work on idle.
      await multiplexerSessionManager.onSessionStatus(event);

      // Handle session.deleted events for pane cleanup
      await multiplexerSessionManager.onSessionDeleted(event);

      // Runtime model fallback for foreground agents (rate-limit detection)
      await foregroundFallback.handleEvent(input.event);

      // Handle auto-update checking
      await autoUpdateChecker.event(input);

      await interviewManager.handleEvent(
        input as {
          event: { type: string; properties?: Record<string, unknown> };
        },
      );

      await taskSessionManagerHook.event(
        input as {
          event: {
            type: string;
            properties?: { info?: { id?: string }; sessionID?: string };
          };
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
          agent: sessionID ? sessionAgentMap.get(sessionID) : undefined,
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
        if (depthTracker && sessionID) {
          depthTracker.cleanup(sessionID);
        }
        if (sessionID) {
          sessionAgentMap.delete(sessionID);
        }
      }
    },

    'tool.execute.before': async (input, output) => {
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

      await presetManager.handleCommandExecuteBefore(
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
      input: { sessionID: string; agent?: string },
      output?: { message?: { agent?: string } },
    ) => {
      const rawAgent = input.agent ?? output?.message?.agent;
      const agent = rawAgent
        ? resolveRuntimeAgentName(config, rawAgent)
        : undefined;

      if (
        agent &&
        output?.message &&
        typeof output.message.agent === 'string'
      ) {
        output.message.agent = agent;
      }

      if (agent) {
        sessionAgentMap.set(input.sessionID, agent);
        // A chat message means this session is actively working. This also
        // covers the race where session.status busy fires before the
        // session's agent is known.
        companionManager.onSessionStatus({
          sessionId: input.sessionID,
          agent,
          status: 'busy',
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
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      const agentName = input.sessionID
        ? sessionAgentMap.get(input.sessionID)
        : undefined;
      if (agentName === 'orchestrator') {
        const alreadyInjected = output.system.some(
          (s) =>
            typeof s === 'string' &&
            s.includes('<Role>') &&
            s.includes('orchestrator'),
        );
        if (!alreadyInjected) {
          // Prepend the orchestrator prompt to the system array. Use the
          // resolved prompt from the orchestrator agent definition (which
          // includes any custom replacement or append from orchestrator.md
          // / orchestrator_append.md) Fall back to
          // buildOrchestratorPrompt only if the resolved prompt is
          // missing.
          const orchestratorDef = agentDefs.find(
            (a) => a.name === 'orchestrator',
          );
          const orchestratorPrompt =
            typeof orchestratorDef?.config?.prompt === 'string'
              ? orchestratorDef.config.prompt
              : buildOrchestratorPrompt(disabledAgents);
          output.system[0] =
            orchestratorPrompt +
            (output.system[0] ? `\n\n${output.system[0]}` : '');
        }
      }

      // Inject ephemeral post-file-tool-nudge reminder
      await postFileToolNudge['experimental.chat.system.transform'](
        input as never,
        output as never,
      );

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
      processImageAttachments({
        messages: typedOutput.messages,
        workDir: ctx.directory,
        disabledAgents,
        log,
      });

      await phaseReminder['experimental.chat.messages.transform'](
        input as never,
        typedOutput as never,
      );
      await filterAvailableSkills['experimental.chat.messages.transform'](
        input as never,
        typedOutput as never,
      );
      await taskSessionManagerHook['experimental.chat.messages.transform'](
        input as never,
        typedOutput as never,
      );
    },

    'tool.execute.after': async (input, output) => {
      await postFileToolNudgeAfter(input, output);
      await delegateTaskRetryAfter(input, output);
      await jsonErrorRecoveryAfter(input, output);
      await taskSessionManagerAfter(input, output);
    },
  };
};

export default OhMyOpenCodeLite;

export type {
  AgentName,
  AgentOverrideConfig,
  McpName,
  MultiplexerConfig,
  MultiplexerLayout,
  MultiplexerType,
  PluginConfig,
  TmuxConfig,
  TmuxLayout,
} from './config';
export type { RemoteMcpConfig } from './mcp';
