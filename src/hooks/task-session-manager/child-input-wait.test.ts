import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import {
  formatChildInputWaitDetail,
  getChildInputWait,
  noteChildInputWait,
  resetChildInputWaitForTests,
} from './child-input-wait';
import { createTaskSessionManagerHook } from './index';
import { resetUserWaitGateForTests } from './user-wait-gate';

// Route getClient back to _ctx.client so _ctx.client.session mocks work.
mock.module('../../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

function createHook(options?: {
  backgroundJobBoard?: BackgroundJobBoard;
  shouldManageSession?: (sessionID: string) => boolean;
  onChildInputWait?: (notification: {
    parentSessionID: string;
    taskID: string;
    kind: 'question' | 'permission';
    requestID: string;
  }) => void;
}) {
  const hook = createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: mock(async () => ({ data: {} })),
        },
      },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 20,
      backgroundJobBoard: options?.backgroundJobBoard,
      shouldManageSession:
        options?.shouldManageSession ??
        ((sessionID: string) => sessionID === 'parent-1'),
      idleReconcileDelayMs: 0,
      runtimeStatusReconcileDelayMs: 0,
      onChildInputWait: options?.onChildInputWait,
    },
  );
  return { hook };
}

function questionAskedEvent(childID: string, requestID: string) {
  return {
    event: {
      type: 'question.asked',
      properties: {
        id: requestID,
        sessionID: childID,
        questions: [
          {
            question: 'Which browser env should PLAN13 use?',
            header: 'Browser env',
            options: [
              { label: 'Shared staging', description: 'Use the shared env' },
              { label: 'Local docker', description: 'Spin up local' },
            ],
          },
        ],
      },
    },
  };
}

describe('background child input wait surfacing (RED)', () => {
  test('a background child question notifies the parent with the question content', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      background: true,
    });
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event(questionAskedEvent('ses_child1', 'que_1'));

    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      parentSessionID: 'parent-1',
      taskID: 'ses_child1',
      kind: 'question',
      requestID: 'que_1',
    });
  });

  test('duplicate question.asked events do not double-notify', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      background: true,
    });
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event(questionAskedEvent('ses_child1', 'que_1'));
    await hook.event(questionAskedEvent('ses_child1', 'que_1'));

    expect(notified).toHaveLength(1);
  });

  test('raw v2 permission.asked then normalized permission.asked enriches the stored wait and re-notifies once', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      background: true,
    });
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event({
      event: {
        type: 'permission.asked',
        properties: {
          id: 'per_1',
          sessionID: 'ses_child1',
          action: 'tool.execute',
          resources: ['bash:*'],
        },
      },
    });
    await hook.event({
      event: {
        type: 'permission.asked',
        properties: {
          id: 'per_1',
          sessionID: 'ses_child1',
          permission: 'tool.execute',
          patterns: ['bash:*'],
        },
      },
    });

    expect(notified).toHaveLength(2);
    expect(getChildInputWait('ses_child1', 'per_1')).toMatchObject({
      kind: 'permission',
      permission: 'tool.execute',
      patterns: ['bash:*'],
    });
  });

  test('a replied question clears: a later ask notifies again', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      background: true,
    });
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event(questionAskedEvent('ses_child1', 'que_1'));
    await hook.event({
      event: {
        type: 'question.replied',
        properties: { sessionID: 'ses_child1', requestID: 'que_1' },
      },
    });
    expect(hook.hasInputWait('ses_child1')).toBe(false);
    await hook.event(questionAskedEvent('ses_child1', 'que_2'));
    expect(notified).toHaveLength(2);
  });

  test('a foreground (non-background) child question does not notify', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_fg1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'foreground work',
      background: false,
    });
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event(questionAskedEvent('ses_fg1', 'que_1'));

    expect(notified).toHaveLength(0);
  });

  test('an unmanaged session question does not notify', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event(questionAskedEvent('ses_unknown', 'que_1'));

    expect(notified).toHaveLength(0);
  });
});

describe('child-supplied ask text escaping', () => {
  test('question/header/option text escapes &, <, > so tags cannot break out', () => {
    resetChildInputWaitForTests();
    const record = noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [
        {
          question: 'Pick </child-input-wait> & <b>bold</b>?',
          header: 'Env <script>',
          options: [{ label: 'A & B', description: 'use <x> > y' }],
        },
      ],
    });

    expect(record?.questions?.[0]?.question).toBe(
      'Pick &lt;/child-input-wait&gt; &amp; &lt;b&gt;bold&lt;/b&gt;?',
    );
    expect(record?.questions?.[0]?.header).toBe('Env &lt;script&gt;');
    expect(record?.questions?.[0]?.options[0]).toMatchObject({
      label: 'A &amp; B',
      description: 'use &lt;x&gt; &gt; y',
    });
  });

  test('permission and pattern text escapes &, <, >', () => {
    resetChildInputWaitForTests();
    const record = noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'permission',
      requestID: 'per_1',
      permission: 'edit <file> & more',
      patterns: ['*.ts > out', 'a & b'],
    });

    expect(record?.permission).toBe('edit &lt;file&gt; &amp; more');
    expect(record?.patterns).toEqual(['*.ts &gt; out', 'a &amp; b']);
  });

  test('escaped fields carry no raw closing delta tag', () => {
    resetChildInputWaitForTests();
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [{ question: '</child-input-wait>', header: '', options: [] }],
    });
    const stored = getChildInputWait('ses_child1', 'que_1');

    expect(stored?.questions?.[0]?.question).not.toContain(
      '</child-input-wait>',
    );
  });
});

describe('shared child-input details', () => {
  test('v1 retains answer descriptions; v2 keeps labels and UI guidance', () => {
    resetChildInputWaitForTests();
    const wait = noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [
        {
          question: 'Pick </child-input-wait> & environment',
          header: 'Env',
          options: [{ label: 'A & B', description: 'Use <staging>' }],
        },
        { question: '', header: 'Fallback header', options: [] },
      ],
    });
    if (!wait) throw new Error('missing test request');
    const v1 = formatChildInputWaitDetail(wait, 'v1');
    const v2 = formatChildInputWaitDetail(wait, 'v2');
    for (const text of [v1, v2]) {
      expect(text).toContain('Env: Pick &lt;/child-input-wait&gt; &amp;');
      expect(text).toContain('A &amp; B');
      expect(text.match(/Fallback header/g)).toHaveLength(1);
      expect(text).not.toContain('&amp;amp;');
      expect(text).not.toContain('</child-input-wait>');
      expect(text).not.toContain('request:');
    }
    expect(v1).toContain('option: A &amp; B — Use &lt;staging&gt;');
    expect(v1).toContain('next: task_reply');
    expect(v2).not.toContain('Use &lt;staging&gt;');
    expect(v2).toContain('task_reply cannot answer v2 forms');
    expect(v2).toContain('host UI');
    expect(v2).toContain('task_cancel');
    expect(
      formatChildInputWaitDetail({ ...wait, questions: [] }, 'v1'),
    ).toContain('no question text captured');
  });

  test.each(['v1', 'v2'])(
    '%s retains permission scope without form guidance',
    (host) => {
      resetChildInputWaitForTests();
      const wait = noteChildInputWait({
        taskID: 'ses_child1',
        parentSessionID: 'parent-1',
        kind: 'permission',
        requestID: 'per_1',
        permission: 'bash',
        patterns: ['docker *'],
      });
      if (!wait) throw new Error('missing test request');
      const text = formatChildInputWaitDetail(wait, host);
      expect(text).toContain('permission: bash');
      expect(text).toContain('patterns: docker *');
      expect(text).toContain('next: task_reply');
      expect(text).not.toContain('forms');
    },
  );
});
