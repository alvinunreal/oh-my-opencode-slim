import type { Plugin } from '@opencode-ai/plugin';
import { createAgents, getAgentConfigs, getDisabledAgents } from './agents';
import { buildOrchestratorPrompt } from './agents/orchestrator';
import { loadPluginConfig, type MultiplexerConfig } from './config';
import { parseList } from './config/agent-mcps';
import { CouncilManager } from './council';
import {
  createApplyPatchHook,
  createAutoUpdateCheckerHook,
  createChatHeadersHook,
  createDelegateTaskRetryHook,
  createFilterAvailableSkillsHook,
  createJsonErrorRecoveryHook,
  createPhaseReminderHook,
  createPostFileToolNudgeHook,
  createTodoContinuationHook,
  ForegroundFallbackManager,
} from './hooks';
import { processImageAttachments } from './hooks/image-hook';
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
  createCouncilTool,
  createWebfetchTool,
  lsp_diagnostics,
  lsp_find_references,
  lsp_goto_definition,
  lsp_rename,
  setUserLspConfig,
} from './tools';
import { resolveRuntimeAgentName, rewriteDisplayNameMentions } from './utils';
import { initLogger, log } from './utils/logger';
import { SubagentDepthTracker } from './utils/subagent-depth';

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
  minTools: 5,
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

const OhMyOpenCodeLite: Plugin = async (ctx) => {
  const sessionId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  initLogger(sessionId);

  // Declare variables that must survive the try/catch for the return
  // closure. These are set inside the try block.
  let config: ReturnType<typeof loadPluginConfig>;
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
  let phaseReminderHook: ReturnType<typeof createPhaseReminderHook>;
  let filterAvailableSkillsHook: ReturnType<
    typeof createFilterAvailableSkillsHook
  >;
  let sessionAgentMap: Map<string, string>;
  let postFileToolNudgeHook: ReturnType<typeof createPostFileToolNudgeHook>;
  let chatHeadersHook: ReturnType<typeof createChatHeadersHook>;
  let delegateTaskRetryHook: ReturnType<typeof createDelegateTaskRetryHook>;
  let applyPatchHook: ReturnType<typeof createApplyPatchHook>;
  let jsonErrorRecoveryHook: ReturnType<typeof createJsonErrorRecoveryHook>;
  let foregroundFallback: ForegroundFallbackManager;
  let todoContinuationHook: ReturnType<typeof createTodoContinuationHook>;
  let interviewManager: ReturnType<typeof createInterviewManager>;
  let councilTools: Record<string, unknown>;
  let webfetch: ReturnType<typeof createWebfetchTool>;

  // Counters for post-init health check (set inside try, checked outside)
  let toolCount = 0;

  try {
    config = loadPluginConfig(ctx.directory);
    agentDefs = createAgents(config);
    agents = getAgentConfigs(config);

    // Build a map of agent name → priority model array for runtime
    // fallback. Populated when the user configures model as an array in
    // their plugin config.
    modelArrayMap = {} as Record<
      string,
      Array<{ id: string; variant?: string }>
    >;
    for (const agentDef of agentDefs) {
      if (agentDef._modelArray && agentDef._modelArray.length > 0) {
        modelArrayMap[agentDef.name] = agentDef._modelArray;
      }
    }
    // Build runtime fallback chains for all foreground agents. Each chain
    // is an ordered list of model strings to try when the current model is
    // rate-limited. Seeds from _modelArray entries (when the user
    // configures model as an array), then appends fallback.chains entries.
    runtimeChains = {} as Record<string, string[]>;
    for (const agentDef of agentDefs) {
      if (agentDef._modelArray?.length) {
        runtimeChains[agentDef.name] = agentDef._modelArray.map((m) => m.id);
      }
    }
    if (config.fallback?.enabled !== false) {
      const chains =
        (config.fallback?.chains as Record<string, string[] | undefined>) ?? {};
      for (const [agentName, chainModels] of Object.entries(chains)) {
        if (!chainModels?.length) continue;
        const existing = runtimeChains[agentName] ?? [];
        const seen = new Set(existing);
        for (const m of chainModels) {
          if (!seen.has(m)) {
            seen.add(m);
            existing.push(m);
          }
        }
        runtimeChains[agentName] = existing;
      }
    }

    // Parse multiplexer config with defaults
    multiplexerConfig = {
      type: config.multiplexer?.type ?? 'none',
      layout: config.multiplexer?.layout ?? 'main-vertical',
      main_pane_size: config.multiplexer?.main_pane_size ?? 60,
    };

    // Get multiplexer instance for capability checks
    const multiplexer = getMultiplexer(multiplexerConfig);
    multiplexerEnabled =
      multiplexerConfig.type !== 'none' && multiplexer !== null;

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
    webfetch = createWebfetchTool(ctx);

    // Initialize MultiplexerSessionManager to handle OpenCode's built-in
    // Task tool sessions
    multiplexerSessionManager = new MultiplexerSessionManager(
      ctx,
      multiplexerConfig,
    );

    // Initialize auto-update checker hook
    autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
      showStartupToast: config.showStartupToast ?? true,
      autoUpdate: true,
    });

    // Initialize phase reminder hook for workflow compliance
    phaseReminderHook = createPhaseReminderHook();

    // Initialize available skills filter hook
    filterAvailableSkillsHook = createFilterAvailableSkillsHook(ctx, config);

    // Track session → agent mapping for serve-mode system prompt injection
    sessionAgentMap = new Map<string, string>();

    // Initialize post-file-tool nudge hook
    postFileToolNudgeHook = createPostFileToolNudgeHook({
      shouldInject: (sessionID) =>
        sessionAgentMap.get(sessionID) === 'orchestrator',
    });

    chatHeadersHook = createChatHeadersHook(ctx);

    // Initialize delegate-task retry guidance hook
    delegateTaskRetryHook = createDelegateTaskRetryHook(ctx);

    applyPatchHook = createApplyPatchHook(ctx);
    // Initialize JSON parse error recovery hook
    jsonErrorRecoveryHook = createJsonErrorRecoveryHook(ctx);

    // Initialize foreground fallback manager for runtime model switching
    foregroundFallback = new ForegroundFallbackManager(
      ctx.client,
      runtimeChains,
      config.fallback?.enabled !== false &&
        Object.keys(runtimeChains).length > 0,
    );

    // Initialize todo-continuation hook (opt-in auto-continue for
    // incomplete todos)
    todoContinuationHook = createTodoContinuationHook(ctx, {
      maxContinuations: config.todoContinuation?.maxContinuations ?? 5,
      cooldownMs: config.todoContinuation?.cooldownMs ?? 3000,
      autoEnable: config.todoContinuation?.autoEnable ?? false,
      autoEnableThreshold: config.todoContinuation?.autoEnableThreshold ?? 4,
    });
    interviewManager = createInterviewManager(ctx, config);

    toolCount =
      Object.keys(councilTools).length +
      Object.keys(todoContinuationHook.tool).length +
      1 + // webfetch
      4 + // lsp_goto_definition, lsp_find_references, lsp_diagnostics, lsp_rename
      2; // ast_grep_search, ast_grep_replace
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

  return {
    name: 'oh-my-opencode-slim',

    agent: agents,

    tool: {
      ...councilTools,
      webfetch,
      ...todoContinuationHook.tool,
      lsp_goto_definition,
      lsp_find_references,
      lsp_diagnostics,
      lsp_rename,
      ast_grep_search,
      ast_grep_replace,
    },

    mcp: mcps,

    config: async (opencodeConfig: Record<string, unknown>) => {
      // Set user's lsp config from opencode.json for LSP tools
      const lspConfig = opencodeConfig.lsp as
        | Record<string, unknown>
        | undefined;
      setUserLspConfig(lspConfig);

      // Only set default_agent if not already configured by the user
      // and the plugin config doesn't explicitly disable this behavior
      if (
        config.setDefaultAgent !== false &&
        !(opencodeConfig as { default_agent?: string }).default_agent
      ) {
        (opencodeConfig as { default_agent?: string }).default_agent =
          'orchestrator';
      }

      // Merge Agent configs — per-agent shallow merge to preserve
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

      // Model resolution for foreground agents: combine _modelArray
      // entries with fallback.chains config, then pick the first model in
      // the effective array for startup-time selection.
      //
      // Runtime failover on API errors (e.g. rate limits
      // mid-conversation) is handled separately by
      // ForegroundFallbackManager via the event hook.
      const fallbackChainsEnabled = config.fallback?.enabled !== false;
      const fallbackChains = fallbackChainsEnabled
        ? ((config.fallback?.chains as Record<string, string[] | undefined>) ??
          {})
        : {};

      // Build effective model arrays: seed from _modelArray, then append
      // fallback.chains entries so the resolver considers the full chain
      // when picking the best available provider at startup.
      const effectiveArrays: Record<
        string,
        Array<{ id: string; variant?: string }>
      > = {};

      for (const [agentName, models] of Object.entries(modelArrayMap)) {
        effectiveArrays[agentName] = [...models];
      }

      for (const [agentName, chainModels] of Object.entries(fallbackChains)) {
        if (!chainModels || chainModels.length === 0) continue;

        if (!effectiveArrays[agentName]) {
          // Agent has no _modelArray — seed from its current string model
          // so the fallback chain appends after it rather than replacing
          // it.
          const entry = configAgent[agentName] as
            | Record<string, unknown>
            | undefined;
          const currentModel =
            typeof entry?.model === 'string' ? entry.model : undefined;
          effectiveArrays[agentName] = currentModel
            ? [{ id: currentModel }]
            : [];
        }

        const seen = new Set(effectiveArrays[agentName].map((m) => m.id));
        for (const chainModel of chainModels) {
          if (!seen.has(chainModel)) {
            seen.add(chainModel);
            effectiveArrays[agentName].push({ id: chainModel });
          }
        }
      }

      if (Object.keys(effectiveArrays).length > 0) {
        for (const [agentName, modelArray] of Object.entries(effectiveArrays)) {
          if (modelArray.length === 0) continue;

          // Use the first model in the effective array. Not all providers
          // require entries in opencodeConfig.provider — some are loaded
          // automatically by opencode (e.g. github-copilot, openrouter).
          // We cannot distinguish these from truly unconfigured providers
          // at config-hook time, so we cannot gate on the provider config
          // keys. Runtime failover is handled separately by
          // ForegroundFallbackManager.
          const chosen = modelArray[0];
          const entry = configAgent[agentName] as
            | Record<string, unknown>
            | undefined;
          if (entry) {
            entry.model = chosen.id;
            if (chosen.variant) {
              entry.variant = chosen.variant;
            }
          } else {
            // Agent exists in slim but not in opencodeConfig.agent —
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

      // Register /auto-continue command so OpenCode recognizes it.
      // Actual handling is done by command.execute.before hook below
      // (no LLM round-trip — injected directly into output.parts).
      const configCommand = opencodeConfig.command as
        | Record<string, unknown>
        | undefined;
      if (!configCommand?.['auto-continue']) {
        if (!opencodeConfig.command) {
          opencodeConfig.command = {};
        }
        (opencodeConfig.command as Record<string, unknown>)['auto-continue'] = {
          template: 'Call the auto_continue tool with enabled=true',
          description:
            'Enable auto-continuation — orchestrator keeps working through incomplete todos',
        };
      }

      interviewManager.registerCommand(opencodeConfig);
    },

    event: async (input) => {
      // Runtime model fallback for foreground agents (rate-limit detection)
      await foregroundFallback.handleEvent(input.event);

      // Todo-continuation: auto-continue orchestrator on incomplete todos
      await todoContinuationHook.handleEvent(input);

      // Handle auto-update checking
      await autoUpdateChecker.event(input);

      // Handle multiplexer pane spawning for OpenCode's Task tool sessions
      await multiplexerSessionManager.onSessionCreated(
        input.event as {
          type: string;
          properties?: {
            info?: { id?: string; parentID?: string; title?: string };
          };
        },
      );

      // Handle session.status events for pane cleanup
      await multiplexerSessionManager.onSessionStatus(
        input.event as {
          type: string;
          properties?: { sessionID?: string; status?: { type: string } };
        },
      );

      // Handle session.deleted events for pane cleanup
      await multiplexerSessionManager.onSessionDeleted(
        input.event as {
          type: string;
          properties?: { sessionID?: string };
        },
      );

      await interviewManager.handleEvent(
        input as {
          event: { type: string; properties?: Record<string, unknown> };
        },
      );

      await postFileToolNudgeHook.event(
        input as {
          event: {
            type: string;
            properties?: {
              info?: { id?: string };
              sessionID?: string;
            };
          };
        },
      );

      if (input.event.type === 'session.deleted') {
        const props = input.event.properties as
          | { info?: { id?: string }; sessionID?: string }
          | undefined;
        const sessionID = props?.info?.id ?? props?.sessionID;
        if (sessionID) {
          sessionAgentMap.delete(sessionID);
        }
      }
    },

    // Best-effort rescue only for stale apply_patch input before native
    // execution
    'tool.execute.before': async (input, output) => {
      await applyPatchHook['tool.execute.before'](
        input as {
          tool: string;
          directory?: string;
        },
        output as {
          args?: { patchText?: unknown; [key: string]: unknown };
        },
      );
    },

    // Direct interception of /auto-continue command — bypasses LLM
    // round-trip
    'command.execute.before': async (input, output) => {
      await todoContinuationHook.handleCommandExecuteBefore(
        input as {
          command: string;
          sessionID: string;
          arguments: string;
        },
        output as { parts: Array<{ type: string; text?: string }> },
      );

      await interviewManager.handleCommandExecuteBefore(
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
      }
      todoContinuationHook.handleChatMessage({
        sessionID: input.sessionID,
        agent,
      });
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
              : buildOrchestratorPrompt(getDisabledAgents(config));
          output.system[0] =
            orchestratorPrompt +
            (output.system[0] ? `\n\n${output.system[0]}` : '');
        }
      }

      await todoContinuationHook.handleChatSystemTransform(input, output);
      await postFileToolNudgeHook['experimental.chat.system.transform'](
        input,
        output,
      );

      // Collapse to single system message for provider compatibility.
      // Some providers (e.g. Qwen3.5 via DashScope) reject multiple
      // system messages. Sub-hooks above may push additional entries; join
      // them back into one element so OpenCode emits a single system
      // message.
      const joined = output.system.join('\n\n');
      output.system = joined ? [joined] : [];
    },

    // Inject phase reminder and filter available skills before sending to
    // API (doesn't show in UI)
    'experimental.chat.messages.transform': async (
      input: Record<string, never>,
      output: { messages: unknown[] },
    ): Promise<void> => {
      // Type assertion since we know the structure matches
      // MessageWithParts[]
      const typedOutput = output as {
        messages: Array<{
          info: { role: string; agent?: string; sessionID?: string };
          parts: Array<{
            type: string;
            text?: string;
            [key: string]: unknown;
          }>;
        }>;
      };

      for (const message of typedOutput.messages) {
        if (message.info.role !== 'user') {
          continue;
        }
        for (const part of message.parts) {
          if (part.type !== 'text' || typeof part.text !== 'string') {
            continue;
          }
          part.text = rewriteDisplayNameMentions(config, part.text);
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
        disabledAgents: getDisabledAgents(config),
        log,
      });

      await todoContinuationHook.handleMessagesTransform({
        messages: typedOutput.messages,
      });
      await phaseReminderHook['experimental.chat.messages.transform'](
        input,
        typedOutput,
      );
      await filterAvailableSkillsHook['experimental.chat.messages.transform'](
        input,
        typedOutput,
      );
    },

    // Post-tool hooks: retry guidance for delegation errors + file-tool
    // nudge
    'tool.execute.after': async (input, output) => {
      await delegateTaskRetryHook['tool.execute.after'](
        input as { tool: string },
        output as { output: unknown },
      );

      await jsonErrorRecoveryHook['tool.execute.after'](
        input as {
          tool: string;
          sessionID: string;
          callID: string;
        },
        output as {
          title: string;
          output: unknown;
          metadata: unknown;
        },
      );

      await todoContinuationHook.handleToolExecuteAfter(
        input as {
          tool: string;
          sessionID?: string;
        },
      );

      await postFileToolNudgeHook['tool.execute.after'](
        input as {
          tool: string;
          sessionID?: string;
          callID?: string;
        },
        output as {
          title: string;
          output: string;
          metadata: Record<string, unknown>;
        },
      );
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
