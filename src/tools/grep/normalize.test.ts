/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_GREP_LIMIT, DEFAULT_GREP_TIMEOUT_MS } from './constants';
import { normalizeGrepInput } from './normalize';
import { buildRgArgs } from './rg-args';
import { createRepoContext, createTempTracker } from './test-helpers';

describe('tools/grep/normalize', () => {
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

  test('normalizes defaults while keeping base grep fields compatible', () => {
    const { repoDir, normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      include: '*.ts',
    });

    expect(normalized.pattern).toBe('createTool');
    expect(normalized.searchPath).toBe(path.join(repoDir, 'src'));
    expect(normalized.include).toBe('*.ts');
    expect(normalized.outputMode).toBe('content');
    expect(normalized.caseSensitive).toBe(true);
    expect(normalized.context).toBe(0);
    expect(normalized.beforeContext).toBe(0);
    expect(normalized.afterContext).toBe(0);
    expect(normalized.maxResults).toBe(DEFAULT_GREP_LIMIT);
    expect(normalized.maxCountPerFile).toBeUndefined();
    expect(normalized.timeoutMs).toBe(DEFAULT_GREP_TIMEOUT_MS);
    expect(normalized.hidden).toBe(true);
    expect(normalized.invertMatch).toBe(false);
    expect(normalized.fileTypes).toEqual([]);
    expect(normalized.excludeFileTypes).toEqual([]);
  });

  test('resolves relative path against current directory when it differs from worktree', () => {
    const repoDir = temps.createRepo();
    const parentDir = path.dirname(repoDir);

    const normalized = normalizeGrepInput(
      {
        pattern: 'createTool',
        path: path.basename(repoDir),
      },
      createRepoContext(parentDir, repoDir) as any,
    );

    expect(normalized.searchPath).toBe(repoDir);
    expect(normalized.resolvedPath).toBe(repoDir);
    expect(normalized.worktree).toBe(repoDir);
  });

  test('resolves symlink search paths to their real path for execution and permissions', () => {
    const repoDir = temps.createRepo();
    const externalDir = temps.createDir('oh-my-opencode-grep-ext');
    writeFileSync(path.join(externalDir, 'outside.ts'), 'createTool\n');
    symlinkSync(externalDir, path.join(repoDir, 'linked-outside'), 'dir');

    const normalized = normalizeGrepInput(
      {
        pattern: 'createTool',
        path: 'linked-outside',
      },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.resolvedPath).toBe(path.join(repoDir, 'linked-outside'));
    expect(normalized.searchPath).toBe(externalDir);
    expect(normalized.permissionPatterns).toEqual([externalDir]);
  });

  test('fails cleanly for dangling symlink search paths', () => {
    const repoDir = temps.createRepo();
    const dangling = path.join(repoDir, 'dangling');
    symlinkSync(path.join(repoDir, 'missing-target'), dangling);

    expect(() =>
      normalizeGrepInput(
        {
          pattern: 'createTool',
          path: 'dangling',
        },
        createRepoContext(repoDir) as any,
      ),
    ).toThrow(/Search path does not exist|Failed to resolve search path/);
  });

  test('normalizes advanced glob and engine options', () => {
    const { normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      globs: ['*.ts', '!**/*.test.ts'],
      exclude_globs: ['dist/**'],
      smart_case: true,
      pcre2: true,
      max_filesize: '1M',
      sort_by: 'path',
      sort_order: 'desc',
    });

    expect(normalized.globs).toEqual(['*.ts', '!**/*.test.ts']);
    expect(normalized.excludeGlobs).toEqual(['dist/**']);
    expect(normalized.smartCase).toBe(true);
    expect(normalized.pcre2).toBe(true);
    expect(normalized.maxFilesize).toBe('1M');
    expect(normalized.sortBy).toBe('path');
    expect(normalized.sortOrder).toBe('desc');
  });

  test('explicit case_sensitive=false disables smart_case heuristics', () => {
    const { normalized } = createNormalized({
      pattern: 'CreateTool',
      path: 'src',
      smart_case: true,
      case_sensitive: false,
    });

    const args = buildRgArgs(normalized);
    expect(normalized.caseSensitive).toBe(false);
    expect(normalized.smartCase).toBe(false);
    expect(args).toEqual(expect.arrayContaining(['-i']));
    expect(args).not.toContain('--smart-case');
  });

  test('auto-enables multiline when multiline_dotall is requested', () => {
    const { normalized } = createNormalized({
      pattern: 'foo.*bar',
      path: 'src',
      multiline_dotall: true,
    });

    expect(normalized.multiline).toBe(true);
    expect(normalized.multilineDotall).toBe(true);
    expect(buildRgArgs(normalized)).toEqual(
      expect.arrayContaining(['--multiline', '--multiline-dotall']),
    );
  });

  test.each([
    {
      name: 'defaults mtime ordering to descending recency',
      input: { pattern: 'createTool', path: 'src', sort_by: 'mtime' },
      expected: { sortBy: 'mtime', sortOrder: 'desc' },
    },
    {
      name: 'defaults non-mtime ordering to ascending when omitted',
      input: { pattern: 'createTool', path: 'src', sort_by: 'path' },
      expected: { sortBy: 'path', sortOrder: 'asc' },
    },
  ])('$name', ({ input, expected }) => {
    const { normalized } = createNormalized(input);
    expect(normalized.sortBy).toBe(expected.sortBy);
    expect(normalized.sortOrder).toBe(expected.sortOrder);
  });

  test('normalizes asymmetric context and multiple file type filters', () => {
    const { normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      context: 3,
      before_context: 1,
      file_type: 'ts',
      file_types: ['tsx', 'ts', 'js'],
      exclude_file_types: ['md', 'json', 'md'],
      invert_match: true,
      max_count_per_file: 7,
    });

    expect(normalized.context).toBe(3);
    expect(normalized.beforeContext).toBe(1);
    expect(normalized.afterContext).toBe(3);
    expect(normalized.fileType).toBe('ts');
    expect(normalized.fileTypes).toEqual(['ts', 'tsx', 'js']);
    expect(normalized.excludeFileTypes).toEqual(['md', 'json']);
    expect(normalized.invertMatch).toBe(true);
    expect(normalized.maxCountPerFile).toBe(7);
  });

  test('builds ripgrep args for advanced options', () => {
    const { normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      output_mode: 'content',
      globs: ['*.ts'],
      exclude_globs: ['dist/**'],
      smart_case: true,
      pcre2: true,
      max_filesize: '1M',
      sort_by: 'path',
      sort_order: 'desc',
    });

    const args = buildRgArgs(normalized);
    expect(args).toContain('--smart-case');
    expect(args).toContain('--pcre2');
    expect(args).toContain('--max-filesize');
    expect(args).toContain('1M');
    expect(args).toContain('--sortr');
    expect(args).toContain('path');
    expect(args).toContain('!dist/**');
  });

  test('builds ripgrep args for asymmetric context and file type filters', () => {
    const { normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      output_mode: 'content',
      context: 4,
      before_context: 1,
      after_context: 2,
      file_type: 'ts',
      file_types: ['tsx'],
      exclude_file_types: ['md'],
      invert_match: true,
      max_count_per_file: 5,
    });

    const args = buildRgArgs(normalized);
    expect(args).toEqual(
      expect.arrayContaining([
        '-B',
        '1',
        '-A',
        '2',
        '--type',
        'ts',
        '--type',
        'tsx',
        '--type-not',
        'md',
        '--invert-match',
        '--max-count',
        '5',
      ]),
    );
    expect(args).not.toContain('-C');
  });

  test('builds count/files args with NUL delimiters and engine flags', () => {
    const { normalized: countInput } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      output_mode: 'count',
      fixed_strings: true,
      follow_symlinks: true,
      multiline: true,
    });
    const countArgs = buildRgArgs(countInput);
    expect(countArgs).toEqual(
      expect.arrayContaining([
        '--null',
        '--count-matches',
        '--fixed-strings',
        '--follow',
        '--multiline',
      ]),
    );
    expect(countArgs).not.toContain('--multiline-dotall');

    const { normalized: dotallInput } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      output_mode: 'count',
      multiline: true,
      multiline_dotall: true,
    });
    expect(buildRgArgs(dotallInput)).toEqual(
      expect.arrayContaining(['--multiline', '--multiline-dotall']),
    );

    const { normalized: filesInput } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      output_mode: 'files_with_matches',
    });
    expect(buildRgArgs(filesInput)).toEqual(
      expect.arrayContaining(['--null', '--files-with-matches']),
    );
  });

  test('uses symmetric -C context when effective before and after match', () => {
    const { normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      context: 2,
    });

    const args = buildRgArgs(normalized);
    expect(args).toContain('-C');
    expect(args).toContain('2');
    expect(args).not.toContain('-B');
    expect(args).not.toContain('-A');
  });

  test('builds files_with_matches args without json mode', () => {
    const { normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      output_mode: 'files_with_matches',
    });

    const args = buildRgArgs(normalized);
    expect(args).toContain('--files-with-matches');
    expect(args).not.toContain('--json');
  });
});
