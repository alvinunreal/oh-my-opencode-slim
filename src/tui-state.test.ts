import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearTuiAgentActivities,
  getTuiStatePath,
  readTuiSnapshot,
  recordTuiAgentActivity,
  recordTuiAgentModel,
  recordTuiAgentModels,
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

describe('tui-state persistence', () => {
  test('persists enabled agent models', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          explorer: 'openai/gpt-5.6-luna',
          fixer: 'openai/gpt-5.6-luna',
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
      explorer: 'openai/gpt-5.6-luna',
      fixer: 'openai/gpt-5.6-luna',
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
          explorer: 'openai/gpt-5.6-luna',
        },
      },
      tempDir,
    );

    recordTuiAgentModel(
      {
        agentName: 'orchestrator',
        model: 'openai/gpt-5.6',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentModels).toEqual({
      orchestrator: 'openai/gpt-5.6',
      explorer: 'openai/gpt-5.6-luna',
    });
  });

  test('updates a single live agent variant without dropping others', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          orchestrator: 'default',
          explorer: 'openai/gpt-5.6-luna',
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
        model: 'openai/gpt-5.6',
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
      { agentName: 'explorer', model: 'openai/gpt-5.6-luna' },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe(
      'openai/gpt-5.6-luna',
    );
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('clears persisted activity while preserving model state', () => {
    recordTuiAgentModels(
      { agentModels: { explorer: 'openai/gpt-5.6-luna' } },
      tempDir,
    );
    recordTuiAgentActivity(
      { sessionID: 'explorer-a', agentName: 'explorer', active: true },
      tempDir,
    );

    clearTuiAgentActivities(tempDir);

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.activeSessions).toEqual({});
    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-5.6-luna',
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
        agentModels: { explorer: 'openai/gpt-5.6-luna' },
        configInvalid: true,
        configInvalidByProject: { old: true },
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-5.6-luna',
    });
    expect(snapshot.agentVariants).toEqual({});
    expect(snapshot.activeSessions).toEqual({});
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
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-5.6-luna' },
      tempDir,
    );

    const filePath = getTuiStatePath(tempDir);
    const oldMtime = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(filePath, oldMtime, oldMtime);
    const baselineMtime = fs.statSync(filePath).mtimeMs;

    // Same agent, same model: nothing changed, so the file must not be
    // rewritten (a write would bump the mtime from 2000 back to "now").
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-5.6-luna' },
      tempDir,
    );

    expect(fs.statSync(filePath).mtimeMs).toBe(baselineMtime);
  });

  test('keeps the final file intact when the atomic rename fails', async () => {
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-5.6-luna' },
      tempDir,
    );

    const fsModule = await import('node:fs');
    const renameSpy = spyOn(fsModule, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });

    try {
      recordTuiAgentModel(
        { agentName: 'explorer', model: 'openai/gpt-5.6' },
        tempDir,
      );
    } finally {
      renameSpy.mockRestore();
    }

    // The previously written state must still be readable in full.
    expect(readTuiSnapshot(tempDir).agentModels).toEqual({
      explorer: 'openai/gpt-5.6-luna',
    });

    const stateDir = path.dirname(getTuiStatePath(tempDir));
    expect(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('leaves no temp files behind on the happy path', () => {
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-5.6-luna' },
      tempDir,
    );

    const stateDir = path.dirname(getTuiStatePath(tempDir));
    expect(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });
});
