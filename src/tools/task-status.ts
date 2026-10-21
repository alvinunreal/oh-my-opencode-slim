import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import {
  formatChildInputWaitDetail,
  listChildInputWaits,
} from '../hooks/task-session-manager/child-input-wait';
import { pluginDisposedMessage } from '../hooks/task-session-manager/session-recovery';
import type { BackgroundJobStore } from '../utils/background-job-store';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
  runtimeObservationFromSnapshot,
} from '../utils/background-job-terminal-gate';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import { SESSION_ID_PATTERN } from '../utils/session';
import {
  getRuntimeSessionStatusSnapshot,
  type RuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';
import { observationFromSnapshot, summarizeTaskStatus } from './task-policy';
import {
  type CanonicalTaskResolver,
  idParamFor,
  readTaskRef,
  resolveTaskRecord,
  taskRefArgs,
} from './task-ref';
import {
  readUntrackedEvidence,
  verifyUntrackedOwnership,
} from './untracked-task-observation';

const ACTIVE_STATES = new Set(['busy', 'running', 'retry']);
const UNTRACKED_STATE = 'running-or-incomplete';

export function createTaskStatusTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  activityTracker?: TaskActivityTracker;
  terminalGate?: BackgroundJobTerminalGate;
  now?: () => number;
  statusTimeoutMs?: number;
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
  isDisposed?: () => boolean;
  readTimeoutMs?: number;
}): Record<'task_status', ToolDefinition> {
  const idParam = idParamFor(options.input);
  const gate =
    options.terminalGate ??
    createBackgroundJobTerminalGate({
      backgroundJobBoard: options.backgroundJobBoard,
      input: options.input,
    });
  const z = tool.schema;
  const task_status = tool({
    description:
      "Inspect a tracked child task without resuming, prompting, or changing it. It accepts its task ID or parent-scoped alias. Pass result: true for a completed task's final text; refuses other terminals. For an untracked session (e.g. after a restart), reports a read-only observed state.",
    args: {
      ...taskRefArgs(idParam),
      result: z
        .boolean()
        .optional()
        .describe('Return the completed task’s final text.'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = readTaskRef(args, idParam);
      if (!requested) throw new Error(`task_status requires ${idParam}`);
      if (args.result === true)
        return readTaskResult(
          {
            input: options.input,
            gate,
            board: options.backgroundJobBoard,
            isDisposed: options.isDisposed,
            readTimeoutMs: options.readTimeoutMs,
            resolveCanonicalTaskRef: options.resolveCanonicalTaskRef,
          },
          { parentSessionID, idParam, requested },
        );
      const canonical = options.resolveCanonicalTaskRef
        ? await options.resolveCanonicalTaskRef(parentSessionID, requested)
        : undefined;
      if (canonical?.kind === 'refused') throw new Error(canonical.reason);
      const identity = canonical?.taskID ?? requested;
      const job = canonical
        ? options.backgroundJobBoard.get(identity)
        : options.backgroundJobBoard.resolve(parentSessionID, requested);
      if (!job || job.parentSessionID !== parentSessionID) {
        // Read-only fallback for a session the board lost (e.g. a host or
        // plugin restart emptied the in-memory board): verify ownership
        // like the result mode's untracked path, then report observed
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
      const current = options.backgroundJobBoard.get(taskID) ?? job;
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
      for (const wait of waits) {
        details.push(`waiting_input: true (${wait.kind} ${wait.requestID})`);
        details.push(formatChildInputWaitDetail(wait, hostFlavor));
      }
      if (report.uncertain) {
        details.push('status_uncertain: true');
        if (report.lastStatusError) {
          details.push(`last_status_error: ${report.lastStatusError}`);
        }
      }
      if (
        waits.length === 0 &&
        !report.uncertain &&
        ACTIVE_STATES.has(report.state)
      ) {
        details.push('');
        details.push(
          '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
        );
      }
      return details.join('\n');
    },
  });

  return { task_status };
}

function readonlyTerminalResult(
  requested: string,
  record:
    | {
        state?: string;
        terminalState?: string;
        resultSummary?: string;
      }
    | undefined,
): string {
  const state =
    record?.state === 'reconciled' ? record.terminalState : record?.state;
  const summary = record?.resultSummary?.trim();
  if (state === 'completed' && summary) return summary;
  throw new Error(
    `Task ${requested} result was not consumed. No action was sent.`,
  );
}

function runningResultRefusal(
  idParam: string,
  taskID: string,
  uncertain: boolean,
  status?: 'busy' | 'idle' | 'retry',
  tracked = true,
): string {
  if (status === 'idle')
    return [
      `${idParam}: ${taskID}`,
      'state: pending',
      'message: Task is quiescent; wait for terminal reconciliation before retrieving its result.',
      'next: retry task_status with { result: true } after the terminal notification',
    ].join('\n');
  return [
    `${idParam}: ${taskID}`,
    uncertain
      ? 'state: running (unconfirmed)'
      : `state: ${status === 'retry' ? 'retry' : 'running'}`,
    uncertain
      ? 'message: Live task status is uncertain; no definitive running state is available.'
      : 'message: Task is still running. Wait for its terminal result.',
    `next: ${!tracked ? 'retry task_status with { result: true } after the task finishes' : uncertain ? 'retry task_status with { result: true } or inspect the task without result' : 'inspect the task without result'}`,
  ].join('\n');
}

interface TaskResultReadOptions {
  input: PluginInput;
  gate: BackgroundJobTerminalGate;
  board: BackgroundJobStore;
  isDisposed?: () => boolean;
  readTimeoutMs?: number;
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
}

interface TaskResultReadRef {
  parentSessionID: string;
  idParam: string;
  requested: string;
}

/** Result-mode read. Completed-only; never re-runs or re-prompts. */
async function readTaskResult(
  options: TaskResultReadOptions,
  ref: TaskResultReadRef,
): Promise<string> {
  const { parentSessionID, idParam, requested } = ref;
  const board = options.board;
  const gate = options.gate;
  const resolution = await resolveTaskRecord(
    {
      resolveCanonicalTaskRef: options.resolveCanonicalTaskRef,
      isDisposed: options.isDisposed,
      backgroundJobBoard: options.board,
    },
    parentSessionID,
    requested,
  );
  if (resolution.kind === 'disposed') throw new Error(pluginDisposedMessage());
  if (resolution.kind === 'refused') throw new Error(resolution.reason);
  const { identity, canonical, job: tracked } = resolution;
  if (tracked && tracked.parentSessionID !== parentSessionID) {
    throw new Error(`Task ${identity} does not belong to this session`);
  }
  const taskID = tracked?.taskID ?? identity;
  if (!SESSION_ID_PATTERN.test(taskID))
    throw new Error(`Unknown task ID or alias: ${requested}`);

  // Inspect every retained state BEFORE rejection, acknowledgement or text
  // retrieval. Busy retracts even a consumed or timed-out publication.
  let snapshot: RuntimeSessionStatusSnapshot | undefined;
  if (
    tracked &&
    typeof getClient(options.input).session?.status === 'function'
  ) {
    const observation = gate.capture(tracked);
    if (observation) {
      snapshot = await getRuntimeSessionStatusSnapshot(options.input);
      if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
      gate.observe(
        observation,
        runtimeObservationFromSnapshot(
          snapshot,
          taskID,
          observation.readStartedAt,
        ),
      );
    }
  }
  if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
  const result = tracked ? await gate.reconcile(tracked) : undefined;
  if (options.isDisposed?.()) {
    return readonlyTerminalResult(requested, tracked);
  }
  const current = canonical
    ? board.get(taskID)
    : board.resolve(parentSessionID, requested);
  if (current && current.parentSessionID !== parentSessionID) {
    throw new Error(`Task ${identity} does not belong to this session`);
  }
  if (
    tracked &&
    (!current ||
      current.generation !== tracked.generation ||
      result?.kind === 'stale')
  ) {
    throw new Error(
      `Task ${requested} changed generation while its result was being retrieved`,
    );
  }
  if (current?.state === 'running')
    return runningResultRefusal(
      idParam,
      taskID,
      current.statusUncertain,
      snapshot && runtimeSessionStatus(snapshot, taskID),
    );

  const token = current ? gate.capture(current) : undefined;
  const client = getClient(options.input);
  let hostInfo: Record<string, unknown> | undefined;
  if (typeof client.session.get === 'function') {
    const response = await client.session.get({
      path: { id: taskID },
      query: { directory: options.input.directory },
    });
    if (response.data?.parentID !== parentSessionID)
      throw new Error(`Task ${requested} does not belong to this session`);
    if (isRecord(response.data)) hostInfo = response.data;
  } else if (!current)
    throw new Error(
      `Task ${requested} is not tracked by this session and cannot be verified`,
    );

  if (current) {
    const latest = board.get(taskID);
    const after = gate.capture(current);
    if (
      options.isDisposed?.() ||
      (token === undefined && after === undefined)
    ) {
      return readonlyTerminalResult(requested, current);
    }
    if (
      latest?.generation !== current.generation ||
      latest.terminalRevision !== current.terminalRevision ||
      after?.activityRevision !== token?.activityRevision ||
      after?.attemptRevision !== token?.attemptRevision ||
      after?.episode !== token?.episode
    ) {
      throw new Error(
        `Task ${requested} changed generation or publication while its result was being retrieved; wait for its current terminal result instead of retrieving it.`,
      );
    }
    const state =
      current.state === 'reconciled' ? current.terminalState : current.state;
    if (state === 'completed' && result?.kind !== 'committed')
      return runningResultRefusal(idParam, taskID, true);
    board.markUsed(parentSessionID, taskID);
    if (state === 'error')
      throw new Error(
        `Task ${requested} ended in error: ${current.lastStatusError ?? current.resultSummary ?? 'no error details available'}`,
      );
    if (state === 'cancelled')
      throw new Error(
        `Task ${requested} was cancelled: ${current.resultSummary?.replace(/^cancelled:\s*/i, '') ?? 'cancelled'}`,
      );
    if (state !== 'completed' || !current.resultSummary?.trim())
      throw new Error(`Task ${requested} has no confirmed completed result`);
    return current.resultSummary;
  }

  // Untracked fallback: rendered from the same single read that the
  // status fallback uses. Ownership is already verified above (the
  // session.get parentID gate), so only the live probe and transcript
  // classification run here.
  const read = await readUntrackedEvidence(
    { input: options.input, readTimeoutMs: options.readTimeoutMs },
    taskID,
    hostInfo,
  );
  if (read.live.status === 'busy' || read.live.status === 'retry')
    return runningResultRefusal(
      idParam,
      taskID,
      false,
      read.live.status,
      false,
    );
  if (read.live.status === 'unknown')
    return runningResultRefusal(idParam, taskID, true, undefined, false);
  if (read.roundError) throw read.roundError;
  const evidence = read.round;
  if (!evidence || evidence.verdict === 'incomplete')
    return runningResultRefusal(idParam, taskID, true, undefined, false);
  const completedText =
    evidence.verdict === 'completed' && 'text' in evidence
      ? evidence.text
      : undefined;
  if (!completedText)
    throw new Error(
      `Task ${requested} shows no terminal evidence of completion; refusing to present partial output as its final result`,
    );
  return completedText;
}

interface UntrackedStatusOptions {
  input: PluginInput;
  now?: () => number;
  statusTimeoutMs?: number;
  isDisposed?: () => boolean;
  readTimeoutMs?: number;
}

/**
 * Read-only status for a task the board does not track: ownership and
 * evidence both come from the shared untracked-read module — the same
 * single implementation the task_status result mode's untracked path
 * uses. Never registers, prompts, or aborts anything.
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
  const unknown = () => new Error(`Unknown task ID or alias: ${identity}`);
  const ownership = await verifyUntrackedOwnership(
    options,
    identity,
    parentSessionID,
  );
  // Disposed: keep task_status's existing unknown-task contract.
  if (options.isDisposed?.()) throw unknown();
  if (ownership.kind !== 'verified') {
    if (ownership.kind === 'foreign-parent') {
      throw new Error(`Task ${ref.requested} does not belong to this session`);
    }
    throw unknown();
  }

  const details = [
    `Task ${identity} is not tracked by the local background job board (its tracking does not survive a host or plugin restart).`,
    'board: untracked',
  ];

  const evidence = await readUntrackedEvidence(
    options,
    identity,
    ownership.hostInfo,
  );
  // v1's live status map is real evidence of execution; v2 has no
  // equivalent (the shim omits `status`), so this probe is v1 only.
  if (evidence.live.status === 'busy' || evidence.live.status === 'retry') {
    details.push(`state: ${evidence.live.status} (live)`);
    details.push(
      '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
    );
    return details.join('\n');
  }

  let evidenceLine: string;
  if (evidence.live.status === 'unknown') {
    evidenceLine = `state: unknown (uncertain; live status could not be read: ${evidence.live.reason})`;
  } else if (evidence.round) {
    evidenceLine = describeUntrackedEvidence(evidence.round);
  } else {
    evidenceLine = `state: ${UNTRACKED_STATE} (uncertain; transcript could not be read)`;
  }
  details.push(evidenceLine);
  if (ownership.agent) details.push(`agent: ${ownership.agent}`);
  // The host session's creation time, not its latest activity.
  if (ownership.createdAt !== undefined)
    details.push(`created_at: ${new Date(ownership.createdAt).toISOString()}`);
  details.push(
    "next: use task_status with { result: true } for a completed task's final text",
  );
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
