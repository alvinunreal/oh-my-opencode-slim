import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearTuiAgentActivities,
  clearTuiSessionAlias,
  flushTuiSnapshotBatch,
  getTuiStatePath,
  readTuiSnapshot,
  readTuiSnapshotAsync,
  recordTuiAgentActivity,
  recordTuiAgentModel,
  recordTuiAgentModels,
  recordTuiSessionParent,
  resolveTuiSnapshotRoot,
  snapshotSectionsEqual,
  TUI_SESSION_PARENTS_MAX,
  updateSnapshot,
  updateTuiSessionDetails,
  withTuiSnapshotBatch,
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

const LUNA = {
  sessionID: 'model-session',
  agentName: 'explorer',
  model: 'openai/gpt-6-luna',
} as const;
const GPT = {
  sessionID: 'model-session',
  agentName: 'explorer',
  model: 'openai/gpt-6',
} as const;

function recordLuna(): void {
  recordTuiAgentModel(LUNA, tempDir);
}

describe('tui-state persistence', () => {
  test('bounds session observations while retaining active sessions', () => {
    updateSnapshot(tempDir, (snapshot) => {
      snapshot.sessionModels = Object.fromEntries(
        Array.from({ length: TUI_SESSION_PARENTS_MAX }, (_, i) => [
          `session-${i}`,
          { explorer: { model: `model-${i}` } },
        ]),
      );
      snapshot.activeSessions['session-0'] = 'explorer';
      snapshot.activityPids['session-0'] = process.pid;
    });
    recordTuiAgentModel(
      { sessionID: 'new', agentName: 'explorer', model: 'new-model' },
      tempDir,
    );
    const sessions = readTuiSnapshot(tempDir).sessionModels ?? {};
    expect(Object.keys(sessions)).toHaveLength(TUI_SESSION_PARENTS_MAX);
    expect(sessions['session-0']?.explorer?.model).toBe('model-0');
    expect(sessions['session-1']).toBeUndefined();
    expect(sessions.new?.explorer?.model).toBe('new-model');

    recordTuiAgentActivity({ sessionID: 'session-0', active: false }, tempDir);
    recordTuiAgentModel(
      { sessionID: 'newer', agentName: 'explorer', model: 'newer-model' },
      tempDir,
    );
    const afterIdle = readTuiSnapshot(tempDir).sessionModels ?? {};
    expect(Object.keys(afterIdle)).toHaveLength(TUI_SESSION_PARENTS_MAX);
    expect(afterIdle['session-0']).toBeUndefined();
    expect(afterIdle.newer?.explorer?.model).toBe('newer-model');
  });

  test('readTuiSnapshotAsync caches by stat and invalidates on write', async () => {
    recordTuiAgentModel(LUNA, tempDir);
    const first = await readTuiSnapshotAsync(tempDir);
    expect(first.sessionModels?.['model-session']?.explorer?.model).toBe(
      LUNA.model,
    );

    // Same stat (dev:ino:mtimeMs:size) → cached snapshot object identity.
    const second = await readTuiSnapshotAsync(tempDir);
    expect(second).toBe(first);

    // A real write publishes via tmp+rename (new inode) → cache miss and
    // the updated content is observed by the next poll.
    recordTuiAgentModel(GPT, tempDir);
    const third = await readTuiSnapshotAsync(tempDir);
    expect(third).not.toBe(first);
    expect(third.sessionModels?.['model-session']?.explorer?.model).toBe(
      GPT.model,
    );
  });

  test('readTuiSnapshotAsync cache is bounded (LRU eviction)', async () => {
    recordTuiAgentModel(LUNA, tempDir);
    const first = await readTuiSnapshotAsync(tempDir);
    expect(first.sessionModels?.['model-session']?.explorer?.model).toBe(
      LUNA.model,
    );

    // Poll 8 other projects: the first entry must be evicted even though
    // its file is unchanged (a fresh read returns a new object identity).
    for (let i = 0; i < 8; i += 1) {
      const dir = path.join(tempDir, `project-${i}`);
      recordTuiAgentModel(GPT, dir);
      await readTuiSnapshotAsync(dir);
    }

    const reRead = await readTuiSnapshotAsync(tempDir);
    expect(reRead.sessionModels?.['model-session']?.explorer?.model).toBe(
      LUNA.model,
    );
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

  test('persists canonical-to-display names and keeps them on model-only writes', () => {
    recordTuiAgentModels(
      {
        agentModels: { arbiter: 'openai/gpt-6' },
        agentDisplayNames: { arbiter: 'reviewer' },
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentDisplayNames).toEqual({
      arbiter: 'reviewer',
    });

    // A writer that only carries models must not wipe the label map.
    recordTuiAgentModels(
      {
        agentModels: { arbiter: 'openai/gpt-6', paladin: 'openai/gpt-6' },
      },
      tempDir,
    );
    expect(readTuiSnapshot(tempDir).agentDisplayNames).toEqual({
      arbiter: 'reviewer',
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
        sessionID: 'model-session',
        agentName: 'orchestrator',
        model: 'openai/gpt-6',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentModels).toEqual({
      orchestrator: 'default',
      explorer: 'openai/gpt-6-luna',
    });
    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.orchestrator,
    ).toEqual({ model: 'openai/gpt-6' });
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
        sessionID: 'model-session',
        agentName: 'orchestrator',
        model: 'openai/gpt-6',
        variant: 'high',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentVariants).toEqual({
      explorer: 'low',
    });
    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.orchestrator,
    ).toEqual({ model: 'openai/gpt-6', variant: 'high' });
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

    recordTuiAgentModel(LUNA, tempDir);

    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.explorer
        ?.model,
    ).toBe('openai/gpt-6-luna');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('recovers an aged state lock whose recorded PID is alive', () => {
    const lockPath = `${getTuiStatePath(tempDir)}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
    const staleTime = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(lockPath, staleTime, staleTime);

    recordLuna();

    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.explorer
        ?.model,
    ).toBe(LUNA.model);
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
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'child-a')).toBe(
      'conv-1',
    );
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'child-b')).toBe(
      'conv-2',
    );
    expect(readTuiSnapshot(tempDir).activeSessions).toEqual({
      'child-a': 'oracle',
      'child-b': 'fixer',
    });
  });

  function seedSessionParents(count: number): void {
    const statePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        ...readTuiSnapshot(tempDir),
        sessionParents: Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `ses_${i}`,
            i ? `ses_${i - 1}` : 'root',
          ]),
        ),
      }),
    );
  }

  test('caps session parents on any write, refreshing re-registered links', () => {
    seedSessionParents(TUI_SESSION_PARENTS_MAX + 2);

    recordLuna();
    expect(readTuiSnapshot(tempDir).sessionParents.ses_1).toBeUndefined();
    recordTuiSessionParent('ses_2', 'root', tempDir);
    recordTuiSessionParent('ses_new', 'root', tempDir);

    const { sessionParents } = readTuiSnapshot(tempDir);
    expect(Object.keys(sessionParents)).toHaveLength(TUI_SESSION_PARENTS_MAX);
    expect(sessionParents.ses_2).toBe('root');
    expect(sessionParents.ses_3).toBeUndefined();
    expect(sessionParents.ses_new).toBe('root');
  });

  test('keeps the ancestry of an active session past the cap', () => {
    seedSessionParents(TUI_SESSION_PARENTS_MAX + 1);
    recordTuiAgentActivity(
      { sessionID: 'ses_1', agentName: 'explorer', active: true },
      tempDir,
    );

    recordTuiSessionParent('ses_new', 'root', tempDir);

    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'ses_1')).toBe(
      'root',
    );
  });

  test('resolves multi-level ancestry through the index', () => {
    recordTuiSessionParent('grandchild', 'child', tempDir);
    recordTuiSessionParent('child', 'root', tempDir);

    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'grandchild')).toBe(
      'root',
    );
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'child')).toBe(
      'root',
    );
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'root')).toBe(
      'root',
    );
  });

  test('re-roots a live activity when ancestry is discovered late', () => {
    // Revived/restarted session recorded before its parent was known.
    recordTuiAgentActivity(
      { sessionID: 'child-a', agentName: 'oracle', active: true },
      tempDir,
    );
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'child-a')).toBe(
      'child-a',
    );

    recordTuiSessionParent('child-a', 'root-a', tempDir);

    expect(readTuiSnapshot(tempDir).sessionParents['child-a']).toBe('root-a');
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'child-a')).toBe(
      'root-a',
    );
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
              {
                taskID: 'ses_2',
                alias: 'ora-2',
                terminalState: 'stopped',
                lastUsedAt: 400,
              },
              {
                taskID: 'ses_invalid',
                alias: 'ora-3',
                terminalState: 'unknown',
                lastUsedAt: 500,
              },
              {
                taskID: 'ses_no_timestamp',
                alias: 'ora-4',
                terminalState: 'stopped',
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
      {
        taskID: 'ses_2',
        alias: 'ora-2',
        terminalState: 'stopped',
        lastUsedAt: 400,
      },
    ]);
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

  test('memoized updates deep-clone nested reusableByAgent arrays', () => {
    const entry = (taskID: string) => ({
      taskID,
      alias: taskID,
      terminalState: 'completed' as const,
      lastUsedAt: 1,
    });
    // First write seeds the in-memory memo with a nested entry array.
    expect(
      updateSnapshot(tempDir, (snapshot) => {
        snapshot.reusableByAgent['parent-1'] = { oracle: [entry('ses_1')] };
      }),
    ).toBe(true);
    // An in-place push on the memo-backed candidate must not leak into the
    // memo: a shared array would make the update look like a no-op and
    // silently skip the disk write.
    expect(
      updateSnapshot(tempDir, (snapshot) => {
        snapshot.reusableByAgent['parent-1']?.oracle?.push(entry('ses_2'));
      }),
    ).toBe(true);

    const onDisk = JSON.parse(
      fs.readFileSync(getTuiStatePath(tempDir), 'utf8'),
    ) as { reusableByAgent: Record<string, Record<string, unknown[]>> };
    expect(
      onDisk.reusableByAgent['parent-1']?.oracle?.map(
        (item) => (item as { taskID: string }).taskID,
      ),
    ).toEqual(['ses_1', 'ses_2']);
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
    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.explorer
        ?.model,
    ).toBe(GPT.model);
  });

  test('single-key no-op avoids cloning but an external replacement is respected', () => {
    recordLuna();
    const clone = spyOn(globalThis, 'structuredClone');
    try {
      recordLuna();
      expect(clone).not.toHaveBeenCalled();

      const filePath = getTuiStatePath(tempDir);
      const external = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      external.sessionModels[GPT.sessionID].explorer = { model: GPT.model };
      fs.writeFileSync(`${filePath}.external`, JSON.stringify(external));
      fs.renameSync(`${filePath}.external`, filePath);
      recordLuna();
      expect(
        readTuiSnapshot(tempDir).sessionModels?.[LUNA.sessionID]?.explorer
          ?.model,
      ).toBe(LUNA.model);
      expect(clone).toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  test('synchronous reads retain the persisted snapshot normalization', () => {
    updateSnapshot(tempDir, (snapshot) => {
      snapshot.agentModels.explorer = 'model';
      snapshot.sessionDetails.session = { alias: undefined };
    });
    expect(readTuiSnapshot(tempDir).sessionDetails).toEqual({});
  });

  test('external snapshot changes are not masked by the memo', () => {
    recordLuna();
    const external = readTuiSnapshot(tempDir);
    external.agentModels.builder = GPT.model;
    fs.writeFileSync(getTuiStatePath(tempDir), `${JSON.stringify(external)}\n`);
    recordTuiAgentModel(
      {
        sessionID: 'model-session',
        agentName: 'build',
        model: 'anthropic/claude-x',
      },
      tempDir,
    );
    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.agentModels.builder).toBe(GPT.model);
    expect(snapshot.sessionModels?.['model-session']?.build?.model).toBe(
      'anthropic/claude-x',
    );
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
    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.explorer
        ?.model,
    ).toBe(GPT.model);
  });

  test('external atomic replacement invalidates the memo even with identical mtime and size', () => {
    recordTuiAgentModel(
      { sessionID: 'model-session', agentName: 'explorer', model: 'model-x' },
      tempDir,
    );
    const filePath = getTuiStatePath(tempDir);
    const external = readTuiSnapshot(tempDir);
    external.sessionModels = {
      'model-session': { explorer: { model: 'model-y' } },
    };
    const tmpPath = `${filePath}.external.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(external)}\n`);
    const stat = fs.statSync(filePath);
    fs.renameSync(tmpPath, filePath);
    fs.utimesSync(filePath, stat.atime, stat.mtime);
    recordTuiAgentModel(
      { sessionID: 'model-session', agentName: 'explorer', model: 'model-x' },
      tempDir,
    );
    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.explorer
        ?.model,
    ).toBe('model-x');
  });

  test('in-place rewrite preserving mtime is caught by ctime', () => {
    recordTuiAgentModel(
      { sessionID: 'model-session', agentName: 'explorer', model: 'model-x' },
      tempDir,
    );
    const filePath = getTuiStatePath(tempDir);

    // Pin mtime to a whole-millisecond date (utimes cannot restore
    // sub-millisecond precision), then re-prime the memo so it holds a
    // stat snapshot of this exact state.
    const pinned = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(filePath, pinned, pinned);
    recordTuiAgentModel(
      { sessionID: 'model-session', agentName: 'explorer', model: 'model-x' },
      tempDir,
    );
    const statBefore = fs.statSync(filePath);

    // In-place rewrite (same inode, same length): mtime restored via
    // utimes. ctime cannot be restored by userspace, so the memo must
    // invalidate and re-record the value from the real file.
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleeper, 0, 0, 10);
    const external = readTuiSnapshot(tempDir);
    external.sessionModels = {
      'model-session': { explorer: { model: 'model-y' } },
    };
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, `${JSON.stringify(external)}\n`);
    fs.closeSync(fd);
    fs.utimesSync(filePath, statBefore.atime, statBefore.mtime);
    const statAfter = fs.statSync(filePath);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);

    recordTuiAgentModel(
      { sessionID: 'model-session', agentName: 'explorer', model: 'model-x' },
      tempDir,
    );
    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.explorer
        ?.model,
    ).toBe('model-x');
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
    recordTuiAgentModel(LUNA, tempDir);

    const fsModule = await import('node:fs');
    const renameSpy = spyOn(fsModule, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });

    try {
      recordTuiAgentModel(GPT, tempDir);
    } finally {
      renameSpy.mockRestore();
    }

    // The previously written state must still be readable in full.
    expect(readTuiSnapshot(tempDir).sessionModels?.['model-session']).toEqual({
      explorer: { model: 'openai/gpt-6-luna' },
    });

    const stateDir = path.dirname(getTuiStatePath(tempDir));
    expect(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('leaves no temp files behind on the happy path', () => {
    recordTuiAgentModel(LUNA, tempDir);

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

describe('snapshotSectionsEqual (structural deep equality)', () => {
  test('key insertion order and updatedAt never manufacture differences', () => {
    recordTuiAgentModels(
      { agentModels: { explorer: 'model-a', oracle: 'model-b' } },
      tempDir,
    );
    const snapshot = readTuiSnapshot(tempDir);
    const reordered = readTuiSnapshot(tempDir);
    reordered.agentModels = { oracle: 'model-b', explorer: 'model-a' };
    reordered.updatedAt = snapshot.updatedAt + 1_000;
    expect(snapshotSectionsEqual(snapshot, reordered)).toBe(true);
  });

  test('nested value differences still break equality', () => {
    const a = readTuiSnapshot(tempDir);
    const b = readTuiSnapshot(tempDir);
    const entry = (lastUsedAt: number) => ({
      taskID: 'ses_1',
      alias: 'ora-1',
      terminalState: 'completed' as const,
      lastUsedAt,
    });
    a.reusableByAgent['parent-1'] = { oracle: [entry(5)] };
    b.reusableByAgent['parent-1'] = { oracle: [entry(6)] };
    expect(snapshotSectionsEqual(a, b)).toBe(false);

    b.reusableByAgent['parent-1'] = { oracle: [entry(5)] };
    expect(snapshotSectionsEqual(a, b)).toBe(true);

    a.sessionDetails.ses_1 = { alias: 'ora-1', status: 'busy' };
    b.sessionDetails.ses_1 = { alias: 'ora-1', status: 'retry' };
    expect(snapshotSectionsEqual(a, b)).toBe(false);
  });
});

describe('unified snapshot cache (writer memo + async reader)', () => {
  test('readTuiSnapshotAsync serves a snapshot the writer published without re-reading', async () => {
    recordTuiAgentModel(LUNA, tempDir);
    const fsModule = await import('node:fs');
    const readSpy = spyOn(fsModule.promises, 'readFile').mockImplementation(
      (() =>
        Promise.reject(
          new Error('unreadable'),
        )) as unknown as typeof fsModule.promises.readFile,
    );
    try {
      // The shared cache holds the writer's post-write snapshot at the
      // post-write stat: a hit never touches the file.
      const snapshot = await readTuiSnapshotAsync(tempDir);
      expect(snapshot.sessionModels?.['model-session']?.explorer?.model).toBe(
        LUNA.model,
      );
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  test('readTuiSnapshotAsync never stamps pre-rename data with the post-read stat', async () => {
    recordTuiAgentModel(LUNA, tempDir);
    const statePath = getTuiStatePath(tempDir);
    // First replacement: the writer's cache entry no longer matches, so
    // the raced read below takes the miss path.
    const mid = readTuiSnapshot(tempDir);
    mid.sessionModels = {
      'model-session': { explorer: { model: 'model-mid' } },
    };
    const midTmp = `${statePath}.race-mid.tmp`;
    fs.writeFileSync(midTmp, `${JSON.stringify(mid)}\n`);
    fs.renameSync(midTmp, statePath);

    const fsModule = await import('node:fs');
    const originalReadFile = fsModule.promises.readFile.bind(fsModule.promises);
    const stale = (await originalReadFile(statePath, 'utf8')) as string;
    const readSpy = spyOn(fsModule.promises, 'readFile').mockImplementation(
      (async () => {
        // The file is atomically replaced between the pre-read stat and
        // the read; the read observes the pre-rename bytes.
        recordTuiAgentModel(GPT, tempDir);
        return stale;
      }) as unknown as typeof fsModule.promises.readFile,
    );
    try {
      const raced = await readTuiSnapshotAsync(tempDir);
      // The read returns what it actually read...
      expect(raced.sessionModels?.['model-session']?.explorer?.model).toBe(
        'model-mid',
      );
      // ...but the stat moved during the read, so nothing was published:
      // the next poll must observe the replaced file, not stale bytes.
      const next = await readTuiSnapshotAsync(tempDir);
      expect(next.sessionModels?.['model-session']?.explorer?.model).toBe(
        GPT.model,
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  test('a read that succeeds but cannot re-stat still returns the parsed snapshot', async () => {
    const statePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        updatedAt: 1,
        agentModels: { explorer: 'model-x' },
      })}\n`,
    );
    const fsModule = await import('node:fs');
    const originalStat = fsModule.promises.stat.bind(fsModule.promises);
    let statCalls = 0;
    const statSpy = spyOn(fsModule.promises, 'stat').mockImplementation((async (
      ...args: Parameters<typeof fsModule.promises.stat>
    ) => {
      statCalls += 1;
      if (statCalls === 2) {
        // The publication stat fails after a successful read.
        throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
      }
      return originalStat(...args);
    }) as unknown as typeof fsModule.promises.stat);
    try {
      // No cache entry exists, so the read takes the miss path.
      const snapshot = await readTuiSnapshotAsync(tempDir);
      expect(snapshot.agentModels.explorer).toBe('model-x');
      expect(statCalls).toBe(2);
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('withTuiSnapshotBatch (native event fan-out scope)', () => {
  test('a recorder outside any batch writes immediately', () => {
    recordTuiAgentModel(LUNA, tempDir);
    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.explorer
        ?.model,
    ).toBe(LUNA.model);
  });

  test('staged writes are invisible until the commit', async () => {
    await withTuiSnapshotBatch(async () => {
      recordTuiAgentModel(LUNA, tempDir);
      expect(
        readTuiSnapshot(tempDir).sessionModels?.['model-session']?.explorer
          ?.model,
      ).toBeUndefined();
    });
    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.explorer
        ?.model,
    ).toBe(LUNA.model);
  });

  test('the finally commits staged writes even when the fan-out throws', async () => {
    await expect(
      withTuiSnapshotBatch(async () => {
        recordTuiAgentModel(LUNA, tempDir);
        recordTuiAgentActivity(
          { sessionID: 's1', agentName: 'oracle', active: true },
          tempDir,
        );
        throw new Error('event failed');
      }),
    ).rejects.toThrow('event failed');

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.sessionModels?.['model-session']?.explorer?.model).toBe(
      LUNA.model,
    );
    expect(snapshot.activeSessions.s1).toBe('oracle');
  });

  test('overlapping wrappers never merge their staged writes', async () => {
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withTuiSnapshotBatch(async () => {
      recordTuiAgentModel(LUNA, tempDir);
      await firstBlocked;
      recordTuiAgentModel(
        { sessionID: 'model-session', agentName: 'oracle', model: 'model-o' },
        tempDir,
      );
    });
    // The first wrapper is suspended inside its batch; a second wrapper
    // commits its own staged writes independently.
    const second = withTuiSnapshotBatch(async () => {
      recordTuiAgentModel(GPT, tempDir);
    });
    await second;

    expect(readTuiSnapshot(tempDir).sessionModels?.['model-session']).toEqual({
      explorer: { model: GPT.model },
    });

    releaseFirst();
    await first;

    expect(readTuiSnapshot(tempDir).sessionModels?.['model-session']).toEqual({
      explorer: { model: LUNA.model },
      oracle: { model: 'model-o' },
    });
  });

  test('a nested wrapper joins the open scope and adds to its commit', async () => {
    await withTuiSnapshotBatch(async () => {
      recordTuiAgentModel(LUNA, tempDir);
      await withTuiSnapshotBatch(async () => {
        recordTuiAgentModel(
          { sessionID: 'model-session', agentName: 'oracle', model: 'model-o' },
          tempDir,
        );
      });
      // The nested call staged rather than committing its own write.
      expect(readTuiSnapshot(tempDir).sessionModels ?? {}).toEqual({});
    });
    expect(readTuiSnapshot(tempDir).sessionModels?.['model-session']).toEqual({
      explorer: { model: LUNA.model },
      oracle: { model: 'model-o' },
    });
  });

  test('the commit keeps fields another process wrote mid-batch', async () => {
    recordTuiAgentModel(GPT, tempDir); // seed the state file
    await withTuiSnapshotBatch(async () => {
      recordTuiAgentModel(LUNA, tempDir);
      // Another process rewrites the file directly while the batch is
      // open: the commit re-reads under the lock and preserves its field.
      const external = readTuiSnapshot(tempDir);
      external.agentModels.builder = 'foreign-model';
      fs.writeFileSync(
        getTuiStatePath(tempDir),
        `${JSON.stringify(external)}\n`,
      );
    });

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.sessionModels?.['model-session']?.explorer?.model).toBe(
      LUNA.model,
    );
    expect(snapshot.agentModels.builder).toBe('foreign-model');
  });

  test('a flushed status is not overwritten after a later scope commits', async () => {
    // session.error stages "inactive", then awaits the fallback re-prompt
    // whose busy event commits "active" in its own scope. Without the
    // flush the outer scope's drain would land last and show it idle.
    let releaseReprompt: () => void = () => {};
    const reprompt = new Promise<void>((resolve) => {
      releaseReprompt = resolve;
    });
    recordTuiAgentActivity(
      { sessionID: 's1', agentName: 'oracle', active: true },
      tempDir,
    );
    const errorEvent = withTuiSnapshotBatch(async () => {
      recordTuiAgentActivity({ sessionID: 's1', active: false }, tempDir);
      flushTuiSnapshotBatch();
      await reprompt;
    });
    expect(readTuiSnapshot(tempDir).activeSessions.s1).toBeUndefined();
    await withTuiSnapshotBatch(async () => {
      recordTuiAgentActivity(
        { sessionID: 's1', agentName: 'oracle', active: true },
        tempDir,
      );
    });
    releaseReprompt();
    await errorEvent;

    expect(readTuiSnapshot(tempDir).activeSessions.s1).toBe('oracle');
  });

  test('a continuation after the closed scope records immediately', async () => {
    await withTuiSnapshotBatch(async () => {
      await Promise.resolve();
    });
    recordTuiAgentModel(LUNA, tempDir);
    expect(
      readTuiSnapshot(tempDir).sessionModels?.['model-session']?.explorer
        ?.model,
    ).toBe(LUNA.model);
  });
});
