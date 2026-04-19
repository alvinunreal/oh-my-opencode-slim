/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { DEFAULT_GREP_TIMEOUT_MS } from './constants';
import {
  buildResult,
  createExecutionContext,
  createTempTracker,
} from './test-helpers';
import { createGrepTool } from './tool';
import type { GrepRunner, GrepSearchResult } from './types';

describe('tools/grep/tool', () => {
  const temps = createTempTracker();

  function getAskInput(ctx: ReturnType<typeof createExecutionContext>) {
    const call = ctx.ask.mock.calls[0] as unknown as
      | [
          {
            permission: string;
            patterns: string[];
            metadata: Record<string, unknown>;
          },
        ]
      | undefined;

    if (!call) {
      throw new Error('ask was not called');
    }

    return call[0];
  }

  function getMetadataInput(ctx: ReturnType<typeof createExecutionContext>) {
    const call = ctx.metadata.mock.calls[0] as unknown as
      | [
          {
            title: string;
            metadata: Record<string, unknown>;
          },
        ]
      | undefined;

    if (!call) {
      throw new Error('metadata was not called');
    }

    return call[0];
  }

  test('creates a grep tool that asks permission, runs rg, and emits metadata', async () => {
    const repoDir = temps.createRepo();
    const run: GrepRunner = mock(async (input) => {
      expect(input.searchPath).toBe(path.join(repoDir, 'src'));
      expect(input.include).toBe('*.ts');
      return buildResult(repoDir);
    });

    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    const output = await grep.execute(
      {
        pattern: 'createTool',
        path: 'src',
        include: '*.ts',
      },
      ctx as any,
    );

    expect(output).toContain('Found 1 match across 1 file.');
    expect(output).toContain('src/example.ts');
    expect(output).toContain('2: const target = createTool();');
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    expect(ctx.metadata).toHaveBeenCalledTimes(1);

    const askInput = getAskInput(ctx);
    expect(askInput.permission).toBe('grep');
    expect(askInput.patterns).toEqual([path.join(repoDir, 'src')]);
    expect(askInput.metadata.before_context).toBe(0);
    expect(askInput.metadata.after_context).toBe(0);
    expect(askInput.metadata.pattern).toBe('createTool');
    expect(askInput.metadata.case_sensitive).toBe(true);
    expect(askInput.metadata.word_regexp).toBe(false);
    expect(askInput.metadata.timeout_ms).toBe(DEFAULT_GREP_TIMEOUT_MS);
    expect(askInput.metadata.hidden).toBe(true);
    expect(askInput.metadata.follow_symlinks).toBe(false);
    expect(askInput.metadata.real_path_exhaustive).toBe(true);
    expect(askInput.metadata.fixed_strings).toBe(false);
    expect(askInput.metadata.multiline).toBe(false);
    expect(askInput.metadata.multiline_dotall).toBe(false);
    expect(askInput.metadata.pcre2).toBe(false);
    expect(askInput.metadata.max_filesize).toBeUndefined();
    expect(askInput.metadata.sort_by).toBe('none');
    expect(askInput.metadata.sort_order).toBe('asc');
    expect(askInput.metadata.file_types).toEqual([]);
    expect(askInput.metadata.exclude_file_types).toEqual([]);
    expect(askInput.metadata.invert_match).toBe(false);
    expect(askInput.metadata.max_count_per_file).toBeUndefined();
    expect(askInput.metadata.route_mode).toBeUndefined();
    expect(askInput.metadata.requested_backend).toBeUndefined();
    expect(askInput.metadata.effective_backend).toBeUndefined();
    expect(askInput.metadata.route_fallback_reason).toBeUndefined();

    const metadataInput = getMetadataInput(ctx);
    expect(metadataInput.title).toBe('createTool');
    expect(metadataInput.metadata.backend).toBe('rg');
    expect(metadataInput.metadata.pattern).toBe('createTool');
    expect(metadataInput.metadata.case_sensitive).toBe(true);
    expect(metadataInput.metadata.word_regexp).toBe(false);
    expect(metadataInput.metadata.timeout_ms).toBe(DEFAULT_GREP_TIMEOUT_MS);
    expect(metadataInput.metadata.hidden).toBe(true);
    expect(metadataInput.metadata.follow_symlinks).toBe(false);
    expect(metadataInput.metadata.real_path_exhaustive).toBe(true);
    expect(metadataInput.metadata.fixed_strings).toBe(false);
    expect(metadataInput.metadata.multiline).toBe(false);
    expect(metadataInput.metadata.multiline_dotall).toBe(false);
    expect(metadataInput.metadata.pcre2).toBe(false);
    expect(metadataInput.metadata.max_filesize).toBeUndefined();
    expect(metadataInput.metadata.sort_by).toBe('none');
    expect(metadataInput.metadata.sort_order).toBe('asc');
    expect(metadataInput.metadata.matches).toBe(1);
    expect(metadataInput.metadata.before_context).toBe(0);
    expect(metadataInput.metadata.after_context).toBe(0);
    expect(metadataInput.metadata.file_types).toEqual([]);
    expect(metadataInput.metadata.exclude_file_types).toEqual([]);
    expect(metadataInput.metadata.invert_match).toBe(false);
    expect(metadataInput.metadata.max_count_per_file).toBeUndefined();
    expect(metadataInput.metadata.route_mode).toBeUndefined();
    expect(metadataInput.metadata.requested_backend).toBeUndefined();
    expect(metadataInput.metadata.effective_backend).toBeUndefined();
    expect(metadataInput.metadata.route_fallback_reason).toBeUndefined();
  });

  test('emits strategy metadata for mtime-hybrid results', async () => {
    const repoDir = temps.createRepo();
    const run: GrepRunner = mock(async () => {
      return {
        ...buildResult(repoDir),
        outputMode: 'files_with_matches',
        matchKind: 'file',
        files: [
          {
            file: 'src/example.ts',
            absolutePath: path.join(repoDir, 'src', 'example.ts'),
            replayPath: path.join(repoDir, 'src', 'example.ts'),
            matchCount: 1,
            matches: [],
          },
        ],
        totalMatches: 1,
        totalFiles: 1,
        strategy: 'mtime-hybrid',
        discoveryCommand: ['rg', '--files-with-matches', 'needle', repoDir],
        replayBatchCount: 2,
        replayTargetCount: 5,
        discoveredFiles: 5,
        sortedFiles: 5,
        replayedFiles: 1,
        partialPhase: 'replay',
        mtimeDiscoveryCapped: true,
        command: undefined,
      } satisfies GrepSearchResult;
    });

    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    await grep.execute(
      {
        pattern: 'needle',
        path: 'src',
        sort_by: 'mtime',
        output_mode: 'files_with_matches',
      },
      ctx as any,
    );

    const metadataInput = getMetadataInput(ctx);
    expect(metadataInput.metadata.strategy).toBe('mtime-hybrid');
    expect(metadataInput.metadata.command).toBeUndefined();
    expect(metadataInput.metadata.discovery_command).toEqual([
      'rg',
      '--files-with-matches',
      'needle',
      repoDir,
    ]);
    expect(metadataInput.metadata.replay_batch_count).toBe(2);
    expect(metadataInput.metadata.replay_target_count).toBe(5);
    expect(metadataInput.metadata.discovered_files).toBe(5);
    expect(metadataInput.metadata.sorted_files).toBe(5);
    expect(metadataInput.metadata.replayed_files).toBe(1);
    expect(metadataInput.metadata.partial_phase).toBe('replay');
    expect(metadataInput.metadata.mtime_discovery_capped).toBe(true);
  });

  test('emits metadata when normalization fails before execution', async () => {
    const repoDir = temps.createRepo();
    const grep = createGrepTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    const ctx = createExecutionContext(repoDir);

    await expect(
      grep.execute(
        {
          pattern: 'createTool',
          path: 'missing-path',
        },
        ctx as any,
      ),
    ).rejects.toThrow(/Search path does not exist/);

    expect(ctx.metadata).toHaveBeenCalledTimes(1);
    const metadataInput = getMetadataInput(ctx);
    expect(metadataInput.title).toBe('createTool');
    expect(metadataInput.metadata.error_stage).toBe('normalize');
    expect(metadataInput.metadata.pattern).toBe('createTool');
    expect(metadataInput.metadata.path).toBe('missing-path');
  });

  test('does not let metadata failure break a successful grep result', async () => {
    const repoDir = temps.createRepo();
    const run: GrepRunner = mock(async () => buildResult(repoDir));
    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = {
      ...createExecutionContext(repoDir),
      metadata: mock(() => {
        throw new Error('metadata channel failed');
      }),
    };

    const output = await grep.execute(
      {
        pattern: 'createTool',
        path: 'src',
      },
      ctx as any,
    );

    expect(output).toContain('Found 1 match across 1 file.');
  });

  test('emits metadata when permission step fails', async () => {
    const repoDir = temps.createRepo();
    const grep = createGrepTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    const ctx = {
      ...createExecutionContext(repoDir),
      ask: mock(async () => {
        throw new Error('permission denied');
      }),
    };

    await expect(
      grep.execute(
        {
          pattern: 'createTool',
          path: 'src',
        },
        ctx as any,
      ),
    ).rejects.toThrow(/permission denied/);

    expect(ctx.metadata).toHaveBeenCalledTimes(1);
    const metadataCalls = ctx.metadata.mock.calls as unknown as Array<
      [{ metadata: Record<string, unknown> }]
    >;
    const metadataInput = metadataCalls[0]?.[0];
    expect(metadataInput?.metadata.error_stage).toBe('permission');
    expect(metadataInput?.metadata.real_path).toBe(path.join(repoDir, 'src'));
  });

  test('preserves the original error when metadata emission also fails', async () => {
    const repoDir = temps.createRepo();
    const grep = createGrepTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    const ctx = {
      ...createExecutionContext(repoDir),
      metadata: mock(() => {
        throw new Error('metadata channel failed');
      }),
    };

    await expect(
      grep.execute(
        {
          pattern: 'createTool',
          path: 'missing-path',
        },
        ctx as any,
      ),
    ).rejects.toThrow(/Search path does not exist/);
  });

  test('sanitizes multiline pattern titles and reports real path metadata', async () => {
    const repoDir = temps.createRepo();
    const run: GrepRunner = mock(async () => buildResult(repoDir));
    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    await grep.execute(
      {
        pattern: 'first line\nsecond line',
        path: 'src',
      },
      ctx as any,
    );

    const metadataInput = getMetadataInput(ctx);
    expect(metadataInput.title).toBe('first line second line');
    expect(metadataInput.metadata.resolved_path).toBe(
      path.join(repoDir, 'src'),
    );
    expect(metadataInput.metadata.real_path).toBe(path.join(repoDir, 'src'));
  });
});
