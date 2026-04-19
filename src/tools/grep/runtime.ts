import type { ChildProcess } from 'node:child_process';
import { type CrossSpawnResult, crossSpawn } from '../../utils/compat';
import {
  DEFAULT_GREP_MAX_CONCURRENCY,
  DEFAULT_GREP_RETRY_DELAY_MS,
  GREP_BINARY,
  RG_BINARY,
} from './constants';
import type { GrepBackend } from './types';

export class RetryableRipgrepError extends Error {}
export class AbortWaitError extends Error {}

export type GrepProcess = CrossSpawnResult & {
  proc: ChildProcess;
};

const ABORT_KIND = new WeakMap<AbortSignal, 'timeout' | 'cancel'>();

export function setAbortKind(
  signal: AbortSignal,
  kind: 'timeout' | 'cancel',
): boolean {
  if (ABORT_KIND.has(signal)) {
    return false;
  }
  ABORT_KIND.set(signal, kind);
  return true;
}

export function getAbortKind(
  signal: AbortSignal,
): 'timeout' | 'cancel' | undefined {
  return ABORT_KIND.get(signal);
}

export function isTimedOutAbort(signal: AbortSignal): boolean {
  return getAbortKind(signal) === 'timeout';
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async use<T>(callback: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await callback();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new AbortWaitError('Search was cancelled before execution started.'),
      );
    }

    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const entry = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve();
      };
      const onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) {
          this.queue.splice(index, 1);
        }
        reject(
          new AbortWaitError('Search was cancelled before execution started.'),
        );
      };

      this.queue.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    next?.();
  }
}

export const RUNNER_SEMAPHORE = new Semaphore(DEFAULT_GREP_MAX_CONCURRENCY);

export function sleepWithSignal(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  if (signal.aborted) {
    return Promise.reject(
      new AbortWaitError(
        isTimedOutAbort(signal)
          ? 'Search retry backoff timed out.'
          : 'Search retry backoff was aborted.',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new AbortWaitError(
          isTimedOutAbort(signal)
            ? 'Search retry backoff timed out.'
            : 'Search retry backoff was aborted.',
        ),
      );
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

export function createGlobalAbortState(
  signal: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup: () => void;
  getTimedOut: () => boolean;
  getCancelled: () => boolean;
  timeout: () => void;
} {
  const controller = new AbortController();
  let kind: 'timeout' | 'cancel' | undefined;

  const settle = (next: 'timeout' | 'cancel', reason: string) => {
    if (!setAbortKind(controller.signal, next)) {
      return false;
    }
    kind = next;
    controller.abort(reason);
    return true;
  };

  const timeoutId = setTimeout(() => {
    if (settle('timeout', 'grep-timeout')) {
      signal.removeEventListener('abort', onAbort);
    }
  }, timeoutMs);

  const onAbort = () => {
    const next = getAbortKind(signal) === 'timeout' ? 'timeout' : 'cancel';
    if (settle(next, next === 'timeout' ? 'grep-timeout' : 'grep-cancelled')) {
      clearTimeout(timeoutId);
    }
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    },
    getTimedOut: () => kind === 'timeout',
    getCancelled: () => kind === 'cancel',
    timeout: () => {
      if (settle('timeout', 'grep-timeout')) {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

export function killProcess(proc: GrepProcess): void {
  try {
    proc.kill();
  } catch {
    // Process may have already exited.
  }
}

export function spawnRipgrep(command: string[], cwd: string): GrepProcess {
  return crossSpawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  }) as GrepProcess;
}

export interface TerminationState {
  timedOut: boolean;
  cancelled: boolean;
}

export function attachTerminationHandlers(
  proc: GrepProcess,
  timeoutMs: number,
  signal: AbortSignal,
): {
  state: TerminationState;
  cleanup: () => void;
} {
  const state: TerminationState = { timedOut: false, cancelled: false };
  let settled = false;
  const settle = (kind: 'timeout' | 'cancel') => {
    if (settled) {
      return;
    }
    settled = true;
    state.timedOut = kind === 'timeout';
    state.cancelled = kind === 'cancel';
    killProcess(proc);
  };
  const timeoutId = setTimeout(() => {
    settle('timeout');
  }, timeoutMs);

  const abortHandler = () => {
    settle(ABORT_KIND.get(signal) === 'timeout' ? 'timeout' : 'cancel');
  };

  if (signal.aborted) {
    abortHandler();
  } else {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  return {
    state,
    cleanup: () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', abortHandler);
    },
  };
}

export function createFriendlySpawnError(
  error: unknown,
  cli?: {
    backend?: GrepBackend;
    path?: string;
  },
): string | undefined {
  const code = getErrorCode(error);
  const message = toErrorMessage(error);

  if (code === 'ENOENT' || /not found|enoent/i.test(message)) {
    if (cli?.backend === 'grep' || cli?.path === GREP_BINARY) {
      return `${GREP_BINARY} is not available. ripgrep was unavailable or auto-install failed, and GNU grep could not be executed.`;
    }

    if (cli?.backend === 'rg' || cli?.path === RG_BINARY) {
      return `${RG_BINARY} is not available. Install ripgrep or allow the managed ripgrep installer to run.`;
    }

    return `No usable search backend is available. Install ripgrep (${RG_BINARY}) or provide GNU grep (${GREP_BINARY}).`;
  }

  return undefined;
}

export function isTransientFailure(error: unknown): boolean {
  const code = getErrorCode(error) ?? '';
  const message = toErrorMessage(error);
  const text = `${code} ${message}`.toLowerCase();

  return [
    'eagain',
    'emfile',
    'enfile',
    'etxtbsy',
    'resource temporarily unavailable',
    'too many open files',
    'text file busy',
  ].some((needle) => text.includes(needle));
}

export function isTransientStderr(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return [
    'resource temporarily unavailable',
    'too many open files',
    'text file busy',
  ].some((needle) => text.includes(needle));
}

export async function waitForExitAndStderr(
  proc: GrepProcess,
  stderrPromise: Promise<string>,
): Promise<{ exitCode: number; stderr: string }> {
  const [exitResult, stderr] = await Promise.allSettled([
    proc.exited,
    stderrPromise,
  ]);
  const exitCode = exitResult.status === 'fulfilled' ? exitResult.value : 1;

  return {
    exitCode,
    stderr: stderr.status === 'fulfilled' ? stderr.value : '',
  };
}

export function getRetryBackoffMs(deadline: number): number {
  return Math.min(
    DEFAULT_GREP_RETRY_DELAY_MS,
    Math.max(0, remainingTimeout(deadline) - 1),
  );
}
