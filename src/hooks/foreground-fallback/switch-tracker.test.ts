import { describe, expect, test } from 'bun:test';
import { createTimerHarness, tick } from '../../utils/test-timers';
import { SwitchTracker } from './switch-tracker';

describe('SwitchTracker', () => {
  test('drain resolves at the budget when a switch never settles', async () => {
    const clock = createTimerHarness();
    const tracker = new SwitchTracker(clock);
    tracker.track(new Promise<never>(() => {}));

    let result: boolean | undefined;
    const drain = tracker.drain(1_000).then((settled) => {
      result = settled;
    });
    await tick();
    await clock.advance(999);
    expect(result).toBeUndefined();

    await clock.advance(1);
    await drain;
    expect(result).toBe(false);
    expect(tracker.size).toBe(1);
  });

  test('a switch settling after the drain gave up is removed', async () => {
    const clock = createTimerHarness();
    const tracker = new SwitchTracker(clock);
    const late = Promise.withResolvers<void>();
    tracker.track(late.promise);

    const drain = tracker.drain(1_000);
    await tick();
    await clock.advance(1_000);
    expect(await drain).toBe(false);
    expect(tracker.size).toBe(1);

    late.resolve();
    await tick();
    expect(tracker.size).toBe(0);
  });

  test('drain resolves early once everything settles, rejections included', async () => {
    const clock = createTimerHarness();
    const tracker = new SwitchTracker(clock);
    const failing = Promise.withResolvers<void>();
    tracker.track(failing.promise).catch(() => {});

    const drain = tracker.drain(1_000);
    failing.reject(new Error('boom'));
    expect(await drain).toBe(true);
    expect(tracker.size).toBe(0);
    expect(clock.pending()).toBe(0);
  });
});
