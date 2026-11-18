import { describe, expect, test } from 'bun:test';
import { ALL_AGENT_NAMES } from './config/constants';
import {
  minimumExpectedAgentCount,
  minimumExpectedToolCount,
} from './health-check';

describe('plugin health thresholds', () => {
  test('agent floor accounts for the configured disabled roster', () => {
    expect(
      minimumExpectedAgentCount(['explorer', 'oracle', 'designer', 'fixer']),
    ).toBe(4);
    expect(minimumExpectedAgentCount(['observer'])).toBe(7);
    expect(
      minimumExpectedAgentCount([
        'explorer',
        'oracle',
        'designer',
        'fixer',
        'observer',
      ]),
    ).toBe(3);
  });

  test('agent floor omits council agents when no council is configured', () => {
    expect(minimumExpectedAgentCount(['observer'], false)).toBe(5);
    expect(
      minimumExpectedAgentCount(
        ['explorer', 'oracle', 'designer', 'fixer'],
        false,
      ),
    ).toBe(2);
    expect(minimumExpectedAgentCount(['observer'], true)).toBe(7);
  });

  test('agent floor follows createAgents when council is explicitly disabled', () => {
    expect(minimumExpectedAgentCount(['council', 'observer'])).toBe(5);
    expect(
      minimumExpectedAgentCount(['council', 'observer', 'explorer'], true),
    ).toBe(4);
  });

  test('agent floor safely handles malformed or exhaustive disabled input', () => {
    expect(minimumExpectedAgentCount('' as any)).toBe(ALL_AGENT_NAMES.length);
    expect(minimumExpectedAgentCount(null as any)).toBe(ALL_AGENT_NAMES.length);
    expect(minimumExpectedAgentCount({} as any)).toBe(ALL_AGENT_NAMES.length);
    expect(minimumExpectedAgentCount([...ALL_AGENT_NAMES])).toBe(1);
  });

  test('drops the floor by three on v2 (no wait_for_user, task_revive, task_message)', () => {
    expect(minimumExpectedToolCount([], true)).toBe(6);
    expect(minimumExpectedToolCount(['wait_for_user'], true)).toBe(6);
    expect(minimumExpectedToolCount(['task_reply'], true)).toBe(5);
    expect(minimumExpectedToolCount([], false)).toBe(5);
  });

  test('v2 never lowers the floor for the tools it does not register', () => {
    expect(minimumExpectedToolCount(['task_revive'], true)).toBe(6);
    expect(minimumExpectedToolCount(['task_message'], true)).toBe(6);
    expect(
      minimumExpectedToolCount(
        ['task_revive', 'task_message', 'wait_for_user'],
        true,
      ),
    ).toBe(6);
  });

  test('keeps at least one tool of margin for the v2 registrations', () => {
    const registered = 10;
    const defaultFloor = minimumExpectedToolCount([], true);
    expect(registered - defaultFloor).toBeGreaterThanOrEqual(1);
    const withoutInterview = registered - 1;
    expect(withoutInterview - defaultFloor).toBeGreaterThanOrEqual(1);
    expect(
      registered - minimumExpectedToolCount(['task_revive'], true),
    ).toBeGreaterThanOrEqual(1);
  });

  test('never throws when disabledTools is not an array', () => {
    expect(minimumExpectedToolCount('' as any)).toBe(6);
    expect(minimumExpectedToolCount(null as any)).toBe(6);
    expect(minimumExpectedToolCount({} as any)).toBe(6);
  });

  test('native mode includes the v2 permission reply in its baseline', () => {
    expect(minimumExpectedToolCount([], true, 'native')).toBe(6);
    expect(minimumExpectedToolCount(['task_reply'], true, 'native')).toBe(5);
    expect(minimumExpectedToolCount(['task_cancel'], true, 'native')).toBe(5);
    expect(
      minimumExpectedToolCount(
        ['task_cancel', 'task_status', 'task_reply'],
        true,
        'native',
      ),
    ).toBe(3);
    expect(minimumExpectedToolCount([], true, 'off')).toBe(3);
  });

  test('task_report stays outside the baseline in every host lifecycle', () => {
    for (const mode of ['native', 'off'] as const) {
      expect(minimumExpectedToolCount(['task_report'], true, mode)).toBe(
        minimumExpectedToolCount([], true, mode),
      );
    }
  });

  test('drops the floor by three on v2 when the managed lifecycle is off', () => {
    expect(minimumExpectedToolCount([], true, 'off')).toBe(3);
    expect(minimumExpectedToolCount(['task_reply'], true, 'off')).toBe(3);
    expect(minimumExpectedToolCount(['task_revive'], true, 'off')).toBe(3);
    expect(minimumExpectedToolCount(['task_message'], true, 'off')).toBe(3);
    expect(minimumExpectedToolCount([], false, 'off')).toBe(2);
  });
});
