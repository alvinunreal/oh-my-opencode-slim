import { beforeEach, describe, expect, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  createJsonErrorRecoveryHook,
  JSON_ERROR_PATTERNS,
  JSON_ERROR_REMINDER,
  JSON_ERROR_TOOL_EXCLUDE_LIST,
} from './index';

describe('json-error-recovery hook', () => {
  let hook: ReturnType<typeof createJsonErrorRecoveryHook>;

  type ToolExecuteAfterHandler = NonNullable<
    ReturnType<typeof createJsonErrorRecoveryHook>['tool.execute.after']
  >;
  type ToolExecuteAfterInput = Parameters<ToolExecuteAfterHandler>[0];
  type ToolExecuteAfterOutput = Parameters<ToolExecuteAfterHandler>[1];

  const createMockPluginInput = (): PluginInput => {
    return {
      client: {} as PluginInput['client'],
      directory: '/tmp/test',
    } as PluginInput;
  };

  beforeEach(() => {
    hook = createJsonErrorRecoveryHook(createMockPluginInput());
  });

  const createInput = (tool = 'Edit'): ToolExecuteAfterInput => ({
    tool,
    sessionID: 'test-session',
    callID: 'test-call-id',
  });

  const createOutput = (outputText: unknown): ToolExecuteAfterOutput => ({
    title: 'Tool Error',
    output: outputText,
    metadata: {},
  });

  test('appends reminder when output includes JSON parse error', async () => {
    const output = createOutput("JSON parse error: expected '}' in JSON body");

    await hook['tool.execute.after'](createInput(), output);

    expect(output.output).toContain(JSON_ERROR_REMINDER);
  });

  test('does not append reminder for normal output', async () => {
    const output = createOutput('Task completed successfully');

    await hook['tool.execute.after'](createInput(), output);

    expect(output.output).toBe('Task completed successfully');
  });

  test('does not append reminder for excluded tools', async () => {
    const output = createOutput(
      'JSON parse error: unexpected end of JSON input',
    );

    await hook['tool.execute.after'](createInput('Read'), output);

    expect(output.output).toBe(
      'JSON parse error: unexpected end of JSON input',
    );
  });

  test('does not append duplicate reminder on repeated execution', async () => {
    const output = createOutput('JSON parse error: invalid JSON arguments');

    await hook['tool.execute.after'](createInput(), output);
    await hook['tool.execute.after'](createInput(), output);

    const reminderCount =
      String(output.output).split(
        '[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]',
      ).length - 1;
    expect(reminderCount).toBe(1);
  });

  test('ignores non-string output values', async () => {
    const values: unknown[] = [42, null, undefined, { error: 'invalid json' }];

    for (const value of values) {
      const output = createOutput(value);
      await hook['tool.execute.after'](createInput(), output);
      expect(output.output).toBe(value);
    }
  });

  test('pattern list detects known JSON parse errors', () => {
    const output = 'JSON parse error: unexpected end of JSON input';
    const isMatched = JSON_ERROR_PATTERNS.some((pattern) =>
      pattern.test(output),
    );
    expect(isMatched).toBe(true);
  });

  test('exclude list contains content-heavy tools', () => {
    const expectedExcludedTools: Array<
      (typeof JSON_ERROR_TOOL_EXCLUDE_LIST)[number]
    > = ['read', 'bash', 'webfetch'];

    const allExpectedToolsIncluded = expectedExcludedTools.every((toolName) =>
      JSON_ERROR_TOOL_EXCLUDE_LIST.includes(toolName),
    );
    expect(allExpectedToolsIncluded).toBe(true);
  });
});
