import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobBoardApi } from '../background-jobs';
import { listChildInputWaits } from '../hooks/task-session-manager/child-input-wait';
import {
  classifyTerminalEvidence,
  classifyV2HistoricalRound,
  fetchChildTranscript,
} from '../utils/child-transcript';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import { SESSION_ID_PATTERN, withTimeout } from '../utils/session';
import {
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';
import { observationFromSnapshot, summarizeTaskStatus } from './task-policy';
import {
  type CanonicalTaskResolver,
  idParamFor,
  readTaskRef,
  taskRefArgs,
} from './task-ref';

const ACTIVE_STATES = new Set(['busy', 'running', 'retry']);
const UNTRACKED_STATE = 'running-or-incomplete';
/** Each untracked host read (ownership, transcript) refuses after 5 s. */
const UNTRACKED_READ_TIMEOUT_MS = 5_000;

export function createTaskStatusTool(options: {
  input: PluginInput;
  backgroundJobs: BackgroundJobBoardApi;
  activityTracker?: TaskActivityTracker;
  now?: () => number;
  statusTimeoutMs?: number;
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
  isDisposed?: () => boolean;
  readTimeoutMs?: number;
}): Record<'task_status', ToolDefinition> {
  const idParam = idParamFor(options.input);
  const task_status = tool({
    description:
      'Read the current status of a tracked child task without resuming, prompting, or changing it. Accepts its task ID or parent-scoped alias. For a task the board no longer tracks (e.g. after a restart), verifies host ownership and reports a read-only observed state.',
    args: {
      ...taskRefArgs(idParam),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = readTaskRef(args, idParam);
      if (!requested) throw new Error(`task_status requires ${idParam}`);
      const canonical = options.resolveCanonicalTaskRef
        ? await options.resolveCanonicalTaskRef(parentSessionID, requested)
        : undefined;
      if (canonical?.kind === 'refused') throw new Error(canonical.reason);
      const identity = canonical?.taskID ?? requested;
      const job = canonical
        ? options.backgroundJobs.get(identity)
        : options.backgroundJobs.resolve(parentSessionID, requested);
      if (!job || job.parentSessionID !== parentSessionID) {
        // Read-only fallback for a session the board lost (e.g. a host or
        // plugin restart emptied the in-memory board): verify ownership
        // like task_result's untracked path, then report observed
        // evidence. The task is never registered, prompted, or aborted.
        return reportUntrackedTaskStatus(options, {
          requested,
          identity,
          parentSessionID,
        });
      }
      const taskID = job.taskID;

      // Bounded live read: a failed, malformed, or timed-out host status
      // response surfaces as explicit uncertainty instead of a confident
      // board-state fallback.
      const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
        timeoutMs: options.statusTimeoutMs,
      });
      const current = options.backgroundJobs.get(taskID) ?? job;
      if (
        current.parentSessionID !== parentSessionID ||
        current.taskID !== taskID
      ) {
        throw new Error(`Unknown task ID or alias: ${taskID}`);
      }
      const observation = observationFromSnapshot(snapshot, taskID);
      const now = options.now?.() ?? Date.now();
      const lastActivityAt =
        options.activityTracker?.lastActivityAt(taskID) ??
        current.lastLiveBusyAt ??
        current.runStartedAt;
      const report = summarizeTaskStatus(
        current,
        observation,
        lastActivityAt,
        now,
      );

      const details = [
        `Task ${current.alias} (${current.taskID})`,
        `state: ${report.state}${report.uncertain ? ' (unconfirmed)' : ''}`,
        `agent: ${current.agent}`,
        `last_activity_at: ${new Date(lastActivityAt).toISOString()}`,
        `idle_for_seconds: ${report.idleSeconds}`,
        `possibly_stuck: ${report.possiblyStuck}`,
      ];
      const waits = listChildInputWaits(taskID);
      const hostFlavor = (options.input as { hostFlavor?: unknown }).hostFlavor;
      // A child parked on an open question/permission moves no tokens and
      // never finishes on its own: surface the block explicitly so the
      // parent handles it instead of waiting it out. On pinned v2 hosts,
      // questions are Form requests; the plugin context exposes observation
      // but no supported form-reply API, so do not promise task_reply can
      // unblock them.
      for (const wait of waits) {
        details.push(`waiting_input: true (${wait.kind} ${wait.requestID})`);
        details.push(
          `pending_${wait.kind}: ${formatPendingInput(wait.kind, wait.requestID, wait.questions, wait.permission, wait.patterns)}`,
        );
        details.push(inputWaitGuidance(wait.kind, hostFlavor));
      }
      if (report.uncertain) {
        details.push('status_uncertain: true');
        if (report.lastStatusError) {
          details.push(`last_status_error: ${report.lastStatusError}`);
        }
      }
      if (!report.uncertain && ACTIVE_STATES.has(report.state)) {
        details.push('');
        details.push(
          '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
        );
      }
      if (waits.length > 0) {
        details.push('');
        details.push(
          '[guidance]: The task is waiting for input and cannot proceed until the pending request is handled. See the request-specific guidance above.',
        );
      }
      return details.join('\n');
    },
  });

  return { task_status };
}

interface UntrackedStatusOptions {
  input: PluginInput;
  now?: () => number;
  statusTimeoutMs?: number;
  isDisposed?: () => boolean;
  readTimeoutMs?: number;
}

/** Bounds one host read; a held read is aborted at its deadline. */
async function boundedRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  return withTimeout(read(controller.signal), timeoutMs, message).catch(
    (error) => {
      controller.abort();
      throw error;
    },
  );
}

/**
 * Read-only status for a task the board does not track. Mirrors
 * task_result's untracked path: ownership via `client.session.get`
 * parentID, then v2 `classifyV2HistoricalRound` / v1
 * `classifyTerminalEvidence` over the child transcript. Never registers,
 * prompts, or aborts anything.
 */
async function reportUntrackedTaskStatus(
  options: UntrackedStatusOptions,
  ref: {
    requested: string;
    identity: string;
    parentSessionID: string;
  },
): Promise<string> {
  const { identity, parentSessionID } = ref;
  if (!SESSION_ID_PATTERN.test(identity)) {
    throw new Error(`Unknown task ID or alias: ${identity}`);
  }
  if (options.isDisposed?.()) {
    // Disposed: keep task_status's existing unknown-task contract.
    throw new Error(`Unknown task ID or alias: ${identity}`);
  }
  const client = getClient(options.input);
  if (typeof client.session?.get !== 'function') {
    throw new Error(`Unknown task ID or alias: ${identity}`);
  }
  const readTimeoutMs = options.readTimeoutMs ?? UNTRACKED_READ_TIMEOUT_MS;
  let response: Awaited<ReturnType<typeof client.session.get>>;
  try {
    response = await boundedRead(
      (signal) =>
        client.session.get({
          path: { id: identity },
          query: { directory: options.input.directory },
          signal,
        }),
      readTimeoutMs,
      'session ownership read timed out',
    );
  } catch {
    // An unreadable host session cannot be verified or attributed.
    throw new Error(`Unknown task ID or alias: ${identity}`);
  }
  if (options.isDisposed?.()) {
    // Disposed: keep task_status's existing unknown-task contract.
    throw new Error(`Unknown task ID or alias: ${identity}`);
  }
  // Read untyped fields (agent, time) the generated Session type omits.
  const data: Record<string, unknown> | undefined = isRecord(response.data)
    ? response.data
    : undefined;
  if (!data) {
    // A host error payload (e.g. NotFound) verifies nothing.
    throw new Error(`Unknown task ID or alias: ${identity}`);
  }
  if (typeof data.parentID !== 'string' || !data.parentID) {
    // The host session exists but exposes no parent: ownership cannot be
    // verified, so the caller gets the existing unknown error rather
    // than a claim that another parent owns it.
    throw new Error(`Unknown task ID or alias: ${identity}`);
  }
  if (data.parentID !== parentSessionID) {
    throw new Error(`Task ${ref.requested} does not belong to this session`);
  }
  const agentRaw = data.agent;
  const agent =
    typeof agentRaw === 'string' && agentRaw.trim()
      ? agentRaw.trim()
      : undefined;
  const time = isRecord(data.time) ? data.time : undefined;
  const created = time?.created;
  const createdAt =
    typeof created === 'number' && Number.isFinite(created)
      ? created
      : undefined;

  const v2 = (options.input as { hostFlavor?: string }).hostFlavor === 'v2';
  const details = [
    `Task ${identity} is not tracked by the local background job board (its tracking does not survive a host or plugin restart).`,
    'board: untracked',
  ];

  // v1's live status map is real evidence of execution; v2 has no
  // equivalent (the shim omits `status`), so this probe is v1 only.
  let liveStatusUnknown: string | undefined;
  if (!v2) {
    const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
      timeoutMs: options.statusTimeoutMs,
    });
    const status = runtimeSessionStatus(snapshot, identity);
    if (status === 'busy' || status === 'retry') {
      details.push(`state: ${status} (live)`);
      details.push(
        `[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.`,
      );
      return details.join('\n');
    }
    // Like task_result: an unreadable live status cannot rule out a new
    // run that history does not show yet, so history proves nothing.
    if (snapshot.error) liveStatusUnknown = snapshot.error;
    else if (snapshot.malformedSessionIDs.has(identity))
      liveStatusUnknown = 'malformed session-status entry';
  }

  let evidence: string;
  if (liveStatusUnknown) {
    evidence = `state: unknown (uncertain; live status could not be read: ${liveStatusUnknown})`;
  } else {
    try {
      const transcript = await boundedRead(
        (signal) =>
          fetchChildTranscript(
            client,
            identity,
            options.input.directory,
            undefined,
            signal,
          ),
        readTimeoutMs,
        'child transcript read timed out',
      );
      const round = v2
        ? classifyV2HistoricalRound(transcript)
        : classifyTerminalEvidence(transcript);
      evidence = describeUntrackedEvidence(round);
    } catch {
      evidence = `state: ${UNTRACKED_STATE} (uncertain; transcript could not be read)`;
    }
  }
  details.push(evidence);
  if (agent) details.push(`agent: ${agent}`);
  // The host session's creation time, not its latest activity.
  if (createdAt !== undefined)
    details.push(`created_at: ${new Date(createdAt).toISOString()}`);
  details.push("next: use task_result to read a completed task's final text");
  return details.join('\n');
}

/** Observed-state line for one transcript classification verdict. */
function describeUntrackedEvidence(round: {
  verdict: string;
  reason?: string;
}): string {
  if (round.verdict === 'completed') {
    return 'state: completed (verified from history)';
  }
  if (round.verdict === 'error') {
    return 'state: error (verified from history)';
  }
  if (round.verdict === 'interrupted') {
    return 'state: stopped (interrupted, verified from history)';
  }
  if (round.verdict === 'unreadable' || round.verdict === 'retry') {
    return `state: ${UNTRACKED_STATE} (uncertain; transcript ${round.verdict}${round.reason ? `: ${round.reason}` : ''})`;
  }
  // incomplete / absent: no verified terminal round after the latest
  // input. The session may be running or merely unfinished — do not
  // claim definite running.
  return `state: ${UNTRACKED_STATE} (uncertain; no verified terminal round)`;
}

function inputWaitGuidance(
  kind: 'question' | 'permission',
  hostFlavor: unknown,
): string {
  if (kind === 'question' && hostFlavor === 'v2') {
    return '[guidance]: This is an OpenCode v2 form request. The pinned v2 plugin context can observe it but exposes no supported form-reply API, so task_reply cannot answer it. Answer/cancel it in the host UI if available; otherwise leave the child waiting or cancel the task.';
  }
  return '[guidance]: Use task_reply with this request ID to answer or reject this pending request.';
}

function formatPendingInput(
  kind: 'question' | 'permission',
  requestID: string,
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
  }>,
  permission?: string,
  patterns?: string[],
): string {
  if (kind === 'permission') {
    const patternText =
      patterns && patterns.length > 0
        ? ` patterns: ${patterns.join(', ')}`
        : '';
    return `${requestID} permission: ${permission ?? 'unknown'}${patternText}`;
  }
  if (!questions || questions.length === 0) return requestID;
  const rendered = questions
    .map((entry) => {
      const options =
        entry.options.length > 0
          ? ` [${entry.options.map((option) => option.label).join(' / ')}]`
          : '';
      const header = entry.header ? `${entry.header}: ` : '';
      return `${header}${entry.question}${options}`;
    })
    .join('; ');
  return `${requestID} ${rendered}`;
}
