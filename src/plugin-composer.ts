import type { Plugin, ToolDefinition } from '@opencode-ai/plugin';
import type { PluginConfig, AgentOverrideConfig, MultiplexerConfig } from './config';
import type { AgentDefinition } from './agents';
import { HookRegistry } from './hooks/hook-registry';

// Re-export for consumers
export type { HookRegistry } from './hooks/hook-registry';

export interface ComposerDependencies {
  // Agent creation
  agentFactory: typeof import('./agents').createAgents;
  getAgentConfigs: typeof import('./agents').getAgentConfigs;
  getDisabledAgents: typeof import('./agents').getDisabledAgents;
  buildOrchestratorPrompt: typeof import('./agents/orchestrator').buildOrchestratorPrompt;
  applyOrchestratorModelConfig: typeof import('./config/strip-orchestrator-model').applyOrchestratorModelConfig;
  agentDefsGetter: (config: PluginConfig, options: { projectDirectory: string }) => AgentDefinition[];

  // Hook system
  hookRegistry: HookRegistry;

  // Tool system
  createCancelTaskTool: typeof import('./tools').createCancelTaskTool;
  createAcpRunTool: typeof import('./tools').createAcpRunTool;
  createWebfetchTool: typeof import('./tools').createWebfetchTool;
  astGrepSearch: typeof import('./tools').ast_grep_search;
  astGrepReplace: typeof import('./tools').ast_grep_replace;

  // Multiplexer
  getMultiplexer: typeof import('./multiplexer').getMultiplexer;
  MultiplexerSessionManager: typeof import('./multiplexer').MultiplexerSessionManager;
  startAvailabilityCheck: typeof import('./multiplexer').startAvailabilityCheck;

  // Background jobs
  BackgroundJobBoard: typeof import('./utils').BackgroundJobBoard;
  BackgroundJobCoordinator: typeof import('./utils').BackgroundJobCoordinator;

  // Session lifecycle
  SessionLifecycle: typeof import('./hooks').SessionLifecycle;

  // Interview & Preset
  createInterviewManager: typeof import('./interview').createInterviewManager;
  createPresetManager: typeof import('./tools/preset-manager').createPresetManager;

  // Companion
  CompanionManager: typeof import('./companion/manager').CompanionManager;
  ensureCompanionVersion: typeof import('./companion/updater').ensureCompanionVersion;

  // Config
  loadPluginConfig: typeof import('./config').loadPluginConfig;
  deepMerge: typeof import('./config').deepMerge;
  parseList: typeof import('./config/agent-mcps').parseList;
  resolveImageRouting: typeof import('./config/constants').resolveImageRouting;
  AGENT_ALIASES: typeof import('./config/constants').AGENT_ALIASES;
  DEFAULT_MAX_SESSIONS_PER_AGENT: typeof import('./config/constants').DEFAULT_MAX_SESSIONS_PER_AGENT;
  DEFAULT_READ_CONTEXT_MIN_LINES: typeof import('./config/constants').DEFAULT_READ_CONTEXT_MIN_LINES;
  DEFAULT_READ_CONTEXT_MAX_FILES: typeof import('./config/constants').DEFAULT_READ_CONTEXT_MAX_FILES;

  // Hook factories
  createAutoUpdateCheckerHook: typeof import('./hooks').createAutoUpdateCheckerHook;
  createCacheMonitorHook: typeof import('./hooks').createCacheMonitorHook;
  createChatHeadersHook: typeof import('./hooks').createChatHeadersHook;
  createDeepworkCommandHook: typeof import('./hooks').createDeepworkCommandHook;
  createReflectCommandHook: typeof import('./hooks').createReflectCommandHook;
  createLoopCommandHook: typeof import('./hooks').createLoopCommandHook;
  createTaskSessionManagerHook: typeof import('./hooks').createTaskSessionManagerHook;
  createPhaseReminderHook: typeof import('./hooks').createPhaseReminderHook;
  createFilterAvailableSkillsHook: typeof import('./hooks').createFilterAvailableSkillsHook;
  createPostFileToolNudgeHook: typeof import('./hooks').createPostFileToolNudgeHook;
  createDelegateTaskRetryHook: typeof import('./hooks').createDelegateTaskRetryHook;
  createApplyPatchHook: typeof import('./hooks').createApplyPatchHook;
  createJsonErrorRecoveryHook: typeof import('./hooks').createJsonErrorRecoveryHook;
  createDisplayNameMentionRewriter: typeof import('./utils').createDisplayNameMentionRewriter;

  // Utilities
  processImageAttachments: typeof import('./hooks/image-hook').processImageAttachments;
  isMessageWithParts: typeof import('./hooks/types').isMessageWithParts;
  handleTaskSessionEvent: typeof import('./index-event').handleTaskSessionEvent;
  recordTuiAgentModel: typeof import('./tui-state').recordTuiAgentModel;
  recordTuiAgentModels: typeof import('./tui-state').recordTuiAgentModels;
  resolveRuntimeAgentName: typeof import('./utils').resolveRuntimeAgentName;
  collapseSystemInPlace: typeof import('./utils/system-collapse').collapseSystemInPlace;
  getActiveRuntimePreset: typeof import('./config/runtime-preset').getActiveRuntimePreset;
  getPreviousRuntimePreset: typeof import('./config/runtime-preset').getPreviousRuntimePreset;
  setActiveRuntimePreset: typeof import('./config/runtime-preset').setActiveRuntimePreset;
  ForegroundFallbackManager: typeof import('./hooks').ForegroundFallbackManager;
  isPluginDisabledByEnv: typeof import('./utils/env').isPluginDisabledByEnv;
  initLogger: typeof import('./utils/logger').initLogger;
  log: typeof import('./utils/logger').log;
  appLog: typeof import('./utils/plugin-init').appLog;
  probeJSDOM: typeof import('./utils/plugin-init').probeJSDOM;
  HEALTH_CHECK: typeof import('./utils/plugin-init').HEALTH_CHECK;
  createBuiltinMcps: typeof import('./mcp').createBuiltinMcps;
}

export interface PluginComposer {
  compose(ctx: Parameters<Plugin>[0]): ReturnType<Plugin>;
}

export function createPluginComposer(deps: ComposerDependencies): PluginComposer {
  return {
    async compose(ctx) {
      const sessionId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      deps.initLogger(sessionId);

      if (deps.isPluginDisabledByEnv()) {
        deps.log('[plugin] disabled by OH_MY_OPENCODE_SLIM_DISABLE');
        return {};
      }

      // Observation-only prompt-cache watchdog
      const cacheMonitor = deps.createCacheMonitorHook();

      // Load config
      const config = deps.loadPluginConfig(ctx.directory);

      // Runtime preset override
      const runtimePreset = deps.getActiveRuntimePreset();
      if (runtimePreset && config.presets?.[runtimePreset]) {
        config.preset = runtimePreset;
        const presetAgents = config.presets[runtimePreset];
        config.agents = deps.deepMerge(config.agents, presetAgents);
      } else if (runtimePreset) {
        deps.setActiveRuntimePreset(null);
      }

      // Create agents
      const agentComposer = new AgentComposer(deps);
      const { disabledAgents, agentDefs, agents } = agentComposer.compose(config, ctx.directory);

      // Build model array map and runtime chains
      const modelArrayMap: Record<string, Array<{ id: string; variant?: string }>> = {};
      const everModelSwitched = new Set<string>();
      const runtimeChains: Record<string, string[]> = {};
      for (const agentDef of agentDefs) {
        if (agentDef._modelArray?.length) {
          modelArrayMap[agentDef.name] = agentDef._modelArray;
          runtimeChains[agentDef.name] = agentDef._modelArray.map((m) => m.id);
        }
      }

      // Multiplexer
      const multiplexerComposer = new MultiplexerComposer(deps);
      const { multiplexerConfig, multiplexerEnabled, multiplexer } = multiplexerComposer.compose(config);

      // Background jobs
      const backgroundJobBoard = new deps.BackgroundJobBoard({
        maxReusablePerAgent:
          config.backgroundJobs?.maxSessionsPerAgent ?? deps.DEFAULT_MAX_SESSIONS_PER_AGENT,
        readContextMinLines:
          config.backgroundJobs?.readContextMinLines ?? deps.DEFAULT_READ_CONTEXT_MIN_LINES,
        readContextMaxFiles:
          config.backgroundJobs?.readContextMaxFiles ?? deps.DEFAULT_READ_CONTEXT_MAX_FILES,
      });

      const backgroundJobCoordinator = new deps.BackgroundJobCoordinator(backgroundJobBoard);

      // Multiplexer session manager
      const multiplexerSessionManager = new deps.MultiplexerSessionManager(
        ctx,
        multiplexerConfig,
        backgroundJobCoordinator,
      );
      backgroundJobCoordinator.addTerminalStateListener((taskID) => {
        void multiplexerSessionManager.closeSessionFromCoordinator(taskID);
      });

      // Session lifecycle
      const sessionLifecycle = new deps.SessionLifecycle(deps.log);

      // Auto-update checker
      const autoUpdateChecker = deps.createAutoUpdateCheckerHook(ctx, {
        autoUpdate: config.autoUpdate ?? true,
        companion: config.companion,
      });

      // Session -> agent mapping
      const sessionAgentMap = new Map<string, string>();
      const sessionDirectories = new Map<string, string>();

      // Chat headers
      const chatHeadersHook = deps.createChatHeadersHook(ctx);

      // Foreground fallback
      const foregroundFallback = new deps.ForegroundFallbackManager(
        ctx.client,
        runtimeChains,
        config.fallback?.enabled !== false,
        config.fallback?.maxRetries ?? 3,
        sessionLifecycle,
      );

      // Command hooks
      const deepworkCommandHook = deps.createDeepworkCommandHook();
      const reflectCommandHook = deps.createReflectCommandHook();
      const loopCommandHook = deps.createLoopCommandHook();

      // Task session manager
      const taskSessionManagerHook = deps.createTaskSessionManagerHook(ctx, {
        maxSessionsPerAgent:
          config.backgroundJobs?.maxSessionsPerAgent ?? deps.DEFAULT_MAX_SESSIONS_PER_AGENT,
        readContextMinLines:
          config.backgroundJobs?.readContextMinLines ?? deps.DEFAULT_READ_CONTEXT_MIN_LINES,
        readContextMaxFiles:
          config.backgroundJobs?.readContextMaxFiles ?? deps.DEFAULT_READ_CONTEXT_MAX_FILES,
        backgroundJobBoard: backgroundJobCoordinator,
        shouldManageSession: (sessionID) => sessionAgentMap.get(sessionID) === 'orchestrator',
        registerSessionAsOrchestrator: (sessionID) => {
          sessionAgentMap.set(sessionID, 'orchestrator');
        },
        isFallbackInProgress: (sessionID) => foregroundFallback.isFallbackInProgress(sessionID),
        coordinator: sessionLifecycle,
      });

      // Phase reminder
      const phaseReminder = deps.createPhaseReminderHook({
        shouldInject: (sessionID: string) => sessionAgentMap.get(sessionID) === 'orchestrator',
      });

      // Filter available skills
      const filterAvailableSkills = deps.createFilterAvailableSkillsHook(ctx, config);

      // Post file tool nudge
      const postFileToolNudge = deps.createPostFileToolNudgeHook({
        shouldInject: (sessionID: string) => sessionAgentMap.get(sessionID) === 'orchestrator',
        coordinator: sessionLifecycle,
      });

      // Delegate task retry
      const delegateTaskRetry = deps.createDelegateTaskRetryHook(ctx);

      // Apply patch
      const applyPatch = deps.createApplyPatchHook(ctx);

      // JSON error recovery
      const jsonErrorRecovery = deps.createJsonErrorRecoveryHook(ctx);

      // Interview manager
      const interviewManager = deps.createInterviewManager(ctx, config);

      // Preset manager
      const presetManager = deps.createPresetManager(ctx, config);

      // Companion manager
      const companionManager = new deps.CompanionManager(
        `proc_${process.pid}`,
        ctx.directory,
        config.companion,
      );

      // Cancel task tools
      const cancelTaskTools = deps.createCancelTaskTool({
        client: ctx.client,
        backgroundJobBoard: backgroundJobCoordinator,
        shouldManageSession: (sessionID) => sessionAgentMap.get(sessionID) === 'orchestrator',
      });

      // ACP run tools
      const acpRunTools = Object.keys(config.acpAgents ?? {}).length > 0
        ? { acp_run: deps.createAcpRunTool(config.acpAgents) }
        : {};

      // Webfetch
      const webfetch = deps.createWebfetchTool(ctx);

      // Tools
      const toolComposer = new ToolComposer(deps);
      const tools = toolComposer.compose(config, ctx, backgroundJobCoordinator, sessionAgentMap);

      // Rewrite display name mentions
      const rewriteDisplayNameMentions = deps.createDisplayNameMentionRewriter(config);

      // Register all hooks
      const hookComposer = new HookComposer(deps);
      hookComposer.compose(
        config,
        ctx,
        agentDefs,
        disabledAgents,
        sessionAgentMap,
        sessionDirectories,
        sessionLifecycle,
        backgroundJobCoordinator,
        multiplexerSessionManager,
        foregroundFallback,
        interviewManager,
        presetManager,
        taskSessionManagerHook,
        postFileToolNudge,
        delegateTaskRetry,
        jsonErrorRecovery,
        phaseReminder,
        filterAvailableSkills,
        applyPatch,
        autoUpdateChecker,
        cacheMonitor,
        chatHeadersHook,
        companionManager,
        rewriteDisplayNameMentions,
      );

      // Config hook
      const configComposer = new ConfigComposer(deps);
      const configHook = configComposer.compose(
        config,
        agents,
        agentDefs,
        modelArrayMap,
        runtimeChains,
        everModelSwitched,
        foregroundFallback,
        sessionAgentMap,
        ctx,
      );

      // Event hook
      const eventComposer = new EventComposer(deps);
      const eventHook = eventComposer.compose(
        config,
        ctx,
        sessionAgentMap,
        sessionDirectories,
        sessionLifecycle,
        multiplexerSessionManager,
        foregroundFallback,
        autoUpdateChecker,
        interviewManager,
        companionManager,
        cacheMonitor,
        rewriteDisplayNameMentions,
        disabledAgents,
        deps.resolveImageRouting(config.image_routing),
        modelArrayMap,
        agentDefs,
      );

      // Message transform hook
      const messageTransformComposer = new MessageTransformComposer(deps);
      const messageTransformHook = messageTransformComposer.compose(
        config,
        ctx,
        sessionAgentMap,
        sessionDirectories,
        taskSessionManagerHook,
        postFileToolNudge,
        phaseReminder,
        filterAvailableSkills,
        rewriteDisplayNameMentions,
        disabledAgents,
        deps.resolveImageRouting(config.image_routing),
        agentDefs,
      );

      // System transform hook
      const systemTransformComposer = new SystemTransformComposer(deps);
      const systemTransformHook = systemTransformComposer.compose(
        agentDefs,
        sessionAgentMap,
        disabledAgents,
        deps.buildOrchestratorPrompt,
      );

      // Create MCPs
      const mcps = deps.createBuiltinMcps(config.disabled_mcps, config.websearch);

      // Health check
      const agentCount = Object.keys(agents).length;
      const mcpCount = Object.keys(mcps).length;
      const mcpThreshold = config.disabled_mcps && config.disabled_mcps.length > 0 ? 0 : deps.HEALTH_CHECK.minMcps;

      if (
        agentCount < deps.HEALTH_CHECK.minAgents ||
        Object.keys(tools).length < deps.HEALTH_CHECK.minTools ||
        mcpCount < mcpThreshold
      ) {
        const msg = [
          'Health check: registrations suspiciously low.',
          `  agents: ${agentCount} (expected >=${deps.HEALTH_CHECK.minAgents})`,
          `  tools:  ${Object.keys(tools).length} (expected >=${deps.HEALTH_CHECK.minTools})`,
          `  mcps:   ${mcpCount} (expected >=${mcpThreshold})`,
          'This usually means a dependency failed to resolve (jsdom, etc).',
          'If you recently updated opencode, see:',
          '  github.com/alvinunreal/oh-my-opencode-slim/issues/310',
        ].join('\n');
        deps.log(`[plugin] WARN: ${msg}`);
        await deps.appLog(ctx, 'warn', msg);
      } else {
        deps.log('[plugin] health check passed', {
          agents: agentCount,
          tools: Object.keys(tools).length,
          mcps: mcpCount,
        });
      }

      // Probe jsdom (async, non-blocking)
      deps.probeJSDOM().then((err) => {
        if (err) {
          const msg = `jsdom probe failed; webfetch tool will not work: ${err}`;
          deps.log(`[plugin] WARN: ${msg}`);
          deps.appLog(ctx, 'warn', msg).catch(() => {});
        }
      });

      // Companion startup update
      if (config.companion?.enabled === true) {
        try {
          const companionResult = await deps.ensureCompanionVersion({
            config: config.companion,
            downloadTimeoutMs: 3_000,
            lockTimeoutMs: 500,
          });
          if (companionResult.status === 'installed') {
            deps.log('[companion] updated before startup', companionResult.version);
          } else if (companionResult.status === 'failed') {
            deps.log('[companion] startup update failed', companionResult.error);
          }
        } catch (err) {
          deps.log('[companion] startup update failed', String(err));
        }
      }

      companionManager.onLoad();

      // Return plugin exports
      return {
        name: 'oh-my-opencode-slim',
        agent: agents,
        tool: tools,
        mcp: mcps,
        config: configHook,
        event: eventHook,
        'tool.execute.before': async (input, output) => {
          await deps.hookRegistry.dispatch('applyPatch.before', input, output);
          await deps.hookRegistry.dispatch('taskSessionManager.before', input, output);
        },
        'command.execute.before': async (input, output) => {
          await deps.hookRegistry.dispatch('command.before', input, output);
        },
        'chat.headers': chatHeadersHook['chat.headers'],
        'chat.message': async (input, output) => {
          // Handle chat.message logic
          const rawAgent = input.agent ?? output?.message?.agent;
          const agent = rawAgent
            ? deps.resolveRuntimeAgentName(config, rawAgent)
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
          taskSessionManagerHook.observeChatMessage(input, output);
        },
        'experimental.chat.system.transform': systemTransformHook,
        'experimental.chat.messages.transform': messageTransformHook,
        'tool.execute.after': async (input, output) => {
          await deps.hookRegistry.dispatch('tool.after', input, output);
        },
      };
    },
  };
}

// Helper for chat.message
function shouldInjectOrchestratorReminder(sessionID: string, sessionAgentMap: Map<string, string>) {
  return sessionAgentMap.get(sessionID) === 'orchestrator';
}

// Internal: Tool Registry
interface ToolRegistry {
  tools: Record<string, ToolDefinition>;
  register(name: string, tool: ToolDefinition): void;
  getAll(): Record<string, ToolDefinition>;
  applyDisabledTools(disabled: string[]): void;
}

function createToolRegistry(): ToolRegistry {
  const tools: Record<string, ToolDefinition> = {};
  return {
    tools,
    register(name: string, tool: ToolDefinition) { tools[name] = tool; },
    getAll() { return { ...tools }; },
    applyDisabledTools(disabled: string[]) {
      const disabledSet = new Set(disabled);
      for (const name of Object.keys(tools)) {
        if (disabledSet.has(name)) delete tools[name];
      }
    },
  };
}

// Internal: Agent Composer
class AgentComposer {
  constructor(private deps: ComposerDependencies) {}

  compose(config: PluginConfig, projectDirectory: string) {
    const disabledAgents = this.deps.getDisabledAgents(config);
    const agentDefs = this.deps.agentDefsGetter(config, { projectDirectory });
    const agents = this.deps.getAgentConfigs(config, { projectDirectory });
    return { disabledAgents, agentDefs, agents };
  }
}

// Internal: Hook Composer - registers all hooks with explicit priorities
class HookComposer {
  constructor(private deps: ComposerDependencies) {}

  compose(
    config: PluginConfig,
    ctx: Parameters<Plugin>[0],
    agentDefs: AgentDefinition[],
    disabledAgents: Set<string>,
    sessionAgentMap: Map<string, string>,
    sessionDirectories: Map<string, string>,
    sessionLifecycle: InstanceType<typeof import('./hooks').SessionLifecycle>,
    backgroundJobCoordinator: InstanceType<typeof import('./utils').BackgroundJobCoordinator>,
    multiplexerSessionManager: InstanceType<typeof import('./multiplexer').MultiplexerSessionManager>,
    foregroundFallback: InstanceType<typeof import('./hooks').ForegroundFallbackManager>,
    interviewManager: ReturnType<typeof import('./interview').createInterviewManager>,
    presetManager: ReturnType<typeof import('./tools/preset-manager').createPresetManager>,
    taskSessionManagerHook: ReturnType<typeof import('./hooks').createTaskSessionManagerHook>,
    postFileToolNudge: ReturnType<typeof import('./hooks').createPostFileToolNudgeHook>,
    delegateTaskRetry: ReturnType<typeof import('./hooks').createDelegateTaskRetryHook>,
    jsonErrorRecovery: ReturnType<typeof import('./hooks').createJsonErrorRecoveryHook>,
    phaseReminder: ReturnType<typeof import('./hooks').createPhaseReminderHook>,
    filterAvailableSkills: ReturnType<typeof import('./hooks').createFilterAvailableSkillsHook>,
    applyPatch: ReturnType<typeof import('./hooks').createApplyPatchHook>,
    autoUpdateChecker: ReturnType<typeof import('./hooks').createAutoUpdateCheckerHook>,
    cacheMonitor: ReturnType<typeof import('./hooks').createCacheMonitorHook>,
    chatHeadersHook: ReturnType<typeof import('./hooks').createChatHeadersHook>,
    companionManager: InstanceType<typeof import('./companion/manager').CompanionManager>,
    rewriteDisplayNameMentions: ReturnType<typeof import('./utils').createDisplayNameMentionRewriter>,
  ) {
    const registry = this.deps.hookRegistry;

    // Helper for error-isolated post-tool hooks
    const wrapPostToolHook = (
      name: string,
      fn: (i: unknown, o: unknown) => Promise<void>,
    ): ((i: unknown, o: unknown) => Promise<void>) => {
      return async (i, o) => {
        try {
          await fn(i, o);
        } catch (error) {
          const meta = i as { tool?: string; sessionID?: string; callID?: string };
          this.deps.log('[plugin] post-tool hook failed open', {
            hook: name,
            tool: meta.tool,
            sessionID: meta.sessionID,
            callID: meta.callID,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
    };

    const shouldInjectOrchestratorReminder = (sessionID: string) =>
      sessionAgentMap.get(sessionID) === 'orchestrator';

    // Register hooks in priority order (lower = earlier)
    // applyPatch.before - priority 10
    registry.register('applyPatch.before', ((input: unknown, output: unknown) => applyPatch['tool.execute.before'](input as never, output as never)) as (input: unknown, output: unknown) => Promise<void>, 10);

    // taskSessionManager.before - priority 20
    registry.register('taskSessionManager.before', ((input: unknown, output: unknown) => taskSessionManagerHook['tool.execute.before'](input as never, output as never)) as (input: unknown, output: unknown) => Promise<void>, 20);

    // chat.headers - priority 30
    registry.register('chat.headers', chatHeadersHook['chat.headers'] as unknown as (input: unknown, output: unknown) => Promise<void>, 30);

    // chat.message - priority 40 (handled in main compose return)
    registry.register('chat.message', async () => {}, 40);

    // system.transform - priority 50 (handled in experimental.chat.system.transform)
    registry.register('system.transform', async () => {}, 50);

    // messages.transform - priority 60 (handled in experimental.chat.messages.transform)
    registry.register('messages.transform', async () => {}, 60);

    // taskSessionManager.transform - priority 70
    registry.register('messages.transform', ((input: unknown, output: unknown) => taskSessionManagerHook['experimental.chat.messages.transform'](input as never, output as never)) as (input: unknown, output: unknown) => Promise<void>, 70);

    // postFileToolNudge.transform - priority 80
    registry.register('messages.transform', ((input: unknown, output: unknown) => postFileToolNudge['experimental.chat.messages.transform'](input as never, output as never)) as (input: unknown, output: unknown) => Promise<void>, 80);

    // phaseReminder.transform - priority 90
    registry.register('messages.transform', ((input: unknown, output: unknown) => phaseReminder['experimental.chat.messages.transform'](input as never, output as never)) as (input: unknown, output: unknown) => Promise<void>, 90);

    // filterAvailableSkills.transform - priority 100
    registry.register('messages.transform', ((input: unknown, output: unknown) => filterAvailableSkills['experimental.chat.messages.transform'](input as never, output as never)) as (input: unknown, output: unknown) => Promise<void>, 100);

    // injectBackgroundJobBoard - priority 110
    registry.register('messages.transform', async (input, output) => {
      await taskSessionManagerHook.injectBackgroundJobBoard(input as never, output as never);
    }, 110);

    // tool.after hooks - priorities 120-150
    const postFileToolNudgeAfter = wrapPostToolHook('post-file-tool-nudge', (i, o) =>
      postFileToolNudge['tool.execute.after'](i as never, o as never),
    );
    registry.register('tool.after', postFileToolNudgeAfter, 120);

    const delegateTaskRetryAfter = wrapPostToolHook('delegate-task-retry', (i, o) =>
      delegateTaskRetry['tool.execute.after'](i as never, o as never),
    );
    registry.register('tool.after', delegateTaskRetryAfter, 130);

    const jsonErrorRecoveryAfter = wrapPostToolHook('json-error-recovery', (i, o) =>
      jsonErrorRecovery['tool.execute.after'](i as never, o as never),
    );
    registry.register('tool.after', jsonErrorRecoveryAfter, 140);

    const taskSessionManagerAfter = wrapPostToolHook('task-session-manager', (i, o) =>
      taskSessionManagerHook['tool.execute.after'](i as never, o as never),
    );
    registry.register('tool.after', taskSessionManagerAfter, 150);

    // command.before hooks - priorities 160-200
    registry.register('command.before', async (input, output) => {
      await interviewManager.handleCommandExecuteBefore(input as never, output as never);
    }, 160);

    registry.register('command.before', async (input, output) => {
      await presetManager.handleCommandExecuteBefore(input as never, output as never);
    }, 170);

    registry.register('command.before', async (input, output) => {
      await this.deps.createDeepworkCommandHook().handleCommandExecuteBefore(input as never, output as never);
    }, 180);

    registry.register('command.before', async (input, output) => {
      await this.deps.createReflectCommandHook().handleCommandExecuteBefore(input as never, output as never);
    }, 190);

    registry.register('command.before', async (input, output) => {
      await this.deps.createLoopCommandHook().handleCommandExecuteBefore(input as never, output as never);
    }, 200);
  }
}

// Internal: Tool Composer
class ToolComposer {
  constructor(private deps: ComposerDependencies) {}

  compose(config: PluginConfig, ctx: Parameters<Plugin>[0], backgroundJobCoordinator: InstanceType<typeof import('./utils').BackgroundJobCoordinator>, sessionAgentMap: Map<string, string>) {
    const registry = createToolRegistry();

    const cancelTaskTools = this.deps.createCancelTaskTool({
      client: ctx.client,
      backgroundJobBoard: backgroundJobCoordinator,
      shouldManageSession: (sessionID) => sessionAgentMap.get(sessionID) === 'orchestrator',
    });
    Object.entries(cancelTaskTools).forEach(([name, tool]) => { registry.register(name, tool); });

    const acpRunTools = Object.keys(config.acpAgents ?? {}).length > 0
      ? { acp_run: this.deps.createAcpRunTool(config.acpAgents) }
      : {};
    Object.entries(acpRunTools).forEach(([name, tool]) => { registry.register(name, tool); });

    const webfetch = this.deps.createWebfetchTool(ctx);
    registry.register('webfetch', webfetch);

    registry.register('ast_grep_search', this.deps.astGrepSearch);
    registry.register('ast_grep_replace', this.deps.astGrepReplace);

    if (config.disabled_tools && config.disabled_tools.length > 0) {
      registry.applyDisabledTools(config.disabled_tools);
    }

    return registry.getAll();
  }
}

// Internal: Multiplexer Composer
class MultiplexerComposer {
  constructor(private deps: ComposerDependencies) {}

  compose(config: PluginConfig) {
    const multiplexerConfig: MultiplexerConfig = {
      type: config.multiplexer?.type ?? 'none',
      layout: config.multiplexer?.layout ?? 'main-vertical',
      main_pane_size: config.multiplexer?.main_pane_size ?? 60,
      zellij_pane_mode: config.multiplexer?.zellij_pane_mode ?? 'agent-tab',
    };

    const multiplexer = this.deps.getMultiplexer(multiplexerConfig);
    const multiplexerEnabled =
      multiplexerConfig.type !== 'none' && multiplexer !== null && multiplexer.isInsideSession();

    let multiplexerSessionManager: InstanceType<typeof import('./multiplexer').MultiplexerSessionManager> | null = null;
    if (multiplexerEnabled) {
      this.deps.startAvailabilityCheck(multiplexerConfig);
    }

    return { multiplexerConfig, multiplexerEnabled, multiplexer };
  }
}

// Internal: Config Composer - handles the config() hook logic
class ConfigComposer {
  constructor(private deps: ComposerDependencies) {}

  compose(
    config: PluginConfig,
    agents: Record<string, unknown>,
    agentDefs: AgentDefinition[],
    modelArrayMap: Record<string, Array<{ id: string; variant?: string }>>,
    runtimeChains: Record<string, string[]>,
    everModelSwitched: Set<string>,
    foregroundFallback: InstanceType<typeof import('./hooks').ForegroundFallbackManager>,
    sessionAgentMap: Map<string, string>,
    ctx: Parameters<Plugin>[0],
  ) {
    return async (opencodeConfig: Record<string, unknown>) => {
      // Placeholder - will be implemented in Task 3
    };
  }
}

// Internal: Event Composer - handles the event() hook logic
class EventComposer {
  constructor(private deps: ComposerDependencies) {}

  compose(
    config: PluginConfig,
    ctx: Parameters<Plugin>[0],
    sessionAgentMap: Map<string, string>,
    sessionDirectories: Map<string, string>,
    sessionLifecycle: InstanceType<typeof import('./hooks').SessionLifecycle>,
    multiplexerSessionManager: InstanceType<typeof import('./multiplexer').MultiplexerSessionManager> | null,
    foregroundFallback: InstanceType<typeof import('./hooks').ForegroundFallbackManager>,
    autoUpdateChecker: ReturnType<typeof import('./hooks').createAutoUpdateCheckerHook>,
    interviewManager: ReturnType<typeof import('./interview').createInterviewManager>,
    companionManager: InstanceType<typeof import('./companion/manager').CompanionManager>,
    cacheMonitor: ReturnType<typeof import('./hooks').createCacheMonitorHook>,
    rewriteDisplayNameMentions: ReturnType<typeof import('./utils').createDisplayNameMentionRewriter>,
    disabledAgents: Set<string>,
    resolveImageRouting: ReturnType<typeof import('./config/constants').resolveImageRouting>,
    modelArrayMap: Record<string, Array<{ id: string; variant?: string }>>,
    agentDefs: AgentDefinition[],
  ) {
    return async (input: { event: { type: string; properties?: Record<string, unknown> } }) => {
      // Placeholder - will be implemented in Task 3
    };
  }
}

// Internal: Message Transform Composer - handles experimental.chat.messages.transform
class MessageTransformComposer {
  constructor(private deps: ComposerDependencies) {}

  compose(
    config: PluginConfig,
    ctx: Parameters<Plugin>[0],
    sessionAgentMap: Map<string, string>,
    sessionDirectories: Map<string, string>,
    taskSessionManagerHook: ReturnType<typeof import('./hooks').createTaskSessionManagerHook>,
    postFileToolNudge: ReturnType<typeof import('./hooks').createPostFileToolNudgeHook>,
    phaseReminder: ReturnType<typeof import('./hooks').createPhaseReminderHook>,
    filterAvailableSkills: ReturnType<typeof import('./hooks').createFilterAvailableSkillsHook>,
    rewriteDisplayNameMentions: ReturnType<typeof import('./utils').createDisplayNameMentionRewriter>,
    disabledAgents: Set<string>,
    resolveImageRouting: ReturnType<typeof import('./config/constants').resolveImageRouting>,
    agentDefs: AgentDefinition[],
  ) {
    return async (input: Record<string, never>, output: { messages: unknown[] }) => {
      // Placeholder - will be implemented in Task 3
    };
  }
}

// Internal: System Transform Composer - handles experimental.chat.system.transform
class SystemTransformComposer {
  constructor(private deps: ComposerDependencies) {}

  compose(
    agentDefs: AgentDefinition[],
    sessionAgentMap: Map<string, string>,
    disabledAgents: Set<string>,
    buildOrchestratorPrompt: typeof import('./agents/orchestrator').buildOrchestratorPrompt,
  ) {
    return async (input: { sessionID?: string }, output: { system: string[] }) => {
      // Placeholder - will be implemented in Task 3
    };
  }
}