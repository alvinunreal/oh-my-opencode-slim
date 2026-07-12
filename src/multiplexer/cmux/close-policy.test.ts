import { describe, expect, test } from 'bun:test';
import { CmuxClosePolicy } from './close-policy';

describe('CmuxClosePolicy', () => {
  test('activity cancels idle but not deleted', () => {
    const policy = new CmuxClosePolicy();
    expect(policy.activity(policy.request('idle', 1, 0))).toBeUndefined();
    expect(policy.activity(policy.request('deleted', 1, 0))?.reason).toBe(
      'deleted',
    );
  });

  test('deleted upgrades idle and refreshes its retry budget', () => {
    const policy = new CmuxClosePolicy(100, 2);
    const idle = policy.failed(policy.request('idle', 1, 0), 1);
    const deleted = policy.request('deleted', 2, 50, idle);
    expect(deleted).toMatchObject({
      reason: 'deleted',
      attempts: 0,
      deadline: 150,
      nextAttemptAt: 50,
    });
  });

  test('exhaustion enters 30 then 60 second tracked cooldown', () => {
    const policy = new CmuxClosePolicy(100, 1);
    const first = policy.failed(policy.request('cleanup', 0, 0), 1);
    expect(first).toMatchObject({ phase: 'cooldown', nextAttemptAt: 30_001 });
    const second = policy.failed(first, 30_001);
    expect(second.nextAttemptAt).toBe(90_001);
    const resumed = policy.resume(first, 30_001);
    const third = policy.failed(resumed, 30_002);
    expect(third.nextAttemptAt).toBe(90_002);
    expect(policy.complete()).toBeUndefined();
  });
});
