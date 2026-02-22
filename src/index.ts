import type { Plugin } from '@opencode-ai/plugin';
import { getAgentConfigsWithModelConfig } from './agents';
import { TmuxSessionManager } from './background';
import { loadPluginConfig, type TmuxConfig } from './config';
import { parseList } from './config/agent-mcps';
import { createPacketTools, PacketTaskManager } from './delegates';
import { createAirlockHook, createAutoUpdateCheckerHook } from './hooks';
import { createBuiltinMcps } from './mcp';
import { setConfigDirectory } from './token-discipline';
import {
  ast_grep_replace,
  ast_grep_search,
  grep,
  lsp_diagnostics,
  lsp_find_references,
  lsp_goto_definition,
  lsp_rename,
} from './tools';
import { startTmuxCheck } from './utils';
import { log } from './utils/logger';

const OhMyOpenCodeLite: Plugin = async (ctx) => {
  // Initialize token-discipline config directory so omoslim.json is found
  setConfigDirectory(ctx.directory);

  const config = loadPluginConfig(ctx.directory);

  // Load model assignments from omoslim.json and build agent configs.
  // Priority: PluginConfig.agents[name].model > omoslim.json > DEFAULT_MODELS
  const agents = await getAgentConfigsWithModelConfig(config);

  const tmuxConfig: TmuxConfig = {
    enabled: config.tmux?.enabled ?? false,
    layout: config.tmux?.layout ?? 'main-vertical',
    main_pane_size: config.tmux?.main_pane_size ?? 60,
  };

  log('[plugin] initialized', { directory: ctx.directory, tmuxConfig });

  if (tmuxConfig.enabled) {
    startTmuxCheck();
  }

  // Packet-based delegation — the only task system
  const packetManager = new PacketTaskManager(ctx, tmuxConfig, config);
  const packetTools = createPacketTools(packetManager);

  const mcps = createBuiltinMcps(config.disabled_mcps);

  // TmuxSessionManager handles pane lifecycle for OpenCode Task tool sessions
  const tmuxSessionManager = new TmuxSessionManager(ctx, tmuxConfig);

  // Auto-update checker: runs once on first session.created
  const autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
    showStartupToast: true,
    autoUpdate: true,
  });

  // Airlock hook: caps all tool outputs before they enter agent context
  const airlockHook = createAirlockHook();

  return {
    name: 'oh-my-opencode-slim',

    agent: agents,

    tool: {
      ...packetTools,
      lsp_goto_definition,
      lsp_find_references,
      lsp_diagnostics,
      lsp_rename,
      grep,
      ast_grep_search,
      ast_grep_replace,
    },

    mcp: mcps,

    config: async (opencodeConfig: Record<string, unknown>) => {
      (opencodeConfig as { default_agent?: string }).default_agent =
        'orchestrator';

      // Merge agent configs
      if (!opencodeConfig.agent) {
        opencodeConfig.agent = { ...agents };
      } else {
        Object.assign(opencodeConfig.agent, agents);
      }
      const configAgent = opencodeConfig.agent as Record<string, unknown>;

      // Merge MCP configs
      const configMcp = opencodeConfig.mcp as
        | Record<string, unknown>
        | undefined;
      if (!configMcp) {
        opencodeConfig.mcp = { ...mcps };
      } else {
        Object.assign(configMcp, mcps);
      }

      // Apply per-agent MCP permission rules (allow/deny per server)
      const allMcpNames = Object.keys(mcps);
      for (const [agentName, agentConfig] of Object.entries(agents)) {
        const agentMcps = (agentConfig as { mcps?: string[] })?.mcps;
        if (!agentMcps) continue;

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

        const allowedMcps = parseList(agentMcps, allMcpNames);

        for (const mcpName of allMcpNames) {
          const sanitizedMcpName = mcpName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const permissionKey = `${sanitizedMcpName}_*`;
          const action = allowedMcps.includes(mcpName) ? 'allow' : 'deny';
          if (!(permissionKey in agentPermission)) {
            agentPermission[permissionKey] = action;
          }
        }

        agentConfigEntry.permission = agentPermission;
      }
    },

    event: async (input) => {
      await autoUpdateChecker.event(input);

      await tmuxSessionManager.onSessionCreated(
        input.event as {
          type: string;
          properties?: {
            info?: { id?: string; parentID?: string; title?: string };
          };
        },
      );

      // Completion detection and pane cleanup on session.status (idle)
      await packetManager.handleSessionStatus(
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

      // Task and pane cleanup on session.deleted
      await packetManager.handleSessionDeleted(
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

    // Cap all tool outputs before they enter agent context (airlock)
    'tool.execute.after': async (input: unknown, output: unknown) => {
      await airlockHook['tool.execute.after'](
        input as { tool: string; sessionID?: string; callID?: string },
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
  PacketV1,
  PluginConfig,
  TmuxConfig,
  TmuxLayout,
  TokenDisciplineConfig,
  TokenDisciplineSettings,
} from './config';
export type {
  LaunchOptions as PacketLaunchOptions,
  PacketTask,
} from './delegates';
export type { RemoteMcpConfig } from './mcp';
