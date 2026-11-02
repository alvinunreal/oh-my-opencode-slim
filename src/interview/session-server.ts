import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { InterviewConfig } from '../config';
import type { InterviewSessionRuntime } from './runtime';
import { createInterviewServer, createInterviewServerDeps } from './server';
import { createInterviewService } from './service';

export function createPerSessionInterviewServer(
  ctx: PluginInput,
  interviewConfig: InterviewConfig | undefined,
  outputFolder: string,
  runtime?: InterviewSessionRuntime,
): {
  service: ReturnType<typeof createInterviewService>;
  registerCommand: (
    config: Record<string, unknown>,
    enabled?: { interview?: boolean; implement?: boolean },
  ) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
  dispose: () => void;
} {
  const service = createInterviewService(
    ctx,
    interviewConfig,
    runtime ? { runtime } : undefined,
  );
  const resolvedOutputPath = path.join(ctx.directory, outputFolder);
  const server = createInterviewServer(
    createInterviewServerDeps(service, resolvedOutputPath, 0),
  );
  service.setBaseUrlResolver(() => server.ensureStarted());
  let disposed = false;

  return {
    service,
    registerCommand: (c, enabled) => service.registerCommand(c, enabled),
    handleCommandExecuteBefore: async (input, output) =>
      service.handleCommandExecuteBefore(input, output),
    handleEvent: async (input) => service.handleEvent(input),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      server.close();
    },
  };
}
