import { describe, expect, mock, test } from 'bun:test';
import {
  abortSessionWithTimeout,
  OperationTimeoutError,
  promptWithTimeout,
  withTimeout,
} from './session';

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('session utilities', () => {
  test('withTimeout resolves without waiting for the timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 50, 'too slow');

    expect(result).toBe('ok');
  });

  test('withTimeout rejects with OperationTimeoutError when operation hangs', async () => {
    await expect(withTimeout(never(), 5, 'too slow')).rejects.toThrow(
      OperationTimeoutError,
    );
  });

  test('promptWithTimeout aborts a timed-out prompt before rejecting', async () => {
    const abort = mock(async () => ({}));
    const prompt = mock(() => never());
    const client = {
      session: {
        abort,
        prompt,
      },
    } as any;

    await expect(
      promptWithTimeout(client, { path: { id: 's1' }, body: { parts: [] } }, 5),
    ).rejects.toThrow('Prompt timed out after 5ms');

    expect(abort).toHaveBeenCalledWith({ path: { id: 's1' } });
  });

  test('promptWithTimeout preserves timeout error when abort fails', async () => {
    const abort = mock(async () => {
      throw new Error('abort failed');
    });
    const prompt = mock(() => never());
    const client = {
      session: {
        abort,
        prompt,
      },
    } as any;

    await expect(
      promptWithTimeout(client, { path: { id: 's1' }, body: { parts: [] } }, 5),
    ).rejects.toThrow('Prompt timed out after 5ms');

    // Abort must still be attempted even though it threw; the original
    // timeout error is preserved.
    expect(abort).toHaveBeenCalledWith({ path: { id: 's1' } });
  });

  test('promptWithTimeout honors abort signal when timeout is disabled', async () => {
    const controller = new AbortController();
    const abort = mock(async () => ({}));
    const prompt = mock(() => never());
    const client = {
      session: {
        abort,
        prompt,
      },
    } as any;

    queueMicrotask(() => controller.abort());

    await expect(
      promptWithTimeout(
        client,
        { path: { id: 's1' }, body: { parts: [] } },
        0,
        controller.signal,
      ),
    ).rejects.toThrow('Prompt cancelled');

    // Signal cancel must abort the server-side session, same as timeout.
    // Without this, the parent tool returns cancelled while the child keeps
    // running (orphan session).
    expect(abort).toHaveBeenCalledWith({ path: { id: 's1' } });
  });

  test('promptWithTimeout returns when prompt resolves with no timeout', async () => {
    const abort = mock(async () => ({}));
    const prompt = mock(async () => ({}));
    const client = {
      session: {
        abort,
        prompt,
      },
    } as any;

    await expect(
      promptWithTimeout(client, { path: { id: 's1' }, body: { parts: [] } }, 0),
    ).resolves.toBeUndefined();
  });

  test('abortSessionWithTimeout rejects if abort hangs', async () => {
    const client = {
      session: {
        abort: mock(() => never()),
      },
    } as any;

    await expect(abortSessionWithTimeout(client, 's1', 5)).rejects.toThrow(
      'Session abort timed out after 5ms',
    );
  });
});
