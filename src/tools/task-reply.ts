import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobBoardApi } from '../background-jobs';
import {
  clearChildInputWait,
  getChildInputWait,
  listChildInputWaits,
} from '../hooks/task-session-manager/child-input-wait';
import { pluginDisposedMessage } from '../hooks/task-session-manager/session-recovery';
import { getClient } from '../utils/opencode-client';
import { OperationTimeoutError, withTimeout } from '../utils/session';
import {
  type CanonicalTaskResolver,
  idParamFor,
  readTaskRef,
  taskRefArgs,
} from './task-ref';

const z = tool.schema;
const DEFAULT_REPLY_TIMEOUT_MS = 10_000;
const MAX_ANSWER_LENGTH = 2000;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Fail a reply when the host transport reports an error result.
 *
 * Host SDK calls return `{ data, error, response }` and do NOT throw on
 * HTTP errors by default, so a bare `await` would treat a 404/validation
 * failure as success. Treat a set `error` or a non-2xx response as
 * failure; results that carry neither (including domain-mock shapes like
 * `{ data: true }` or `{}`) pass.
 */
function assertHostReplyResult(result: unknown, operation: string): void {
  if (typeof result !== 'object' || result === null) return;
  const record = result as {
    error?: unknown;
    response?: { ok?: unknown; status?: unknown };
  };
  if (record.error !== undefined && record.error !== null) {
    throw new Error(`${operation} failed: ${errorText(record.error)}`);
  }
  const response = record.response;
  if (response && typeof response.ok === 'boolean' && !response.ok) {
    const status =
      typeof response.status === 'number'
        ? ` with HTTP ${response.status}`
        : '';
    throw new Error(`${operation} failed${status}`);
  }
}

/**
 * Answer (or reject) a background child's pending question/permission when
 * the host exposes a supported reply API.
 *
 * A background child that calls the `question` tool parks with no tokens
 * moving until the host's question.reply/reject API resolves the request —
 * a `task_message` text nudge does NOT unblock it. This tool performs the
 * actual reply through the host client, scoped to the calling parent's own
 * tracked children: the task must resolve under the parent session and
 * have a recorded open ask for the given request id. A reply for an
 * unknown request id converges benignly when the task has no open asks at
 * all (issue #1435), while stale ids with open asks still throw. OpenCode
 * v2 forms are
 * observable as question waits, but the pinned v2 plugin context exposes no
 * supported form-reply API, so those waits fail honestly instead of using
 * undocumented transport.
 */
export function createTaskReplyTool(options: {
  input: PluginInput;
  backgroundJobs: BackgroundJobBoardApi;
  replyTimeoutMs?: number;
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
  isDisposed?: () => boolean;
}): Record<'task_reply', ToolDefinition> {
  const idParam = idParamFor(options.input);
  const task_reply = tool({
    description:
      'Answer a tracked background child task waiting on a question or permission request. Accepts the task ID or parent-scoped alias plus the request ID from the wake or task_status.',
    args: {
      ...taskRefArgs(idParam),
      request_id: z
        .string()
        .describe('Open question/permission request ID to answer'),
      answers: z
        .array(z.string().max(MAX_ANSWER_LENGTH))
        .optional()
        .describe(
          'Answers for a question request, in question order (each entry selects option labels). Omit to reject the request instead of answering it.',
        ),
      reply: z
        .enum(['once', 'always', 'reject'])
        .optional()
        .describe(
          'Response for a permission request: once, always, or reject. Defaults to once.',
        ),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_reply requires sessionID');

      const requested = readTaskRef(args, idParam);
      if (!requested) throw new Error(`task_reply requires ${idParam}`);
      const requestID = args.request_id.trim();
      if (!requestID) throw new Error('task_reply requires request_id');
      const canonical = options.resolveCanonicalTaskRef
        ? await options.resolveCanonicalTaskRef(parentSessionID, requested)
        : undefined;
      if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
      if (canonical?.kind === 'refused') throw new Error(canonical.reason);
      const identity = canonical?.taskID ?? requested;
      const job = canonical
        ? options.backgroundJobs.get(identity)
        : options.backgroundJobs.resolve(parentSessionID, requested);
      if (!job || job.parentSessionID !== parentSessionID) {
        throw new Error(`Unknown task ID or alias: ${identity}`);
      }
      if (job.state !== 'running') {
        throw new Error(
          `Task ${requested} cannot be answered: board state is ${job.state}, not running`,
        );
      }

      const wait = getChildInputWait(job.taskID, requestID);
      if (!wait) {
        const other = listChildInputWaits().find(
          (entry) =>
            entry.requestID === requestID &&
            entry.taskID !== job.taskID &&
            entry.parentSessionID === parentSessionID,
        );
        if (other) {
          const record = options.backgroundJobs.get(other.taskID);
          const otherLabel = record
            ? `${record.alias} (${other.taskID})`
            : other.taskID;
          throw new Error(
            `Task ${requested} has no open request ${requestID}. Request ${requestID} is open on task ${otherLabel}; reply there.`,
          );
        }
        const open = listChildInputWaits(job.taskID);
        if (open.length > 0) {
          const hint = ` Open requests for this task: ${open
            .map((entry) => entry.requestID)
            .join(', ')}.`;
          throw new Error(
            `Task ${requested} has no open request ${requestID}.${hint}`,
          );
        }
        // The task has no open asks at all: the request this wake steered
        // toward was resolved elsewhere or never existed (external replier,
        // host policy, or the parent's own earlier reply) while the child
        // kept running (#1435). Converge benignly — the parent approved
        // nothing.
        return `No open request ${requestID} on ${job.alias} (${job.taskID}); it was resolved elsewhere or is no longer tracked. Nothing was replied. Run task_status if you expected an open ask.`;
      }

      const client = getClient(options.input) as unknown as {
        question?: {
          reply: (args: Record<string, unknown>) => Promise<unknown>;
          reject: (args: Record<string, unknown>) => Promise<unknown>;
        };
        permission?: {
          reply: (args: Record<string, unknown>) => Promise<unknown>;
        };
        postSessionIdPermissionsPermissionId?: (
          args: Record<string, unknown>,
        ) => Promise<unknown>;
        _client?: {
          post?: (args: Record<string, unknown>) => Promise<unknown>;
        };
      };
      const timeoutMs = Math.max(
        1,
        options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
      );
      // Pinned after the guards above so the transport closures below keep
      // narrowed (non-undefined) types.
      const openWait = wait;
      const targetJob = job;

      /**
       * Answer/reject through the host. Clients exposing `question` /
       * `permission` domains directly keep that preferred branch; the
       * SDK client (no such domains) falls back to its own underlying
       * hey-api transport so auth headers + the directory interceptor
       * are reused — never a hand-rolled fetch. Host SDK results do not
       * throw on HTTP errors, so error/non-2xx results fail here.
       */
      async function replyQuestion(
        answers: string[][] | undefined,
      ): Promise<unknown> {
        const question = client.question;
        if (answers !== undefined) {
          if (typeof question?.reply === 'function') {
            return await question.reply({
              requestID: openWait.requestID,
              directory: options.input.directory,
              answers,
            });
          }
          const post = client._client?.post;
          if (typeof post !== 'function') {
            throw new Error(
              'Host client has no question.reply API; cannot answer the pending question',
            );
          }
          return await post({
            url: '/question/{requestID}/reply',
            path: { requestID: openWait.requestID },
            query: { directory: options.input.directory },
            body: { answers },
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (typeof question?.reject === 'function') {
          return await question.reject({
            requestID: openWait.requestID,
            directory: options.input.directory,
          });
        }
        const post = client._client?.post;
        if (typeof post !== 'function') {
          throw new Error(
            'Host client has no question.reject API; cannot reject the pending question',
          );
        }
        return await post({
          url: '/question/{requestID}/reject',
          path: { requestID: openWait.requestID },
          query: { directory: options.input.directory },
          headers: { 'Content-Type': 'application/json' },
        });
      }

      async function replyPermission(
        response: 'once' | 'always' | 'reject',
      ): Promise<unknown> {
        if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
        const permission = client.permission;
        if (typeof permission?.reply === 'function') {
          return await permission.reply({
            sessionID: targetJob.taskID,
            requestID: openWait.requestID,
            directory: options.input.directory,
            reply: response,
          });
        }
        if (typeof client.postSessionIdPermissionsPermissionId === 'function') {
          return await client.postSessionIdPermissionsPermissionId({
            path: { id: targetJob.taskID, permissionID: openWait.requestID },
            query: { directory: options.input.directory },
            body: { response },
          });
        }
        throw new Error(
          'Host client has no permission.reply API; cannot answer the pending permission request',
        );
      }

      try {
        if (openWait.kind === 'question') {
          if (!args.answers || args.answers.length === 0) {
            const result = await withTimeout(
              replyQuestion(undefined),
              timeoutMs,
              `Question reject timed out after ${timeoutMs}ms`,
            );
            assertHostReplyResult(
              result,
              `Question reject ${openWait.requestID}`,
            );
            // Confirmed on the host (which also emits question.rejected on
            // success, clearing the sidecar via the event path); clear here
            // as well so a missed/slow event cannot re-wake the parent.
            clearChildInputWait(targetJob.taskID, openWait.requestID);
            return `Rejected pending question ${openWait.requestID} for ${targetJob.alias} (${targetJob.taskID}).`;
          }
          const result = await withTimeout(
            replyQuestion(args.answers.map((answer) => [answer])),
            timeoutMs,
            `Question reply timed out after ${timeoutMs}ms`,
          );
          assertHostReplyResult(result, `Question reply ${openWait.requestID}`);
          clearChildInputWait(targetJob.taskID, openWait.requestID);
          return `Answered pending question ${openWait.requestID} for ${targetJob.alias} (${targetJob.taskID}).`;
        }

        const reply = args.reply ?? 'once';
        const result = await withTimeout(
          replyPermission(reply),
          timeoutMs,
          `Permission reply timed out after ${timeoutMs}ms`,
        );
        assertHostReplyResult(result, `Permission reply ${openWait.requestID}`);
        clearChildInputWait(targetJob.taskID, openWait.requestID);
        return `Replied ${reply} to pending permission ${openWait.requestID} for ${targetJob.alias} (${targetJob.taskID}).`;
      } catch (error) {
        if (error instanceof OperationTimeoutError) throw error;
        const message = errorText(error);
        // The reply targets the owning child session, so the host's typed
        // not-found means the request is no longer pending there: it was
        // answered elsewhere (e.g. the UI) or dropped with its step (#1356).
        // Clear the stale wait so it cannot keep waking the parent; this
        // call approved nothing.
        if (
          openWait.kind === 'permission' &&
          message.includes('Permission request not found') &&
          message.includes(openWait.requestID)
        ) {
          clearChildInputWait(targetJob.taskID, openWait.requestID);
          return `Permission ${openWait.requestID} for ${targetJob.alias} (${targetJob.taskID}) is no longer pending on the host; cleared the stale wait. Nothing was replied.`;
        }
        // Keep the wait on other errors so task_status still shows the
        // open ask and task_reply can retry; a failed transport leaves the
        // ask open on the host.
        throw new Error(`Task reply transport failed: ${message}`);
      }
    },
  });

  return { task_reply };
}
