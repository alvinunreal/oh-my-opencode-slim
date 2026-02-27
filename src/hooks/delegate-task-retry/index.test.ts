import { describe, expect, test } from 'bun:test';
import { createDelegateTaskRetryHook } from './hook';

describe('delegate-task-retry hook', () => {
  test('appends guidance for task argument errors', async () => {
    const hook = createDelegateTaskRetryHook({} as never);
    const output = {
      output:
        '[ERROR] Invalid arguments: Must provide either category or subagent_type. Available categories: quick, unspecified-low',
    };

    await hook['tool.execute.after']({ tool: 'task' }, output);

    expect(output.output).toContain('[delegate-task retry suggestion]');
    expect(output.output).toContain('missing_category_or_agent');
  });

  test('appends guidance for background agent allowlist errors', async () => {
    const hook = createDelegateTaskRetryHook({} as never);
    const output = {
      output: "Agent 'oracle' is not allowed. Allowed agents: explorer, fixer",
    };

    await hook['tool.execute.after']({ tool: 'background_task' }, output);

    expect(output.output).toContain('background_agent_not_allowed');
    expect(output.output).toContain('Available: explorer, fixer');
  });

  test('does nothing for unrelated tool output', async () => {
    const hook = createDelegateTaskRetryHook({} as never);
    const output = { output: 'all good' };

    await hook['tool.execute.after']({ tool: 'read' }, output);

    expect(output.output).toBe('all good');
  });
});
