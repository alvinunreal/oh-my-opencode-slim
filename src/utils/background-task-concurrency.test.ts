import { describe, expect, test } from 'bun:test';
import {
  BackgroundTaskConcurrency,
  BackgroundTaskConcurrencyQueueCancelledError,
  getBackgroundTaskConcurrency,
  resetBackgroundTaskConcurrencyForTests,
} from './background-task-concurrency';

const limited = (overrides = {}) =>
  new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
    ...overrides,
  });

describe('BackgroundTaskConcurrency', () => {
  test('admits one task and queues the next task', async () => {
    const scheduler = limited();
    const first = scheduler.acquire({ model: 'openai/fast' });
    const second = scheduler.acquire({ model: 'openai/fast' });

    await first.ready;
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 1 });

    let secondReady = false;
    void second.ready.then(() => {
      secondReady = true;
    });
    await Promise.resolve();
    expect(secondReady).toBe(false);

    first.bind('ses_first');
    scheduler.releaseTask('ses_first');
    await second.ready;
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
  });

  test('preserves admission order under the default cap', async () => {
    const scheduler = limited();
    const first = scheduler.acquire({ model: 'openai/fast' });
    const second = scheduler.acquire({ model: 'openai/fast' });
    const order: string[] = [];

    await first.ready;
    order.push('first');
    first.bind('ses_first');
    void second.ready.then(() => order.push('second'));
    scheduler.releaseTask('ses_first');
    await second.ready;

    expect(order).toEqual(['first', 'second']);
  });

  test('applies provider and model caps for their own keys', async () => {
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 3,
      providerConcurrency: { openai: 1 },
      modelConcurrency: { 'anthropic/slow': 1 },
    });
    const openaiFirst = scheduler.acquire({ model: 'openai/fast' });
    const openaiSecond = scheduler.acquire({ model: 'openai/cheap' });
    const anthropic = scheduler.acquire({ model: 'anthropic/slow' });

    await openaiFirst.ready;
    await anthropic.ready;
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 1 });

    openaiFirst.bind('ses_openai');
    scheduler.releaseTask('ses_openai');
    await openaiSecond.ready;
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 0 });
  });

  test('a model cap takes precedence over an unrestricted default', async () => {
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 0,
      providerConcurrency: {},
      modelConcurrency: { 'openai/slow': 1 },
    });
    const first = scheduler.acquire({ model: 'openai/slow' });
    const second = scheduler.acquire({ model: 'openai/slow' });

    await first.ready;
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 1 });
    first.release();
    await second.ready;
  });

  test('the most specific configured cap wins: model > provider > default', async () => {
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: { openai: 1 },
      modelConcurrency: { 'openai/gpt-4o': 3 },
    });
    const first = scheduler.acquire({ model: 'openai/gpt-4o' });
    const second = scheduler.acquire({ model: 'openai/gpt-4o' });
    const third = scheduler.acquire({ model: 'openai/gpt-4o' });

    await Promise.all([first.ready, second.ready, third.ready]);
    expect(scheduler.snapshot()).toEqual({ active: 3, queued: 0 });
  });

  test('a provider cap overrides the default cap', async () => {
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: { openai: 3 },
      modelConcurrency: {},
    });
    const first = scheduler.acquire({ model: 'openai/fast' });
    const second = scheduler.acquire({ model: 'openai/cheap' });

    await Promise.all([first.ready, second.ready]);
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 0 });
  });

  test('a provider cap of zero means unlimited for that provider', async () => {
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: { openai: 0 },
      modelConcurrency: {},
    });
    const first = scheduler.acquire({ model: 'openai/fast' });
    const second = scheduler.acquire({ model: 'openai/fast' });

    await Promise.all([first.ready, second.ready]);
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 0 });
  });

  test('does not cap tasks when all limits are disabled', async () => {
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 0,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const first = scheduler.acquire({ model: 'openai/fast' });
    const second = scheduler.acquire({ model: 'anthropic/slow' });

    await Promise.all([first.ready, second.ready]);
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 0 });
  });

  test('restoreTask reclaims a slot for an already-running task and is idempotent', async () => {
    const scheduler = limited();
    scheduler.restoreTask('ses_running', 'openai/fast');
    // A second restore for the same task must not double-count the slot.
    scheduler.restoreTask('ses_running', 'openai/fast');

    const next = scheduler.acquire({ model: 'openai/fast' });
    let nextReady = false;
    void next.ready.then(() => {
      nextReady = true;
    });
    await Promise.resolve();
    expect(nextReady).toBe(false);

    scheduler.releaseTask('ses_running');
    await next.ready;
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
  });

  test('restored tasks are accounted against their resolved provider/model cap', async () => {
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 10,
      providerConcurrency: { openai: 1 },
      modelConcurrency: {},
    });
    scheduler.restoreTask('ses_running', 'openai/gpt-4o');

    const next = scheduler.acquire({ model: 'openai/cheap' });
    let nextReady = false;
    void next.ready.then(() => {
      nextReady = true;
    });
    await Promise.resolve();
    expect(nextReady).toBe(false);

    scheduler.releaseTask('ses_running');
    await next.ready;
  });

  test('migrateTask moves provider accounting when a task switches models', async () => {
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 10,
      providerConcurrency: { openai: 1, google: 1 },
      modelConcurrency: {},
    });
    const openai = scheduler.acquire({ model: 'openai/gpt-4o' });
    await openai.ready;
    openai.bind('ses_openai');

    // A second openai task is blocked by the openai cap.
    const blockedOpenai = scheduler.acquire({ model: 'openai/cheap' });
    let openaiBlocked = false;
    void blockedOpenai.ready.then(() => {
      openaiBlocked = true;
    });
    await Promise.resolve();
    expect(openaiBlocked).toBe(false);

    // The openai task falls back to google: the openai slot frees and the
    // google accounting now includes this task.
    scheduler.migrateTask('ses_openai', 'google/gemini-pro');
    await blockedOpenai.ready;
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 0 });

    // Now the migrated task holds the single google slot.
    const blockedGoogle = scheduler.acquire({ model: 'google/gemini-flash' });
    let googleBlocked = false;
    void blockedGoogle.ready.then(() => {
      googleBlocked = true;
    });
    await Promise.resolve();
    expect(googleBlocked).toBe(false);

    scheduler.releaseTask('ses_openai');
    await blockedGoogle.ready;
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 0 });
  });

  test('releasing an unbound ticket removes it from the queue', async () => {
    const scheduler = limited();
    const first = scheduler.acquire({ model: 'openai/fast' });
    const second = scheduler.acquire({ model: 'openai/fast' });

    await first.ready;
    second.releaseIfUnbound();
    await expect(second.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
    first.release();
  });

  test('dispose cancels queued tickets and releases active capacity', async () => {
    const scheduler = limited();
    const first = scheduler.acquire({ model: 'openai/fast' });
    const second = scheduler.acquire({ model: 'openai/fast' });

    await first.ready;
    scheduler.dispose();

    await expect(second.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  describe('process-scoped shared instances', () => {
    const config = (overrides = {}) => ({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
      ...overrides,
    });

    test('returns the same instance and keeps running + queued state across re-inits', async () => {
      resetBackgroundTaskConcurrencyForTests();
      try {
        const scheduler = getBackgroundTaskConcurrency('proj-a', config());
        const first = scheduler.acquire({ model: 'openai/fast' });
        await first.ready;
        first.bind('ses_first');

        const second = scheduler.acquire({ model: 'openai/fast' });
        let secondReady = false;
        void second.ready.then(() => {
          secondReady = true;
        });
        await Promise.resolve();
        expect(secondReady).toBe(false);

        // Simulate a plugin re-init: the factory re-runs and re-requests the
        // shared scheduler. Running slots AND queued tickets must survive —
        // the queued ticket is NOT rejected.
        const again = getBackgroundTaskConcurrency('proj-a', config());
        expect(again).toBe(scheduler);
        expect(scheduler.snapshot()).toEqual({ active: 1, queued: 1 });
        expect(secondReady).toBe(false);

        scheduler.releaseTask('ses_first');
        await second.ready;
        expect(secondReady).toBe(true);
        expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
      } finally {
        resetBackgroundTaskConcurrencyForTests();
      }
    });

    test('isolates schedulers per project directory', async () => {
      resetBackgroundTaskConcurrencyForTests();
      try {
        const schedulerA = getBackgroundTaskConcurrency('proj-a', config());
        const schedulerB = getBackgroundTaskConcurrency('proj-b', config());
        expect(schedulerA).not.toBe(schedulerB);

        const a = schedulerA.acquire({ model: 'openai/fast' });
        await a.ready;
        a.bind('ses_a_first');
        const a2 = schedulerA.acquire({ model: 'openai/fast' });
        void a2.ready.catch(() => {});
        await Promise.resolve();
        expect(schedulerA.snapshot()).toEqual({ active: 1, queued: 1 });

        // Project B is unaffected by A's saturated queue and A's re-init.
        const b = schedulerB.acquire({ model: 'openai/fast' });
        await b.ready;
        expect(schedulerB.snapshot()).toEqual({ active: 1, queued: 0 });

        // A re-init for A must not mutate B's config either.
        getBackgroundTaskConcurrency(
          'proj-a',
          config({ defaultConcurrency: 2 }),
        );
        const b2 = schedulerB.acquire({ model: 'openai/fast' });
        let b2Ready = false;
        void b2.ready.then(
          () => {
            b2Ready = true;
          },
          () => {},
        );
        await Promise.resolve();
        expect(b2Ready).toBe(false);
        expect(schedulerB.snapshot()).toEqual({ active: 1, queued: 1 });
      } finally {
        resetBackgroundTaskConcurrencyForTests();
      }
    });

    test('updateConfig re-resolves queued tiers and re-pumps', async () => {
      const scheduler = new BackgroundTaskConcurrency({
        defaultConcurrency: 1,
        providerConcurrency: {},
        modelConcurrency: {},
      });
      const first = scheduler.acquire({ model: 'openai/fast' });
      await first.ready;
      first.bind('ses_first');
      const second = scheduler.acquire({ model: 'openai/fast' });
      await Promise.resolve();
      expect(scheduler.snapshot()).toEqual({ active: 1, queued: 1 });

      // Raising the default cap admits the queued task immediately.
      scheduler.updateConfig({
        defaultConcurrency: 2,
        providerConcurrency: {},
        modelConcurrency: {},
      });
      await second.ready;
      expect(scheduler.snapshot()).toEqual({ active: 2, queued: 0 });
    });

    test('updateConfig re-counts running tasks against a newly tightened provider cap', async () => {
      // Two OpenAI tasks admitted while the provider was unrestricted, then
      // the config tightens the openai cap to 1: the running tasks must now
      // count against it, so a third openai task queues instead of starting.
      const scheduler = new BackgroundTaskConcurrency({
        defaultConcurrency: 10,
        providerConcurrency: {},
        modelConcurrency: {},
      });
      const first = scheduler.acquire({ model: 'openai/gpt-4o' });
      const second = scheduler.acquire({ model: 'openai/cheap' });
      await Promise.all([first.ready, second.ready]);
      first.bind('ses_openai_1');
      second.bind('ses_openai_2');
      expect(scheduler.snapshot()).toEqual({ active: 2, queued: 0 });

      scheduler.updateConfig({
        defaultConcurrency: 10,
        providerConcurrency: { openai: 1 },
        modelConcurrency: {},
      });

      const third = scheduler.acquire({ model: 'openai/gpt-4o-mini' });
      let thirdReady = false;
      void third.ready.then(() => {
        thirdReady = true;
      });
      await Promise.resolve();
      expect(thirdReady).toBe(false);
      expect(scheduler.snapshot()).toEqual({ active: 2, queued: 1 });

      // Releasing one running openai task keeps the cap full (the other
      // still runs); releasing both frees the slot for the queued task.
      scheduler.releaseTask('ses_openai_2');
      await Promise.resolve();
      expect(thirdReady).toBe(false);

      scheduler.releaseTask('ses_openai_1');
      await third.ready;
      expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
    });

    test('a disposed shared instance is replaced by a fresh one', () => {
      resetBackgroundTaskConcurrencyForTests();
      try {
        const first = getBackgroundTaskConcurrency('proj-a', config());
        first.dispose();
        const second = getBackgroundTaskConcurrency('proj-a', config());
        expect(second).not.toBe(first);
        expect(second.isDisposed()).toBe(false);
      } finally {
        resetBackgroundTaskConcurrencyForTests();
      }
    });
  });
});
