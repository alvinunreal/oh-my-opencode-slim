import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginConfig } from '../config';
import { createInterviewServer } from './server';
import { createInterviewService } from './service';

/**
 * Interview Manager - Composition root wiring the lean service ↔ server flow.
 *
 * Architecture:
 * - Service: in-memory interview runtime + markdown document updates
 * - Server: localhost UI + JSON API
 * - Manager: small adapter exposing plugin hooks
 *
 * Dependency injection pattern:
 * - Server depends on service.getState and service.submitAnswers
 * - Service depends on server.ensureStarted (via setBaseUrlResolver)
 * - Circular dependency resolved by lazy resolution
 *
 * Plugin integration:
 * - registerCommand: injects /interview into OpenCode config
 * - handleCommandExecuteBefore: intercepts /interview execution
 * - handleEvent: listens to session.status and session.deleted events
 */
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
  const service = createInterviewService(ctx, config.interview);
  const server = createInterviewServer({
    getState: async (interviewId) => service.getInterviewState(interviewId),
    submitAnswers: async (interviewId, answers) =>
      service.submitAnswers(interviewId, answers),
  });

  // Inject server URL resolver into service (lazy: server starts on first request)
  service.setBaseUrlResolver(() => server.ensureStarted());

  return {
    registerCommand: (config) => service.registerCommand(config),
    handleCommandExecuteBefore: async (input, output) =>
      service.handleCommandExecuteBefore(input, output),
    handleEvent: async (input) => service.handleEvent(input),
  };
}
