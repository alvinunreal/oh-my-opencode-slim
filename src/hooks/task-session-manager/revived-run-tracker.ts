import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobLease,
  BackgroundJobRecord,
  ContextFile,
} from '../../utils/background-job-board';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import type { BackgroundJobSupervisor } from '../../utils/background-job-supervisor';
import {
  extractChildTerminalEvidence,
  fetchChildTranscript,
  responseError,
  stringifyError,
} from '../../utils/child-transcript';
import { isRecord } from '../../utils/guards';
import { createInternalAgentTextPart } from '../../utils/internal-initiator';
import { getClient } from '../../utils/opencode-client';
import { COMPLETED_WITHOUT_TEXT_DIAGNOSTIC } from '../../utils/task';

const DEFAULT_NOTIFICATION_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const TERMINAL_NOTIFICATION_TIMEOUT_MS = 10_000;
const DEFAULT_STABILIZATION_PROBES = 3;
const DEFAULT_STABILIZATION_DELAY_MS = 150;

type SessionMessage = {
  info?: {
    id?: string;
    role?: string;
    error?: unknown;
    finish?: string;
    time?: { completed?: number };
  };
  parts?: Array<{
    type?: string;
    text?: string;
    state?: { status?: string };
  }>;
};

type RevivedRun = {
  taskID: string;
  generation: number;
  parentSessionID: string;
  baselineMessageID?: string;
  description: string;
  notification: {
    attempts: number;
    sent: boolean;
    pending: boolean;
    retryTimer?: ReturnType<typeof setTimeout>;
  };
  stabilizationProbes: number;
  stabilizationTimer?: ReturnType<typeof setTimeout>;
  terminalState?: 'completed' | 'error';
  probeInFlight?: Promise<boolean>;
};

export interface RevivedRunTracker {
  captureBaseline(taskID: string): Promise<string | undefined>;
  register(input: {
    taskID: string;
    generation: number;
    parentSessionID: string;
    baselineMessageID?: string;
    description: string;
  }): void;
  isTracked(taskID: string, generation: number): boolean;
  probe(taskID: string, generation: number): Promise<boolean>;
  onTerminal(record: BackgroundJobRecord): void;
  dispose(): void;
}

export function createRevivedRunTracker(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  maxNotificationRetries?: number;
  notificationRetryDelayMs?: number;
  maxStabilizationProbes?: number;
  stabilizationProbeDelayMs?: number;
  onRegister?: (taskID: string) => void;
  onSettled?: (taskID: string) => void;
  contextFilesForPrompt?: (taskID: string) => ContextFile[];
  pruneContext?: () => void;
}): RevivedRunTracker {
  const runs = new Map<string, RevivedRun>();
  const maxNotificationRetries =
    options.maxNotificationRetries ?? DEFAULT_NOTIFICATION_RETRIES;
  const retryDelayMs =
    options.notificationRetryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxStabilizationProbes =
    options.maxStabilizationProbes ?? DEFAULT_STABILIZATION_PROBES;
  const stabilizationProbeDelayMs =
    options.stabilizationProbeDelayMs ?? DEFAULT_STABILIZATION_DELAY_MS;
  let disposed = false;

  const captureBaseline = async (
    taskID: string,
  ): Promise<string | undefined> => {
    const response = await fetchChildTranscript(
      getClient(options.input),
      taskID,
      options.input.directory,
    );
    if (response === undefined) return undefined;
    const data =
      isRecord(response) && Array.isArray(response.data) ? response.data : [];
    const last = data.at(-1) as SessionMessage | undefined;
    return typeof last?.info?.id === 'string' ? last.info.id : undefined;
  };

  const isTracked = (taskID: string, generation: number): boolean => {
    const run = runs.get(taskID);
    return run?.generation === generation;
  };

  const probe = async (
    taskID: string,
    generation: number,
  ): Promise<boolean> => {
    const run = runs.get(taskID);
    if (!run || run.generation !== generation || disposed) return false;
    if (run.probeInFlight) return run.probeInFlight;

    run.probeInFlight = probeRun(run).finally(() => {
      run.probeInFlight = undefined;
    });
    return run.probeInFlight;
  };

  const onTerminal = (record: BackgroundJobRecord): void => {
    const run = runs.get(record.taskID);
    if (!run || run.generation !== record.generation) return;
    if (record.state === 'cancelled') {
      settleRun(run, record);
      options.backgroundJobSupervisor?.onTerminal(record);
      discardRun(run);
      return;
    }
    if (record.state !== 'completed' && record.state !== 'error') {
      return;
    }
    finish(run, record);
  };

  const dispose = (): void => {
    disposed = true;
    for (const run of runs.values()) {
      if (run.notification.retryTimer) {
        clearTimeout(run.notification.retryTimer);
      }
      if (run.stabilizationTimer) {
        clearTimeout(run.stabilizationTimer);
      }
    }
    runs.clear();
  };

  async function probeRun(run: RevivedRun): Promise<boolean> {
    let response: unknown;
    try {
      response = await fetchChildTranscript(
        getClient(options.input),
        run.taskID,
        options.input.directory,
      );
    } catch {
      // Transport failures and error payloads both degrade to "not yet
      // settled" — the probe retries on its stabilization schedule.
      return false;
    }
    if (response === undefined) return false;

    const evidence = extractChildTerminalEvidence(response, {
      baselineMessageID: run.baselineMessageID,
    });
    switch (evidence.kind) {
      case 'no-new-messages':
      case 'no-assistant':
      case 'pending':
        return false;
      case 'error': {
        const updated = options.backgroundJobBoard.updateStatus({
          taskID: run.taskID,
          expectedGeneration: run.generation,
          state: 'error',
          resultSummary: evidence.errorText || 'Revived child session failed.',
        });
        return updated?.generation === run.generation && finish(run, updated);
      }
      case 'ready': {
        const updated = options.backgroundJobBoard.updateStatus({
          taskID: run.taskID,
          expectedGeneration: run.generation,
          state: 'completed',
          resultSummary: evidence.text,
        });
        return updated?.generation === run.generation && finish(run, updated);
      }
      case 'textless':
        break;
    }

    if (run.stabilizationProbes >= maxStabilizationProbes) {
      const updated = options.backgroundJobBoard.updateStatus({
        taskID: run.taskID,
        expectedGeneration: run.generation,
        state: 'error',
        resultSummary: COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
        lastStatusError: COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
      });
      return updated?.generation === run.generation && finish(run, updated);
    }

    run.stabilizationProbes += 1;
    scheduleStabilizationProbe(run);
    return false;
  }

  function finish(run: RevivedRun, record: BackgroundJobRecord): boolean {
    if (record.state !== 'completed' && record.state !== 'error') return false;
    if (run.stabilizationTimer) {
      clearTimeout(run.stabilizationTimer);
      run.stabilizationTimer = undefined;
    }
    if (run.terminalState && run.terminalState !== record.state) return true;
    run.terminalState = record.state;
    settleRun(run, record);
    options.backgroundJobSupervisor?.onTerminal(record);
    if (run.notification.sent || run.notification.pending) return true;
    void notifyParent(run, record);
    return true;
  }

  function settleRun(run: RevivedRun, record: BackgroundJobRecord): void {
    options.backgroundJobBoard.addContext(
      record.taskID,
      options.contextFilesForPrompt?.(record.taskID) ?? [],
    );
    options.backgroundJobBoard.addContext(record.taskID, record.contextFiles);
    options.pruneContext?.();
    options.onSettled?.(run.taskID);
  }

  async function notifyParent(
    run: RevivedRun,
    record: BackgroundJobRecord,
  ): Promise<void> {
    if (disposed || run.notification.sent || run.notification.pending) return;
    run.notification.pending = true;
    run.notification.attempts += 1;
    try {
      const session = getClient(options.input).session;
      const promptAsync =
        typeof session.promptAsync === 'function'
          ? session.promptAsync.bind(session)
          : undefined;
      if (typeof promptAsync !== 'function') {
        throw new Error('session.promptAsync unavailable');
      }
      const current = options.backgroundJobBoard.get(run.taskID);
      if (
        !current ||
        current.generation !== run.generation ||
        terminalOutcome(current) !== run.terminalState ||
        record.state !== run.terminalState
      ) {
        discardRun(run);
        return;
      }
      const lease = options.backgroundJobBoard.acquireTerminalNotificationLease(
        run.taskID,
        run.generation,
      );
      if (!lease) {
        scheduleNotificationRetry(run, record);
        return;
      }
      const state = record.state === 'completed' ? 'completed' : 'error';
      const tag = state === 'completed' ? 'task_result' : 'task_error';
      const summary =
        state === 'completed'
          ? `Background task completed: ${run.description}`
          : `Background task failed: ${run.description}`;
      const text = [
        `<task id="${run.taskID}" state="${state}">`,
        `<summary>${summary}</summary>`,
        `<${tag}>`,
        record.resultSummary ??
          (state === 'completed' ? 'Completed.' : 'Failed.'),
        `</${tag}>`,
        '</task>',
      ].join('\n');
      const response = await awaitNotificationTransport(
        options.backgroundJobBoard,
        lease,
        () =>
          promptAsync({
            path: { id: run.parentSessionID },
            query: { directory: options.input.directory },
            body: {
              agent: 'orchestrator',
              // Internal-initiator part (synthetic flag + metadata + marker):
              // the v2 client-shim routes these through session.synthetic so
              // the notification stays machine-context instead of a visible
              // user message, and the session-prompt bridge classifies the
              // admission as internal (not external user activity). A bare
              // `synthetic: true` part loses its flag in the flat v2 prompt
              // translation (#1157).
              parts: [createInternalAgentTextPart(text)],
            },
          }),
      );
      const error = responseError(response);
      if (error !== undefined) throw new Error(stringifyError(error));
      const latest = options.backgroundJobBoard.get(run.taskID);
      if (
        !latest ||
        latest.generation !== run.generation ||
        terminalOutcome(latest) !== run.terminalState
      ) {
        discardRun(run);
        return;
      }
      run.notification.sent = true;
    } catch {
      scheduleNotificationRetry(run, record);
    } finally {
      run.notification.pending = false;
    }
  }

  function scheduleNotificationRetry(
    run: RevivedRun,
    record: BackgroundJobRecord,
  ): void {
    if (
      disposed ||
      runs.get(run.taskID) !== run ||
      run.notification.attempts >= maxNotificationRetries ||
      run.notification.retryTimer
    ) {
      return;
    }
    run.notification.retryTimer = setTimeout(() => {
      run.notification.retryTimer = undefined;
      void notifyParent(run, record);
    }, retryDelayMs);
    run.notification.retryTimer.unref?.();
  }

  function scheduleStabilizationProbe(run: RevivedRun): void {
    if (disposed || runs.get(run.taskID) !== run || run.stabilizationTimer) {
      return;
    }
    run.stabilizationTimer = setTimeout(() => {
      run.stabilizationTimer = undefined;
      void probe(run.taskID, run.generation);
    }, stabilizationProbeDelayMs);
    run.stabilizationTimer.unref?.();
  }

  function register(input: {
    taskID: string;
    generation: number;
    parentSessionID: string;
    baselineMessageID?: string;
    description: string;
  }): void {
    const old = runs.get(input.taskID);
    if (old?.notification.retryTimer) clearTimeout(old.notification.retryTimer);
    if (old?.stabilizationTimer) clearTimeout(old.stabilizationTimer);
    runs.set(input.taskID, {
      ...input,
      notification: { attempts: 0, sent: false, pending: false },
      stabilizationProbes: 0,
    });
    options.onRegister?.(input.taskID);
  }

  function discardRun(run: RevivedRun): void {
    if (runs.get(run.taskID) !== run) return;
    if (run.notification.retryTimer) clearTimeout(run.notification.retryTimer);
    if (run.stabilizationTimer) clearTimeout(run.stabilizationTimer);
    runs.delete(run.taskID);
  }

  return {
    captureBaseline,
    register,
    isTracked,
    probe,
    onTerminal,
    dispose,
  };
}

async function awaitNotificationTransport<T>(
  backgroundJobBoard: BackgroundJobStore,
  lease: BackgroundJobLease,
  operation: () => Promise<T>,
): Promise<T> {
  let settled = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const transport = Promise.resolve()
    .then(operation)
    .then(
      (value) => {
        settled = true;
        if (timedOut) backgroundJobBoard.releaseLease(lease);
        return value;
      },
      (error: unknown) => {
        settled = true;
        if (timedOut) backgroundJobBoard.releaseLease(lease);
        throw error;
      },
    );

  try {
    return await Promise.race([
      transport,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NotificationTransportTimeoutError()),
          TERMINAL_NOTIFICATION_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (error instanceof NotificationTransportTimeoutError) {
      timedOut = true;
      if (settled) backgroundJobBoard.releaseLease(lease);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (!timedOut) backgroundJobBoard.releaseLease(lease);
  }
}

class NotificationTransportTimeoutError extends Error {
  constructor() {
    super('Parent terminal notification transport timed out');
    this.name = 'NotificationTransportTimeoutError';
  }
}

function terminalOutcome(
  record: BackgroundJobRecord,
): 'completed' | 'error' | undefined {
  if (record.state === 'reconciled') {
    return record.terminalState === 'completed' ||
      record.terminalState === 'error'
      ? record.terminalState
      : undefined;
  }
  return record.state === 'completed' || record.state === 'error'
    ? record.state
    : undefined;
}
