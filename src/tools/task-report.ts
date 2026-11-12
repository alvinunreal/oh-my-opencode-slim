import { randomUUID } from 'node:crypto';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { isRecord } from '../utils/guards';
import { createInternalAgentTextPart } from '../utils/internal-initiator';
import { getClient } from '../utils/opencode-client';
import { withAgent } from '../utils/prompt-agent';

const z = tool.schema;
const MAX_REPORT_LENGTH = 2000;

type SessionInfo = {
  id?: string;
  parentID?: string;
  agent: string;
  outcome?: string;
};

function unwrapSessionInfo(response: unknown, label: string): SessionInfo {
  if (!isRecord(response)) throw new Error(`Could not read ${label} session`);
  if (response.error !== undefined && response.error !== null) {
    throw new Error(`Could not read ${label} session`);
  }
  const value = isRecord(response.data) ? response.data : response;
  if (typeof value.id !== 'string' || typeof value.agent !== 'string') {
    throw new Error(`Could not verify ${label} session identity`);
  }
  return value as SessionInfo;
}

function assertPromptAccepted(response: unknown): void {
  if (!isRecord(response)) return;
  if (response.error !== undefined && response.error !== null) {
    throw new Error('The parent session did not accept the report');
  }
  const result = isRecord(response.data) ? response.data : response;
  const status = isRecord(result.response) ? result.response.status : undefined;
  if (
    isRecord(result.response) &&
    typeof result.response.ok === 'boolean' &&
    result.response.ok === false
  ) {
    throw new Error(
      `The parent session did not accept the report${typeof status === 'number' ? ` (HTTP ${status})` : ''}`,
    );
  }
}

export function createTaskReportTool(options: {
  input: PluginInput;
  hasInputWait?: (sessionID: string) => boolean;
  isDisposed?: () => boolean;
}): Record<'task_report', ToolDefinition> {
  const task_report = tool({
    description:
      'Send a bounded progress update or blocker to this running subagent’s owning parent. Use for material milestones, consequential findings, blockers, or decisions the parent must make. The host queues it without starting an overlapping parent turn; the result confirms queue acceptance, not that the parent has processed it.',
    args: {
      kind: z
        .enum(['progress', 'escalation'])
        .describe(
          'Use progress for a material update; escalation for a blocker or decision.',
        ),
      message: z
        .string()
        .trim()
        .min(1)
        .max(MAX_REPORT_LENGTH)
        .describe(
          `Update for the parent (max ${MAX_REPORT_LENGTH} characters)`,
        ),
    },
    async execute(args, toolContext) {
      if (options.isDisposed?.()) throw new Error('Plugin is disposing');
      const childSessionID = toolContext?.sessionID;
      if (!childSessionID) {
        throw new Error('task_report requires a subagent session');
      }

      const client = getClient(options.input);
      const childResponse = await client.session.get({
        path: { id: childSessionID },
        query: { directory: options.input.directory },
        throwOnError: true,
      });
      const child = unwrapSessionInfo(childResponse, 'subagent');
      if (child.id !== childSessionID) {
        throw new Error('Could not verify the calling subagent session');
      }
      if (!child.parentID) {
        throw new Error('task_report is only available in a child session');
      }
      if (options.isDisposed?.()) throw new Error('Plugin is disposing');

      const parentResponse = await client.session.get({
        path: { id: child.parentID },
        query: { directory: options.input.directory },
        throwOnError: true,
      });
      const parent = unwrapSessionInfo(parentResponse, 'parent');
      if (parent.id !== child.parentID) {
        throw new Error('Could not verify the owning parent session');
      }
      if (options.isDisposed?.()) throw new Error('Plugin is disposing');

      // A pending user/question wait or an interrupted parent must remain
      // dormant. Store the update in the host inbox without resuming it; the
      // next real user action can consume it.
      const dormant =
        parent.outcome === 'interrupted' ||
        options.hasInputWait?.(parent.id) === true;
      const updateID = randomUUID();
      const message = [
        `<subagent-update id="${updateID}" kind="${args.kind}">`,
        `From @${child.agent ?? 'subagent'} (session ${child.id}):`,
        args.message.trim(),
        '</subagent-update>',
      ].join('\n');
      const body = withAgent(
        {
          parts: [createInternalAgentTextPart(message)],
        },
        parent.agent,
      );
      const promptAsync = client.session.promptAsync as unknown as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const response = await promptAsync({
        path: { id: parent.id },
        query: { directory: options.input.directory },
        // Keep the report in the same FIFO steer lane as the host's native
        // completion notice. A paused parent receives it only after a real
        // user action because resume stays false.
        delivery: 'steer',
        resume: !dormant,
        body,
      });
      assertPromptAccepted(response);

      return dormant
        ? `Update ${updateID} queued for the parent without waking it. The host accepted the update; processing is not confirmed.`
        : `Update ${updateID} queued for the parent. The host accepted the update; processing is not confirmed.`;
    },
  });

  return { task_report };
}
