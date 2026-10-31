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
    // A configured council plus disabled_agents:["council","observer"]
    // leaves orchestrator + explorer + oracle + designer + fixer.
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

  test('accounts only for intentionally disabled baseline tools', () => {
    expect(minimumExpectedToolCount()).toBe(9);
    expect(minimumExpectedToolCount(['wait_for_user'])).toBe(8);
    expect(minimumExpectedToolCount(['wait_for_user', 'wait_for_user'])).toBe(
      8,
    );
    expect(minimumExpectedToolCount(['task_reply'])).toBe(8);
    expect(minimumExpectedToolCount(['task_message'])).toBe(8);
    expect(minimumExpectedToolCount(['unknown_tool'])).toBe(9);
    expect(minimumExpectedToolCount([], false)).toBe(8);
    expect(minimumExpectedToolCount(['wait_for_user'], false)).toBe(7);
    expect(minimumExpectedToolCount(['webfetch'], false)).toBe(8);
    expect(minimumExpectedToolCount(['task_cancel', 'task_revive'])).toBe(7);
  });

  test('drops the floor by three on v2 (no wait_for_user, task_revive, task_message)', () => {
    // minTools 9 already excludes task_result (folded into task_status);
    // v2 drops wait_for_user, task_revive and task_message → 6.
    expect(minimumExpectedToolCount([], true, 'v2')).toBe(6);
    // disabled_tools still wins when listed: no double-counting.
    expect(minimumExpectedToolCount(['wait_for_user'], true, 'v2')).toBe(6);
    expect(minimumExpectedToolCount(['task_reply'], true, 'v2')).toBe(5);
    expect(minimumExpectedToolCount([], false, 'v2')).toBe(5);
  });

  test('v2 never lowers the floor for the tools it does not register', () => {
    // task_revive, task_message and wait_for_user are unregistered on v2, so
    // listing them under disabled_tools must not mask a genuinely missing
    // tool.
    expect(minimumExpectedToolCount(['task_revive'], true, 'v2')).toBe(6);
    expect(minimumExpectedToolCount(['task_message'], true, 'v2')).toBe(6);
    expect(
      minimumExpectedToolCount(
        ['task_revive', 'task_message', 'wait_for_user'],
        true,
        'v2',
      ),
    ).toBe(6);
    // v1 keeps them in the baseline.
    expect(minimumExpectedToolCount(['task_revive'], true, 'v1')).toBe(8);
    expect(minimumExpectedToolCount(['task_message'], true, 'v1')).toBe(8);
  });

  test('keeps at least one tool of margin for the v2 registrations', () => {
    // v2 registers: task_cancel, task_reply, task_status,
    // interview_submit_state, acp_run, webfetch, ast_grep_search,
    // ast_grep_replace (8) + marketplace_inspect + marketplace_manage (2).
    const registered = 10;
    const defaultFloor = minimumExpectedToolCount([], true, 'v2');
    expect(registered - defaultFloor).toBeGreaterThanOrEqual(1);
    // disabled_commands:["interview"] removes interview_submit_state.
    const withoutInterview = registered - 1;
    expect(withoutInterview - defaultFloor).toBeGreaterThanOrEqual(1);
    // disabled_tools:["task_revive"] changes nothing on v2 (never registered).
    expect(
      registered - minimumExpectedToolCount(['task_revive'], true, 'v2'),
    ).toBeGreaterThanOrEqual(1);
  });

  test('never throws when disabledTools is not an array', () => {
    // Regression test: a malformed/non-array config.disabled_tools value
    // must degrade to "nothing disabled" instead of crashing plugin init.
    expect(minimumExpectedToolCount('' as any)).toBe(9);
    expect(minimumExpectedToolCount(null as any)).toBe(9);
    expect(minimumExpectedToolCount({} as any)).toBe(9);
  });

  test('defaults the lifecycle switch to true (additive parameter)', () => {
    // Existing callers pass three arguments; the fourth must not change
    // the floor they already computed.
    expect(minimumExpectedToolCount([], true, 'v1')).toBe(9);
    expect(minimumExpectedToolCount([], true, 'v2')).toBe(6);
    expect(minimumExpectedToolCount(['task_reply'])).toBe(8);
  });

  test('native mode floors the two thin host-read controls only', () => {
    // v1: task_cancel + task_status + webfetch + both ast-grep tools = 5.
    expect(minimumExpectedToolCount([], true, 'v1', 'native')).toBe(5);
    // v2 drops the v1-only tools as usual: same five survive.
    expect(minimumExpectedToolCount([], true, 'v2', 'native')).toBe(5);
    // task_reply is managed-only in native mode; listing it cannot mask a
    // missing registered tool.
    expect(minimumExpectedToolCount(['task_reply'], true, 'v2', 'native')).toBe(
      5,
    );
    // A genuinely disabled native control still lowers the floor.
    expect(
      minimumExpectedToolCount(['task_cancel'], true, 'v2', 'native'),
    ).toBe(4);
    // off keeps the existing six-tool reduction.
    expect(minimumExpectedToolCount([], true, 'v2', 'off')).toBe(3);
  });

  test('drops the floor by six on v1 when the managed lifecycle is off', () => {
    // task_cancel, task_status, task_reply, task_message, task_revive and
    // wait_for_user all disappear → 9 - 6 = 3.
    expect(minimumExpectedToolCount([], true, 'v1', false)).toBe(3);
    expect(minimumExpectedToolCount([], true, undefined, false)).toBe(3);
    // Listing the unregistered tools under disabled_tools must not
    // double-count them (v1 floor is already at 3).
    expect(
      minimumExpectedToolCount(
        ['task_cancel', 'task_status', 'task_reply'],
        true,
        'v1',
        false,
      ),
    ).toBe(3);
    expect(
      minimumExpectedToolCount(
        ['task_revive', 'task_message', 'wait_for_user'],
        true,
        'v1',
        false,
      ),
    ).toBe(3);
    // webfetch is independent of the lifecycle switch and still counted.
    expect(minimumExpectedToolCount([], false, 'v1', false)).toBe(2);
  });

  test('drops the floor by three on v2 when the managed lifecycle is off', () => {
    // v2 already drops wait_for_user, task_revive and task_message; off
    // removes the three remaining task tools → 9 - 3 - 3 = 3.
    expect(minimumExpectedToolCount([], true, 'v2', false)).toBe(3);
    expect(minimumExpectedToolCount(['task_reply'], true, 'v2', false)).toBe(3);
    // The v2-unregistered tools stay non-counting.
    expect(minimumExpectedToolCount(['task_revive'], true, 'v2', false)).toBe(
      3,
    );
    expect(minimumExpectedToolCount(['task_message'], true, 'v2', false)).toBe(
      3,
    );
    expect(minimumExpectedToolCount([], false, 'v2', false)).toBe(2);
  });
});
