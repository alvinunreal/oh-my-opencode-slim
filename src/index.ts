import type { Plugin } from "@opencode-ai/plugin";
import { getAgentConfigs } from "./agents";
import { BackgroundTaskManager, TmuxSessionManager } from "./features";
import {
  createBackgroundTools,
  lsp_goto_definition,
  lsp_find_references,
  lsp_diagnostics,
  lsp_rename,
  grep,
  ast_grep_search,
  ast_grep_replace,
  antigravity_quota,
  createSkillTools,
  SkillMcpManager,
} from "./tools";
import { loadPluginConfig, type TmuxConfig } from "./config";
import { createBuiltinMcps } from "./mcp";
import { createAutoUpdateCheckerHook } from "./hooks";
import { startTmuxCheck } from "./utils";
import { log } from "./shared/logger";

const OhMyOpenCodeLite: Plugin = async (ctx) => {
  const config = loadPluginConfig(ctx.directory);
  const agents = getAgentConfigs(config);

  // Parse tmux config with defaults
  const tmuxConfig: TmuxConfig = {
    enabled: config.tmux?.enabled ?? false,
    layout: config.tmux?.layout ?? "main-vertical",
    main_pane_size: config.tmux?.main_pane_size ?? 60,
  };

  log("[plugin] initialized with tmux config", { 
    tmuxConfig, 
    rawTmuxConfig: config.tmux,
    directory: ctx.directory 
  });

  // Start background tmux check if enabled
  if (tmuxConfig.enabled) {
    startTmuxCheck();
  }

  const backgroundManager = new BackgroundTaskManager(ctx, tmuxConfig, config);
  const backgroundTools = createBackgroundTools(ctx, backgroundManager, tmuxConfig, config);
  const mcps = createBuiltinMcps(config.disabled_mcps);
  const skillMcpManager = SkillMcpManager.getInstance();
  const skillTools = createSkillTools(skillMcpManager);

  // Initialize TmuxSessionManager to handle OpenCode's built-in Task tool sessions
  const tmuxSessionManager = new TmuxSessionManager(ctx, tmuxConfig);

  // Initialize auto-update checker hook
  const autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
    showStartupToast: true,
    autoUpdate: true,
  });

  return {
    name: "oh-my-opencode-slim",

    agent: agents,

    tool: {
      ...backgroundTools,
      lsp_goto_definition,
      lsp_find_references,
      lsp_diagnostics,
      lsp_rename,
      grep,
      ast_grep_search,
      ast_grep_replace,
      antigravity_quota,
      ...skillTools,
    },

    mcp: mcps,

    config: async (opencodeConfig: Record<string, unknown>) => {
      (opencodeConfig as { default_agent?: string }).default_agent = "orchestrator";

      const configAgent = opencodeConfig.agent as Record<string, unknown> | undefined;
      if (!configAgent) {
        opencodeConfig.agent = { ...agents };
      } else {
        Object.assign(configAgent, agents);
      }

      // Merge MCP configs
      const configMcp = opencodeConfig.mcp as Record<string, unknown> | undefined;
      if (!configMcp) {
        opencodeConfig.mcp = { ...mcps };
      } else {
        Object.assign(configMcp, mcps);
      }
    },

    event: async (input) => {
      // Handle auto-update checking
      await autoUpdateChecker.event(input);
      
      // Handle tmux pane spawning for OpenCode's Task tool sessions
      await tmuxSessionManager.onSessionCreated(input.event as {
        type: string;
        properties?: { info?: { id?: string; parentID?: string; title?: string } };
      });
    },
  };
};

export default OhMyOpenCodeLite;

export type { PluginConfig, AgentOverrideConfig, AgentName, McpName, TmuxConfig, TmuxLayout } from "./config";
export type { RemoteMcpConfig } from "./mcp";
