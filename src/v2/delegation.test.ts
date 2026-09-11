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
