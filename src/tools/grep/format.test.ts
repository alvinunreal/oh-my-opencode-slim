/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { DEFAULT_GREP_LIMIT, DEFAULT_GREP_TIMEOUT_MS } from './constants';
import { formatGrepResult } from './format';
import { normalizeGrepInput } from './normalize';
import {
  buildResult,
  createRepoContext,
  createTempTracker,
} from './test-helpers';
import type { GrepSearchResult } from './types';

describe('tools/grep/format', () => {
  const temps = createTempTracker();

  function createNormalized(
    input: any,
    options: { directory?: string; worktree?: string } = {},
  ) {
    const repoDir = options.worktree ?? temps.createRepo();
    const directory = options.directory ?? repoDir;
    const worktree = options.worktree ?? repoDir;

    return {
      repoDir,
      normalized: normalizeGrepInput(
        input,
        createRepoContext(directory, worktree) as any,
      ),
    };
  }

  test('formats partial output notes for limit and retry cases', () => {
    const { repoDir, normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
    });

    const output = formatGrepResult(normalized, {
      ...buildResult(repoDir),
      truncated: true,
      limitReached: true,
      retryCount: 1,
      warnings: ['permission warning'],
    });

    expect(output).toContain(
      `Stopped after collecting ${DEFAULT_GREP_LIMIT} matches`,
    );
    expect(output).toContain('Retried 1 transient failure.');
    expect(output).toContain('permission warning');
  });

  test('formats files_with_matches mode cleanly', () => {
    const { repoDir, normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      output_mode: 'files_with_matches',
    });

    const output = formatGrepResult(normalized, {
      ...buildResult(repoDir),
      outputMode: 'files_with_matches',
      matchKind: 'file',
      totalMatches: 1,
      files: [
        {
          file: 'src/example.ts',
          absolutePath: path.join(repoDir, 'src', 'example.ts'),
          matchCount: 1,
          matches: [],
        },
      ],
    });

    expect(output).toContain('Found 1 matching file.');
    expect(output).toContain('src/example.ts');
    expect(output).not.toContain('Line');
  });

  test.each([
    {
      name: 'escapes control characters in displayed file paths',
      createResult: (repoDir: string): GrepSearchResult => ({
        ...buildResult(repoDir),
        outputMode: 'files_with_matches',
        matchKind: 'file',
        totalMatches: 1,
        files: [
          {
            file: 'src/odd\nname\r\t.ts',
            absolutePath: path.join(repoDir, 'src', 'odd\nname\r\t.ts'),
            matchCount: 1,
            matches: [],
          },
        ],
      }),
      assertOutput: (output: string) => {
        expect(output).toContain('src/odd\\nname\\r\\t.ts');
      },
    },
    {
      name: 'preserves normal Windows backslashes in displayed paths',
      createResult: (repoDir: string): GrepSearchResult => ({
        ...buildResult(repoDir),
        outputMode: 'files_with_matches',
        matchKind: 'file',
        totalMatches: 1,
        files: [
          {
            file: 'C:\\repo\\src\\file.ts',
            absolutePath: 'C:\\repo\\src\\file.ts',
            matchCount: 1,
            matches: [],
          },
        ],
      }),
      assertOutput: (output: string) => {
        expect(output).toContain('C:\\repo\\src\\file.ts');
        expect(output).not.toContain('C:\\\\repo');
      },
    },
  ])('$name', ({ createResult, assertOutput }) => {
    const { repoDir, normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      output_mode: 'files_with_matches',
    });

    assertOutput(formatGrepResult(normalized, createResult(repoDir)));
  });

  test.each([
    {
      name: 'escapes control characters in pattern, include, warnings and stderr',
      input: {
        pattern: 'create\nTool\t',
        path: 'src',
        include: 'weird\n*.ts',
      },
      result: (repoDir: string): GrepSearchResult => ({
        ...buildResult(repoDir),
        warnings: ['warn\nline'],
        stderr: 'stderr\tline',
        error: 'partial\rerror',
      }),
      expected: [
        'Pattern: create\\nTool\\t',
        'Include: weird\\n*.ts',
        'Partial error: partial\\rerror',
        'warn\\nline',
        'stderr\\tline',
      ],
    },
    {
      name: 'escapes ansi and control characters in headers, paths and notes',
      input: {
        pattern: 'create\u001b[31mTool',
        path: 'src',
        include: 'weird\u0007*.ts',
      },
      result: (repoDir: string): GrepSearchResult => ({
        ...buildResult(repoDir),
        files: [
          {
            file: 'src/evil\u001b[31m.ts',
            absolutePath: path.join(repoDir, 'src', 'evil.ts'),
            matchCount: 1,
            matches: [],
          },
        ],
        outputMode: 'files_with_matches',
        matchKind: 'file',
        totalMatches: 1,
        totalFiles: 1,
        warnings: ['warn\u0007line'],
        stderr: 'stderr\u001b[31mline',
        error: 'partial\u001berror',
      }),
      expected: [
        'Pattern: create\\x1b[31mTool',
        'Include: weird\\x07*.ts',
        'src/evil\\x1b[31m.ts',
        'warn\\x07line',
        'stderr\\x1b[31mline',
        'Partial error: partial\\x1berror',
      ],
    },
  ])('$name', ({ input, result, expected }) => {
    const { repoDir, normalized } = createNormalized(input);
    const output = formatGrepResult(normalized, result(repoDir));

    for (const fragment of expected) {
      expect(output).toContain(fragment);
    }
  });

  test('formats count mode with per-file counts', () => {
    const { repoDir, normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      output_mode: 'count',
    });

    const output = formatGrepResult(normalized, {
      ...buildResult(repoDir),
      outputMode: 'count',
      matchKind: 'occurrence',
      files: [
        {
          file: 'src/z-last.ts',
          absolutePath: path.join(repoDir, 'src', 'z-last.ts'),
          matchCount: 2,
          matches: [],
        },
        {
          file: 'src/example.ts',
          absolutePath: path.join(repoDir, 'src', 'example.ts'),
          matchCount: 3,
          matches: [],
        },
      ],
      totalMatches: 5,
      totalFiles: 2,
    });

    expect(output).toContain('Found 5 total matches across 2 files.');
    const zIndex = output.indexOf('2: src/z-last.ts');
    const exampleIndex = output.indexOf('3: src/example.ts');
    expect(zIndex).toBeGreaterThan(-1);
    expect(exampleIndex).toBeGreaterThan(-1);
    expect(zIndex).toBeLessThan(exampleIndex);
  });

  test.each([
    {
      name: 'count mode keeps repo-relative file paths',
      createInput: (repoDir: string) => ({
        input: {
          pattern: 'createTool',
          path: 'src',
          output_mode: 'count',
        },
        options: { worktree: repoDir },
      }),
      createResult: (repoDir: string): GrepSearchResult => ({
        ...buildResult(repoDir),
        outputMode: 'count',
        matchKind: 'occurrence',
        files: [
          {
            file: 'src/example.ts',
            absolutePath: path.join(repoDir, 'src', 'example.ts'),
            matchCount: 1,
            matches: [],
          },
        ],
        totalMatches: 1,
      }),
      assertOutput: (output: string, repoDir: string) => {
        expect(output).toContain('1: src/example.ts');
        expect(output).not.toContain(repoDir);
      },
    },
    {
      name: 'keeps absolute paths when worktree is filesystem root',
      createInput: (repoDir: string) => ({
        input: {
          pattern: 'createTool',
          path: repoDir,
          output_mode: 'count',
        },
        options: { worktree: path.parse(repoDir).root },
      }),
      createResult: (repoDir: string): GrepSearchResult => ({
        ...buildResult(repoDir),
        outputMode: 'count',
        matchKind: 'occurrence',
        files: [
          {
            file: path.join(repoDir, 'src', 'example.ts'),
            absolutePath: path.join(repoDir, 'src', 'example.ts'),
            matchCount: 1,
            matches: [],
          },
        ],
        totalMatches: 1,
      }),
      assertOutput: (output: string, repoDir: string) => {
        expect(output).toContain(path.join(repoDir, 'src', 'example.ts'));
      },
    },
  ])('$name', ({ createInput, createResult, assertOutput }) => {
    const repoDir = temps.createRepo();
    const { input, options } = createInput(repoDir);
    const { normalized } = createNormalized(input, {
      directory: repoDir,
      ...options,
    });
    const output = formatGrepResult(normalized, createResult(repoDir));

    assertOutput(output, repoDir);
  });

  test.each([
    {
      name: 'formats partial-empty timeout output without claiming no matches',
      input: { pattern: 'createTool', path: 'src' },
      result: (repoDir: string): GrepSearchResult => ({
        ...buildResult(repoDir),
        files: [],
        totalMatches: 0,
        totalFiles: 0,
        truncated: true,
        timedOut: true,
      }),
      expected: [
        'No visible results were collected before the search stopped.',
        `Timed out after ${DEFAULT_GREP_TIMEOUT_MS}ms; showing partial results.`,
      ],
      unexpected: ['No matches found.'],
    },
    {
      name: 'formats mtime discovery partials without pretending no matches were found',
      input: { pattern: 'needle', path: 'src', sort_by: 'mtime' },
      result: (repoDir: string): GrepSearchResult => ({
        ...buildResult(repoDir),
        files: [],
        totalMatches: 0,
        totalFiles: 0,
        truncated: true,
        timedOut: true,
        partialPhase: 'discovery',
        discoveredFiles: 3,
        strategy: 'mtime-hybrid',
      }),
      expected: [
        'Search stopped during mtime discovery after discovering 3 candidate files before replay produced visible results.',
      ],
      unexpected: [
        'No visible results were collected before the search stopped.',
      ],
    },
    {
      name: 'formats mtime replay partials as replay instead of discovery',
      input: { pattern: 'needle', path: 'src', sort_by: 'mtime' },
      result: (repoDir: string): GrepSearchResult => ({
        ...buildResult(repoDir),
        files: [],
        totalMatches: 0,
        totalFiles: 0,
        truncated: true,
        timedOut: true,
        partialPhase: 'replay',
        discoveredFiles: 2,
        strategy: 'mtime-hybrid',
      }),
      expected: [
        'Search stopped during mtime replay after discovering 2 candidate files before replay produced visible results.',
      ],
      unexpected: [],
    },
    {
      name: 'formats non-stopped replay partials without claiming the search stopped',
      input: { pattern: 'needle', path: 'src', sort_by: 'mtime' },
      result: (repoDir: string): GrepSearchResult => ({
        ...buildResult(repoDir),
        files: [],
        totalMatches: 0,
        totalFiles: 0,
        truncated: true,
        partialPhase: 'replay',
        discoveredFiles: 2,
        strategy: 'mtime-hybrid',
        warnings: ['Skipped replay batch'],
      }),
      expected: [
        'mtime replay could not produce visible results after discovering 2 candidate files.',
      ],
      unexpected: ['Search stopped during mtime replay'],
    },
  ])('$name', ({ input, result, expected, unexpected }) => {
    const { repoDir, normalized } = createNormalized(input);
    const output = formatGrepResult(normalized, result(repoDir));

    for (const fragment of expected) {
      expect(output).toContain(fragment);
    }

    for (const fragment of unexpected) {
      expect(output).not.toContain(fragment);
    }
  });

  test('does not show rg elapsed for mtime-hybrid summaries', () => {
    const { repoDir, normalized } = createNormalized({
      pattern: 'needle',
      path: 'src',
      sort_by: 'mtime',
    });

    const output = formatGrepResult(normalized, {
      ...buildResult(repoDir),
      strategy: 'mtime-hybrid',
      summary: { elapsedTotalHuman: '9.9s' },
    });

    expect(output).not.toContain('rg elapsed:');
  });

  test('formats partial body when an error happens after visible results', () => {
    const { repoDir, normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
    });

    const output = formatGrepResult(normalized, {
      ...buildResult(repoDir),
      truncated: true,
      error: 'permission denied',
    });

    expect(output).toContain('src/example.ts');
    expect(output).toContain('Partial error: permission denied');
    expect(output).not.toContain('grep search failed.');
  });
});
