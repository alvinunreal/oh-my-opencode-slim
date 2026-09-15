import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { RevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import type { BackgroundJobSupervisor } from '../utils/background-job-supervisor';
import { getClient } from '../utils/opencode-client';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import {
  assertOrchestrator,
  cancelTrackedExecution,
  type TaskControlToolOptions,
} from './cancel-task';

const z = tool.schema;

export interface TaskReviveToolOptions extends TaskControlToolOptions {
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  revivedRunTracker: RevivedRunTracker;
}

export function createTaskReviveTool(
  options: TaskReviveToolOptions,
): Record<'task_revive', ToolDefinition> {
  const revivedRunTracker = options.revivedRunTracker;
  const task_revive = tool({
    description:
      'Revive a retained background task in its existing session with a new prompt.',
    args: {
      task_id: z
        .string()
        .describe('Tracked background task ID or Background Job Board alias'),
      prompt: z.string().min(1).describe('Prompt for the revived task'),
    },
    async execute(args, toolContext) {
      const parentSessionID = assertOrchestrator(
        options,
        toolContext,
        'task_revive',
      );
      const requested = args.task_id.trim();
      const prompt = args.prompt.trim();
      if (!requested) throw new Error('task_revive requires task_id');
      if (!prompt) throw new Error('task_revive requires prompt');

      const resolved = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!resolved) {
        throw new Error(`Unknown or unowned background task: ${requested}`);
      }

      let current = getCurrentReviveJob(
        options,
        parentSessionID,
        requested,
        resolved.taskID,
        resolved.generation,
      );
      const captured = {
        taskID: current.taskID,
        generation: current.generation,
      };

      let cancelledForRevive = false;
      if (current.state === 'running') {
        await cancelTrackedExecution(options, captured, 'revived');
        cancelledForRevive = true;
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          requested,
          captured.taskID,
          captured.generation,
        );
      }

      if (!cancelledForRevive && !isReviveableRetainedJob(current)) {
        throw new Error(
          `Task ${requested} cannot be revived: state ${current.state} is not a verified retained terminal session`,
        );
      }

      const relaunchLease = options.backgroundJobBoard.acquireRelaunchLease(
        current.taskID,
        current.generation,
      );
      if (!relaunchLease) {
        throw new Error(
          `Task ${requested} cannot be revived: relaunch lease unavailable`,
        );
      }

      let baselineMessageID: string | undefined;
      let launched:
        | ReturnType<
            TaskControlToolOptions['backgroundJobBoard']['registerLaunch']
          >
        | undefined;
      try {
        const observedLiveBusyAt = current.lastLiveBusyAt;
        baselineMessageID = await revivedRunTracker.captureBaseline(
          current.taskID,
        );
        // captureBaseline awaits network I/O; the record may have changed
        // while we waited. Revalidate against the live record before
        // sending anything: never relaunch over a session that is
        // running again. A live relaunch lease keeps the board record
        // stopped while a revive is in flight (the busy observation only
        // advances lastLiveBusyAt), so treat any movement of that
        // timestamp as fresh activity and refuse.
        const rechecked = getCurrentReviveJob(
          options,
          parentSessionID,
          requested,
          captured.taskID,
          captured.generation,
        );
        const freshLiveActivity =
          rechecked.lastLiveBusyAt !== undefined &&
          rechecked.lastLiveBusyAt !== observedLiveBusyAt;
        if (
          !options.backgroundJobBoard.validateLease(relaunchLease) ||
          rechecked.state === 'running' ||
          !isReviveableRetainedJob(rechecked) ||
          freshLiveActivity
        ) {
          throw new Error(
            `Task ${requested} became active again (${rechecked.state}) before the revive prompt was sent; the prompt was NOT sent and no duplicate was launched. Use task_status to inspect it.`,
          );
        }
        current = rechecked;
        // Fence the send against independent host-level resumes. The
        // board record stays stopped under the relaunch lease, so the
        // host's live status map is the only place an independently
        // resumed session shows up. On v2 hosts promptAsync degrades to
        // steering an in-flight run instead of rejecting it, so a busy
        // or retry entry must refuse here; an unverifiable map refuses
        // rather than guessing. A verified-absent entry means no active
        // runner: the session is idle and safe to prompt.
        const liveSnapshot = await getRuntimeSessionStatusSnapshot(
          options.input,
        );
        const liveStatus = liveSnapshot.statuses.get(current.taskID);
        if (liveStatus === 'busy' || liveStatus === 'retry') {
          throw new Error(
            `Task ${requested} is executing at the host (live status: ${liveStatus}); the revive prompt was NOT sent and no duplicate was launched. Use task_status to inspect it.`,
          );
        }
        if (
          liveSnapshot.error !== undefined ||
          liveSnapshot.malformedSessionIDs.has(current.taskID)
        ) {
          throw new Error(
            `Task ${requested} could not be verified against the live session map (${liveSnapshot.error ?? 'malformed entry'}); the revive prompt was NOT sent. Retry task_revive.`,
          );
        }
        const session = getClient(options.input).session;
        if (typeof session.promptAsync !== 'function') {
          throw new Error('The host session does not support promptAsync');
        }
        // Close the check-then-act window for good: a session can become
        // active between the live-status read above and this send. On v2
        // hosts the default prompt delivery is `steer`, which injects into
        // an in-flight run instead of rejecting; `queue` makes the send
        // safe (the prompt waits for idle, v1 prompt_async semantics) so a
        // raced revive can never steer or duplicate an active run. The v1
        // SDK ignores the extra client-side argument (not part of the HTTP
        // request); the v2 shim threads it to the host.
        const response = await (
          session.promptAsync as (
            args: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          path: { id: current.taskID },
          query: { directory: options.input.directory },
          body: {
            agent: current.agent,
            parts: [{ type: 'text', text: prompt }],
          },
          delivery: 'queue',
        });
        const responseError = getApiError(response);
        if (responseError !== undefined) {
          throw new Error(errorText(responseError));
        }

        launched = options.backgroundJobBoard.registerLaunch({
          taskID: current.taskID,
          parentSessionID,
          agent: current.agent,
          description: current.description,
          objective: current.objective,
          background: true,
          relaunchLease,
        });
        if (launched.generation <= current.generation) {
          throw new Error(`Task ${requested} did not receive a new generation`);
        }
        revivedRunTracker.register({
          taskID: launched.taskID,
          generation: launched.generation,
          parentSessionID,
          baselineMessageID,
          description: launched.description,
        });
        options.backgroundJobSupervisor?.onLaunch(launched);
        await revivedRunTracker.probe(launched.taskID, launched.generation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (launched) {
          options.backgroundJobBoard.markStatusUncertain(
            current.taskID,
            `task_revive failed: ${message}`,
            launched.generation,
          );
        }
        throw new Error(`Task ${requested} revive failed: ${message}`);
      } finally {
        options.backgroundJobBoard.releaseLease(relaunchLease);
      }

      if (!launched) {
        throw new Error(`Task ${requested} revive did not launch`);
      }
      const latest = options.backgroundJobBoard.get(current.taskID);
      if (!latest || latest.generation !== launched.generation) {
        throw new Error(
          `Task ${requested} revive became stale before launch completed`,
        );
      }
      return renderReviveOutput(latest);
    },
  });

  return { task_revive };
}

function renderReviveOutput(
  record: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
  >,
): string {
  const state =
    record.state === 'reconciled'
      ? (record.terminalState ?? record.state)
      : record.state;
  const lines = [
    `task_id: ${record.taskID}`,
    `generation: ${record.generation}`,
    `state: ${state}`,
    `status: ${state === 'running' ? 'started' : state}`,
  ];
  if (record.resultSummary !== undefined) {
    const tag = state === 'completed' ? 'task_result' : 'task_error';
    lines.push('', `<${tag}>`, record.resultSummary, `</${tag}>`);
  }
  return lines.join('\n');
}

function getCurrentReviveJob(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  requested: string,
  taskID: string,
  generation: number,
): NonNullable<ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>> {
  const current = options.backgroundJobBoard.get(taskID);
  const resolved = options.backgroundJobBoard.resolve(
    parentSessionID,
    requested,
  );
  if (!current || !resolved || resolved.taskID !== taskID) {
    throw new Error(
      `Task ${requested} is no longer tracked; refusing stale revive`,
    );
  }
  if (current.generation !== generation || resolved.generation !== generation) {
    throw new Error(
      `Task ${requested} run generation changed; refusing stale revive`,
    );
  }
  return current;
}

function isReviveableRetainedJob(
  job: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
  >,
): boolean {
  if (job.statusUncertain) return false;
  if (job.state === 'stopped') return true;
  if (
    job.state === 'completed' ||
    job.state === 'error' ||
    job.state === 'cancelled'
  ) {
    return true;
  }
  return job.state === 'reconciled' && job.terminalState !== undefined;
}

function getApiError(response: unknown): unknown {
  if (!response || typeof response !== 'object') return undefined;
  const record = response as Record<string, unknown>;
  return record.error === undefined || record.error === null
    ? undefined
    : record.error;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
