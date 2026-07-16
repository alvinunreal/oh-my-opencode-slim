import { describe, expect, test } from 'bun:test';
import { handleTaskSessionEvent } from './index-event';

describe('plugin disposal event ordering', () => {
  test('invalidates task continuations before multiplexer handling and cleanup', async () => {
    const calls: string[] = [];
    let releaseCleanup = (): void => {
      throw new Error('disposal cleanup did not start');
    };
    let notifyCleanupStarted = (): void => {};
    const cleanupStarted = new Promise<void>((resolve) => {
      notifyCleanupStarted = resolve;
    });

    const eventPromise = handleTaskSessionEvent(
      { event: { type: 'server.instance.disposed' } },
      async () => {
        calls.push('invalidate');
      },
      async () => {
        calls.push('multiplexer');
      },
      async () => {
        calls.push('cleanup');
        notifyCleanupStarted();
        await new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
      },
    );

    await cleanupStarted;
    expect(calls).toEqual(['invalidate', 'multiplexer', 'cleanup']);

    releaseCleanup();
    await eventPromise;
  });
});
