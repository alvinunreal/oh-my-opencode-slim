import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearTuiAgentActivities,
  clearTuiSessionAlias,
  getTuiStatePath,
  readTuiSnapshot,
  readTuiSnapshotAsync,
  recordTuiAgentActivity,
  recordTuiAgentModel,
  recordTuiAgentModels,
  recordTuiSessionParent,
  resolveTuiSessionRoot,
  snapshotSectionsEqual,
  updateTuiSessionDetails,
} from './tui-state';

let previousXdgDataHome: string | undefined;
let tempDir: string;

beforeEach(() => {
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-state-'));
  process.env.XDG_DATA_HOME = tempDir;
});

afterEach(() => {
  if (previousXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = previousXdgDataHome;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

const LUNA = { agentName: 'explorer', model: 'openai/gpt-6-luna' } as const;
const GPT = { agentName: 'explorer', model: 'openai/gpt-6' } as const;

function recordLuna(): void {
  recordTuiAgentModel(LUNA, tempDir);
}

describe('tui-state persistence', () => {
  test('readTuiSnapshotAsync caches by stat and invalidates on write', async () => {
    recordTuiAgentModel(LUNA, tempDir);
    const first = await readTuiSnapshotAsync(tempDir);
    expect(first.agentModels.explorer).toBe(LUNA.model);

    // Same stat (dev:ino:mtimeMs:size) → cached snapshot object identity.
    const second = await readTuiSnapshotAsync(tempDir);
    expect(second).toBe(first);

    // A real write publishes via tmp+rename (new inode) → cache miss and
    // the updated content is observed by the next poll.
    recordTuiAgentModel(GPT, tempDir);
    const third = await readTuiSnapshotAsync(tempDir);
    expect(third).not.toBe(first);
    expect(third.agentModels.explorer).toBe(GPT.model);
  });

  test('readTuiSnapshotAsync cache is bounded (LRU eviction)', async () => {
    recordTuiAgentModel(LUNA, tempDir);
    const first = await readTuiSnapshotAsync(tempDir);
    expect(first.agentModels.explorer).toBe(LUNA.model);

    // Poll 8 other projects: the first entry must be evicted even though
    // its file is unchanged (a fresh read returns a new object identity).
    for (let i = 0; i < 8; i += 1) {
      const dir = path.join(tempDir, `project-${i}`);
      recordTuiAgentModel(GPT, dir);
      await readTuiSnapshotAsync(dir);
    }

    const reRead = await readTuiSnapshotAsync(tempDir);
    expect(reRead.agentModels.explorer).toBe(LUNA.model);
    expect(reRead).not.toBe(first);
  });

  test('persists enabled agent models', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          explorer: 'openai/gpt-6-luna',
          fixer: 'openai/gpt-6-luna',
        },
        agentVariants: {
          explorer: 'low',
          fixer: 'high',
        },
      },
      tempDir,
    );

    const snapshot = readTuiSnapshot(tempDir);

    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-6-luna',
      fixer: 'openai/gpt-6-luna',
    });
    expect(snapshot.agentVariants).toEqual({
      explorer: 'low',
      fixer: 'high',
    });
  });

  test('updates a single live agent model without dropping others', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          orchestrator: 'default',
          explorer: 'openai/gpt-6-luna',
        },
      },
      tempDir,
    );

    recordTuiAgentModel(
      {
        agentName: 'orchestrator',
        model: 'openai/gpt-6',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentModels).toEqual({
      orchestrator: 'openai/gpt-6',
      explorer: 'openai/gpt-6-luna',
    });
  });

  test('updates a single live agent variant without dropping others', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          orchestrator: 'default',
          explorer: 'openai/gpt-6-luna',
        },
        agentVariants: {
          explorer: 'low',
        },
      },
      tempDir,
    );

    recordTuiAgentModel(
      {
        agentName: 'orchestrator',
        model: 'openai/gpt-6',
        variant: 'high',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentVariants).toEqual({
      orchestrator: 'high',
      explorer: 'low',
    });
  });

  test('tracks concurrent activity by session without clearing the agent early', () => {
    recordTuiAgentActivity(
      { sessionID: 'fixer-a', agentName: 'fixer', active: true },
      tempDir,
    );
    recordTuiAgentActivity(
      { sessionID: 'fixer-b', agentName: 'fixer', active: true },
      tempDir,
    );

    recordTuiAgentActivity({ sessionID: 'fixer-a', active: false }, tempDir);

    expect(readTuiSnapshot(tempDir).activeSessions).toEqual({
      'fixer-b': 'fixer',
    });
  });

  test('does not restore stale activity during concurrent process cleanup', async () => {
    recordTuiAgentActivity(
      { sessionID: 'oracle-a', agentName: 'oracle', active: true },
      tempDir,
    );
    recordTuiAgentActivity(
      { sessionID: 'explorer-b', agentName: 'explorer', active: true },
      tempDir,
    );

    const barrierDir = path.join(tempDir, 'cleanup-barrier');
    const readReleasePath = path.join(barrierDir, 'read-release');
    const startReleasePath = path.join(barrierDir, 'start-release');
    fs.mkdirSync(barrierDir, { recursive: true });
    const statePath = getTuiStatePath(tempDir);
    const moduleUrl = new URL('./tui-state.ts', import.meta.url).href;
    const workerSource = `
      import { mock } from 'bun:test';
      import fs from 'node:fs';

      const originalReadFileSync = fs.readFileSync.bind(fs);
      let paused = false;
      mock.module('node:fs', () => ({
        ...fs,
        readFileSync: (...args) => {
          const value = originalReadFileSync(...args);
          if (
            !paused &&
            String(args[0]) === process.env.TUI_STATE_PATH &&
            !fs.existsSync(process.env.TUI_STATE_LOCK_PATH)
          ) {
            paused = true;
            fs.writeFileSync(process.env.READ_MARKER, 'ready');
            const sleeper = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(process.env.READ_RELEASE)) {
              Atomics.wait(sleeper, 0, 0, 10);
            }
          }
          return value;
        },
      }));

      const { recordTuiAgentActivity } = await import(
        process.env.TUI_STATE_MODULE_URL
      );
      fs.writeFileSync(process.env.START_MARKER, 'ready');
      const starter = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(process.env.START_RELEASE)) {
        Atomics.wait(starter, 0, 0, 10);
      }
      recordTuiAgentActivity(
        { sessionID: process.env.SESSION_ID, active: false },
        process.env.PROJECT_DIR,
      );
    `;
    const sessions = ['oracle-a', 'explorer-b'];
    const workers = sessions.map((sessionID, index) =>
      Bun.spawn([process.execPath, '-e', workerSource], {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          PROJECT_DIR: tempDir,
          READ_MARKER: path.join(barrierDir, `read-${index}`),
          READ_RELEASE: readReleasePath,
          SESSION_ID: sessionID,
          START_MARKER: path.join(barrierDir, `start-${index}`),
          START_RELEASE: startReleasePath,
          TUI_STATE_MODULE_URL: moduleUrl,
          TUI_STATE_LOCK_PATH: `${statePath}.lock`,
          TUI_STATE_PATH: statePath,
        },
        stdout: 'ignore',
        stderr: 'pipe',
      }),
    );

    const deadline = Date.now() + 5_000;
    while (
      !workers.every((_, index) =>
        fs.existsSync(path.join(barrierDir, `start-${index}`)),
      )
    ) {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for cleanup workers to start');
      }
      await Bun.sleep(10);
    }
    fs.writeFileSync(startReleasePath, 'release');

    while (workers.some((worker) => worker.exitCode === null)) {
      const allReadsPaused = workers.every((_, index) =>
        fs.existsSync(path.join(barrierDir, `read-${index}`)),
      );
      if (allReadsPaused) {
        fs.writeFileSync(readReleasePath, 'release');
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for concurrent cleanup');
      }
      await Bun.sleep(10);
    }

    const exitCodes = await Promise.all(workers.map((worker) => worker.exited));
    for (const [index, exitCode] of exitCodes.entries()) {
      if (exitCode !== 0) {
        const stderr = await new Response(workers[index]?.stderr).text();
        throw new Error(`Cleanup worker ${index} failed: ${stderr}`);
      }
    }

    expect(readTuiSnapshot(tempDir).activeSessions).toEqual({});
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
  });

  test('recovers an abandoned state lock', () => {
    const statePath = getTuiStatePath(tempDir);
    const lockPath = `${statePath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '{}');
    const staleTime = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(lockPath, staleTime, staleTime);

    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-6-luna' },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe(
      'openai/gpt-6-luna',
    );
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('scopes recorded activity to the owning conversation tree', () => {
    recordTuiSessionParent('child-a', 'conv-1', tempDir);
    recordTuiSessionParent('child-b', 'conv-2', tempDir);
    recordTuiAgentActivity(
      { sessionID: 'child-a', agentName: 'oracle', active: true },
      tempDir,
    );
    recordTuiAgentActivity(
      { sessionID: 'child-b', agentName: 'fixer', active: true },
      tempDir,
    );

    // Roots resolve through the persistent index; render compares both
    // sides against it, so conv-2's subagents stay out of conv-1 (#1147).
    expect(resolveTuiSessionRoot('child-a', tempDir)).toBe('conv-1');
    expect(resolveTuiSessionRoot('child-b', tempDir)).toBe('conv-2');
    expect(readTuiSnapshot(tempDir).activeSessions).toEqual({
      'child-a': 'oracle',
      'child-b': 'fixer',
    });
  });

  test('resolves multi-level ancestry through the index', () => {
    recordTuiSessionParent('grandchild', 'child', tempDir);
    recordTuiSessionParent('child', 'root', tempDir);

    expect(resolveTuiSessionRoot('grandchild', tempDir)).toBe('root');
    expect(resolveTuiSessionRoot('child', tempDir)).toBe('root');
    expect(resolveTuiSessionRoot('root', tempDir)).toBe('root');
  });

  test('re-roots a live activity when ancestry is discovered late', () => {
    // Revived/restarted session recorded before its parent was known.
    recordTuiAgentActivity(
      { sessionID: 'child-a', agentName: 'oracle', active: true },
      tempDir,
    );
    expect(resolveTuiSessionRoot('child-a', tempDir)).toBe('child-a');

    recordTuiSessionParent('child-a', 'root-a', tempDir);

    expect(readTuiSnapshot(tempDir).sessionParents['child-a']).toBe('root-a');
    expect(resolveTuiSessionRoot('child-a', tempDir)).toBe('root-a');
  });

  test('startup sweep keeps live foreign activities and drops dead residue', async () => {
    const dead = Bun.spawn(['true']);
    await dead.exited;
    const live = Bun.spawn(['sleep', '30']);
    try {
      const statePath = getTuiStatePath(tempDir);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        `${JSON.stringify({
          version: 1,
          updatedAt: Date.now(),
          agentModels: {},
          agentVariants: {},
          activeSessions: {
            'dead-a': 'oracle',
            'live-b': 'fixer',
            'legacy-c': 'explorer',
          },
          activityPids: {
            'dead-a': dead.pid,
            'live-b': live.pid,
          },
        })}\n`,
      );

      clearTuiAgentActivities(tempDir);

      expect(readTuiSnapshot(tempDir).activeSessions).toEqual({
        'live-b': 'fixer',
      });
    } finally {
      live.kill();
    }
  });

  test('startup sweep keeps live own-PID activity and still drops dead residue', () => {
    recordTuiAgentModels(
      { agentModels: { explorer: 'openai/gpt-6-luna' } },
      tempDir,
    );
    recordTuiAgentActivity(
      {
        sessionID: 'explorer-a',
        agentName: 'explorer',
        active: true,
        details: { alias: 'exp-1' },
      },
      tempDir,
    );

    clearTuiAgentActivities(tempDir);

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.activeSessions).toEqual({ 'explorer-a': 'explorer' });
    expect(snapshot.sessionDetails['explorer-a']?.alias).toBe('exp-1');
    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-6-luna',
    });
  });

  test('ignores legacy config status fields in old snapshots', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        agentModels: { explorer: 'openai/gpt-6-luna' },
        configInvalid: true,
        configInvalidByProject: { old: true },
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-6-luna',
    });
    expect(snapshot.agentVariants).toEqual({});
    expect(snapshot.activeSessions).toEqual({});
  });

  test('parseSnapshot tolerates a snapshot without reusableByAgent (defaults {})', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        agentModels: { explorer: 'openai/gpt-6-luna' },
        // Pre-dot snapshot: no reusableByAgent key at all.
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.reusableByAgent).toEqual({});
    // Sibling sections still parse.
    expect(snapshot.agentModels.explorer).toBe('openai/gpt-6-luna');
  });

  test('parseSnapshot restores a well-formed reusableByAgent section', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        reusableByAgent: {
          'parent-1': {
            oracle: [
              {
                taskID: 'ses_1',
                alias: 'ora-1',
                terminalState: 'completed',
                completedAt: 200,
                lastUsedAt: 300,
              },
            ],
          },
        },
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.reusableByAgent['parent-1']?.oracle).toEqual([
      {
        taskID: 'ses_1',
        alias: 'ora-1',
        terminalState: 'completed',
        completedAt: 200,
        lastUsedAt: 300,
      },
    ]);
  });

  test('parseSnapshot accepts stable running entries without terminal fields', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        reusableByAgent: {
          'parent-1': {
            oracle: [
              { taskID: 'ses_live', alias: 'ora-1', running: true },
              { taskID: 'ses_bad', alias: 'ora-2', running: false },
            ],
          },
        },
      }),
    );
    expect(
      readTuiSnapshot(tempDir).reusableByAgent['parent-1']?.oracle,
    ).toEqual([{ taskID: 'ses_live', alias: 'ora-1', running: true }]);
  });

  test('parseSnapshot drops malformed reusableByAgent entries', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        reusableByAgent: {
          'parent-1': {
            oracle: { taskID: 'ses_1' }, // missing alias/lastUsedAt
            fixer: null,
          },
          'parent-2': 'not-an-object',
        },
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.reusableByAgent).toEqual({});
  });

  test('snapshotSectionsEqual includes reusableByAgent', () => {
    const base = readTuiSnapshot(tempDir);
    const sameAgentModels = readTuiSnapshot(tempDir);
    sameAgentModels.reusableByAgent['parent-1'] = {
      oracle: [
        {
          taskID: 'ses_1',
          alias: 'ora-1',
          terminalState: 'completed',
          lastUsedAt: 300,
        },
      ],
    };
    // A reusableByAgent-only difference must break equality…
    expect(snapshotSectionsEqual(base, sameAgentModels)).toBe(false);

    // …and identical sections (both empty) stay equal.
    const alsoEmpty = readTuiSnapshot(tempDir);
    expect(snapshotSectionsEqual(base, alsoEmpty)).toBe(true);
  });

  test('cross-project isolation — different directories write independent state files', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-b-'));
    try {
      recordTuiAgentModels({ agentModels: { explorer: 'model-a' } }, dirA);
      recordTuiAgentModels({ agentModels: { explorer: 'model-b' } }, dirB);

      expect(readTuiSnapshot(dirA).agentModels.explorer).toBe('model-a');
      expect(readTuiSnapshot(dirB).agentModels.explorer).toBe('model-b');
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('skips the disk write when the recorded value is unchanged', () => {
    recordLuna();
    const filePath = getTuiStatePath(tempDir);
    const oldMtime = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(filePath, oldMtime, oldMtime);
    const baselineMtime = fs.statSync(filePath).mtimeMs;
    recordLuna();
    expect(fs.statSync(filePath).mtimeMs).toBe(baselineMtime);
  });

  test('repeated no-op updates do not touch the lock or the filesystem', async () => {
    recordLuna();
    const fsModule = await import('node:fs');
    let openCalls = 0;
    let readCalls = 0;
    const lockCreateSpy = spyOn(fsModule, 'openSync').mockImplementation(
      (...args: Parameters<typeof fs.openSync>) => {
        openCalls += 1;
        return fs.openSync(...args);
      },
    );
    const readSpy = spyOn(fsModule, 'readFileSync').mockImplementation(
      (...args: Parameters<typeof fs.readFileSync>) => {
        readCalls += 1;
        return fs.readFileSync(...args);
      },
    );
    try {
      recordLuna();
      recordLuna();
      expect(openCalls).toBe(0);
      expect(readCalls).toBe(0);
    } finally {
      lockCreateSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  test('a real change after a no-op still reaches the disk', () => {
    recordLuna();
    recordLuna();
    recordTuiAgentModel(GPT, tempDir);
    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe(GPT.model);
  });

  test('external snapshot changes are not masked by the memo', () => {
    recordLuna();
    const external = readTuiSnapshot(tempDir);
    external.agentModels.builder = GPT.model;
    fs.writeFileSync(getTuiStatePath(tempDir), `${JSON.stringify(external)}\n`);
    recordTuiAgentModel(
      { agentName: 'build', model: 'anthropic/claude-x' },
      tempDir,
    );
    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.agentModels.builder).toBe(GPT.model);
    expect(snapshot.agentModels.build).toBe('anthropic/claude-x');
  });

  test('a failed persistence is retried, not swallowed by the memo', async () => {
    recordLuna();
    const fsModule = await import('node:fs');
    const renameSpy = spyOn(fsModule, 'renameSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      recordTuiAgentModel(GPT, tempDir);
    } finally {
      renameSpy.mockRestore();
    }
    recordTuiAgentModel(GPT, tempDir);
    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe(GPT.model);
  });

  test('external atomic replacement invalidates the memo even with identical mtime and size', () => {
    recordTuiAgentModel({ agentName: 'explorer', model: 'model-x' }, tempDir);
    const filePath = getTuiStatePath(tempDir);
    const external = readTuiSnapshot(tempDir);
    external.agentModels.explorer = 'model-y';
    const tmpPath = `${filePath}.external.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(external)}\n`);
    const stat = fs.statSync(filePath);
    fs.renameSync(tmpPath, filePath);
    fs.utimesSync(filePath, stat.atime, stat.mtime);
    recordTuiAgentModel({ agentName: 'explorer', model: 'model-x' }, tempDir);
    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe('model-x');
  });

  test('in-place rewrite preserving mtime is caught by ctime', () => {
    recordTuiAgentModel({ agentName: 'explorer', model: 'model-x' }, tempDir);
    const filePath = getTuiStatePath(tempDir);

    // Pin mtime to a whole-millisecond date (utimes cannot restore
    // sub-millisecond precision), then re-prime the memo so it holds a
    // stat snapshot of this exact state.
    const pinned = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(filePath, pinned, pinned);
    recordTuiAgentModel({ agentName: 'explorer', model: 'model-x' }, tempDir);
    const statBefore = fs.statSync(filePath);

    // In-place rewrite (same inode, same length): mtime restored via
    // utimes. ctime cannot be restored by userspace, so the memo must
    // invalidate and re-record the value from the real file.
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleeper, 0, 0, 10);
    const external = readTuiSnapshot(tempDir);
    external.agentModels.explorer = 'model-y';
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, `${JSON.stringify(external)}\n`);
    fs.closeSync(fd);
    fs.utimesSync(filePath, statBefore.atime, statBefore.mtime);
    const statAfter = fs.statSync(filePath);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);

    recordTuiAgentModel({ agentName: 'explorer', model: 'model-x' }, tempDir);
    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe('model-x');
  });

  test('a transient read failure does not seed the memo with an empty snapshot', async () => {
    recordTuiAgentActivity(
      { sessionID: 's1', agentName: 'oracle', active: true },
      tempDir,
    );
    const filePath = getTuiStatePath(tempDir);
    const fsModule = await import('node:fs');
    const originalRead = fsModule.readFileSync;
    const readSpy = spyOn(fsModule, 'readFileSync').mockImplementation(
      (path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (String(path) === filePath) {
          const err = new Error('transient') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return originalRead(path as fs.PathOrFileDescriptor, ...(args as []));
      },
    );
    try {
      recordTuiAgentActivity({ sessionID: 's1', active: false }, tempDir);
    } finally {
      readSpy.mockRestore();
    }
    recordTuiAgentActivity({ sessionID: 's1', active: false }, tempDir);
    expect(readTuiSnapshot(tempDir).activeSessions).toEqual({});
  });

  test('keeps the final file intact when the atomic rename fails', async () => {
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-6-luna' },
      tempDir,
    );

    const fsModule = await import('node:fs');
    const renameSpy = spyOn(fsModule, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });

    try {
      recordTuiAgentModel(
        { agentName: 'explorer', model: 'openai/gpt-6' },
        tempDir,
      );
    } finally {
      renameSpy.mockRestore();
    }

    // The previously written state must still be readable in full.
    expect(readTuiSnapshot(tempDir).agentModels).toEqual({
      explorer: 'openai/gpt-6-luna',
    });

    const stateDir = path.dirname(getTuiStatePath(tempDir));
    expect(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('leaves no temp files behind on the happy path', () => {
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-6-luna' },
      tempDir,
    );

    const stateDir = path.dirname(getTuiStatePath(tempDir));
    expect(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });
});

describe('sessionDetails (clickable sidebar projection)', () => {
  test('activation with details round-trips alias/status', () => {
    recordTuiAgentActivity(
      {
        sessionID: 'ora-1-ses',
        agentName: 'oracle',
        active: true,
        details: { alias: 'ora-1', status: 'busy' },
      },
      tempDir,
    );
    expect(readTuiSnapshot(tempDir).sessionDetails).toEqual({
      'ora-1-ses': { alias: 'ora-1', status: 'busy' },
    });
  });

  test('deactivation removes details together with the activity', () => {
    recordTuiAgentActivity(
      {
        sessionID: 'ora-1-ses',
        agentName: 'oracle',
        active: true,
        details: { alias: 'ora-1' },
      },
      tempDir,
    );
    recordTuiAgentActivity({ sessionID: 'ora-1-ses', active: false }, tempDir);
    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.activeSessions).toEqual({});
    expect(snapshot.sessionDetails).toEqual({});
  });

  test('detail updates only apply to active sessions (no resurrection)', () => {
    // Idle first: a late detail update must not recreate the entry.
    recordTuiAgentActivity({ sessionID: 'gone', active: false }, tempDir);
    updateTuiSessionDetails('gone', { alias: 'ora-9' }, tempDir);
    expect(readTuiSnapshot(tempDir).sessionDetails).toEqual({});

    // Active session: updates merge into existing details.
    recordTuiAgentActivity(
      { sessionID: 'live', agentName: 'oracle', active: true },
      tempDir,
    );
    updateTuiSessionDetails('live', { alias: 'ora-1' }, tempDir);
    updateTuiSessionDetails('live', { status: 'retry' }, tempDir);
    expect(readTuiSnapshot(tempDir).sessionDetails).toEqual({
      live: { alias: 'ora-1', status: 'retry' },
    });
  });

  test('clearTuiSessionAlias retracts only the alias, keeping status', () => {
    recordTuiAgentActivity(
      {
        sessionID: 'live',
        agentName: 'oracle',
        active: true,
        details: { alias: 'ora-1', status: 'busy' },
      },
      tempDir,
    );
    clearTuiSessionAlias('live', tempDir);
    expect(readTuiSnapshot(tempDir).sessionDetails).toEqual({
      live: { status: 'busy' },
    });
    // Alias-less entry with no other fields is removed entirely.
    recordTuiAgentActivity(
      {
        sessionID: 'bare',
        agentName: 'fixer',
        active: true,
        details: { alias: 'fix-1' },
      },
      tempDir,
    );
    clearTuiSessionAlias('bare', tempDir);
    expect(readTuiSnapshot(tempDir).sessionDetails.bare).toBeUndefined();
  });

  test('orphaned details are swept by clearTuiAgentActivities', () => {
    // Simulate a live foreign recorder (PID 1 is always running and is
    // never this process) plus an orphaned details entry with no activity.
    const statePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        updatedAt: 1,
        activeSessions: { 'live-foreign': 'oracle' },
        activityPids: { 'live-foreign': 1 },
        sessionDetails: {
          'live-foreign': { alias: 'ora-7' },
          orphan: { alias: 'ora-8' },
        },
      })}\n`,
    );

    clearTuiAgentActivities(tempDir);
    const after = readTuiSnapshot(tempDir);
    expect(after.activeSessions).toEqual({ 'live-foreign': 'oracle' });
    expect(after.sessionDetails).toEqual({
      'live-foreign': { alias: 'ora-7' },
    });
  });

  test('parser drops malformed detail entries without losing valid ones', () => {
    const statePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        updatedAt: 1,
        sessionDetails: {
          good: { alias: 'ora-1', model: 'openai/gpt-6', status: 'busy' },
          oldModelOnly: { model: 'openai/gpt-6' },
          badStatus: { alias: 'ora-2', status: 'weird' },
          nonObject: 'nope',
          nullEntry: null,
          empty: {},
        },
      })}\n`,
    );
    const parsed = readTuiSnapshot(tempDir);
    expect(parsed.sessionDetails).toEqual({
      good: { alias: 'ora-1', status: 'busy' },
      badStatus: { alias: 'ora-2' },
    });
  });

  test('legacy snapshot without sessionDetails parses with an empty section', () => {
    const statePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        updatedAt: 1,
        agentModels: { oracle: 'openai/gpt-6' },
      })}\n`,
    );
    const parsed = readTuiSnapshot(tempDir);
    expect(parsed.sessionDetails).toEqual({});
    expect(parsed.agentModels).toEqual({ oracle: 'openai/gpt-6' });
  });
});
