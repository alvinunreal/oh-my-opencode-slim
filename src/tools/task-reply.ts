import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import {
  type ChildInputWaitQuestion,
  clearChildInputWait,
  getChildInputWait,
  listChildInputWaits,
} from '../hooks/task-session-manager/child-input-wait';
import { pluginDisposedMessage } from '../hooks/task-session-manager/session-recovery';
import type { BackgroundJobBoard } from '../utils/background-job-board';
import { log } from '../utils/logger';
import { getClient } from '../utils/opencode-client';
import { OperationTimeoutError, withTimeout } from '../utils/session';
import {
  delegationWording,
  TASK_REPLY_PERMISSION_ONLY_DESCRIPTION,
} from '../v2/delegation';
import {
  type CanonicalTaskResolver,
  idParamFor,
  readTaskRef,
  resolveTaskRecord,
  taskRefArgs,
  unknownTaskRefError,
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
 * Fold v1 question answers (`string[][]`: selected option labels per
 * question, in question order) into the v2 form-reply `answer` map
 * (`{ [fieldKey]: string | number | boolean | string[] }` per
 * SessionFormReplyInput).
 *
 * The open wait stores the form's fields as v1 questions in adapter order
 * (form.created → question.asked; see event-adapter.ts), and the adapter
 * never reorders the surviving fields — so the i-th answer fills the i-th
 * stored question. The adapter also carries each field's original key
 * (`ChildInputWaitQuestion.key`): the host requires answers keyed by that
 * exact value (`answer[field.key]` — anything else is "Unknown form
 * field"), while `header` is display text truncated to 30 chars. Keyless
 * asks (v1-native or older records) fall back to the stored question text.
 */
function toFormAnswer(
  answers: string[][],
  questions: ChildInputWaitQuestion[] | undefined,
): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {};
  answers.forEach((selections, index) => {
    const question = questions?.[index];
    // The key is used verbatim: the host matches it exactly.
    const key =
      question?.key ||
      question?.header.trim() ||
      question?.question.trim() ||
      `question_${index}`;
    // Multiselect fields require a string[] even for a single selection.
    answer[key] =
      question?.multiple || selections.length !== 1
        ? [...selections]
        : selections[0];
  });
  return answer;
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
 * v2 forms are observable as question waits; when the runtime host client
 * exposes the documented `session.form.reply` API (present since v2.0.18),
 * those waits are answered through it and the `answers` arg is advertised.
 * Hosts without the runtime domain keep the C4 behavior: the pinned v2
 * plugin context exposes no supported form-reply API, so those waits fail
 * honestly instead of using undocumented transport.
 */
export function createTaskReplyTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobBoard;
  replyTimeoutMs?: number;
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
  isDisposed?: () => boolean;
}): Record<'task_reply', ToolDefinition> {
  const idParam = idParamFor(options.input);
  const hostFlavor = (options.input as { hostFlavor?: unknown }).hostFlavor;
  const delegation = delegationWording(
    typeof hostFlavor === 'string' ? hostFlavor : undefined,
  );
  // v2 form-reply capability probe (creation-time): the host generated
  // client exposes session.form.reply (POST
  // /api/session/:sid/form/:fid/reply) from v2.0.18 — see the promise
  // client at packages/client/src/promise/generated/client.ts:1053 (`form`
  // block at :1014) and the effect layer at
  // effect/generated/client.ts:735 — but the pinned compile-time plugin
  // context carries no form domain, and neither does the host's runtime
  // plugin session domain (15 methods, no form). The probed client is the
  // v1-shaped shim built by buildPluginInput from the host session domain;
  // the shim forwards `session.form.reply` when the host provides it
  // (client-shim.ts), so this probe reads the one surface that can truthfully
  // carry the capability: pinned v2.0.26 → absent (honest failure below);
  // a future host that exposes the domain → detected. A cast keeps the
  // mirror-conformance guard (src/v2/mirror-conformance.ts) green because
  // the mirrored V2Context type is untouched.
  const v2FormReply =
    hostFlavor === 'v2'
      ? (options.input as { client?: unknown }).client
      : undefined;
  const hasV2FormReply =
    typeof (v2FormReply as { session?: { form?: { reply?: unknown } } })
      ?.session?.form?.reply === 'function';
  // Single-line detection record: which reply surface the tool advertises.
  log(
    `[task-reply] v2 form-reply ${hasV2FormReply ? 'detected; answers advertised' : 'absent; questions fail honestly'}`,
  );
  const replyArgs = {
    ...taskRefArgs(idParam),
    request_id: z
      .string()
      .describe('Open question/permission request ID to answer'),
    answers: z
      .array(z.string().max(MAX_ANSWER_LENGTH))
      .optional()
      .describe(
        hostFlavor === 'v2'
          ? 'Answers for a question request, in question order (each entry selects option labels).'
          : 'Answers for a question request, in question order (each entry selects option labels). Omit to reject the request instead of answering it.',
      ),
    reply: z
      .enum(['once', 'always', 'reject'])
      .optional()
      .describe(
        'Response for a permission request: once, always, or reject. Defaults to once.',
      ),
  };
  // v2 advertises `answers` only when the runtime host client exposes
  // session.form.reply (detected above): undetected v2 keeps the
  // honest-surface shape, so advertising question answers there can only
  // invite calls the execute gate refuses (#1510 stays intact). v1 and
  // unknown flavors (which fail toward the capable side) keep the full
  // surface. The static type keeps `answers` optional; the undetected v2
  // gate below refuses question kinds before any answers access, so the
  // absent key is never read there.
  if (hostFlavor === 'v2' && !hasV2FormReply) {
    delete (replyArgs as Partial<typeof replyArgs>).answers;
  }
  const task_reply = tool({
    description:
      hostFlavor === 'v2' && !hasV2FormReply
        ? TASK_REPLY_PERMISSION_ONLY_DESCRIPTION
        : 'Answer a background child ask (question/permission requests) by task ID/alias and request ID.',
    args: replyArgs,
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_reply requires sessionID');

      const requested = readTaskRef(args, idParam);
      if (!requested) throw new Error(`task_reply requires ${idParam}`);
      const requestID = args.request_id.trim();
      if (!requestID) throw new Error('task_reply requires request_id');
      const ref = await resolveTaskRecord(options, parentSessionID, requested);
      if (ref.kind === 'disposed') throw new Error(pluginDisposedMessage());
      if (ref.kind === 'refused') throw new Error(ref.reason);
      // The await above resumes in a later microtask; a disposal queued in
      // that gap must still stop the send path (the helper's disposed
      // check ran before the gap).
      if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
      const { identity, job } = ref;
      if (job && job.parentSessionID !== parentSessionID) {
        // Another parent's record: not this caller's task, and the
        // settled-session recovery route would reject the same ownership
        // mismatch — keep the bare unknown error.
        throw new Error(`Unknown task ID or alias: ${identity}`);
      }
      if (!job) {
        throw unknownTaskRefError(
          identity,
          delegation.resumeParam,
          undefined,
          typeof hostFlavor === 'string' ? hostFlavor : undefined,
        );
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
          const record = options.backgroundJobBoard.get(other.taskID);
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
        session?: {
          form?: {
            reply: (args: Record<string, unknown>) => Promise<unknown>;
          };
        };
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
      // v2 gate (C4): question asks fail honestly BEFORE any transport
      // attempt whenever the reply would dead-end. Undetected hosts: BOTH
      // reply and reject dead-end (no session.form.reply, no question
      // domain on the shim client) — refuse with the alternatives the
      // parent still has. Detected hosts: answers flow through
      // session.form.reply, but a rejected ask (answers omitted) would
      // fall through to the v1 question.reject route, which the detected
      // surface equally lacks — and form.cancel carries dismissal
      // semantics the plugin must not fake, so rejection redirects to the
      // host UI. Early exit never reaches clearChildInputWait: the ask
      // stays open and answerable where it actually is. Permission
      // requests are not gated; v1 hosts (no hostFlavor) keep the full
      // path untouched.
      if (
        openWait.kind === 'question' &&
        hostFlavor === 'v2' &&
        (!hasV2FormReply ||
          args.answers === undefined ||
          args.answers.length === 0)
      ) {
        throw new Error(
          hasV2FormReply
            ? "Question rejection is not supported through task_reply on this host — dismiss the child's question in the host UI, or cancel the child with task_cancel instead."
            : "Question replies are not supported on this host — answer the child's question in the host UI, or cancel the child with task_cancel instead.",
        );
      }

      /**
       * Answer/reject through the host. Clients exposing `question` /
       * `permission` domains directly keep that preferred branch; the
       * SDK client (no such domains) falls back to its own underlying
       * hey-api transport so auth headers + the directory interceptor
       * are reused — never a hand-rolled fetch. Host SDK results do not
       * throw on HTTP errors, so error/non-2xx results fail here.
       *
       * v2 hosts with a detected runtime session.form.reply answer
       * through it (SessionFormReplyInput: `{sessionID, formID, answer}` —
       * POST /api/session/:sid/form/:fid/reply, 204 empty). The open
       * wait's (taskID, requestID) IS the (sessionID, formID) pair: the
       * event router notes waits keyed by the form's owning session and
       * id (event-router.ts:934-941), so no mapping is invented here.
       * Reject on detected v2 keeps the host-UI redirect: form.cancel
       * carries dismissal semantics the plugin must not fake.
       */
      async function replyQuestion(
        answers: string[][] | undefined,
      ): Promise<unknown> {
        const formReply = client.session?.form?.reply;
        if (answers !== undefined && hasV2FormReply) {
          if (typeof formReply !== 'function') {
            throw new Error(
              'Host client has no session.form.reply API; cannot answer the pending form',
            );
          }
          const answer = toFormAnswer(answers, openWait.questions);
          return await formReply({
            sessionID: targetJob.taskID,
            formID: openWait.requestID,
            answer,
          });
        }
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
