import type { Plugin } from '@opencode-ai/plugin';
import { createAgents, getAgentConfigs } from './agents';
import { BackgroundTaskManager, MultiplexerSessionManager } from './background';
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
import { createInterviewManager } from './interview';
import { createBuiltinMcps } from './mcp';
import { getMultiplexer, startAvailabilityCheck } from './multiplexer';
import {
  ast_grep_replace,
  ast_grep_search,
  createBackgroundTools,
  createCouncilTool,
  createWebfetchTool,
  lsp_diagnostics,
  lsp_find_references,
  lsp_goto_definition,
  lsp_rename,
  setUserLspConfig,
} from './tools';
import { log } from './utils/logger';

const OhMyOpenCodeLite: Plugin = async (ctx) => {
  const config = loadPluginConfig(ctx.directory);
  const agentDefs = createAgents(config);
  const agents = getAgentConfigs(config);

  // Build a map of agent name → priority model array for runtime fallback.
  // Populated when the user configures model as an array in their plugin config.
  const modelArrayMap: Record<
    string,
    Array<{ id: string; variant?: string }>
  > = {};
  for (const agentDef of agentDefs) {
    if (agentDef._modelArray && agentDef._modelArray.length > 0) {
      modelArrayMap[agentDef.name] = agentDef._modelArray;
    }
  }
  // Build runtime fallback chains for all foreground agents.
  // Each chain is an ordered list of model strings to try when the current
  // model is rate-limited. Seeds from _modelArray entries (when the user
  // configures model as an array), then appends fallback.chains entries.
  const runtimeChains: Record<string, string[]> = {};
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
  const multiplexerConfig: MultiplexerConfig = {
    type: config.multiplexer?.type ?? 'none',
    layout: config.multiplexer?.layout ?? 'main-vertical',
    main_pane_size: config.multiplexer?.main_pane_size ?? 60,
  };

  // Get multiplexer instance for capability checks
  const multiplexer = getMultiplexer(multiplexerConfig);
  const multiplexerEnabled =
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

  const backgroundManager = new BackgroundTaskManager(
    ctx,
    multiplexerConfig,
    config,
  );
  const backgroundTools = createBackgroundTools(
    ctx,
    backgroundManager,
    multiplexerConfig,
    config,
  );

  // Initialize council tools (only when council is configured)
  const councilTools = config.council
    ? createCouncilTool(
        ctx,
        new CouncilManager(
          ctx,
          config,
          backgroundManager.getDepthTracker(),
          multiplexerEnabled,
        ),
      )
    : {};

  const mcps = createBuiltinMcps(config.disabled_mcps, config.websearch);
  const webfetch = createWebfetchTool(ctx);

  // Initialize MultiplexerSessionManager to handle OpenCode's built-in Task tool sessions
  const multiplexerSessionManager = new MultiplexerSessionManager(
    ctx,
    multiplexerConfig,
  );

  // Initialize auto-update checker hook
  const autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
    showStartupToast: true,
    autoUpdate: true,
  });

  // Initialize phase reminder hook for workflow compliance
  const phaseReminderHook = createPhaseReminderHook();

  // Initialize available skills filter hook
  const filterAvailableSkillsHook = createFilterAvailableSkillsHook(
    ctx,
    config,
  );

  // Track session → agent mapping for serve-mode system prompt injection
  const sessionAgentMap = new Map<string, string>();

  // Initialize post-file-tool nudge hook
  const postFileToolNudgeHook = createPostFileToolNudgeHook({
    shouldInject: (sessionID) =>
      sessionAgentMap.get(sessionID) === 'orchestrator',
  });

  const chatHeadersHook = createChatHeadersHook(ctx);

  // Initialize delegate-task retry guidance hook
  const delegateTaskRetryHook = createDelegateTaskRetryHook(ctx);

  const applyPatchHook = createApplyPatchHook(ctx);
  // Initialize JSON parse error recovery hook
  const jsonErrorRecoveryHook = createJsonErrorRecoveryHook(ctx);

  // Initialize foreground fallback manager for runtime model switching
  const foregroundFallback = new ForegroundFallbackManager(
    ctx.client,
    runtimeChains,
    config.fallback?.enabled !== false && Object.keys(runtimeChains).length > 0,
  );

  // Initialize todo-continuation hook (opt-in auto-continue for incomplete todos)
  const todoContinuationHook = createTodoContinuationHook(ctx, {
    maxContinuations: config.todoContinuation?.maxContinuations ?? 5,
    cooldownMs: config.todoContinuation?.cooldownMs ?? 3000,
    autoEnable: config.todoContinuation?.autoEnable ?? false,
    autoEnableThreshold: config.todoContinuation?.autoEnableThreshold ?? 4,
  });
  const interviewManager = createInterviewManager(ctx, config);

  return {
    name: 'oh-my-opencode-slim',

    agent: agents,

    tool: {
      ...backgroundTools,
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

      // Model resolution for foreground agents: combine _modelArray entries
      // with fallback.chains config, then pick the first model in the
      // effective array for startup-time selection.
      //
      // Runtime failover on API errors (e.g. rate limits mid-conversation)
      // is handled separately by ForegroundFallbackManager via the event hook.
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
          // Agent has no _modelArray — seed from its current string model so
          // the fallback chain appends after it rather than replacing it.
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

          // Use the first model in the effective array.
          // Not all providers require entries in opencodeConfig.provider —
          // some are loaded automatically by opencode (e.g. github-copilot,
          // openrouter). We cannot distinguish these from truly unconfigured
          // providers at config-hook time, so we cannot gate on the provider
          // config keys. Runtime failover is handled separately by
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

      // Handle session.status events for:
      // 1. BackgroundTaskManager: completion detection
      // 2. MultiplexerSessionManager: pane cleanup
      await backgroundManager.handleSessionStatus(
        input.event as {
          type: string;
          properties?: { sessionID?: string; status?: { type: string } };
        },
      );
      await multiplexerSessionManager.onSessionStatus(
        input.event as {
          type: string;
          properties?: { sessionID?: string; status?: { type: string } };
        },
      );

      // Handle session.deleted events for:
      // 1. BackgroundTaskManager: task cleanup
      // 2. MultiplexerSessionManager: pane cleanup
      await backgroundManager.handleSessionDeleted(
        input.event as {
          type: string;
          properties?: { info?: { id?: string }; sessionID?: string };
        },
      );
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
        const sessionID =
          props?.info?.id ?? props?.sessionID;
        if (sessionID) {
          sessionAgentMap.delete(sessionID);
        }
      }
    },

    // Best-effort rescue only for stale apply_patch input before native execution
    'tool.execute.before': async (input, output) => {
      await applyPatchHook['tool.execute.before'](
        input as {
          tool: string;
          directory?: string;
        },
        output as { args?: { patchText?: unknown; [key: string]: unknown } },
      );
    },

    // Direct interception of /auto-continue command — bypasses LLM round-trip
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

    // Track which agent each session uses (needed for serve-mode prompt injection)
    'chat.message': async (
      input: { sessionID: string; agent?: string },
      output?: { message?: { agent?: string } },
    ) => {
      const agent = input.agent ?? output?.message?.agent;
      if (agent) {
        sessionAgentMap.set(input.sessionID, agent);
      }
      todoContinuationHook.handleChatMessage({
        sessionID: input.sessionID,
        agent,
      });
    },

    // Inject orchestrator system prompt for serve-mode sessions.
    // In serve mode, the agent's prompt field may be absent from the agents registry
    // (built before plugin config hooks run). This hook injects it at LLM call time.
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
          // Prepend the orchestrator prompt to the system array
          const { ORCHESTRATOR_PROMPT } = await import('./agents/orchestrator');
          output.system[0] =
            ORCHESTRATOR_PROMPT +
            (output.system[0] ? `\n\n${output.system[0]}` : '');
        }
      }

      await todoContinuationHook.handleChatSystemTransform(input, output);
      await postFileToolNudgeHook['experimental.chat.system.transform'](
        input,
        output,
      );
    },

    // Inject phase reminder and filter available skills before sending to API (doesn't show in UI)
    'experimental.chat.messages.transform': async (
      input: Record<string, never>,
      output: { messages: unknown[] },
    ): Promise<void> => {
      // Type assertion since we know the structure matches MessageWithParts[]
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

    // Post-tool hooks: retry guidance for delegation errors + file-tool nudge
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
