import { describe, expect, test } from 'bun:test';
import { minimumExpectedToolCount } from './health-check';

describe('plugin health thresholds', () => {
  test('accounts only for intentionally disabled baseline tools', () => {
    expect(minimumExpectedToolCount()).toBe(10);
    expect(minimumExpectedToolCount(['wait_for_user'])).toBe(9);
    expect(minimumExpectedToolCount(['wait_for_user', 'wait_for_user'])).toBe(
      9,
    );
    expect(minimumExpectedToolCount(['unknown_tool'])).toBe(10);
    expect(minimumExpectedToolCount([], false)).toBe(9);
    expect(minimumExpectedToolCount(['wait_for_user'], false)).toBe(8);
    expect(minimumExpectedToolCount(['webfetch'], false)).toBe(9);
    expect(
      minimumExpectedToolCount(['task_cancel', 'task_message', 'task_revive']),
    ).toBe(7);
  });

  test('never throws when disabledTools is not an array', () => {
    // Regression test: a malformed/non-array config.disabled_tools value
    // must degrade to "nothing disabled" instead of crashing plugin init.
    expect(minimumExpectedToolCount('' as any)).toBe(10);
    expect(minimumExpectedToolCount(null as any)).toBe(10);
    expect(minimumExpectedToolCount({} as any)).toBe(10);
  });
});
