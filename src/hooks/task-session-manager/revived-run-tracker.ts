import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobLease,
  BackgroundJobRecord,
  ContextFile,
} from '../../utils/background-job-board';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import type { BackgroundJobSupervisor } from '../../utils/background-job-supervisor';
import { getClient } from '../../utils/opencode-client';

const DEFAULT_NOTIFICATION_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const TERMINAL_NOTIFICATION_TIMEOUT_MS = 10_000;

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
  onRegister?: (taskID: string) => void;
  onSettled?: (taskID: string) => void;
  contextFilesForPrompt?: (taskID: string) => ContextFile[];
  pruneContext?: () => void;
  shouldManageSession?: (sessionID: string) => boolean;
}): RevivedRunTracker {
  const runs = new Map<string, RevivedRun>();
  const maxNotificationRetries =
    options.maxNotificationRetries ?? DEFAULT_NOTIFICATION_RETRIES;
  const retryDelayMs =
    options.notificationRetryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let disposed = false;

  const captureBaseline = async (
    taskID: string,
  ): Promise<string | undefined> => {
    const session = getClient(options.input).session;
    const messages =
      typeof session.messages === 'function'
        ? session.messages.bind(session)
        : undefined;
    if (typeof messages !== 'function') return undefined;
    const response = await messages({
      path: { id: taskID },
      query: { directory: options.input.directory },
    });
    const error = responseError(response);
    if (error !== undefined) throw new Error(errorText(error));
    const data = Array.isArray(response.data) ? response.data : [];
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
    }
    runs.clear();
  };

  async function probeRun(run: RevivedRun): Promise<boolean> {
    const session = getClient(options.input).session;
    const messages =
      typeof session.messages === 'function'
        ? session.messages.bind(session)
        : undefined;
    if (typeof messages !== 'function') return false;
    let response: unknown;
    try {
      response = await messages({
        path: { id: run.taskID },
        query: { directory: options.input.directory },
      });
    } catch {
      return false;
    }

    const data =
      isRecord(response) && Array.isArray(response.data)
        ? (response.data as SessionMessage[])
        : [];
    const baselineIndex = run.baselineMessageID
      ? data.findIndex((message) => message.info?.id === run.baselineMessageID)
      : -1;
    if (run.baselineMessageID && baselineIndex < 0) return false;

    const lastIndex = data.length - 1;
    const last = data[lastIndex];
    if (last?.info?.role !== 'assistant') return false;
    if (lastIndex <= baselineIndex) return false;
    if (typeof last.info.time?.completed !== 'number') return false;
    if (last.info.finish === 'tool-calls' || last.info.finish === 'unknown') {
      return false;
    }
    if (hasPendingToolCall(data, baselineIndex)) return false;
    if (last.info.error !== undefined) {
      const result = errorText(last.info.error);
      const updated = options.backgroundJobBoard.updateStatus({
        taskID: run.taskID,
        expectedGeneration: run.generation,
        state: 'error',
        resultSummary: result || 'Revived child session failed.',
      });
      return updated?.generation === run.generation && finish(run, updated);
    }
    const text = (last.parts ?? [])
      .filter(
        (part) =>
          (part.type === 'text' || part.type === 'reasoning') &&
          typeof part.text === 'string' &&
          part.text.length > 0,
      )
      .map((part) => part.text as string)
      .join('\n\n')
      .trim();
    const updated = options.backgroundJobBoard.updateStatus({
      taskID: run.taskID,
      expectedGeneration: run.generation,
      state: 'completed',
      resultSummary: text,
    });
    return updated?.generation === run.generation && finish(run, updated);
  }

  function finish(run: RevivedRun, record: BackgroundJobRecord): boolean {
    if (record.state !== 'completed' && record.state !== 'error') return false;
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
    if (
      options.shouldManageSession &&
      !options.shouldManageSession(run.parentSessionID)
    )
      return;
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
              parts: [{ type: 'text', synthetic: true, text }],
            },
          }),
      );
      const error = responseError(response);
      if (error !== undefined) throw new Error(errorText(error));
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

  function register(input: {
    taskID: string;
    generation: number;
    parentSessionID: string;
    baselineMessageID?: string;
    description: string;
  }): void {
    const old = runs.get(input.taskID);
    if (old?.notification.retryTimer) clearTimeout(old.notification.retryTimer);
    runs.set(input.taskID, {
      ...input,
      notification: { attempts: 0, sent: false, pending: false },
    });
    options.onRegister?.(input.taskID);
  }

  function discardRun(run: RevivedRun): void {
    if (runs.get(run.taskID) !== run) return;
    if (run.notification.retryTimer) clearTimeout(run.notification.retryTimer);
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

function hasPendingToolCall(
  messages: SessionMessage[],
  baselineIndex: number,
): boolean {
  return messages.slice(baselineIndex + 1).some((message) =>
    (message.parts ?? []).some((part) => {
      if (part.type !== 'tool') return false;
      const status = part.state?.status;
      return status !== 'completed' && status !== 'error';
    }),
  );
}

function responseError(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  return response.error === undefined || response.error === null
    ? undefined
    : response.error;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
