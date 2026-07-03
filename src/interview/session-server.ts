import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { InterviewConfig } from '../config';
import { createInterviewServer } from './server';
import { createInterviewService } from './service';

export function createPerSessionInterviewServer(
  ctx: PluginInput,
  interviewConfig: InterviewConfig | undefined,
  outputFolder: string,
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
  const service = createInterviewService(ctx, interviewConfig);
  const resolvedOutputPath = path.join(ctx.directory, outputFolder);
  const server = createInterviewServer({
    getState: async (interviewId) => service.getInterviewState(interviewId),
    listInterviewFiles: async () => service.listInterviewFiles(),
    listInterviews: () => service.listInterviews(),
    submitAnswers: async (interviewId, answers) =>
      service.submitAnswers(interviewId, answers),
    submitBlockComment: async (interviewId, section, comment) =>
      service.submitBlockComment(interviewId, section, comment),
    submitChat: async (interviewId, message) =>
      service.submitChat(interviewId, message),
    handleNudgeAction: async (interviewId, action) =>
      service.handleNudgeAction(interviewId, action),
    outputFolder: resolvedOutputPath,
    port: 0,
  });
  service.setBaseUrlResolver(() => server.ensureStarted());
  return {
    registerCommand: (c) => service.registerCommand(c),
    handleCommandExecuteBefore: async (input, output) =>
      service.handleCommandExecuteBefore(input, output),
    handleEvent: async (input) => service.handleEvent(input),
  };
}
