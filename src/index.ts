import type { Plugin } from '@opencode-ai/plugin';
import { createAgents, getAgentConfigs } from './agents';
import { BackgroundTaskManager, TmuxSessionManager } from './background';
import { loadPluginConfig, type TmuxConfig } from './config';
import { parseList } from './config/agent-mcps';
import {
  createAutoUpdateCheckerHook,
  createChatHeadersHook,
  createDelegateTaskRetryHook,
  createJsonErrorRecoveryHook,
  createPhaseReminderHook,
  createPostReadNudgeHook,
  ForegroundFallbackManager,
} from './hooks';
import { createBuiltinMcps } from './mcp';
import {
  ast_grep_replace,
  ast_grep_search,
  createBackgroundTools,
  lsp_diagnostics,
  lsp_find_references,
  lsp_goto_definition,
  lsp_rename,
  setUserLspConfig,
} from './tools';
import { startTmuxCheck } from './utils';
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

  // Parse tmux config with defaults
  const tmuxConfig: TmuxConfig = {
    enabled: config.tmux?.enabled ?? false,
    layout: config.tmux?.layout ?? 'main-vertical',
    main_pane_size: config.tmux?.main_pane_size ?? 60,
  };

  log('[plugin] initialized with tmux config', {
    tmuxConfig,
    rawTmuxConfig: config.tmux,
    directory: ctx.directory,
  });

  // Start background tmux check if enabled
  if (tmuxConfig.enabled) {
    startTmuxCheck();
  }

  const backgroundManager = new BackgroundTaskManager(ctx, tmuxConfig, config);
  const backgroundTools = createBackgroundTools(
    ctx,
    backgroundManager,
    tmuxConfig,
    config,
  );
  const mcps = createBuiltinMcps(config.disabled_mcps);

  // Initialize TmuxSessionManager to handle OpenCode's built-in Task tool sessions
  const tmuxSessionManager = new TmuxSessionManager(ctx, tmuxConfig);

  // Initialize auto-update checker hook
  const autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
    showStartupToast: true,
    autoUpdate: true,
  });

  // Initialize phase reminder hook for workflow compliance
  const phaseReminderHook = createPhaseReminderHook();

  // Initialize post-read nudge hook
  const postReadNudgeHook = createPostReadNudgeHook();

  const chatHeadersHook = createChatHeadersHook(ctx);

  // Initialize delegate-task retry guidance hook
  const delegateTaskRetryHook = createDelegateTaskRetryHook(ctx);

  // Initialize JSON parse error recovery hook
  const jsonErrorRecoveryHook = createJsonErrorRecoveryHook(ctx);

  // Initialize foreground fallback manager for runtime model switching
  const foregroundFallback = new ForegroundFallbackManager(
    ctx.client,
    runtimeChains,
    config.fallback?.enabled !== false && Object.keys(runtimeChains).length > 0,
  );

  return {
    name: 'oh-my-opencode-slim',

    agent: agents,

    tool: {
      ...backgroundTools,
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

      // Model resolution for foreground agents: pick the best available model
      // by combining _modelArray entries with fallback.chains config.
      //
      // NOTE: We cannot call ctx.client.provider.list() here because
      // the HTTP server is still initializing (causes deadlock).
      // Instead, inspect opencodeConfig.provider directly.
      //
      // NOTE: This is startup-time selection only — it picks the best
      // available provider at plugin init. Runtime failover on API errors
      // (e.g. rate limits mid-conversation) is handled separately by
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

      // Get all MCP names from our config
      const allMcpNames = Object.keys(mcps);

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
    },

    event: async (input) => {
      // Runtime model fallback for foreground agents (rate-limit detection)
      await foregroundFallback.handleEvent(input.event);

      // Handle auto-update checking
      await autoUpdateChecker.event(input);

      // Handle tmux pane spawning for OpenCode's Task tool sessions
      await tmuxSessionManager.onSessionCreated(
        input.event as {
          type: string;
          properties?: {
            info?: { id?: string; parentID?: string; title?: string };
          };
        },
      );

      // Handle session.status events for:
      // 1. BackgroundTaskManager: completion detection
      // 2. TmuxSessionManager: pane cleanup
      await backgroundManager.handleSessionStatus(
        input.event as {
          type: string;
          properties?: { sessionID?: string; status?: { type: string } };
        },
      );
      await tmuxSessionManager.onSessionStatus(
        input.event as {
          type: string;
          properties?: { sessionID?: string; status?: { type: string } };
        },
      );

      // Handle session.deleted events for:
      // 1. BackgroundTaskManager: task cleanup
      // 2. TmuxSessionManager: pane cleanup
      await backgroundManager.handleSessionDeleted(
        input.event as {
          type: string;
          properties?: { info?: { id?: string }; sessionID?: string };
        },
      );
      await tmuxSessionManager.onSessionDeleted(
        input.event as {
          type: string;
          properties?: { sessionID?: string };
        },
      );
    },

    'chat.headers': chatHeadersHook['chat.headers'],

    // Inject phase reminder before sending to API (doesn't show in UI)
    'experimental.chat.messages.transform':
      phaseReminderHook['experimental.chat.messages.transform'],

    // Post-tool hooks: retry guidance for delegation errors + post-read nudge
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

      await postReadNudgeHook['tool.execute.after'](
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
  PluginConfig,
  TmuxConfig,
  TmuxLayout,
} from './config';
export type { RemoteMcpConfig } from './mcp';
