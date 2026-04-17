/// <reference types="bun-types" />
import { afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetGrepCliResolverForTests } from './resolver';
import type { GrepSearchResult } from './types';

function createTempPath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

export function createTempDir(prefix = 'oh-my-opencode-grep'): string {
  const dir = createTempPath(prefix);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createTempRepo(): string {
  const dir = createTempDir('oh-my-opencode-grep');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'src', 'example.ts'),
    [
      "import { createTool } from './tool';",
      'const target = createTool();',
      'export { target };',
      '',
    ].join('\n'),
  );
  return dir;
}

export function createTempTracker(options: { resetResolver?: boolean } = {}) {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }

    if (options.resetResolver) {
      resetGrepCliResolverForTests();
    }

    mock.restore();
  });

  return {
    add<T extends string>(dir: T): T {
      tempDirs.push(dir);
      return dir;
    },
    createDir(prefix?: string): string {
      const dir = createTempDir(prefix);
      tempDirs.push(dir);
      return dir;
    },
    createRepo(): string {
      const dir = createTempRepo();
      tempDirs.push(dir);
      return dir;
    },
  };
}

export function createRepoContext(directory: string, worktree = directory) {
  return {
    directory,
    worktree,
  } as const;
}

export function createExecutionContext(
  directory: string,
  worktree = directory,
) {
  return {
    ask: mock(async () => undefined),
    metadata: mock(() => undefined),
    abort: new AbortController().signal,
    directory,
    worktree,
    sessionID: 'session-1',
    messageID: 'message-1',
    agent: 'explorer',
  } as const;
}

export function createTextStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

export function buildResult(directory: string): GrepSearchResult {
  return {
    files: [
      {
        file: 'src/example.ts',
        absolutePath: path.join(directory, 'src', 'example.ts'),
        matchCount: 1,
        matches: [
          {
            lineNumber: 2,
            lineText: 'const target = createTool();',
            submatches: ['createTool'],
            before: [
              {
                lineNumber: 1,
                text: "import { createTool } from './tool';",
              },
            ],
            after: [
              {
                lineNumber: 3,
                text: 'export { target };',
              },
            ],
          },
        ],
      },
    ],
    totalMatches: 1,
    totalFiles: 1,
    outputMode: 'content',
    matchKind: 'match',
    truncated: false,
    limitReached: false,
    timedOut: false,
    cancelled: false,
    exitCode: 0,
    retryCount: 0,
    command: [
      'rg',
      '--json',
      '--regexp',
      'createTool',
      path.join(directory, 'src'),
    ],
    cwd: directory,
    stderr: '',
    warnings: [],
  };
}
