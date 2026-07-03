import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginConfig } from '../config';
import { DEFAULT_DASHBOARD_PORT } from './dashboard';
import { createDashboardManager } from './dashboard-manager';
import { createPerSessionInterviewServer } from './session-server';

export function createInterviewManager(
  ctx: PluginInput,
  config: PluginConfig,
): {
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
} {
  const interviewConfig = config.interview;
  const effectivePort = interviewConfig?.port ?? 0;
  const dashboardEnabled =
    interviewConfig?.dashboard === true || effectivePort > 0;
  const outputFolder = interviewConfig?.outputFolder ?? 'interview';

  // ─── Per-session mode (upstream behavior) ───────────────────────
  if (!dashboardEnabled) {
    return createPerSessionInterviewServer(ctx, interviewConfig, outputFolder);
  }

  // ─── Dashboard mode ─────────────────────────────────────────────
  const dashboardPort =
    effectivePort > 0 ? effectivePort : DEFAULT_DASHBOARD_PORT;

  return createDashboardManager(ctx, config, dashboardPort, outputFolder);
}
