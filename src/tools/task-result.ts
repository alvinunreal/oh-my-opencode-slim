import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { pluginDisposedMessage } from '../hooks/task-session-manager/session-recovery';
import type { BackgroundJobStore } from '../utils/background-job-store';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
  runtimeObservationFromSnapshot,
} from '../utils/background-job-terminal-gate';
import {
  classifyTerminalEvidence,
  classifyV2HistoricalRound,
  fetchChildTranscript,
} from '../utils/child-transcript';
import { getClient } from '../utils/opencode-client';
import { SESSION_ID_PATTERN } from '../utils/session';
import {
  getRuntimeSessionStatusSnapshot,
  type RuntimeSessionStatusSnapshot,
  readLiveSession,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';
import {
  type CanonicalTaskResolver,
  idParamFor,
  readTaskRef,
  taskRefArgs,
} from './task-ref';

interface TaskResultToolOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  terminalGate?: BackgroundJobTerminalGate;
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
  isDisposed?: () => boolean;
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

function pending(
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
      'next: retry task_result after the terminal notification',
    ].join('\n');
  return [
    `${idParam}: ${taskID}`,
    uncertain
      ? 'state: running (unconfirmed)'
      : `state: ${status === 'retry' ? 'retry' : 'running'}`,
    uncertain
      ? 'message: Live task status is uncertain; no definitive running state is available.'
      : 'message: Task is still running. Wait for its terminal result.',
    `next: ${!tracked ? 'retry task_result after the task finishes' : uncertain ? 'retry task_result or use task_status to inspect the task' : 'use task_status to inspect the task'}`,
  ].join('\n');
}

export function createTaskResultTool(
  options: TaskResultToolOptions,
): Record<string, ToolDefinition> {
  const gate =
    options.terminalGate ??
    createBackgroundJobTerminalGate({
      backgroundJobBoard: options.backgroundJobBoard,
      input: options.input,
    });
  const idParam = idParamFor(options.input);
  return {
    task_result: tool({
      description: `Read-only: return a completed specialist task's final text, or a status line while it is still running. Never re-runs or re-prompts the specialist. Use this when the user asks to see a prior task's full result, or before retrying work whose completed output may already answer the request. Accepts the native ${idParam} or the parent-scoped alias from the Background Job Board.`,
      args: {
        ...taskRefArgs(idParam),
      },
      async execute(args, toolContext) {
        const parentSessionID = toolContext?.sessionID;
        if (!parentSessionID) throw new Error('task_result requires sessionID');
        const requested = readTaskRef(args, idParam);
        if (!requested) throw new Error(`task_result requires ${idParam}`);
        const canonical = options.resolveCanonicalTaskRef
          ? await options.resolveCanonicalTaskRef(parentSessionID, requested)
          : undefined;
        if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
        if (canonical?.kind === 'refused') throw new Error(canonical.reason);
        const identity = canonical?.taskID ?? requested;
        const board = options.backgroundJobBoard;
        const tracked = canonical
          ? board.get(identity)
          : board.resolve(parentSessionID, requested);
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
            if (options.isDisposed?.())
              throw new Error(pluginDisposedMessage());
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
          return pending(
            idParam,
            taskID,
            current.statusUncertain,
            snapshot && runtimeSessionStatus(snapshot, taskID),
          );

        const token = current ? gate.capture(current) : undefined;
        const client = getClient(options.input);
        if (typeof client.session.get === 'function') {
          const response = await client.session.get({
            path: { id: taskID },
            query: { directory: options.input.directory },
          });
          if (response.data?.parentID !== parentSessionID)
            throw new Error(
              `Task ${requested} does not belong to this session`,
            );
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
            current.state === 'reconciled'
              ? current.terminalState
              : current.state;
          if (state === 'completed' && result?.kind !== 'committed')
            return pending(idParam, taskID, true);
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
            throw new Error(
              `Task ${requested} has no confirmed completed result`,
            );
          return current.resultSummary;
        }

        // v2 data: the context's idle marker ends a round, not a status map.
        const v2 =
          (options.input as { hostFlavor?: string }).hostFlavor === 'v2';
        if (!v2) {
          const live = await readLiveSession(options.input, taskID);
          if (live.kind === 'busy' || live.kind === 'retry')
            return pending(idParam, taskID, false, live.kind, false);
          if (live.kind === 'unknown')
            return pending(idParam, taskID, true, undefined, false);
        }
        const response = await fetchChildTranscript(
          client,
          taskID,
          options.input.directory,
        );
        const evidence = v2
          ? classifyV2HistoricalRound(response)
          : classifyTerminalEvidence(response);
        if (evidence.verdict === 'incomplete')
          return pending(idParam, taskID, true, undefined, false);
        if (evidence.verdict !== 'completed' || !evidence.text)
          throw new Error(
            `Task ${requested} shows no terminal evidence of completion; refusing to present partial output as its final result`,
          );
        return evidence.text;
      },
    }),
  };
}
