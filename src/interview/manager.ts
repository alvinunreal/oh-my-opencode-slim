import type { Server } from 'node:http';
import type { PluginInput } from '@opencode-ai/plugin';
import type { InterviewConfig, PluginConfig } from '../config';
import { DEFAULT_DASHBOARD_PORT } from './dashboard';
import { createDashboardManager } from './dashboard-manager';
import { createPerSessionInterviewServer } from './session-server';

/**
 * Pure interview mode computation shared by the v1 manager and the v2
 * interview bridge: dashboard enablement (`dashboard === true` or an
 * explicit port), the resolved output folder, and the dashboard port
 * (explicit port when set, else the default).
 */
export function computeInterviewMode(config: InterviewConfig | undefined): {
  dashboardEnabled: boolean;
  outputFolder: string;
  dashboardPort: number;
} {
  const effectivePort = config?.port ?? 0;
  return {
    dashboardEnabled: config?.dashboard === true || effectivePort > 0,
    outputFolder: config?.outputFolder ?? 'interview',
    dashboardPort: effectivePort > 0 ? effectivePort : DEFAULT_DASHBOARD_PORT,
  };
}

export function createInterviewManager(
  ctx: PluginInput,
  config: PluginConfig,
  options: {
    /** Already-listening server for the dashboard role to adopt. */
    server?: Server;
  } = {},
): {
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
  dispose: () => Promise<void> | void;
} {
  const interviewConfig = config.interview;
  const { dashboardEnabled, outputFolder, dashboardPort } =
    computeInterviewMode(interviewConfig);

  // ─── Per-session mode (upstream behavior) ───────────────────────
  if (!dashboardEnabled) {
    return createPerSessionInterviewServer(ctx, interviewConfig, outputFolder);
  }

  // ─── Dashboard mode ─────────────────────────────────────────────
  return createDashboardManager(
    ctx,
    config,
    dashboardPort,
    outputFolder,
    options,
  );
}
