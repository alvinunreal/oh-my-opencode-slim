import { describe, expect, jest, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createBackgroundJobIdentityIndex } from '../utils/background-job-identity-index';
import { createSameProcessResumeEvidence } from '../utils/same-process-resume-evidence';
import { createTaskControlRecovery } from './task-control-recovery';

const identity = {
  parentSessionID: 'parent',
  taskID: 'ses_child',
  agent: 'fixer',
  alias: 'fix-1',
  directory: '/project',
};

const parentTranscript = {
  data: [
    {
      info: {
        id: 'call',
        role: 'assistant',
        sessionID: 'parent',
        time: { created: 90 },
      },
      parts: [
        {
          type: 'tool',
          name: 'task',
          state: {
            input: {
              subagent_type: 'fixer',
              background: true,
              description: 'Implement fix',
            },
            output: 'task_id: ses_child\nstate: running',
          },
        },
      ],
    },
  ],
};

const childErrorTranscript = {
  data: [
    {
      info: { id: 'child-user', role: 'user', time: { created: 110 } },
      parts: [],
    },
    {
      info: {
        id: 'child-error',
        role: 'assistant',
        error: { name: 'MessageAbortedError' },
        time: { completed: 190 },
      },
      parts: [],
    },
  ],
};

function makeRecovery(options: {
  status: unknown;
  child?: unknown;
  identityIndex?:
    | Parameters<typeof createTaskControlRecovery>[0]['identityIndex']
    | null;
  getSession?: (taskID: string, directory: string) => Promise<unknown>;
  readParentTranscript?: () => Promise<unknown>;
  readChildTranscript?: (taskID: string) => Promise<unknown>;
  probeStatus?: (taskID: string, directory: string) => Promise<unknown>;
  timeoutMs?: number;
  baselineReadTimeoutMs?: number;
  hasStatus?: boolean;
  sameProcessResumeEvidence?: ReturnType<
    typeof createSameProcessResumeEvidence
  >;
  sameProcessResumeEvidenceContextFor?: (
    taskID: string,
  ) => { generation: number; terminalRevision: number } | undefined;
}) {
  const session: {
    messages: ({ path }: { path: { id: string } }) => Promise<unknown>;
    get: () => Promise<unknown>;
    status?: () => Promise<unknown>;
  } = {
    messages: async ({ path }: { path: { id: string } }) =>
      path.id === 'parent' ? parentTranscript : (options.child ?? { data: [] }),
    get: async () => ({
      data: {
        id: 'ses_child',
        parentID: 'parent',
        directory: '/project',
        time: { created: 100 },
      },
    }),
  };
  const sessionStatus = async () => options.status;
  if (options.hasStatus !== false) session.status = sessionStatus;
  const board = new BackgroundJobBoard();
  const recovery = createTaskControlRecovery({
    input: { directory: '/project', client: { session } } as never,
    backgroundJobBoard: board,
    hostClient: { session } as never,
    identityIndex:
      options.identityIndex === null
        ? undefined
        : (options.identityIndex ?? { lookup: () => identity }),
    getSession: options.getSession,
    readParentTranscript: options.readParentTranscript,
    readChildTranscript: options.readChildTranscript,
    probeStatus: options.probeStatus,
    sameProcessResumeEvidence: options.sameProcessResumeEvidence,
    sameProcessResumeEvidenceContextFor:
      options.sameProcessResumeEvidenceContextFor,
    now: () => 300,
    timeoutMs: options.timeoutMs,
    baselineReadTimeoutMs: options.baselineReadTimeoutMs,
  });
  return { board, recovery };
}

async function withRealIdentityIndex<T>(
  callback: (
    index: ReturnType<typeof createBackgroundJobIdentityIndex>,
  ) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'slim-task-recovery-'));
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  try {
    return await callback(createBackgroundJobIdentityIndex('/project'));
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    rmSync(root, { recursive: true, force: true });
  }
}

describe('task control orphan recovery', () => {
  test('reads the latest normal child user as the resume baseline', async () => {
    const { recovery } = makeRecovery({
      status: { data: {} },
      child: {
        data: [
          {
            info: {
              id: 'child-user-1',
              role: 'user',
              sessionID: 'ses_child',
              time: { created: 110 },
            },
            parts: [],
          },
          {
            info: {
              id: 'child-assistant',
              role: 'assistant',
              sessionID: 'ses_child',
              time: { created: 120 },
            },
            parts: [],
          },
          {
            info: {
              id: 'child-user-2',
              role: 'user',
              sessionID: 'ses_child',
              time: { created: 130 },
            },
            parts: [],
          },
        ],
      },
    });

    await expect(recovery.readLatestChildUser('ses_child')).resolves.toEqual({
      childLatestUserID: 'child-user-2',
      childLatestUserCreatedAt: 130,
    });
  });

  test('returns undefined when the child baseline read never settles', async () => {
    jest.useFakeTimers();
    try {
      const { recovery } = makeRecovery({
        status: { data: {} },
        baselineReadTimeoutMs: 25,
        readChildTranscript: () => new Promise<never>(() => {}),
      });
      const pending = recovery.readLatestChildUser('ses_child');
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      jest.advanceTimersByTime(24);
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);

      await expect(pending).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test('ignores a child baseline response that settles after the timeout', async () => {
    jest.useFakeTimers();
    try {
      let resolveChild!: (value: unknown) => void;
      const lateChild = new Promise<unknown>((resolve) => {
        resolveChild = resolve;
      });
      let dataReads = 0;
      const lateResponse = {
        error: null,
        get data() {
          dataReads += 1;
          return [
            {
              info: {
                id: 'late-user',
                role: 'user',
                sessionID: 'ses_child',
                time: { created: 140 },
              },
              parts: [],
            },
          ];
        },
      };
      const { recovery } = makeRecovery({
        status: { data: {} },
        baselineReadTimeoutMs: 25,
        readChildTranscript: async () => lateChild,
      });
      const pending = recovery.readLatestChildUser('ses_child');

      jest.advanceTimersByTime(25);
      await expect(pending).resolves.toBeUndefined();

      resolveChild(lateResponse);
      await Promise.resolve();
      await Promise.resolve();
      expect(dataReads).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('adopts an exact durable alias with a live status without launching', async () => {
    const { board, recovery } = makeRecovery({
      status: { data: { ses_child: { type: 'busy' } } },
    });

    const target = await recovery.resolve('parent', 'fix-1');

    expect(target).toMatchObject({
      kind: 'recovered',
      job: { taskID: 'ses_child', alias: 'fix-1', state: 'running' },
      classification: { kind: 'live', evidence: { status: 'busy' } },
    });
    expect(board.list('parent')).toHaveLength(1);
  });

  test('adopts a current child MessageAbortedError only with valid quiescence', async () => {
    const { recovery } = makeRecovery({
      status: { data: {} },
      child: childErrorTranscript,
    });

    const target = await recovery.resolve('parent', 'ses_child');

    expect(target).toMatchObject({
      kind: 'recovered',
      job: { taskID: 'ses_child', alias: 'fix-1', state: 'stopped' },
      classification: { kind: 'stopped' },
    });
  });

  test('refuses an exact native ID when durable alias reservation is unavailable', async () => {
    const lookup = () => undefined;
    const { board, recovery } = makeRecovery({
      status: { data: { ses_child: { type: 'busy' } } },
      identityIndex: { lookup },
    });

    const target = await recovery.resolve('parent', 'ses_child');

    expect(target).toMatchObject({
      kind: 'orphan',
      taskID: 'ses_child',
      classification: { kind: 'live' },
    });
    expect(board.list('parent')).toHaveLength(0);
  });

  test('reserves and adopts an exact native ID with a durable alias', async () => {
    await withRealIdentityIndex(async (index) => {
      const { board, recovery } = makeRecovery({
        status: { data: { ses_child: { type: 'busy' } } },
        identityIndex: index,
      });

      const target = await recovery.resolve('parent', 'ses_child');

      expect(target).toMatchObject({
        kind: 'recovered',
        job: { taskID: 'ses_child', alias: 'fix-1', state: 'running' },
        classification: { kind: 'live' },
      });
      expect(index.lookup('parent', 'ses_child')).toMatchObject({
        parentSessionID: 'parent',
        taskID: 'ses_child',
        agent: 'fixer',
        alias: 'fix-1',
        directory: '/project',
      });
      expect(index.lookup('parent', 'fix-1')).toMatchObject({
        taskID: 'ses_child',
        alias: 'fix-1',
      });

      const token = recovery.claimOperation('parent', 'ses_child', 'message', {
        childLatestUserID: 'child-user',
      });
      expect(token).toBeString();
      if (!token) throw new Error('expected a durable operation claim');
      recovery.settleOperation('parent', 'ses_child', 'message', token);
      expect(board.list('parent')).toHaveLength(1);
    });
  });

  test('a second resolver reuses the reserved alias', async () => {
    await withRealIdentityIndex(async (index) => {
      const first = makeRecovery({
        status: { data: { ses_child: { type: 'busy' } } },
        identityIndex: index,
      });
      await first.recovery.resolve('parent', 'ses_child');

      const second = makeRecovery({
        status: { data: { ses_child: { type: 'busy' } } },
        identityIndex: index,
      });
      const target = await second.recovery.resolve('parent', 'ses_child');

      expect(target).toMatchObject({
        kind: 'recovered',
        job: { taskID: 'ses_child', alias: 'fix-1', state: 'running' },
      });
      expect(index.lookup('parent', 'ses_child')?.alias).toBe('fix-1');
    });
  });

  test('keeps an unavailable status read uncertain and never adopts it', async () => {
    const { board, recovery } = makeRecovery({
      status: { error: 'offline' },
      child: childErrorTranscript,
    });

    const target = await recovery.resolve('parent', 'fix-1');

    expect(target).toMatchObject({
      kind: 'orphan',
      classification: { kind: 'uncertain' },
    });
    expect(board.list('parent')).toHaveLength(0);
  });

  test.each([
    ['parent transcript', 'parent'],
    ['session.get', 'session.get'],
    ['child transcript', 'child'],
    ['status', 'status'],
  ])('times out a hanging %s read without adopting', async (_label, stage) => {
    const never = () => new Promise<never>(() => {});
    const { board, recovery } = makeRecovery({
      status:
        stage === 'child'
          ? { data: {} }
          : { data: { ses_child: { type: 'busy' } } },
      timeoutMs: 10,
      readParentTranscript: stage === 'parent' ? never : undefined,
      getSession: stage === 'session.get' ? never : undefined,
      readChildTranscript: stage === 'child' ? never : undefined,
      probeStatus: stage === 'status' ? never : undefined,
    });

    const target = await recovery.resolve('parent', 'fix-1');

    expect(target).toMatchObject({
      kind: 'orphan',
      classification: { kind: 'uncertain' },
      reason: 'recovery timed out after 10ms',
    });
    expect(board.list('parent')).toHaveLength(0);
  });

  test('does not adopt a late status response after recovery times out', async () => {
    let resolveStatus!: (value: unknown) => void;
    const lateStatus = new Promise<unknown>((resolve) => {
      resolveStatus = resolve;
    });
    const { board, recovery } = makeRecovery({
      status: { data: { ses_child: { type: 'busy' } } },
      timeoutMs: 10,
      probeStatus: async () => lateStatus,
    });

    const target = await recovery.resolve('parent', 'fix-1');
    expect(target).toMatchObject({
      kind: 'orphan',
      classification: { kind: 'uncertain' },
    });

    resolveStatus({ data: { ses_child: { type: 'busy' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(board.list('parent')).toHaveLength(0);
  });

  test('does not adopt a late child transcript after recovery times out', async () => {
    let resolveChild!: (value: unknown) => void;
    const lateChild = new Promise<unknown>((resolve) => {
      resolveChild = resolve;
    });
    const { board, recovery } = makeRecovery({
      status: { data: {} },
      timeoutMs: 10,
      readChildTranscript: async () => lateChild,
    });

    const target = await recovery.resolve('parent', 'fix-1');
    expect(target).toMatchObject({
      kind: 'orphan',
      classification: { kind: 'uncertain' },
    });

    resolveChild(childErrorTranscript);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(board.list('parent')).toHaveLength(0);
  });

  test('keeps v2 recovery uncertain when session.status is unavailable', async () => {
    const { board, recovery } = makeRecovery({
      status: { data: { ses_child: { type: 'busy' } } },
      child: childErrorTranscript,
      hasStatus: false,
    });

    const target = await recovery.resolve('parent', 'fix-1');

    expect(target).toMatchObject({
      kind: 'orphan',
      classification: { kind: 'uncertain' },
    });
    expect(board.list('parent')).toHaveLength(0);
  });

  test('allows statusless v2 reuse only with broker-authorized terminal evidence', async () => {
    const parent = {
      data: [
        {
          info: {
            id: 'call',
            role: 'assistant',
            sessionID: 'parent',
            time: { created: 90 },
          },
          parts: [
            {
              type: 'tool',
              name: 'subagent',
              state: {
                status: 'completed',
                input: {
                  agent: 'fixer',
                  background: true,
                  description: 'Implement fix',
                },
                output: 'task_id: ses_child\nstate: running',
                time: { start: 90, end: 100 },
              },
            },
          ],
        },
        {
          info: {
            id: 'result',
            role: 'assistant',
            sessionID: 'parent',
            time: { created: 214 },
          },
          parts: [
            {
              type: 'tool',
              name: 'task_result',
              state: {
                status: 'completed',
                input: { task_id: 'fix-1' },
                time: { start: 214, end: 215 },
                output: 'Finished work.',
              },
            },
          ],
        },
        {
          info: {
            id: 'ack',
            role: 'assistant',
            sessionID: 'parent',
            time: { created: 240, completed: 241 },
            finish: 'stop',
          },
          parts: [{ type: 'text', text: 'Result received.' }],
        },
      ],
    };
    const child = {
      data: [
        {
          info: { id: 'child-user', role: 'user', time: { created: 110 } },
          parts: [],
        },
        {
          info: {
            id: 'child-answer',
            role: 'assistant',
            time: { created: 120, completed: 190 },
            finish: 'stop',
          },
          parts: [{ type: 'text', text: 'Finished work.' }],
        },
      ],
    };
    const noBroker = makeRecovery({
      status: { data: {} },
      hasStatus: false,
      readParentTranscript: async () => parent,
      readChildTranscript: async () => child,
    });
    await expect(
      noBroker.recovery.resolve('parent', 'fix-1'),
    ).resolves.toMatchObject({
      kind: 'orphan',
      classification: { kind: 'uncertain' },
    });

    const broker = createSameProcessResumeEvidence();
    broker.observeAdmission({
      sessionID: 'ses_child',
      messageID: 'child-user',
      createdAt: 110,
    });
    broker.recordTerminal({
      taskID: 'ses_child',
      parentSessionID: 'parent',
      generation: 3,
      terminalRevision: 1,
      state: 'completed',
      resultSummary: 'Finished work.',
      completedAt: 190,
    });
    broker.observeAdmission({
      sessionID: 'parent',
      messageID: 'parent-user-2',
      createdAt: 214,
    });
    const allowed = makeRecovery({
      status: { data: {} },
      hasStatus: false,
      readParentTranscript: async () => parent,
      readChildTranscript: async () => child,
      sameProcessResumeEvidence: broker,
      sameProcessResumeEvidenceContextFor: () => ({
        generation: 3,
        terminalRevision: 1,
      }),
    });
    await expect(
      allowed.recovery.resolve('parent', 'fix-1'),
    ).resolves.toMatchObject({
      kind: 'recovered',
      classification: {
        kind: 'reusable',
        evidence: { acknowledged: true, resumeToken: {} },
      },
    });
    broker.dispose();
  });

  test('does not adopt an exact native ID without fresh status evidence', async () => {
    const { board, recovery } = makeRecovery({
      status: { error: 'offline' },
      child: childErrorTranscript,
      identityIndex: null,
    });

    const target = await recovery.resolve('parent', 'ses_child');

    expect(target).toMatchObject({
      kind: 'orphan',
      classification: { kind: 'uncertain' },
    });
    expect(board.list('parent')).toHaveLength(0);
  });

  test('does not recover an alias without a durable mapping', async () => {
    const { recovery } = makeRecovery({
      status: { data: { ses_child: { type: 'busy' } } },
      identityIndex: { lookup: () => undefined },
    });

    await expect(recovery.resolve('parent', 'fix-1')).resolves.toMatchObject({
      kind: 'unknown',
    });
  });

  test('does not reserve an alias request without a durable mapping', async () => {
    await withRealIdentityIndex(async (index) => {
      const { recovery } = makeRecovery({
        status: { data: { ses_child: { type: 'busy' } } },
        identityIndex: index,
      });

      await expect(recovery.resolve('parent', 'fix-1')).resolves.toMatchObject({
        kind: 'unknown',
      });
      expect(index.lookup('parent', 'fix-1')).toBeUndefined();
    });
  });

  test.each([
    ['foreign parent', { parentID: 'other-parent' }],
    ['foreign agent', { agent: 'other-agent' }],
    ['foreign directory', { directory: '/other-project' }],
  ])('refuses exact-ID recovery with %s evidence', async (_label, mismatch) => {
    const { board, recovery } = makeRecovery({
      status: { data: { ses_child: { type: 'busy' } } },
      identityIndex: null,
      getSession: async () => ({
        data: {
          id: 'ses_child',
          parentID: 'parent',
          directory: '/project',
          ...mismatch,
        },
      }),
    });

    const target = await recovery.resolve('parent', 'ses_child');

    expect(target).toMatchObject({
      kind: 'orphan',
      classification: { kind: 'uncertain' },
    });
    expect(board.list('parent')).toHaveLength(0);
  });

  test('does not reserve after foreign exact-ID evidence', async () => {
    await withRealIdentityIndex(async (index) => {
      const { board, recovery } = makeRecovery({
        status: { data: { ses_child: { type: 'busy' } } },
        identityIndex: index,
        getSession: async () => ({
          data: {
            id: 'ses_child',
            parentID: 'parent',
            directory: '/other-project',
          },
        }),
      });

      await expect(
        recovery.resolve('parent', 'ses_child'),
      ).resolves.toMatchObject({ kind: 'orphan' });
      expect(index.lookup('parent', 'ses_child')).toBeUndefined();
      expect(board.list('parent')).toHaveLength(0);
    });
  });

  test('does not reserve an exact ID without fresh status evidence', async () => {
    await withRealIdentityIndex(async (index) => {
      const { board, recovery } = makeRecovery({
        status: { data: { ses_child: { type: 'busy' } } },
        hasStatus: false,
        identityIndex: index,
      });

      await expect(
        recovery.resolve('parent', 'ses_child'),
      ).resolves.toMatchObject({ kind: 'orphan' });
      expect(index.lookup('parent', 'ses_child')).toBeUndefined();
      expect(board.list('parent')).toHaveLength(0);
    });
  });

  test('does not reserve an exact ID without attributable evidence', async () => {
    await withRealIdentityIndex(async (index) => {
      const { board, recovery } = makeRecovery({
        status: { data: {} },
        child: { data: [] },
        identityIndex: index,
      });

      await expect(
        recovery.resolve('parent', 'ses_child'),
      ).resolves.toMatchObject({ kind: 'orphan' });
      expect(index.lookup('parent', 'ses_child')).toBeUndefined();
      expect(board.list('parent')).toHaveLength(0);
    });
  });

  test('only one durable operation claim can be owned at a time', async () => {
    let claimed = false;
    const index = {
      lookup: () => identity,
      claimOperation: () => {
        if (claimed) return undefined;
        claimed = true;
        return 'claim-1';
      },
      settleOperation: () => {
        claimed = false;
      },
    };
    const { recovery } = makeRecovery({
      status: { data: { ses_child: { type: 'busy' } } },
      identityIndex: index,
    });
    const baseline = {
      childLatestUserID: 'child-user',
      childLatestUserCreatedAt: 110,
    };

    expect(
      recovery.claimOperation('parent', 'ses_child', 'message', baseline),
    ).toBe('claim-1');
    expect(
      recovery.claimOperation('parent', 'ses_child', 'revive', baseline),
    ).toBeUndefined();
    recovery.settleOperation('parent', 'ses_child', 'message', 'claim-1');
    expect(
      recovery.claimOperation('parent', 'ses_child', 'revive', baseline),
    ).toBe('claim-1');
  });

  test('forwards operation transitions and preserves token fencing', () => {
    const calls: string[] = [];
    const index = {
      lookup: () => identity,
      markOperationSent: (
        _parentSessionID: string,
        _taskID: string,
        _operation: 'message' | 'revive',
        token: string,
      ) => {
        calls.push(`sent:${token}`);
        return token === 'claim-1';
      },
      markOperationAccepted: (
        _parentSessionID: string,
        _taskID: string,
        _operation: 'message' | 'revive',
        token: string,
      ) => {
        calls.push(`accepted:${token}`);
        return token === 'claim-1';
      },
      beginOperationCompensation: (
        _parentSessionID: string,
        _taskID: string,
        _operation: 'message' | 'revive',
        token: string,
      ) => {
        calls.push(`compensating:${token}`);
        return token === 'claim-1';
      },
      settleOperation: (
        _parentSessionID: string,
        _taskID: string,
        _operation: 'message' | 'revive',
        token: string,
        resolution?:
          | 'pre_send_failure'
          | 'authoritative_rejection'
          | 'accepted_and_completed'
          | 'compensated',
      ) => {
        calls.push(`settle:${token}:${resolution ?? 'legacy'}`);
        return token === 'claim-1';
      },
    };
    const { recovery } = makeRecovery({
      status: { data: { ses_child: { type: 'busy' } } },
      identityIndex: index,
    });

    expect(
      recovery.markOperationSent('parent', 'ses_child', 'message', 'stale'),
    ).toBe(false);
    expect(
      recovery.markOperationSent('parent', 'ses_child', 'message', 'claim-1'),
    ).toBe(true);
    expect(
      recovery.markOperationAccepted(
        'parent',
        'ses_child',
        'message',
        'claim-1',
      ),
    ).toBe(true);
    expect(
      recovery.beginOperationCompensation(
        'parent',
        'ses_child',
        'message',
        'claim-1',
      ),
    ).toBe(true);
    expect(
      recovery.settleOperation(
        'parent',
        'ses_child',
        'message',
        'claim-1',
        'compensated',
      ),
    ).toBe(true);
    expect(calls).toEqual([
      'sent:stale',
      'sent:claim-1',
      'accepted:claim-1',
      'compensating:claim-1',
      'settle:claim-1:compensated',
    ]);
  });
});
