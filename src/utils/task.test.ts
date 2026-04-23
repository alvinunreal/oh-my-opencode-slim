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
  test('parses and normalizes the last context summary block', () => {
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

  test('returns undefined when context block is absent or empty', () => {
    expect(parseContextSummaryFromTaskOutput('plain output')).toBeUndefined();
    expect(
      parseContextSummaryFromTaskOutput(
        '<context_summary>   \n </context_summary>',
      ),
    ).toBeUndefined();
  });

  test('parses malformed trailing context summary blocks', () => {
    const output = [
      '<task_result>',
      '<results>',
      '<answer>done</answer>',
      '<context_summary>Remember inspected session code.',
      '</task_result>',
    ].join('\n');

    expect(parseContextSummaryFromTaskOutput(output)).toBe(
      'Remember inspected session code.',
    );
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

  test('removes malformed trailing context summary metadata blocks', () => {
    const output = [
      'task_id: session-abc-123',
      '<task_result>',
      '<results>',
      '<answer>done</answer>',
      '<context_summary>metadata only',
      '</task_result>',
    ].join('\n');

    expect(stripContextSummaryFromTaskOutput(output)).toBe(
      [
        'task_id: session-abc-123',
        '<task_result>',
        '<results>',
        '<answer>done</answer>',
      ].join('\n'),
    );
  });
});
