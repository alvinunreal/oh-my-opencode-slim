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
import { createAutoUpdateCheckerHook, createPhaseReminderHook, createPostReadNudgeHook } from "./hooks";
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
  const skillTools = createSkillTools(skillMcpManager, config);

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
      
      const event = input.event as {
        type: string;
        properties?: { 
          sessionID?: string;
          info?: { id?: string; parentID?: string; title?: string } 
        }
      };

      // Handle tmux pane spawning and cleanup for child sessions
      await tmuxSessionManager.onSessionEvent(event);

      // Global Subagent Reaper: Cleanup any child session that becomes idle
      // This ensures history isn't polluted by finished sub-tasks
      if (event.type === "session.idle" && event.properties?.sessionID) {
        const sessionID = event.properties.sessionID;
        
        // Wait a bit to ensure the parent tool has time to read the result
        setTimeout(async () => {
          try {
            const sessionResult = await ctx.client.session.get({ path: { id: sessionID } });
            if (sessionResult.data?.parentID) {
              const parentID = sessionResult.data.parentID;
              log(`[reaper] child session idle, cleaning up`, { 
                sessionID, 
                parentID,
                serverUrl: ctx.serverUrl.toString()
              });
              
              // 1. Attempt deletion via all known SDK styles and raw API
              try {
                const client = ctx.client.session as any;
                if (typeof client.delete === "function") {
                  // Try v1 style
                  await client.delete({ path: { id: sessionID } }).catch(() => {});
                  // Try v2 style
                  await client.delete({ sessionID }).catch(() => {});
                  log(`[reaper] deletion calls sent via SDK`, { sessionID });
                }
                
                // Always try raw fetch as a backup
                const url = new URL(`/session/${sessionID}`, ctx.serverUrl);
                const response = await fetch(url.toString(), {
                  method: "DELETE",
                  headers: { 
                    "x-opencode-directory": ctx.directory,
                    "Content-Type": "application/json" 
                  },
                });
                
                if (response.ok) {
                  log(`[reaper] successfully deleted session via API`, { sessionID });
                  
                  // 2. Notify TUI of completion with a toast
                  await ctx.client.tui.showToast({
                    body: {
                      message: `Subagent session ${sessionID.slice(-4)} cleared`,
                      variant: "info"
                    }
                  }).catch(() => {});

                  // 3. Force TUI to refresh its session view/navigation by re-selecting parent
                  await (ctx.client.tui as any).selectSession({ body: { sessionID: parentID } }).catch(() => {});
                } else {
                  log(`[reaper] API deletion failed`, { sessionID, status: response.status });
                }
              } catch (err) {
                log(`[reaper] deletion logic error`, { sessionID, error: String(err) });
              }
            }
          } catch (err) {
            // Session might already be gone
          }
        }, 2000); 
      }
    },

    // Inject phase reminder before sending to API (doesn't show in UI)
    "experimental.chat.messages.transform": phaseReminderHook["experimental.chat.messages.transform"],

    // Nudge after file reads to encourage delegation
    "tool.execute.after": postReadNudgeHook["tool.execute.after"],
  };
};

export default OhMyOpenCodeLite;

export type { PluginConfig, AgentOverrideConfig, AgentName, McpName, TmuxConfig, TmuxLayout } from "./config";
export type { RemoteMcpConfig } from "./mcp";
