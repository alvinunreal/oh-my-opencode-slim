import { describe, expect, test } from 'bun:test';
import { subagentArgsToV1, toolNameToV1, v1ArgsToSubagent } from './delegation';

describe('delegation normalization', () => {
  test('renames subagent to task only', () => {
    expect(toolNameToV1('subagent')).toBe('task');
    expect(toolNameToV1('Subagent')).toBe('task');
    expect(toolNameToV1('read')).toBe('read');
  });

  test('maps v2 args to v1 view', () => {
    expect(
      subagentArgsToV1({
        agent: 'fixer',
        description: 'd',
        prompt: 'p',
        sessionID: 'ses_1',
        background: true,
      }),
    ).toEqual({
      subagent_type: 'fixer',
      description: 'd',
      prompt: 'p',
      task_id: 'ses_1',
      background: true,
    });
  });

  test('accepts a legacy task_id as the resume id inbound', () => {
    expect(subagentArgsToV1({ agent: 'fixer', task_id: 'ses_legacy' })).toEqual(
      { subagent_type: 'fixer', task_id: 'ses_legacy' },
    );
  });

  test('canonical sessionID wins over a legacy task_id', () => {
    expect(
      subagentArgsToV1({
        agent: 'fixer',
        task_id: 'ses_legacy',
        sessionID: 'ses_canonical',
      }),
    ).toEqual({ subagent_type: 'fixer', task_id: 'ses_canonical' });
  });

  test('outbound emits only sessionID, never task_id', () => {
    const out = v1ArgsToSubagent({
      subagent_type: 'fixer',
      task_id: 'ses_1',
    });
    expect(out).toEqual({ agent: 'fixer', sessionID: 'ses_1' });
    expect(out.task_id).toBeUndefined();
  });

  test('round-trips hook mutations', () => {
    const v1 = subagentArgsToV1({ agent: 'fixer', sessionID: 'ses_1' });
    delete v1.task_id;
    v1.task_id = 'ses_2';
    expect(v1ArgsToSubagent(v1)).toEqual({
      agent: 'fixer',
      sessionID: 'ses_2',
    });
  });

  test('passthrough for non-object input', () => {
    expect(subagentArgsToV1(undefined)).toEqual({});
    expect(subagentArgsToV1('x')).toEqual({});
  });
});
