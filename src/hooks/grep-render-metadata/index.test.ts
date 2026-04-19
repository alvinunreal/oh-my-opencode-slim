import { describe, expect, test } from 'bun:test';
import {
  createGrepRenderMetadataHook,
  parseGrepSummary,
} from './index';

describe('grep render metadata hook', () => {
  test('parses match summary lines', () => {
    expect(
      parseGrepSummary(
        'Pattern: alpha\nPath: src\n\nFound 7 matches across 3 files.\n',
      ),
    ).toEqual({ matches: 7, files: 3 });
  });

  test('parses files_with_matches summary lines', () => {
    expect(parseGrepSummary('Found 4 matching files.\n\nsrc/a.ts')).toEqual({
      matches: 4,
      files: 4,
    });
  });

  test('parses zero-result summaries', () => {
    expect(parseGrepSummary('No matches found.\nPattern: alpha')).toEqual({
      matches: 0,
      files: 0,
    });
    expect(parseGrepSummary('No files found.\nPattern: alpha')).toEqual({
      matches: 0,
      files: 0,
    });
  });

  test('parses mtime no-visible summaries as zero results', () => {
    expect(
      parseGrepSummary(
        'mtime sorting could not produce visible results after discovering 3 candidate files.\nPattern: alpha',
      ),
    ).toEqual({
      matches: 0,
      files: 0,
    });
  });

  test('hydrates final output metadata for grep tools', async () => {
    const hook = createGrepRenderMetadataHook();
    const output: { title?: unknown; output: unknown; metadata?: unknown } = {
      title: '',
      output:
        'Pattern: alpha\nPath: src\n\nFound 2 matches across 1 file.\n\nsrc/example.ts\n      1: alpha',
      metadata: { truncated: false },
    };

    await hook['tool.execute.after'](
      {
        tool: 'grep',
        args: { pattern: 'alpha' },
      },
      output,
    );

    expect(output.title).toBe('alpha');
    expect(output.metadata).toEqual({
      truncated: false,
      matches: 2,
      files: 1,
    });
  });

  test('hydrates zero-result metadata for grep tools', async () => {
    const hook = createGrepRenderMetadataHook();
    const output: { title?: unknown; output: unknown; metadata?: unknown } = {
      title: '',
      output: 'No matches found.\nPattern: alpha\nPath: src',
      metadata: { truncated: false },
    };

    await hook['tool.execute.after'](
      {
        tool: 'grep',
        args: { pattern: 'alpha' },
      },
      output,
    );

    expect(output.title).toBe('alpha');
    expect(output.metadata).toEqual({
      truncated: false,
      matches: 0,
      files: 0,
    });
  });

  test('ignores non-grep tools', async () => {
    const hook = createGrepRenderMetadataHook();
    const output = {
      title: '',
      output: 'Found 2 matches across 1 file.',
      metadata: {},
    };

    await hook['tool.execute.after'](
      {
        tool: 'read',
        args: { pattern: 'alpha' },
      },
      output,
    );

    expect(output).toEqual({
      title: '',
      output: 'Found 2 matches across 1 file.',
      metadata: {},
    });
  });
});
