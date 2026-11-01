import { beforeEach, describe, expect, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  createJsonErrorRecoveryHook,
  JSON_ERROR_PATTERNS,
  JSON_ERROR_REMINDER,
} from './hook';

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

  const createInput = (tool = 'invalid'): ToolExecuteAfterInput => ({
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

  test.each([
    'partial_output: true\ninvalid JSON from child',
    'Final result: failed to parse JSON',
  ])(
    'does not mistake quoted task_status content for argument errors: %s',
    async (text) => {
      const output = createOutput(text);
      await hook['tool.execute.after'](createInput('task_status'), output);
      expect(output.output).toBe(text);
    },
  );

  test.each([
    'src/config.ts:14: const raw = "invalid JSON arguments";',
    'matches found:\nLine 42: throw new Error("JSON parse error: expected object");',
    'SyntaxError: Unexpected token in JSON at position 0',
  ])(
    'does not append reminder for successful grep output quoting json errors: %s',
    async (text) => {
      const output = createOutput(text);
      await hook['tool.execute.after'](createInput('grep'), output);
      expect(output.output).toBe(text);
    },
  );

  test.each([
    'pattern match: export const msg = "failed to parse JSON";',
    'Line 10: console.log("malformed JSON body");',
  ])(
    'does not append reminder for ast_grep_search output quoting json errors: %s',
    async (text) => {
      const output = createOutput(text);
      await hook['tool.execute.after'](createInput('ast_grep_search'), output);
      expect(output.output).toBe(text);
    },
  );

  test.each([
    '+  const output = createOutput("JSON parse error: invalid JSON arguments");',
    'stderr: SyntaxError: Unexpected token } in JSON at position 42',
  ])(
    'does not append reminder for v2 shell tool output quoting json errors: %s',
    async (text) => {
      const output = createOutput(text);
      await hook['tool.execute.after'](createInput('shell'), output);
      expect(output.output).toBe(text);
    },
  );

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
});
