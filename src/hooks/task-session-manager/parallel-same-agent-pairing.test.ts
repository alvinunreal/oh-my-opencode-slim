import { describe, expect, mock, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { BackgroundTaskConcurrency } from '../../utils/background-task-concurrency';
import { createTaskSessionManagerHook } from './index';
import { createPendingCallTracker } from './pending-call-tracker';

const PARENT = 'parent-1';

function createHook(
  board: BackgroundJobBoard,
  extra: {
    backgroundTaskConcurrency?: BackgroundTaskConcurrency;
    pendingCallTracker?: ReturnType<typeof createPendingCallTracker>;
  } = {},
) {
  return createTaskSessionManagerHook(
    {
      client: { session: { status: mock(async () => ({ data: {} })) } },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      ...extra,
    },
  );
}

const HOST_LAUNCH = (taskID: string) =>
  `The subagent is working in the background (sessionID: ${taskID}). You will be notified automatically.`;

function beforeCall(input: { callID: string; description: string }) {
  return [
    {
      tool: 'task',
      sessionID: PARENT,
      callID: input.callID,
    },
    {
      args: {
        subagent_type: 'oracle',
        description: input.description,
        prompt: 'do the review',
        background: true,
      },
    },
  ] as const;
}

function afterCall(input: { callID: string; taskID: string }) {
  return [
    { tool: 'task', sessionID: PARENT, callID: input.callID },
    { output: HOST_LAUNCH(input.taskID) },
  ] as const;
}

function created(input: { child: string; title?: string }) {
  return {
    event: {
      type: 'session.created',
      properties: {
        info: {
          id: input.child,
          parentID: PARENT,
          agent: 'oracle',
          ...(input.title ? { title: input.title } : {}),
        },
      },
    },
  };
}

const L_A = 'Review v2 compat layer PRs';
const L_B = 'Review wake/synthetic PR chain';
const L_C = 'Review v1 fix PRs';

describe('parallel same-agent pairing (incident 2026-09-12)', () => {
  test('after-hooks win: all three children registered with correct labels', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const sA = 'ses_aaaa1111';
    const sB = 'ses_bbbb2222';
    const sC = 'ses_cccc3333';

    // before: insertion order mirrors the incident (B, A, C)
    await hook['tool.execute.before'](
      ...beforeCall({ callID: 'call-b', description: L_B }),
    );
    await hook['tool.execute.before'](
      ...beforeCall({ callID: 'call-a', description: L_A }),
    );
    await hook['tool.execute.before'](
      ...beforeCall({ callID: 'call-c', description: L_C }),
    );

    // .521 after A registers sA
    await hook['tool.execute.after'](
      ...afterCall({ callID: 'call-a', taskID: sA }),
    );
    // .524 created(sA): board already has it — must not fence pending B
    await hook.event(created({ child: sA, title: L_A }));
    // .565 after B registers sB (was dropped by the fence in the incident)
    await hook['tool.execute.after'](
      ...afterCall({ callID: 'call-b', taskID: sB }),
    );
    // .567 created(sB)
    await hook.event(created({ child: sB, title: L_B }));
    // .573 after C registers sC (was dropped by the cross-mark in the incident)
    await hook['tool.execute.after'](
      ...afterCall({ callID: 'call-c', taskID: sC }),
    );
    // .575 created(sC)
    await hook.event(created({ child: sC, title: L_C }));

    expect(board.taskIDs()).toEqual(new Set([sA, sB, sC]));
    expect(board.get(sA)?.description).toBe(L_A);
    expect(board.get(sB)?.description).toBe(L_B);
    expect(board.get(sC)?.description).toBe(L_C);
    const aliases = new Set([sA, sB, sC].map((id) => board.get(id)?.alias));
    expect(aliases.size).toBe(3);
  });

  test('created-first ordering: tentative registration is kept correct by the after-hook', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const sB = 'ses_bbbb2222';

    await hook['tool.execute.before'](
      ...beforeCall({ callID: 'call-b', description: L_B }),
    );
    await hook['tool.execute.before'](
      ...beforeCall({ callID: 'call-c', description: L_C }),
    );

    // created(sB) arrives before after(B): title claims pending B
    await hook.event(created({ child: sB, title: L_B }));
    expect(board.get(sB)?.description).toBe(L_B);

    await hook['tool.execute.after'](
      ...afterCall({ callID: 'call-b', taskID: sB }),
    );
    expect(board.get(sB)?.description).toBe(L_B);
    expect(board.get(sB)?.state).toBe('running');
  });

  test('no-title hosts: placeholder is corrected by the matching after-hook', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const sC = 'ses_cccc3333';

    await hook['tool.execute.before'](
      ...beforeCall({ callID: 'call-b', description: L_B }),
    );
    await hook['tool.execute.before'](
      ...beforeCall({ callID: 'call-c', description: L_C }),
    );

    // Ambiguous (two same-agent pendings, no title): placeholder, not a guess
    await hook.event(created({ child: sC }));
    expect(board.get(sC)?.description).toBe('unattributed oracle task');

    // The owning call's after-hook corrects the description
    await hook['tool.execute.after'](
      ...afterCall({ callID: 'call-c', taskID: sC }),
    );
    expect(board.get(sC)?.description).toBe(L_C);
  });

  test('stale no-title created event cannot cross-mark or misattribute', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const sA = 'ses_aaaa1111';
    const sX = 'ses_xxxx9999';
    const sB = 'ses_bbbb2222';

    // call A completes before its created event: after-hook consumes its
    // pending and registers sA
    await hook['tool.execute.before'](
      ...beforeCall({ callID: 'call-a', description: L_A }),
    );
    await hook['tool.execute.after'](
      ...afterCall({ callID: 'call-a', taskID: sA }),
    );

    // call B still pending; a late no-title (v1-style) child whose owning
    // call was already consumed must not claim pending B — it gets a
    // placeholder instead of B's label, so no cross-mark can form
    await hook['tool.execute.before'](
      ...beforeCall({ callID: 'call-b', description: L_B }),
    );
    await hook.event(created({ child: sX }));
    expect(board.get(sX)?.description).toBe('unattributed oracle task');

    // after(B) parses sB from its own output; pending B was never
    // cross-marked, so sB registers cleanly with the right label
    await hook['tool.execute.after'](
      ...afterCall({ callID: 'call-b', taskID: sB }),
    );

    expect(board.taskIDs()).toEqual(new Set([sA, sX, sB]));
    expect(board.get(sB)?.description).toBe(L_B);
    expect(board.get(sA)?.description).toBe(L_A);
    // the stale child keeps the honest placeholder label, never B's
    expect(board.get(sX)?.description).toBe('unattributed oracle task');
  });

  test('no-callID hosts: swapped after-hooks cannot corrupt descriptions', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const sA = 'ses_aaaa1111';
    const sB = 'ses_bbbb2222';
    const v1Launch = (taskID: string) =>
      [
        `task_id: ${taskID}`,
        'state: running',
        '',
        '<task_result>',
        'Background task started.',
        '</task_result>',
      ].join('\n');

    // two parallel calls WITHOUT callIDs (v1 legacy hosts): the before
    // hook assigns anonymous pending IDs in insertion order
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: PARENT },
      {
        args: {
          subagent_type: 'oracle',
          description: L_A,
          prompt: 'do the review',
          background: true,
        },
      },
    );
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: PARENT },
      {
        args: {
          subagent_type: 'oracle',
          description: L_B,
          prompt: 'do the review',
          background: true,
        },
      },
    );

    // created-first: titles claim the right pendings
    await hook.event(created({ child: sA, title: L_A }));
    await hook.event(created({ child: sB, title: L_B }));
    expect(board.get(sA)?.description).toBe(L_A);
    expect(board.get(sB)?.description).toBe(L_B);

    // after-hooks fire in SWAPPED order with no callIDs: the oldest
    // pending is A's, but this output belongs to call B — the oldest
    // guess must neither drop sB nor overwrite its correct label
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: PARENT },
      { output: v1Launch(sB) },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: PARENT },
      { output: v1Launch(sA) },
    );

    expect(board.taskIDs()).toEqual(new Set([sA, sB]));
    expect(board.get(sA)?.description).toBe(L_A);
    expect(board.get(sB)?.description).toBe(L_B);
  });

  test('no-callID no-title parallel burst drains instead of poisoning the parent (B1)', async () => {
    const board = new BackgroundJobBoard();
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 2,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const tracker = createPendingCallTracker();
    const hook = createHook(board, {
      backgroundTaskConcurrency: concurrency,
      pendingCallTracker: tracker,
    });
    const sA = 'ses_aaaa1111';
    const sB = 'ses_bbbb2222';
    const sC = 'ses_dddd4444';
    const completed = (taskID: string) =>
      [
        `task_id: ${taskID}`,
        'state: completed',
        '',
        '<task_result>',
        'Review finished.',
        '</task_result>',
      ].join('\n');
    const noIDBefore = (description: string) =>
      [
        { tool: 'task', sessionID: PARENT },
        {
          args: {
            subagent_type: 'oracle',
            description,
            prompt: 'do the review',
            background: true,
          },
        },
      ] as const;

    // Parallel burst WITHOUT callIDs and WITHOUT titles: both
    // background admissions take their concurrency tickets.
    await hook['tool.execute.before'](...noIDBefore(L_A));
    await hook['tool.execute.before'](...noIDBefore(L_B));
    expect(concurrency.snapshot()).toEqual({ active: 2, queued: 0 });

    // No-title children are ambiguous → placeholders claim no pending.
    await hook.event(created({ child: sA }));
    await hook.event(created({ child: sB }));
    expect(board.get(sA)?.description).toBe('unattributed oracle task');
    expect(board.get(sB)?.description).toBe('unattributed oracle task');

    // after A parses sA from its own output: take() refuses (2
    // pendings), takeByTaskID misses (nothing claimed sA) → the drain
    // fallback consumes exactly one pending and the output flows
    // through the normal ticket-release path.
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: PARENT },
      { output: completed(sA) },
    );
    expect(tracker.peekByParent(PARENT)?.callId).toBe('parent-1:anonymous-2');
    // Ticket A was bound to sA and released on the terminal status —
    // only B's admission slot remains held.
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });
    // The board record keeps everything output-authoritative (task ID,
    // state, result text from A's own output), but the drained pending
    // was consumed without verified identity — its label/objective may
    // belong to sibling B — so the metadata floor applies: the record
    // keeps the honest placeholder instead of a possibly-wrong label.
    expect(board.get(sA)?.description).toBe('unattributed oracle task');
    expect(board.get(sA)?.state).toBe('completed');
    expect(board.get(sA)?.resultSummary).toBe('Review finished.');

    // after B resolves through the normal sole-survivor take — the
    // burst did not strand anything or poison the parent. The take is
    // still flagged: A's unresolved drain shifted the sole-survivor
    // window, so B's label cannot be trusted either.
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: PARENT },
      { output: completed(sB) },
    );
    expect(board.get(sB)?.description).toBe('unattributed oracle task');
    expect(board.get(sB)?.state).toBe('completed');
    expect(board.get(sB)?.resultSummary).toBe('Review finished.');
    expect(concurrency.snapshot()).toEqual({ active: 0, queued: 0 });

    // A subsequent no-ID call for this parent still works end-to-end.
    // The parent's unresolved window persists for the session, so the
    // sole take is flagged as well; with no placeholder record for sC
    // the fresh registration falls back to registerLaunch's generic
    // default label.
    await hook['tool.execute.before'](...noIDBefore(L_C));
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: PARENT },
      { output: HOST_LAUNCH(sC) },
    );
    expect(board.get(sC)?.description).toBe('background oracle task');
  });

  test('eviction variant: pre-consumed pending degrades the burst without corrupting it (B)', async () => {
    const board = new BackgroundJobBoard();
    const tracker = createPendingCallTracker();
    const hook = createHook(board, { pendingCallTracker: tracker });
    const sA = 'ses_aaaa1111';
    const sB = 'ses_bbbb2222';
    const sC = 'ses_dddd4444';
    const completed = (taskID: string) =>
      [
        `task_id: ${taskID}`,
        'state: completed',
        '',
        '<task_result>',
        'Review finished.',
        '</task_result>',
      ].join('\n');
    const noIDBefore = (description: string) =>
      [
        { tool: 'task', sessionID: PARENT },
        {
          args: {
            subagent_type: 'oracle',
            description,
            prompt: 'do the review',
            background: true,
          },
        },
      ] as const;

    // Burst of three no-ID, no-title calls. The direct tracker.take
    // simulates the oldest pending disappearing without its after-hook
    // (e.g. a real pending-cap eviction would also release its ticket;
    // immaterial here since no concurrency limiter is injected).
    await hook['tool.execute.before'](...noIDBefore(L_A));
    await hook['tool.execute.before'](...noIDBefore(L_B));
    await hook['tool.execute.before'](...noIDBefore(L_C));
    tracker.take('parent-1:anonymous-1');

    // No-title children are ambiguous → placeholders claim no pending.
    await hook.event(created({ child: sA }));
    await hook.event(created({ child: sB }));
    await hook.event(created({ child: sC }));
    expect(board.get(sA)?.description).toBe('unattributed oracle task');
    expect(board.get(sB)?.description).toBe('unattributed oracle task');
    expect(board.get(sC)?.description).toBe('unattributed oracle task');

    // The evicted call's late after-hook: two pendings remain, so
    // take() refuses and the drain fallback consumes B's pending —
    // flagged unresolved, so sA never receives a sibling label.
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: PARENT },
      { output: completed(sA) },
    );
    expect(board.get(sA)?.description).toBe('unattributed oracle task');
    expect(board.get(sA)?.state).toBe('completed');
    expect(board.get(sA)?.resultSummary).toBe('Review finished.');

    // The sibling's after steals the shifted window (sole survivor C,
    // armed by the drain) — flagged too, so sB also stays generic.
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: PARENT },
      { output: completed(sB) },
    );
    expect(board.get(sB)?.description).toBe('unattributed oracle task');
    expect(board.get(sB)?.state).toBe('completed');
    expect(board.get(sB)?.resultSummary).toBe('Review finished.');

    // C's own after arrives last: no pending remains (its pending was
    // consumed by B's window-shifted take), so its output drains
    // nothing and drops. The cascade terminates degraded — sC keeps
    // its honest placeholder instead of a stolen or poisoned record —
    // and nothing is stranded.
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: PARENT },
      { output: completed(sC) },
    );
    expect(board.get(sC)?.description).toBe('unattributed oracle task');
    expect(board.get(sC)?.state).toBe('running');
    expect(tracker.peekByParent(PARENT)).toBeUndefined();
  });

  test('B1 drain fallback logs exactly one deterministic warning per burst', async () => {
    // Log-file assertions run in a subprocess: other test files
    // mock.module('../../utils/logger') globally in shared-process
    // runs, so the real logger is only observable with a pristine
    // module registry (same pattern as runtime-status-reconciliation).
    const logDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'omos-b1-drain-log-'),
    );
    const workerSource = `
      const { createTaskSessionManagerHook } = await import(
        process.env.HOOK_MODULE_URL
      );
      const { BackgroundJobBoard } = await import(
        process.env.BOARD_MODULE_URL
      );
      const { BackgroundTaskConcurrency } = await import(
        process.env.CONCURRENCY_MODULE_URL
      );
      const { initLogger, flushLoggerForTesting } = await import(
        process.env.LOGGER_MODULE_URL
      );
      const { readFileSync } = await import('node:fs');
      initLogger('drain-fallback-b1');
      const board = new BackgroundJobBoard();
      const concurrency = new BackgroundTaskConcurrency({
        defaultConcurrency: 2,
        providerConcurrency: {},
        modelConcurrency: {},
      });
      const hook = createTaskSessionManagerHook(
        {
          client: { session: { status: async () => ({ data: {} }) } },
          directory: '/tmp',
          worktree: '/tmp',
        },
        {
          maxSessionsPerAgent: 2,
          backgroundJobBoard: board,
          backgroundTaskConcurrency: concurrency,
          shouldManageSession: () => true,
        },
      );
      const PARENT = 'parent-1';
      const L_A = 'Review v2 compat layer PRs';
      const L_B = 'Review wake/synthetic PR chain';
      const completed = (taskID) =>
        [
          'task_id: ' + taskID,
          'state: completed',
          '',
          '<task_result>',
          'Review finished.',
          '</task_result>',
        ].join('\\n');
      const created = (child) => ({
        event: {
          type: 'session.created',
          properties: { info: { id: child, parentID: PARENT, agent: 'oracle' } },
        },
      });
      const before = (description) => [
        { tool: 'task', sessionID: PARENT },
        {
          args: {
            subagent_type: 'oracle',
            description,
            prompt: 'do the review',
            background: true,
          },
        },
      ];
      await hook['tool.execute.before'](...before(L_A));
      await hook['tool.execute.before'](...before(L_B));
      await hook.event(created('ses_aaaa1111'));
      await hook.event(created('ses_bbbb2222'));
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: PARENT },
        { output: completed('ses_aaaa1111') },
      );
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: PARENT },
        { output: completed('ses_bbbb2222') },
      );
      await flushLoggerForTesting();
      const lines = readFileSync(process.env.LOG_FILE_PATH, 'utf8').split(
        '\\n',
      );
      console.log(
        JSON.stringify({
          drainWarnings: lines.filter((line) =>
            line.includes(
              'unresolvable no-ID take; consuming first-match pending (drain fallback)',
            ),
          ).length,
          identityResolutions: lines.filter((line) =>
            line.includes(
              'resolved task output identity via early-registered task ID',
            ),
          ).length,
        }),
      );
    `;
    const proc = Bun.spawn([process.execPath, '-e', workerSource], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        OPENCODE_LOG_DIR: logDir,
        HOOK_MODULE_URL: pathToFileURL(path.join(import.meta.dir, 'index.ts'))
          .href,
        BOARD_MODULE_URL: pathToFileURL(
          path.join(import.meta.dir, '../../utils/background-job-board.ts'),
        ).href,
        CONCURRENCY_MODULE_URL: pathToFileURL(
          path.join(
            import.meta.dir,
            '../../utils/background-task-concurrency.ts',
          ),
        ).href,
        LOGGER_MODULE_URL: pathToFileURL(
          path.join(import.meta.dir, '../../utils/logger.ts'),
        ).href,
        LOG_FILE_PATH: path.join(
          logDir,
          'oh-my-opencode-slim.drain-fallback-b1.log',
        ),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    await fsp.rm(logDir, { recursive: true, force: true });
    if (exitCode !== 0) {
      console.error(stderr);
      expect(exitCode).toBe(0);
    }
    const counts = JSON.parse(stdout.trim()) as {
      drainWarnings: number;
      identityResolutions: number;
    };
    // Only after A hits the fallback; after B resolves via the normal
    // sole-survivor take.
    expect(counts.drainWarnings).toBe(1);
    expect(counts.identityResolutions).toBe(0);
  });
});
