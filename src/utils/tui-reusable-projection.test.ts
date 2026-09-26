import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getTuiStatePath,
  readTuiSnapshot,
  recordTuiSessionParent,
  updateSnapshot,
} from '../tui-state';
import { BackgroundJobBoard } from './background-job-fixture';
import { createTuiReusableProjection } from './tui-reusable-projection';

describe('tui-reusable-projection', () => {
  let root: string;
  let projectDir: string;
  let originalDataHome: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-reusable-proj-'));
    projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    originalDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(root, 'data');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
  });

  function seedReconciled(
    board: BackgroundJobBoard,
    taskID: string,
    opts: { agent?: string; launchAt?: number; reconciledAt?: number } = {},
  ) {
    const launchAt = opts.launchAt ?? 100;
    board.registerLaunch({
      taskID,
      parentSessionID: 'parent-1',
      agent: opts.agent ?? 'oracle',
      description: `${taskID} job`,
      now: launchAt,
    });
    board.updateStatus({
      taskID,
      state: 'completed' as never,
      resultSummary: 'done',
      now: launchAt + 50,
    });
    board.markReconciled(taskID, opts.reconciledAt ?? launchAt + 100);
  }

  test('a finished session is projected before the parent acknowledges it', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      board.registerLaunch({
        taskID: 'ses_1',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        description: 'ses_1 job',
        now: 100,
      });
      board.updateStatus({
        taskID: 'ses_1',
        state: 'completed' as never,
        resultSummary: 'done',
        now: 150,
      });

      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-1']?.oracle?.[0],
      ).toMatchObject({
        taskID: 'ses_1',
        terminalState: 'completed',
      });
    } finally {
      projection.dispose();
    }
  });

  test('running projection uses stable fields; heartbeat writes nothing', async () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });
    try {
      board.registerLaunch({
        taskID: 'ses_live',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });
      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-1']?.oracle,
      ).toEqual([{ taskID: 'ses_live', alias: 'ora-1', running: true }]);

      const fsModule = await import('node:fs');
      let writes = 0;
      const stateDir = path.dirname(getTuiStatePath(projectDir));
      const writeSpy = spyOn(fsModule, 'writeFileSync').mockImplementation(
        (...args: Parameters<typeof fs.writeFileSync>) => {
          if (String(args[0]).startsWith(stateDir)) writes++;
          return fs.writeFileSync(...args);
        },
      );
      try {
        board.updateStatus({ taskID: 'ses_live', state: 'running', now: 200 });
        expect(writes).toBe(0);
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      projection.dispose();
    }
  });

  test('placeholder promotions publish running and finished jobs immediately', async () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });
    const fsModule = await import('node:fs');
    let writes = 0;
    let notifications = 0;
    board.addMutationListener(() => notifications++);
    const statePath = getTuiStatePath(projectDir);
    const originalRename = fsModule.renameSync;
    const renameSpy = spyOn(fsModule, 'renameSync').mockImplementation(
      (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]) === statePath) writes++;
        return originalRename(...args);
      },
    );
    try {
      board.registerLaunch({
        taskID: 'ses_run',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        provisional: true,
      });
      const beforeRunning = notifications;
      board.promoteProvisional('ses_run', 'parent-1', { agent: 'fixer' });
      expect(notifications - beforeRunning).toBe(1);
      expect(writes).toBe(1);
      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-1']?.fixer?.[0],
      ).toMatchObject({ taskID: 'ses_run', running: true });

      board.registerLaunch({
        taskID: 'ses_done',
        parentSessionID: 'parent-2',
        agent: 'oracle',
        provisional: true,
      });
      board.updateStatus({
        taskID: 'ses_done',
        state: 'completed' as never,
        resultSummary: 'done',
      });
      writes = 0;
      const beforeFinished = notifications;
      board.registerLaunch({
        taskID: 'ses_done',
        parentSessionID: 'parent-2',
        agent: 'oracle',
        preserveRun: true,
      });
      expect(notifications - beforeFinished).toBe(1);
      expect(writes).toBe(1);
      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-2']?.oracle?.[0],
      ).toMatchObject({ taskID: 'ses_done', terminalState: 'completed' });
    } finally {
      renameSpy.mockRestore();
      projection.dispose();
    }
  });

  test('unattributed and uncertain running jobs are not advertised', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });
    try {
      board.registerLaunch({
        taskID: 'ses_placeholder',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        provisional: true,
      });
      board.registerLaunch({
        taskID: 'ses_uncertain',
        parentSessionID: 'parent-1',
        agent: 'fixer',
      });
      board.updateStatus({
        taskID: 'ses_uncertain',
        state: 'running',
        statusUncertain: true,
      });
      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-1'],
      ).toBeUndefined();
    } finally {
      projection.dispose();
    }
  });

  test('board mutation projects the latest reconciled session into the snapshot', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      seedReconciled(board, 'ses_1');

      const snapshot = readTuiSnapshot(projectDir);
      expect(snapshot.reusableByAgent['parent-1']?.oracle?.[0]).toMatchObject({
        taskID: 'ses_1',
        alias: 'ora-1',
        terminalState: 'completed',
      });
    } finally {
      projection.dispose();
    }
  });

  test('projects every reusable session for an agent in newest-first order', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      seedReconciled(board, 'ses_old', { launchAt: 100 });
      seedReconciled(board, 'ses_new', { launchAt: 300 });

      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-1']?.oracle?.map(
          (entry) => entry.taskID,
        ),
      ).toEqual(['ses_new', 'ses_old']);
    } finally {
      projection.dispose();
    }
  });

  test('creation clears a stale reusable section left by a previous host process', () => {
    // First host process projects a reconciled session and exits.
    const board = new BackgroundJobBoard();
    const first = createTuiReusableProjection({ board, projectDir });
    try {
      seedReconciled(board, 'ses_1');
      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-1']?.oracle?.[0],
      ).toBeDefined();
    } finally {
      first.dispose();
    }

    // Second host process starts over an empty board: the creation
    // sweep must wipe the dead dots without waiting for any mutation
    // (decision: the board is the store; nothing survives a restart).
    const freshBoard = new BackgroundJobBoard();
    const second = createTuiReusableProjection({
      board: freshBoard,
      projectDir,
    });
    try {
      expect(readTuiSnapshot(projectDir).reusableByAgent).toEqual({});
    } finally {
      second.dispose();
    }
  });

  test('startup also drops ownerless inherited sections', () => {
    updateSnapshot(projectDir, (snapshot) => {
      snapshot.reusableByAgent['parent-old'] = {
        oracle: [
          {
            taskID: 'ses_old',
            alias: 'ora-1',
            terminalState: 'completed',
            lastUsedAt: 100,
          },
        ],
      };
    });
    const projection = createTuiReusableProjection({
      board: new BackgroundJobBoard(),
      projectDir,
    });
    try {
      expect(readTuiSnapshot(projectDir).reusableByAgent).toEqual({});
    } finally {
      projection.dispose();
    }
  });

  test('startup drops same-PID sections orphaned by failed disposal', () => {
    updateSnapshot(projectDir, (snapshot) => {
      snapshot.reusableByAgent['parent-old'] = {
        fixer: [{ taskID: 'ses_old', alias: 'fix-1', running: true }],
      };
      snapshot.reusableOwners['parent-old'] = process.pid;
    });
    const projection = createTuiReusableProjection({
      board: new BackgroundJobBoard(),
      projectDir,
    });
    try {
      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-old'],
      ).toBeUndefined();
    } finally {
      projection.dispose();
    }
  });

  test('dispose clears only this projection’s still-owned parent sections', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });
    board.registerLaunch({
      taskID: 'ses_owned',
      parentSessionID: 'parent-owned',
      agent: 'oracle',
    });
    updateSnapshot(projectDir, (snapshot) => {
      snapshot.reusableByAgent['parent-foreign'] = {
        fixer: [{ taskID: 'ses_foreign', alias: 'fix-1', running: true }],
      };
      snapshot.reusableOwners['parent-foreign'] = 1;
    });

    projection.dispose();
    projection.dispose();

    const snapshot = readTuiSnapshot(projectDir);
    expect(snapshot.reusableByAgent['parent-owned']).toBeUndefined();
    expect(snapshot.reusableOwners['parent-owned']).toBeUndefined();
    expect(snapshot.reusableByAgent['parent-foreign']?.fixer?.[0]?.taskID).toBe(
      'ses_foreign',
    );
  });

  test('a timed-out projection write keeps its ownership for the next mutation', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });
    board.registerLaunch({
      taskID: 'ses_old',
      parentSessionID: 'parent-old',
      agent: 'oracle',
    });
    const lockPath = `${getTuiStatePath(projectDir)}.lock`;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: 'held',
        createdAt: Date.now(),
      }),
    );
    try {
      board.drop('ses_old'); // The lock prevents the removal from persisting.
      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-old'],
      ).toBeDefined();
      fs.unlinkSync(lockPath);
      board.registerLaunch({
        taskID: 'ses_new',
        parentSessionID: 'parent-new',
        agent: 'fixer',
      });
      const sections = readTuiSnapshot(projectDir).reusableByAgent;
      expect(sections['parent-old']).toBeUndefined();
      expect(sections['parent-new']?.fixer?.[0]?.taskID).toBe('ses_new');
    } finally {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      projection.dispose();
    }
  }, 5_000);

  test('two live processes keep their own parent sections across startup and mutations', async () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });
    board.registerLaunch({
      taskID: 'ses_parent',
      parentSessionID: 'parent-main',
      agent: 'oracle',
    });
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, 'tui-reusable-projection.child.ts'),
        projectDir,
      ],
      {
        env: { ...process.env, XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? '' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const reader = child.stdout.getReader();
    try {
      const ready = await Promise.race([
        reader.read(),
        Bun.sleep(3_000).then(() => {
          throw new Error('child startup timed out');
        }),
      ]);
      expect(new TextDecoder().decode(ready.value)).toContain('ready');
      let sections = readTuiSnapshot(projectDir).reusableByAgent;
      expect(sections['parent-main']?.oracle?.[0]?.taskID).toBe('ses_parent');
      expect(sections['parent-child']?.fixer?.[0]?.taskID).toBe('ses_child');

      board.registerLaunch({
        taskID: 'ses_parent_2',
        parentSessionID: 'parent-main',
        agent: 'oracle',
      });
      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-child'],
      ).toBeDefined();
      child.stdin.write('mutate\n');
      const mutated = await Promise.race([
        reader.read(),
        Bun.sleep(3_000).then(() => {
          throw new Error('child mutation timed out');
        }),
      ]);
      expect(new TextDecoder().decode(mutated.value)).toContain('mutated');
      sections = readTuiSnapshot(projectDir).reusableByAgent;
      expect(sections['parent-main']?.oracle).toHaveLength(2);
      expect(sections['parent-child']?.fixer).toHaveLength(2);

      board.drop('ses_parent');
      board.drop('ses_parent_2');
      sections = readTuiSnapshot(projectDir).reusableByAgent;
      expect(sections['parent-main']).toBeUndefined();
      expect(sections['parent-child']?.fixer).toHaveLength(2);
    } finally {
      child.stdin.end();
      child.kill();
      await child.exited;
      projection.dispose();
    }
  }, 10_000);

  test('a mutation that changes nothing does not rewrite the state file', async () => {
    const fsModule = await import('node:fs');
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      seedReconciled(board, 'ses_1');
      const statePath = getTuiStatePath(projectDir);

      // Heartbeats change board timestamps, not the stable sidebar section.
      board.registerLaunch({
        taskID: 'ses_running_other',
        parentSessionID: 'parent-2',
        agent: 'fixer',
        now: 500,
      });
      let writes = 0;
      const writeSpy = spyOn(fsModule, 'writeFileSync').mockImplementation(
        (...args: Parameters<typeof fs.writeFileSync>) => {
          if (String(args[0]).startsWith(path.dirname(statePath))) writes += 1;
          return fs.writeFileSync(...args);
        },
      );
      try {
        board.updateStatus({
          taskID: 'ses_running_other',
          state: 'running',
          now: 600,
        });
        expect(writes).toBe(0);
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      projection.dispose();
    }
  });

  test('dropping the selected job cleans the section', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      seedReconciled(board, 'ses_1');
      expect(readTuiSnapshot(projectDir).reusableByAgent['parent-1']).toEqual(
        expect.objectContaining({ oracle: expect.any(Array) }),
      );

      board.drop('ses_1');

      const section = readTuiSnapshot(projectDir).reusableByAgent;
      expect(section['parent-1']).toBeUndefined();
    } finally {
      projection.dispose();
    }
  });

  test('section is scoped per parent and survives alongside other snapshot sections', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      // Another writer persists a parent link; the projection must not
      // clobber sibling sections when it rewrites reusableByAgent.
      recordTuiSessionParent('ses_1', 'parent-1', projectDir);
      seedReconciled(board, 'ses_1', { agent: 'oracle' });
      board.registerLaunch({
        taskID: 'ses_fix',
        parentSessionID: 'parent-2',
        agent: 'fixer',
        now: 100,
      });
      board.updateStatus({
        taskID: 'ses_fix',
        state: 'completed' as never,
        resultSummary: 'done',
        now: 150,
      });
      board.markReconciled('ses_fix', 200);

      const snapshot = readTuiSnapshot(projectDir);
      expect(snapshot.sessionParents.ses_1).toBe('parent-1');
      expect(snapshot.reusableByAgent['parent-1']?.oracle?.[0]?.taskID).toBe(
        'ses_1',
      );
      expect(snapshot.reusableByAgent['parent-2']?.fixer?.[0]?.taskID).toBe(
        'ses_fix',
      );
    } finally {
      projection.dispose();
    }
  });
});
