/**
 * Shared session utilities for council and background managers.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';

export const SESSION_ABORT_TIMEOUT_MS = 1_000;

export const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]+$/;

export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

/** Timer handle: platform timers or a harness's numeric ids. */
export type TimerHandle = ReturnType<typeof setTimeout> | number;

/** Scheduling seam (see src/utils/test-timers.ts); defaults to platform
 *  timers. */
export type TimerSeam = {
  setTimeout: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout: (timer: TimerHandle) => void;
};

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  timers?: TimerSeam,
): Promise<T> {
  if (timeoutMs <= 0) return operation;

  const setTimer =
    timers?.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer =
    timers?.clearTimeout ??
    ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let timer: TimerHandle | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimer(() => {
          reject(new OperationTimeoutError(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    // The Promise executor above runs synchronously, but TS cannot see that.
    if (timer !== undefined) clearTimer(timer);
  }
}

export async function abortSessionWithTimeout(
  client: OpencodeClient,
  sessionId: string,
  timeoutMs = SESSION_ABORT_TIMEOUT_MS,
): Promise<void> {
  const result = await withTimeout(
    client.session.abort({ path: { id: sessionId } }),
    timeoutMs,
    `Session abort timed out after ${timeoutMs}ms`,
  );
  const failure = sessionAbortFailure(result);
  if (failure) throw new Error(failure);
}

/**
 * Error message when an SDK abort result reports a rejected request
 * (error envelope or explicit false), or null when the abort was
 * accepted. Both SDK generations resolve rather than throw on HTTP
 * errors, so the envelope must be inspected before counting an abort
 * as done.
 */
export function sessionAbortFailure(result: unknown): string | null {
  if (result === false) return 'session abort returned false';
  if (result && typeof result === 'object') {
    const error = (result as { error?: unknown }).error;
    if (error != null) {
      return `session abort rejected: ${
        typeof error === 'string' ? error : JSON.stringify(error)
      }`;
    }
  }
  return null;
}

/**
 * Parse a model reference string into provider and model IDs.
 * @param model - Model string in format "provider/model"
 * @returns Object with providerID and modelID, or null if invalid
 */
export function parseModelReference(
  model: string,
): { providerID: string; modelID: string } | null {
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= model.length - 1) {
    return null;
  }
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
}
