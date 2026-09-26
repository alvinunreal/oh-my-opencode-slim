import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskResultTool } from '../../tools/task-result';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createBackgroundJobIdentityIndex } from '../../utils/background-job-identity-index';
import { buildPluginInput } from '../../v2/client-shim';
import { createTaskSessionManagerHook } from './index';
import { classifySessionRecovery } from './session-recovery';

// The real shim's client is the in-process client, including its absent v2 status method.
mock.module('../../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

const PARENT = 'ses_parent';
const CHILD = 'ses_child';
const AGENT = 'fixer';
const RESULT = 'Exact final result.\nSecond line retained.';

function runningOutput() {
  return `The subagent is working in the background (sessionID: ${CHILD})`;
}

function createHost(base: number, directory: string, idleAt?: number) {
  const parent: Array<Record<string, unknown>> = [
    {
      id: 'parent-delegation',
      type: 'assistant',
      time: { created: base + 10, completed: base + 30 },
      content: [
        {
          type: 'tool',
          name: 'subagent',
          state: {
            status: 'completed',
            input: { agent: AGENT, background: true, description: 'Fix it' },
            time: { start: base + 10, end: base + 20 },
            content: [{ type: 'text', text: runningOutput() }],
          },
        },
      ],
    },
  ];
  const child: Array<Record<string, unknown>> = [
    {
      id: 'child-admission',
      type: 'user',
      time: { created: base + 40 },
      text: 'Fix it',
    },
    {
      id: 'child-answer',
      type: 'assistant',
      finish: 'stop',
      time: { created: base + 50, completed: base + 100 },
      content: [{ type: 'text', text: RESULT }],
    },
    {
      id: 'child-idle',
      type: 'idle',
      time: { created: base + 110 },
      outcome: 'succeeded',
    },
  ];
  const get = mock(async ({ sessionID }: { sessionID: string }) => {
    expect(sessionID).toBe(CHILD);
    return {
      id: CHILD,
      parentID: PARENT,
      agent: AGENT,
      location: { directory },
      outcome: 'succeeded',
      time: {
        created: base,
        updated: base + 110,
        ...(idleAt === undefined ? {} : { idle: idleAt }),
      },
    };
  });
  const context = mock(async ({ sessionID }: { sessionID: string }) => {
    if (sessionID === PARENT) return parent;
    expect(sessionID).toBe(CHILD);
    return child;
  });
  const input = buildPluginInput({
    location: { directory },
    session: { get, context },
  } as never) as never;
  return { input, parent, child, get, context };
}

function createHook(
  input: ReturnType<typeof createHost>['input'],
  board: BackgroundJobBoard,
  index: ReturnType<typeof createBackgroundJobIdentityIndex>,
) {
  return createTaskSessionManagerHook(input, {
    maxSessionsPerAgent: 2,
    maxRetainedSnapshots: 2,
    backgroundJobBoard: board,
    identityIndex: index,
    shouldManageSession: (id) => id === PARENT,
  });
}

function recoveredHost(
  host: ReturnType<typeof createHost>,
  directory: string,
  requested: { alias: string } | { sessionID: string } = { alias: 'fix-1' },
) {
  const client = host.input.client.session;
  return {
    requested,
    parentSessionID: PARENT,
    agent: AGENT,
    directory,
    identityIndex: {
      lookup: () => ({
        parentSessionID: PARENT,
        taskID: CHILD,
        alias: 'fix-1',
        agent: AGENT,
        directory,
      }),
    },
    readParentTranscript: () => client.messages({ path: { id: PARENT } }),
    readChildTranscript: () => client.messages({ path: { id: CHILD } }),
    getSession: () => client.get({ path: { id: CHILD } }),
  };
}

function persistRetrieval(
  host: ReturnType<typeof createHost>,
  startedAt: number,
  endedAt: number,
  acknowledgedAt: number,
) {
  host.parent.push(
    {
      id: 'parent-retrieval',
      type: 'assistant',
      time: { created: startedAt },
      content: [
        {
          type: 'tool',
          name: 'task_result',
          state: {
            status: 'completed',
            input: { task_id: 'fix-1' },
            time: { start: startedAt, end: endedAt },
            content: [{ type: 'text', text: RESULT }],
          },
        },
      ],
    },
    {
      id: 'parent-ack',
      type: 'assistant',
      finish: 'stop',
      time: { created: acknowledgedAt, completed: acknowledgedAt + 1 },
      content: [{ type: 'text', text: 'Received.' }],
    },
  );
}

describe('v2 background recovery across plugin restart', () => {
  test('running native part -> retrieval -> persisted acknowledgement -> same-ID resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'slim-recovery-flow-'));
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = root;
    try {
      const directory = join(root, 'project');
      const base = Date.now() - 10_000;
      const host = createHost(base, directory, base + 110);
      const index = createBackgroundJobIdentityIndex(directory);
      const initialBoard = new BackgroundJobBoard();
      const initialHook = createHook(host.input, initialBoard, index);
      const first = { args: { subagent_type: AGENT, background: true } };
      await initialHook['tool.execute.before'](
        { tool: 'task', sessionID: PARENT, callID: 'first' },
        first,
      );
      const nativeLaunch = mock(async (_taskID?: string) => runningOutput());
      await initialHook['tool.execute.after'](
        { tool: 'task', sessionID: PARENT, callID: 'first' },
        { output: await nativeLaunch() },
      );
      expect(initialBoard.get(CHILD)?.state).toBe('running');
      expect(host.parent[0].content).toMatchObject([
        { state: { content: [{ text: runningOutput() }] } },
      ]);
      // The synthetic completion notification is model-visible, not a persisted user turn.
      expect(host.parent).toHaveLength(1);
      const alias = index.reserve(PARENT, CHILD, AGENT, 'fix').alias;
      const restartedIndex = createBackgroundJobIdentityIndex(directory);
      expect(restartedIndex.lookup(PARENT, alias)?.taskID).toBe(CHILD);

      const board = new BackgroundJobBoard();
      const hook = createHook(host.input, board, restartedIndex);
      expect(board.get(CHILD)).toBeUndefined();
      const recover = () =>
        classifySessionRecovery({
          requested: { alias },
          parentSessionID: PARENT,
          agent: AGENT,
          directory,
          identityIndex: restartedIndex,
          readParentTranscript: () =>
            host.input.client.session.messages({ path: { id: PARENT } }),
          readChildTranscript: () =>
            host.input.client.session.messages({ path: { id: CHILD } }),
          getSession: () =>
            host.input.client.session.get({ path: { id: CHILD } }),
        });
      expect((await recover()).kind).toBe('uncertain');

      const resume = {
        args: { subagent_type: AGENT, background: true, task_id: alias },
      };
      await expect(
        hook['tool.execute.before'](
          { tool: 'task', sessionID: PARENT, callID: 'too-early' },
          resume,
        ),
      ).rejects.toThrow(/no new session was created/);
      expect(resume.args.task_id).toBe(alias);
      expect(nativeLaunch).toHaveBeenCalledTimes(1);
      expect(board.get(CHILD)).toBeUndefined();

      const result = await createTaskResultTool({
        input: host.input,
        backgroundJobBoard: board,
        identityIndex: restartedIndex,
      }).task_result.execute({ task_id: alias }, {
        sessionID: PARENT,
      } as never);
      expect(result).toBe(RESULT);
      host.parent.push({
        id: 'parent-retrieval',
        type: 'assistant',
        time: { created: base + 120 },
        content: [
          {
            type: 'tool',
            name: 'task_result',
            state: {
              status: 'completed',
              input: { task_id: alias },
              time: { start: base + 120, end: base + 130 },
              content: [{ type: 'text', text: result }],
            },
          },
        ],
      });
      expect(await recover()).toMatchObject({
        kind: 'reusable',
        evidence: { resultSummary: RESULT, acknowledged: true },
      });
      host.parent.push({
        id: 'parent-ack',
        type: 'assistant',
        finish: 'stop',
        time: { created: base + 140, completed: base + 150 },
        content: [{ type: 'text', text: 'Received.' }],
      });
      expect(await recover()).toMatchObject({
        kind: 'reusable',
        evidence: { resultSummary: RESULT, acknowledged: true },
      });

      const accepted = {
        args: {
          subagent_type: AGENT,
          background: true,
          description: 'resume retained task',
          task_id: alias,
        },
      };
      await hook['tool.execute.before'](
        { tool: 'task', sessionID: PARENT, callID: 'resume' },
        accepted,
      );
      expect(accepted.args.task_id).toBe(CHILD);
      expect(
        restartedIndex.inspectResumeClaim(PARENT, CHILD)?.baseline,
      ).toMatchObject({
        childLatestUserID: 'child-admission',
      });
      expect(nativeLaunch).toHaveBeenCalledTimes(1);
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: PARENT, callID: 'resume' },
        { output: await nativeLaunch(accepted.args.task_id) },
      );
      expect(nativeLaunch).toHaveBeenCalledTimes(2);
      expect(nativeLaunch.mock.calls[1]?.[0]).toBe(CHILD);
      expect(board.get(CHILD)).toMatchObject({
        taskID: CHILD,
        parentSessionID: PARENT,
        state: 'running',
      });
      expect(restartedIndex.inspectResumeClaim(PARENT, CHILD)).toBeUndefined();
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a second child admission cannot reuse an old persisted retrieval', async () => {
    const base = Date.now() - 10_000;
    const directory = '/project';
    const host = createHost(base, directory);
    persistRetrieval(host, base + 120, base + 130, base + 140);
    host.child.push({
      id: 'second-admission',
      type: 'user',
      time: { created: base + 200 },
      text: 'Continue',
    });
    const recovery = await classifySessionRecovery(
      recoveredHost(host, directory),
    );
    expect(recovery.kind).toBe('uncertain');
    expect(recovery).not.toHaveProperty('evidence');
  });

  test('a retrieval started before a second admission cannot certify that run even if it finishes later', async () => {
    const base = Date.now() - 10_000;
    const directory = '/project';
    const host = createHost(base, directory);
    persistRetrieval(host, base + 120, base + 260, base + 280);
    host.child.push(
      {
        id: 'second-admission',
        type: 'user',
        time: { created: base + 200 },
        text: 'Continue',
      },
      {
        id: 'second-answer',
        type: 'assistant',
        finish: 'stop',
        time: { created: base + 210, completed: base + 250 },
        content: [{ type: 'text', text: RESULT }],
      },
    );
    expect(
      (await classifySessionRecovery(recoveredHost(host, directory))).kind,
    ).toBe('uncertain');
  });

  test('v2 location.directory mismatch invalidates indexed recovery', async () => {
    const base = Date.now() - 10_000;
    const directory = '/project';
    const host = createHost(base, '/different-project');
    persistRetrieval(host, base + 120, base + 130, base + 140);
    expect(
      (await classifySessionRecovery(recoveredHost(host, directory))).kind,
    ).toBe('uncertain');
  });

  test('pre-upgrade exact session ID remains retrievable without an alias index', async () => {
    const base = Date.now() - 10_000;
    const directory = '/project';
    const host = createHost(base, directory, base + 110);
    const recovery = await classifySessionRecovery({
      ...recoveredHost(host, directory, { sessionID: CHILD }),
      identityIndex: undefined,
    });
    expect(recovery.taskID).toBe(CHILD);
    const result = await createTaskResultTool({
      input: host.input,
      backgroundJobBoard: new BackgroundJobBoard(),
    }).task_result.execute({ task_id: CHILD }, { sessionID: PARENT } as never);
    expect(result).toBe(RESULT);
  });

  test('without host idle proof, completed child text remains pending', async () => {
    const base = Date.now() - 10_000;
    const host = createHost(base, '/project');
    const result = await createTaskResultTool({
      input: host.input,
      backgroundJobBoard: new BackgroundJobBoard(),
      identityIndex: recoveredHost(host, '/project').identityIndex,
    }).task_result.execute({ task_id: 'fix-1' }, {
      sessionID: PARENT,
    } as never);
    expect(result).toContain('state: running (unconfirmed)');
    expect(result).not.toBe(RESULT);
    expect(host.get).toHaveBeenCalledTimes(1);
    expect(host.context).toHaveBeenCalledTimes(1);
  });

  test('v2 retrieval remains pending when a child is admitted between get and transcript reads', async () => {
    const base = Date.now() - 10_000;
    const host = createHost(base, '/project');
    const input = buildPluginInput({
      location: { directory: '/project' },
      session: {
        get: async () => {
          host.child.push({
            id: 'second-admission',
            type: 'user',
            time: { created: base + 200 },
            text: 'Continue',
          });
          return await host.get({ sessionID: CHILD });
        },
        context: host.context,
      },
    } as never) as never;
    const result = await createTaskResultTool({
      input,
      backgroundJobBoard: new BackgroundJobBoard(),
      identityIndex: recoveredHost(host, '/project').identityIndex,
    }).task_result.execute({ task_id: 'fix-1' }, {
      sessionID: PARENT,
    } as never);
    expect(host.child.at(-1)).toMatchObject({ id: 'second-admission' });
    expect(host.context).toHaveBeenCalledTimes(1);
    expect(result).toContain('state: running (unconfirmed)');
    expect(result).not.toBe(RESULT);
  });
});
