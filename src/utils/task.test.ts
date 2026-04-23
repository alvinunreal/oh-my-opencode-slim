import { describe, expect, test } from 'bun:test';
import {
  parseContextSummaryFromTaskOutput,
  parseTaskIdFromTaskOutput,
  stripContextSummaryFromTaskOutput,
} from './task';

describe('parseTaskIdFromTaskOutput', () => {
  test('parses task_id line from successful task tool output', () => {
    const output = [
      'task_id: session-abc-123 (for resuming to continue this task if needed)',
      '',
      '<task_result>',
      'done',
      '</task_result>',
    ].join('\n');

    expect(parseTaskIdFromTaskOutput(output)).toBe('session-abc-123');
  });

  test('returns undefined when task_id is absent', () => {
    const output = ['<task_result>', 'no task id here', '</task_result>'].join(
      '\n',
    );

    expect(parseTaskIdFromTaskOutput(output)).toBeUndefined();
  });
});

describe('parseContextSummaryFromTaskOutput', () => {
  test('parses and normalizes the final context summary block', () => {
    const output = [
      '<context_summary>old summary</context_summary>',
      '<task_result>',
      'done',
      '</task_result>',
      '<context_summary>',
      '  Reviewed   session management\n and found implementation points. ',
      '</context_summary>',
    ].join('\n');

    expect(parseContextSummaryFromTaskOutput(output)).toBe(
      'Reviewed session management and found implementation points.',
    );
  });

  test('ignores context summary mentions that are not final metadata', () => {
    const output = [
      '<task_result>',
      '<results>',
      '<answer>Discusses <context_summary> syntax only.</answer>',
      '</results>',
      '</task_result>',
    ].join('\n');

    expect(parseContextSummaryFromTaskOutput(output)).toBeUndefined();
  });

  test('ignores context summary blocks nested inside task results', () => {
    const output = [
      '<task_result>',
      '<results>',
      '<answer>done</answer>',
      '<context_summary>Nested summary should not parse.</context_summary>',
      '</results>',
      '</task_result>',
    ].join('\n');

    expect(parseContextSummaryFromTaskOutput(output)).toBeUndefined();
  });

  test('returns undefined when context block is absent or empty', () => {
    expect(parseContextSummaryFromTaskOutput('plain output')).toBeUndefined();
    expect(
      parseContextSummaryFromTaskOutput(
        '<context_summary>   \n </context_summary>',
      ),
    ).toBeUndefined();
  });

  test('parses malformed final context summary blocks', () => {
    const output = [
      '<task_result>',
      '<results>',
      '<answer>done</answer>',
      '</task_result>',
      '<context_summary>Remember inspected session code.',
    ].join('\n');

    expect(parseContextSummaryFromTaskOutput(output)).toBe(
      'Remember inspected session code.',
    );
  });

  test('truncates long context summaries', () => {
    const longSummary = 'a'.repeat(320);

    expect(
      parseContextSummaryFromTaskOutput(
        `<context_summary>${longSummary}</context_summary>`,
      ),
    ).toHaveLength(280);
  });
});

describe('stripContextSummaryFromTaskOutput', () => {
  test('removes context summary metadata blocks', () => {
    const output = [
      'task_id: session-abc-123',
      '',
      '<task_result>',
      'done',
      '</task_result>',
      '<context_summary>metadata only</context_summary>',
    ].join('\n');

    expect(stripContextSummaryFromTaskOutput(output)).toBe(
      [
        'task_id: session-abc-123',
        '',
        '<task_result>',
        'done',
        '</task_result>',
      ].join('\n'),
    );
  });

  test('does not remove context summary mentions inside task results', () => {
    const output = [
      '<task_result>',
      '<results>',
      '<answer>Discusses <context_summary> syntax only.</answer>',
      '</results>',
      '</task_result>',
    ].join('\n');

    expect(stripContextSummaryFromTaskOutput(output)).toBe(output);
  });

  test('removes malformed final context summary metadata blocks', () => {
    const output = [
      'task_id: session-abc-123',
      '<task_result>',
      '<results>',
      '<answer>done</answer>',
      '</task_result>',
      '<context_summary>metadata only',
    ].join('\n');

    expect(stripContextSummaryFromTaskOutput(output)).toBe(
      [
        'task_id: session-abc-123',
        '<task_result>',
        '<results>',
        '<answer>done</answer>',
        '</task_result>',
      ].join('\n'),
    );
  });
});
