import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import {
  formatChildInputWaitDetail,
  listChildInputWaits,
} from '../hooks/task-session-manager/child-input-wait';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';
import { observationFromSnapshot, summarizeTaskStatus } from './task-policy';
import {
  type CanonicalTaskResolver,
  idParamFor,
  readTaskRef,
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
        ? options.backgroundJobBoard.get(identity)
        : options.backgroundJobBoard.resolve(parentSessionID, requested);
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
 * single implementation task_result's untracked path uses. Never
 * registers, prompts, or aborts anything.
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

  const evidence = await readUntrackedEvidence(options, identity);
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
