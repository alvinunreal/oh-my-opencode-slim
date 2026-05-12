/**
 * Tool definitions for subtask functionality.
 *
 * Factory functions that create tool definitions with injected dependencies:
 * - createSubtaskTool: Create a new session with subtask prompt
 * - createReadSessionTool: Read conversation transcript from a session
 */

import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { extractSessionResult, promptWithTimeout } from '../../utils/session';
import type { SubagentDepthTracker } from '../../utils/subagent-depth';
import {
  buildSyntheticFileParts,
  cleanFileReference,
  parseFileReferences,
} from './files';
import type { SubtaskState } from './state';

export type OpencodeClient = PluginInput['client'];
const SUBTASK_TIMEOUT_MS = 5 * 60 * 1000;
const SUBTASK_SUMMARY_TAG_REGEX = /<\/?subtask_summary>/g;

function normalizeSubtaskSummary(text: string): string {
  return text.replace(SUBTASK_SUMMARY_TAG_REGEX, '').trim();
}

function getAbortSignal(context: unknown): AbortSignal | undefined {
  if (!context || typeof context !== 'object' || !('abort' in context)) {
    return undefined;
  }

  const signal = (context as { abort?: unknown }).abort;
  return signal &&
    typeof signal === 'object' &&
    'addEventListener' in signal &&
    'removeEventListener' in signal &&
    'aborted' in signal
    ? (signal as AbortSignal)
    : undefined;
}

/**
 * Create the subtask tool.
 *
 * Takes the OpenCode client as a dependency for TUI and session operations.
 */
export function createSubtaskTool(
  ctx: PluginInput,
  state: SubtaskState,
  depthTracker?: SubagentDepthTracker,
): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Run a child worker session and return its completion summary to the caller',
    args: {
      prompt: tool.schema.string().describe('The generated subtask prompt'),
      files: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Array of file paths to load into the new session's context"),
    },
    async execute(args, context) {
      const directory =
        context &&
        typeof context === 'object' &&
        'directory' in context &&
        typeof (context as { directory?: unknown }).directory === 'string'
          ? (context as { directory: string }).directory
          : ctx.directory;
      const sessionID =
        context && typeof context === 'object' && 'sessionID' in context
          ? (context as { sessionID: string }).sessionID
          : 'unknown';
      const abortSignal = getAbortSignal(context);
      if (state.isSubtaskSession(sessionID)) {
        return 'Nested subtask is disabled: this session is already a subtask worker. Finish this worker and return its summary to the parent session instead.';
      }
      if (
        sessionID !== 'unknown' &&
        depthTracker &&
        depthTracker.getDepth(sessionID) + 1 > depthTracker.maxDepth
      ) {
        return `Subtask worker blocked: max subagent depth ${depthTracker.maxDepth} would be exceeded.`;
      }

      const sessionReference = `You are a subtask worker spawned by parent session ${sessionID}.

Your job is bounded: complete only the task below. Do not expand scope.
If needed context is missing, use read_session to inspect the parent session.
Do not spawn another subtask.`;
      const files = new Set([
        ...parseFileReferences(args.prompt),
        ...(args.files ?? []).map(cleanFileReference),
      ]);
      const fileRefs =
        files.size > 0 ? [...files].map((f) => `@${f}`).join(' ') : '';
      const fullPrompt = fileRefs
        ? `${sessionReference}\n\nTASK:\n${args.prompt}\n\nFILES PROVIDED:\n${fileRefs}`
        : `${sessionReference}\n\nTASK:\n${args.prompt}`;

      let childSessionID: string | undefined;
      try {
        const session = await client.session.create({
          responseStyle: 'data',
          throwOnError: true,
          query: { directory },
          body: {
            parentID: sessionID === 'unknown' ? undefined : sessionID,
            title: `Subtask worker from ${sessionID}`,
          },
        });

        childSessionID =
          (session as { data?: { id?: string }; id?: string })?.data?.id ??
          (session as { data?: { id?: string }; id?: string })?.id;
        if (!childSessionID) {
          throw new Error('Subtask worker session did not return an id');
        }
        if (sessionID !== 'unknown' && depthTracker) {
          const registered = depthTracker.registerChild(
            sessionID,
            childSessionID,
          );
          if (!registered) {
            throw new Error(
              'Subtask worker blocked: max subagent depth exceeded',
            );
          }
        }
        state.markSession(childSessionID, sessionID);

        await promptWithTimeout(
          client,
          {
            responseStyle: 'data',
            throwOnError: true,
            query: { directory },
            path: { id: childSessionID },
            body: {
              agent: 'orchestrator',
              parts: [
                {
                  type: 'text',
                  text: `${fullPrompt}\n\nInstructions:\n1. Understand the task and relevant file context.\n2. Make only necessary changes.\n3. Run the most relevant validation checks when practical.\n4. Stop when the requested task is done.\n\nReturn your final response in this format:\n\n<subtask_summary>\nStatus: completed | blocked | partial\n\nWhat changed:\n- ...\n\nFiles touched:\n- ...\n\nValidation:\n- ...\n\nRisks / follow-up:\n- ...\n</subtask_summary>`,
                },
                ...(await buildSyntheticFileParts(directory, files)),
              ],
            },
          },
          SUBTASK_TIMEOUT_MS,
          abortSignal,
        );

        const extraction = await extractSessionResult(client, childSessionID, {
          directory,
          includeReasoning: false,
        });
        if (extraction.empty) {
          throw new Error('Subtask worker returned no summary');
        }
        const summary = normalizeSubtaskSummary(extraction.text);

        return [
          `task_id: ${childSessionID}`,
          '',
          '<subtask_summary>',
          summary,
          '</subtask_summary>',
        ].join('\n');
      } finally {
        if (childSessionID) {
          try {
            await client.session.abort({
              path: { id: childSessionID },
              query: { directory },
            });
            state.unmarkSession(childSessionID);
          } catch {
            // Keep the subtask marker if abort fails; session.deleted cleanup
            // will remove it when OpenCode eventually deletes the session.
          }
        }
      }
    },
  });
}

/**
 * Format a conversation transcript for display.
 *
 * @param messages - Array of messages from session.messages()
 * @param limit - Optional limit to indicate if results are truncated
 * @returns Formatted transcript with user/assistant sections
 */
function formatTranscript(
  messages: Array<{ info: { role?: string }; parts: unknown[] }>,
  limit?: number,
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const role = msg.info?.role;
    const parts = msg.parts as Array<{
      type: string;
      text?: string;
      ignored?: boolean;
      filename?: string;
      tool?: string;
      state?: { status: string; title?: string };
    }>;

    if (role === 'user') {
      lines.push('## User');
      for (const part of parts) {
        if (
          part.type === 'text' &&
          !part.ignored &&
          typeof part.text === 'string'
        ) {
          lines.push(part.text);
        }
        if (part.type === 'file') {
          lines.push(`[Attached: ${part.filename || 'file'}]`);
        }
      }
      lines.push('');
    }

    if (role === 'assistant') {
      lines.push('## Assistant');
      for (const part of parts) {
        if (part.type === 'text' && typeof part.text === 'string') {
          lines.push(part.text);
        }
        if (
          part.type === 'tool' &&
          part.state?.status === 'completed' &&
          part.tool
        ) {
          lines.push(`[Tool: ${part.tool}] ${part.state.title ?? ''}`);
        }
      }
      lines.push('');
    }
  }

  const output = lines.join('\n').trim();

  if (messages.length >= (limit ?? 100)) {
    return (
      output +
      `\n\n(Showing ${messages.length} most recent messages. Use a higher 'limit' to see more.)`
    );
  }

  return `${output}\n\n(End of session - ${messages.length} messages)`;
}

/**
 * Create the read_session tool.
 *
 * Takes the OpenCode client as a dependency for session.messages() calls.
 */
export function createReadSessionTool(
  client: OpencodeClient,
  state: SubtaskState,
): ToolDefinition {
  return tool({
    description:
      "Read the conversation transcript from a previous session. Use this when you need specific information from the source session that wasn't included in the subtask summary.",
    args: {
      sessionID: tool.schema
        .string()
        .describe('The full session ID (e.g., sess_01jxyz...)'),
      limit: tool.schema
        .number()
        .optional()
        .describe(
          'Maximum number of messages to read (defaults to 100, max 500)',
        ),
    },
    async execute(args, context) {
      const limit = Math.min(args.limit ?? 100, 500);
      const directory =
        context &&
        typeof context === 'object' &&
        'directory' in context &&
        typeof (context as { directory?: unknown }).directory === 'string'
          ? (context as { directory: string }).directory
          : undefined;
      const callerSessionID =
        context && typeof context === 'object' && 'sessionID' in context
          ? (context as { sessionID?: string }).sessionID
          : undefined;
      if (!callerSessionID || !state.isSubtaskSession(callerSessionID)) {
        return 'read_session is only available from subtask worker sessions.';
      }
      if (state.sourceFor(callerSessionID) !== args.sessionID) {
        return 'read_session can only read the source session for this subtask worker.';
      }

      try {
        const response = (await client.session.messages({
          path: { id: args.sessionID },
          query: { limit, ...(directory ? { directory } : {}) },
        })) as { data?: Array<{ info: { role?: string }; parts: unknown[] }> };

        if (!response.data || response.data.length === 0) {
          return 'Session has no messages or does not exist.';
        }

        return formatTranscript(response.data, limit);
      } catch (error) {
        return `Could not read session ${args.sessionID}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    },
  });
}
