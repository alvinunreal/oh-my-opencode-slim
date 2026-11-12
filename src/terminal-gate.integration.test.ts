import { afterEach, expect, jest, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { isVolatileTaggedMessage } from './hooks/cache-safe-injection';
import { resetOrchestratorWakeGateForTests } from './hooks/orchestrator-wake/wake-gate';
import * as taskSessionManager from './hooks/task-session-manager';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from './hooks/task-session-manager/board-injection';
import type { RevivedRunTracker } from './hooks/task-session-manager/revived-run-tracker';
import * as runtimeFactories from './hooks/task-session-manager/runtime-status-reconciliation';
import { OhMyOpenCodeLite as plugin } from './index';
import type {
  BackgroundJobRecord,
  BackgroundJobBoard as ProductionBoard,
} from './utils/background-job-board';
import * as gateFactories from './utils/background-job-terminal-gate';
import { BackgroundTaskConcurrency } from './utils/background-task-concurrency';
import { createEventDirectoryScope } from './utils/event-directory-scope';
import {
  createInternalAgentTextPart,
  isInternalInitiatorPart,
  isNativeBackgroundTaskNotification,
} from './utils/internal-initiator';
import {
  createKillAllStopReader,
  writeKillAllStop,
} from './utils/kill-all-stop';
import { createTimerHarness } from './utils/test-timers';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type StatusResponse = { data: { child: { type: 'busy' | 'idle' } } };
const transcript = () => ({
  data: [
    {
      info: {
        id: 'answer',
        role: 'assistant',
        time: { completed: Date.now() },
        finish: 'stop',
      },
      parts: [{ type: 'text', text: 'confirmed result' }],
    },
  ],
});

async function assembly(
  onHookCreated?: (
    board: ProductionBoard,
    gate: gateFactories.BackgroundJobTerminalGate,
  ) => void,
  setup: {
    statusTimeoutMs?: number;
    statusAvailable?: boolean;
    graceMs?: number;
    /** Flat `backgroundJobs` config overrides merged into the written
     * config file (e.g. orchestrator-wake knobs for wake-sensitive
     * fixtures). */
    configOverrides?: Record<string, unknown>;
    rootConfigOverrides?: Record<string, unknown>;
    /** Extra gate options injected at the factory seam (same mechanism as
     * `graceMs`). Used by the #1561 probe to run
     * the slow evidence re-arm on a millisecond cadence instead of the
     * production 30 s default. */
    gateOptions?: Record<string, unknown>;
  } = {},
) {
  const env = { ...process.env };
  const directory = await mkdtemp(
    path.join(tmpdir(), 'slim-terminal-assembly-'),
  );
  process.env.OPENCODE_CONFIG_DIR = directory;
  process.env.XDG_CONFIG_HOME = directory;
  process.env.XDG_DATA_HOME = directory;
  process.env.XDG_CACHE_HOME = directory;
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  await Bun.write(
    `${directory}/oh-my-opencode-slim.json`,
    JSON.stringify({
      ...setup.rootConfigOverrides,
      backgroundJobs: {
        mode: 'managed',
        concurrency: { defaultConcurrency: 1 },
        ...(setup.configOverrides ?? {}),
      },
    }),
  );
  let board!: ProductionBoard;
  let gate!: gateFactories.BackgroundJobTerminalGate;
  let taskHook!: ReturnType<
    typeof taskSessionManager.createTaskSessionManagerHook
  >;
  // The production tracker instance, captured from the hook factory's
  // options (index.ts threads `revivedRunTracker` into
  // createTaskSessionManagerHook) so tests can register revived runs —
  // the exact post-admission state task_revive leaves behind.
  let revivedTracker: RevivedRunTracker | undefined;
  let runtime!: ReturnType<
    typeof runtimeFactories.createRuntimeStatusReconciler
  >;
  const originalRuntime = runtimeFactories.createRuntimeStatusReconciler;
  const runtimeSpy = spyOn(
    runtimeFactories,
    'createRuntimeStatusReconciler',
  ).mockImplementation((options) => {
    runtime = originalRuntime({
      ...options,
      statusTimeoutMs: setup.statusTimeoutMs ?? options.statusTimeoutMs,
    });
    return runtime;
  });
  const originalGate = gateFactories.createBackgroundJobTerminalGate;
  const gateSpy = spyOn(
    gateFactories,
    'createBackgroundJobTerminalGate',
  ).mockImplementation((options) => {
    board = options.backgroundJobBoard as ProductionBoard;
    gate = originalGate({
      ...options,
      graceMs: setup.graceMs ?? options.graceMs,
      ...(setup.gateOptions ?? {}),
    });
    return gate;
  });
  const originalHook = taskSessionManager.createTaskSessionManagerHook;
  let prune!: ReturnType<typeof spyOn>;
  const hookSpy = spyOn(
    taskSessionManager,
    'createTaskSessionManagerHook',
  ).mockImplementation((...args) => {
    taskHook = originalHook(...args);
    revivedTracker = args[1]?.revivedRunTracker;
    prune = spyOn(taskHook, 'pruneTaskContext');
    onHookCreated?.(board, gate);
    return taskHook;
  });
  let busy = false;
  const heldStatuses: ReturnType<typeof deferred<StatusResponse>>[] = [];
  const statusMetrics = { activeReads: 0, maxActiveReads: 0 };
  const status = mock(async (): Promise<StatusResponse> => {
    statusMetrics.maxActiveReads = Math.max(
      statusMetrics.maxActiveReads,
      ++statusMetrics.activeReads,
    );
    try {
      const held = heldStatuses.shift();
      return held
        ? await held.promise
        : { data: { child: { type: busy ? 'busy' : 'idle' } } };
    } finally {
      statusMetrics.activeReads--;
    }
  });
  const messages = mock(
    async (_args: unknown): Promise<unknown> => transcript(),
  );
  const get = mock(
    async (_args: unknown): Promise<unknown> => ({
      data: {
        parentID: 'parent',
        outcome: 'succeeded',
        time: { idle: Date.now() },
      },
    }),
  );
  const noop = async () => ({ data: [] });
  const abort = mock(async () => ({}));
  const promptAsync = mock(async (_args: unknown) => ({}));
  const session = new Proxy(
    {
      abort,
      promptAsync,
      status,
      messages,
      get,
    },
    {
      get: (target, key) =>
        key === 'status' && setup.statusAvailable === false
          ? undefined
          : (Reflect.get(target, key) ?? noop),
    },
  );
  const builtClient = new Proxy(
    { session, app: { log: noop } },
    {
      get: (target, key) =>
        Reflect.get(target, key) ?? new Proxy({}, { get: () => noop }),
    },
  );
  const client = builtClient;
  const instance: { hooks?: Awaited<ReturnType<typeof plugin>> } = {};
  cleanups.push(async () => {
    await instance.hooks?.dispose?.();
    prune?.mockRestore();
    hookSpy.mockRestore();
    gateSpy.mockRestore();
    runtimeSpy.mockRestore();
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
    await rm(directory, { recursive: true, force: true });
  });
  const hooks = await plugin({
    client,
    directory,
    worktree: directory,
    serverUrl: new URL('http://127.0.0.1:4096'),
    hostFlavor: 'v1',
  } as never);
  instance.hooks = hooks;
  expect(gate).toBeDefined();
  expect(taskHook).toBeDefined();
  const event = (type: string, properties?: Record<string, unknown>) =>
    hooks.event?.({ event: { type, properties } } as never);
  const call = { tool: 'task', sessionID: 'parent', callID: 'native' };
  const requestTask = (callID: string, description: string) =>
    hooks['tool.execute.before']?.(
      { ...call, callID },
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description,
        },
      },
    );
  const begin = async () => {
    await requestTask('native', 'ordinary task');
    await event('session.created', {
      info: { id: 'child', parentID: 'parent', agent: 'explorer' },
    });
  };
  const after = (state: string) =>
    hooks['tool.execute.after']?.(call, {
      output: `task_id: child\nstate: ${state}\n<task_result>confirmed result</task_result>`,
    });
  const idle = () => event('session.idle', { sessionID: 'child' });
  const busySignal = (activityAt?: number) =>
    event('session.status', {
      sessionID: 'child',
      status: { type: 'busy' },
      activityAt,
    });
  return {
    hooks,
    board,
    gate,
    taskHook,
    revivedTracker,
    runtime,
    prune,
    status,
    statusMetrics,
    messages,
    get,
    abort,
    promptAsync,
    directory,
    begin,
    requestTask,
    after,
    idle,
    event,
    busySignal,
    holdStatus: () => {
      const held = deferred<StatusResponse>();
      heldStatuses.push(held);
      return () => held.resolve({ data: { child: { type: 'busy' } } });
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

type Assembly = Awaited<ReturnType<typeof assembly>>;

async function fallbackAssembly(
  delayMs = 2000,
  foreground = false,
  chain = ['test/primary', 'test/fallback'],
) {
  jest.useFakeTimers();
  let fakeTimers = true;
  const restoreTimers = async () => {
    if (!fakeTimers) return;
    fakeTimers = false;
    jest.useRealTimers();
  };
  // Covers a throw inside assembly() before its disposal cleanup is pushed.
  cleanups.push(restoreTimers);
  const h = await assembly(undefined, {
    rootConfigOverrides: {
      agents: {
        explorer: { model: chain },
      },
      fallback: { initialRetryDelayMs: delayMs },
    },
  });
  // Cleanups run in reverse, so this restores real timers before plugin
  // disposal. Disposing under fake timers can wait on a timer that never
  // fires, time out afterEach, and flip the next test's timers mid-run.
  cleanups.push(restoreTimers);
  if (foreground) {
    const description =
      'Investigate   the complete foreground fallback path with a long task description';
    await h.hooks['tool.execute.before']?.(
      { tool: 'task', sessionID: 'parent', callID: 'native' },
      { args: { subagent_type: 'explorer', description } },
    );
    await h.event('session.created', {
      info: {
        id: 'child',
        parentID: 'parent',
        agent: 'explorer',
        title: `${description} (@explorer subagent)`,
      },
    });
  } else {
    await h.begin();
    await h.after('running');
  }
  await h.hooks['chat.message']?.(
    {
      sessionID: 'child',
      agent: 'explorer',
      model: { providerID: 'test', modelID: 'primary' },
    } as never,
    { parts: [] } as never,
  );
  const history: unknown[] = [
    {
      info: { id: 'request', role: 'user' },
      parts: [{ type: 'text', text: 'work' }],
    },
    {
      info: {
        id: 'failed',
        role: 'assistant',
        error: 'rate limit',
        time: { completed: Date.now() },
      },
      parts: [],
    },
  ];
  h.messages.mockImplementation(async () => ({ data: history }));
  return {
    ...h,
    history,
    context: { sessionID: 'parent', agent: 'orchestrator' } as never,
    fail: () =>
      h.event('session.error', {
        sessionID: 'child',
        error: { statusCode: 429, message: 'rate limit' },
      }),
    advance: async (ms: number) => {
      jest.advanceTimersByTime(ms);
      await flush();
    },
  };
}

const contentFilterError = {
  name: 'ContentFilterError',
  data: {
    message: "The response was blocked by the provider's content filter",
  },
};
const nativeRefusal =
  '<task id="child" state="error">\n<summary>Background task failed: ordinary task</summary>\n<task_error>\nSubagent failed (task_id: child): The response was blocked by the provider\'s content filter\n</task_error>\n</task>';

function setChildError(
  h: Awaited<ReturnType<typeof fallbackAssembly>>,
  error = contentFilterError,
) {
  h.history.pop();
  h.history.push({
    info: {
      id: 'filtered',
      role: 'assistant',
      finish: 'content-filter',
      error,
      time: { completed: Date.now() },
    },
    parts: [],
  });
}

test('v1 managed observes a tracked child error after it moves to another live location', async () => {
  const h = await assembly();
  await h.begin();
  await h.after('running');
  const destination = path.join(h.directory, 'worktree');
  const scope = createEventDirectoryScope(destination);
  cleanups.push(async () => scope.release());
  h.messages.mockImplementation(async () => ({
    data: [
      {
        info: {
          id: 'moved-error',
          role: 'assistant',
          error: { name: 'Error', data: { message: 'Moved child failed' } },
          time: { completed: Date.now() },
        },
        parts: [],
      },
    ],
  }));
  const observe = spyOn(h.taskHook, 'event');
  cleanups.push(async () => observe.mockRestore());
  const failed = (sessionID: string) => ({
    event: {
      type: 'session.error',
      location: { directory: destination },
      properties: {
        sessionID,
        error: { name: 'Error', data: { message: 'Moved child failed' } },
      },
    },
  });

  await h.hooks.event?.(failed('unrelated') as never);
  expect(observe).not.toHaveBeenCalled();
  await h.hooks.event?.(failed('child') as never);

  expect(observe).toHaveBeenCalledTimes(1);
  expect(h.board.get('child')).toMatchObject({
    state: 'error',
    resultSummary: 'Moved child failed',
  });
});

test('v1 background abort wakes the idle parent only for kill-all', async () => {
  const h = await fallbackAssembly();
  const error = {
    name: 'MessageAbortedError',
    data: { message: 'The user aborted a request.' },
  };
  await h.advance(1);
  writeKillAllStop(h.directory, ['parent']);
  setChildError(h, error);
  await h.event('session.error', { sessionID: 'child', error });
  await h.idle();
  await h.runtime.reconcile();
  await h.advance(0);
  expect(h.board.get('child')).toMatchObject({
    state: 'stopped',
    terminalRevision: 1,
    resultSummary: 'Host reported outcome: interrupted.',
  });
  expect(h.promptAsync).toHaveBeenCalledTimes(1);
  const wake = (
    h.promptAsync.mock.calls as unknown as Array<
      [{ body: { parts: Array<{ text: string }> } }]
    >
  )[0][0].body.parts[0].text;
  expect(wake).toContain('state: stopped');

  await h.hooks['chat.message']?.(
    { sessionID: 'parent', agent: 'orchestrator' } as never,
    { parts: [{ type: 'text', text: 'continue' }] } as never,
  );
  await h.advance(1);
  h.promptAsync.mockClear();
  await h.requestTask('another', 'another task');
  await h.event('session.created', {
    info: { id: 'child2', parentID: 'parent', agent: 'explorer' },
  });
  await h.hooks['tool.execute.after']?.(
    { tool: 'task', sessionID: 'parent', callID: 'another' },
    { output: 'task_id: child2\nstate: running' },
  );
  setChildError(h, error);
  await h.event('session.error', { sessionID: 'child2', error });
  await h.event('session.idle', { sessionID: 'child2' });
  await h.runtime.reconcile();
  await h.advance(0);
  expect(h.board.get('child2')).toMatchObject({
    state: 'stopped',
    terminalRevision: 1,
    resultSummary: 'Host reported outcome: interrupted.',
  });
  expect(h.promptAsync).not.toHaveBeenCalled();

  // Once the parent has replied, the stop retires like the error it
  // replaces and the user can have the same objective relaunched.
  await h.hooks['experimental.chat.messages.transform']?.(
    {},
    parentMessage(
      { type: 'text', text: 'Both stopped. How should I proceed?' },
      'assistant',
      Date.now() + 1,
    ) as never,
  );
  expect(h.board.get('child')?.terminalUnreconciled).toBe(false);
  await h.requestTask('relaunch', 'ordinary task');
});

test('v1 kill-all stop already reported to a busy parent does not wake it again', async () => {
  const h = await fallbackAssembly();
  const error = {
    name: 'MessageAbortedError',
    data: { message: 'The user aborted a request.' },
  };
  const working = Date.now();
  await h.advance(1);
  // alt+w while the parent is still working.
  h.status.mockImplementation(async () => ({
    data: { parent: { type: 'busy' } },
  }));
  writeKillAllStop(h.directory, ['parent']);
  setChildError(h, error);
  await h.event('session.error', { sessionID: 'child', error });
  await h.idle();
  await h.runtime.reconcile();
  await h.advance(0);
  expect(h.board.get('child')?.state).toBe('stopped');
  expect(h.promptAsync).not.toHaveBeenCalled();

  // Its next request carries the notice, then it ends its turn.
  const request = {
    messages: [
      ['ask', 'user', 'Delegate the task and keep working.'],
      ['working', 'assistant', 'Checking files.'],
    ].map(([id, role, text]) => ({
      info: { id, sessionID: 'parent', role, time: { created: working } },
      parts: [{ type: 'text', text }],
    })),
  };
  await h.hooks['experimental.chat.messages.transform']?.({}, request as never);
  expect(JSON.stringify(request)).toContain(
    'User stopped all running subagents',
  );
  h.status.mockImplementation(async () => ({ data: {} }));
  await h.event('session.idle', { sessionID: 'parent' });
  await h.advance(0);
  expect(h.promptAsync).not.toHaveBeenCalled();
});

function parentMessage(
  part: Record<string, unknown>,
  role = 'user',
  created = Date.now(),
) {
  return {
    messages: [
      {
        info: { id: 'notice', sessionID: 'parent', role, time: { created } },
        parts: [part],
      },
    ],
  };
}

test('kill-all notice follows internal turns and expires on the next external prompt', async () => {
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  cleanups.push(async () => clock.mockRestore());
  const h = await assembly();
  now += 1;
  writeKillAllStop(h.directory, ['parent']);
  const notice =
    "User stopped all running subagents (emergency stop). Don't relaunch or retry them; ask how to proceed.";
  const request = parentMessage({ type: 'text', text: 'work' });
  const transform = async () => {
    await h.hooks['experimental.chat.messages.transform']?.(
      {},
      request as never,
    );
  };
  await transform();
  expect(request.messages.at(-1)?.parts[0]).toMatchObject({
    synthetic: true,
    text: expect.stringContaining(notice),
    metadata: {
      [BACKGROUND_JOB_BOARD_METADATA_KEY]: true,
      'oh-my-opencode-slim.killAllStop': true,
    },
  });
  await h.hooks['chat.message']?.(
    { sessionID: 'parent', agent: 'orchestrator' } as never,
    { parts: [createInternalAgentTextPart('internal wake')] } as never,
  );
  await transform();
  expect(JSON.stringify(request).split(notice)).toHaveLength(2);

  const other = parentMessage({ type: 'text', text: 'other' });
  other.messages[0].info.sessionID = 'other';
  await h.hooks['experimental.chat.messages.transform']?.({}, other as never);
  expect(JSON.stringify(other)).not.toContain(notice);

  now += 1;
  await h.hooks['chat.message']?.(
    { sessionID: 'parent', agent: 'orchestrator' } as never,
    { parts: [{ type: 'text', text: 'sigue' }] } as never,
  );
  await transform();
  expect(JSON.stringify(request)).not.toContain(notice);
  now += 1;
  writeKillAllStop(h.directory, ['parent']);
  await transform();
  expect(JSON.stringify(request).split(notice)).toHaveLength(2);
  expect(createKillAllStopReader(h.directory).isActive('parent')).toBe(false);
});

function foregroundFailure(error = contentFilterError.data.message) {
  return {
    type: 'tool',
    tool: 'task',
    callID: 'native',
    state: {
      status: 'error',
      input: { subagent_type: 'explorer' },
      error: `Subagent failed (task_id: child): ${error}`,
      time: { start: Date.now() - 10, end: Date.now() },
    },
  };
}

test('v1 foreground replay keeps the error part and appends a correction', async () => {
  const h = await fallbackAssembly(2000, true);
  expect(h.board.get('child')?.background).toBe(false);
  setChildError(h);
  const part = foregroundFailure();
  const request = parentMessage(part, 'assistant');
  request.messages.unshift(
    parentMessage({ type: 'text', text: 'work' }).messages[0],
  );
  const transform = h.hooks['experimental.chat.messages.transform']?.(
    {},
    request as never,
  );
  await h.event('session.error', {
    sessionID: 'child',
    error: contentFilterError,
  });
  await h.idle();
  await h.advance(2000);
  await transform;
  expect(request.messages[1].parts[0]).toEqual(part);
  expect(request.messages.at(-1)?.parts[0]).toMatchObject({
    synthetic: true,
    text: expect.stringContaining('test/fallback'),
    metadata: { [BACKGROUND_JOB_BOARD_METADATA_KEY]: true },
  });
  expect(part.state.status).toBe('error');
  const prompts = () =>
    h.promptAsync.mock.calls.map(
      ([call]) =>
        call as {
          path: { id: string };
          body: { messageID: string; parts: { text: string }[] };
        },
    );
  expect(
    h.revivedTracker?.isTracked('child', h.board.get('child')?.generation ?? 0),
  ).toBe(true);
  h.setBusy(true);
  await h.busySignal();
  h.history.push(
    {
      info: { id: prompts()[0].body.messageID, role: 'user' },
      parts: prompts()[0].body.parts,
    },
    ...transcript().data,
  );
  h.setBusy(false);
  await h.idle();
  await h.runtime.reconcile();
  await flush();
  expect(
    prompts()
      .filter(({ path }) => path.id === 'parent')
      .at(-1)?.body.parts[0].text,
  ).toContain('confirmed result');
});

test('v1 foreground continuation stop reaches the parent once', async () => {
  const h = await fallbackAssembly(2000, true);
  setChildError(h);
  const request = parentMessage(foregroundFailure(), 'assistant');
  request.messages.unshift(
    parentMessage({ type: 'text', text: 'work' }).messages[0],
  );
  const transform = h.hooks['experimental.chat.messages.transform']?.(
    {},
    request as never,
  );
  await h.event('session.error', {
    sessionID: 'child',
    error: contentFilterError,
  });
  await h.idle();
  await h.advance(2000);
  await transform;
  const prompts = () =>
    h.promptAsync.mock.calls.map(
      ([call]) =>
        call as {
          path: { id: string };
          body: { messageID: string; parts: { text: string }[] };
        },
    );
  h.setBusy(true);
  await h.busySignal();
  const replay = prompts().find(({ path }) => path.id === 'child')?.body;
  const error = {
    name: 'MessageAbortedError',
    data: { message: 'The user aborted a request.' },
  };
  h.history.push(
    { info: { id: replay?.messageID, role: 'user' }, parts: replay?.parts },
    {
      info: {
        id: 'aborted',
        role: 'assistant',
        error,
        time: { completed: Date.now() },
      },
      parts: [],
    },
  );
  await h.event('session.error', { sessionID: 'child', error });
  h.setBusy(false);
  await h.idle();
  await h.runtime.reconcile();
  await h.advance(10_000);
  // The continuation tracker owns the stop; no recovery wake beside it.
  const parent = prompts()
    .filter(({ path }) => path.id === 'parent')
    .map(({ body }) => body.parts[0].text);
  expect(parent).toHaveLength(2);
  expect(parent[1]).toContain('<task id="child" state="stopped">');
});

test('v1 foreground leaves the native failure when its chain is exhausted', async () => {
  const h = await fallbackAssembly(2000, true, ['test/primary']);
  setChildError(h);
  const part = foregroundFailure();
  const request = parentMessage(part, 'assistant');
  const transform = h.hooks['experimental.chat.messages.transform']?.(
    {},
    request as never,
  );
  await h.event('session.error', {
    sessionID: 'child',
    error: contentFilterError,
  });
  await h.advance(2000);
  await transform;
  expect(request.messages[0].parts[0]).toEqual(part);
  expect(h.promptAsync).not.toHaveBeenCalled();
});

test('a foreground host stop is acknowledged by the next parent request', async () => {
  const h = await fallbackAssembly(2000, true, ['test/primary']);
  const error = {
    name: 'MessageAbortedError',
    data: { message: 'The user aborted a request.' },
  };
  setChildError(h, error);
  await h.event('session.error', { sessionID: 'child', error });
  await h.idle();
  await h.runtime.reconcile();
  await h.advance(0);
  const stopped = h.board.get('child');
  expect(stopped).toMatchObject({
    state: 'stopped',
    background: false,
    terminalUnreconciled: true,
  });
  // The parent turn that answers the stop can be created before the stop
  // is published; its request still carries the tool result.
  await h.hooks['experimental.chat.messages.transform']?.(
    {},
    parentMessage(
      { type: 'text', text: 'Stopped. How should I proceed?' },
      'assistant',
      (stopped?.completedAt ?? 0) - 15,
    ) as never,
  );
  expect(h.board.get('child')?.terminalUnreconciled).toBe(false);
  await h.requestTask(
    'relaunch',
    'Investigate   the complete foreground fallback path with a long task description',
  );
});

test('v1 background keeps a prefixed refusal and sends one terminal result', async () => {
  const h = await fallbackAssembly();
  setChildError(h);
  const prefix = '\u00a742\u00a7 ';
  const part = { type: 'text', synthetic: true, text: prefix + nativeRefusal };
  const request = parentMessage(part);
  const transform = h.hooks['experimental.chat.messages.transform']?.(
    {},
    request as never,
  );
  await h.event('session.error', {
    sessionID: 'child',
    error: contentFilterError,
  });
  await h.idle();
  await h.advance(2000);
  await transform;
  expect(request.messages[0].parts[0].text).toBe(prefix + nativeRefusal);
  expect(request.messages.at(-1)?.parts[0]).toMatchObject({
    synthetic: true,
    text: expect.stringContaining('test/fallback'),
    metadata: { [BACKGROUND_JOB_BOARD_METADATA_KEY]: true },
  });
  expect(part.text).toBe(prefix + nativeRefusal);
  const calls = () =>
    h.promptAsync.mock.calls.map(
      ([call]) =>
        call as {
          path: { id: string };
          body: { messageID: string; parts: { text: string }[] };
        },
    );
  h.setBusy(true);
  await h.busySignal();
  const replay = calls().find(({ path }) => path.id === 'child')?.body;
  h.history.push(
    { info: { id: replay?.messageID, role: 'user' }, parts: replay?.parts },
    ...transcript().data,
  );
  h.setBusy(false);
  await h.idle();
  await h.runtime.reconcile();
  await flush();
  expect(
    calls().filter(
      ({ path, body }) =>
        path.id === 'parent' &&
        body.parts[0].text.includes('state="completed"'),
    ),
  ).toHaveLength(1);
  expect(h.board.get('child')?.state).not.toBe('running');
  const settled = parentMessage(part);
  await h.hooks['experimental.chat.messages.transform']?.({}, settled as never);
  expect(settled.messages[0].parts[0]).toEqual(part);
  expect(
    settled.messages.some((message) =>
      isVolatileTaggedMessage(message, BACKGROUND_JOB_BOARD_METADATA_KEY),
    ),
  ).toBe(false);
});

test('v1 terminal error delivered by Slim is never rewritten', async () => {
  const h = await fallbackAssembly();
  const part = createInternalAgentTextPart(nativeRefusal);
  const request = parentMessage(part);
  await h.hooks['experimental.chat.messages.transform']?.({}, request as never);
  expect(request.messages[0].parts[0]).toEqual(part);
});

test('v1 non-failover child error does not wait for replay', async () => {
  const h = await fallbackAssembly(2000, true);
  h.history.pop();
  h.history.push({
    info: {
      id: 'bad',
      role: 'assistant',
      error: {
        name: 'APIError',
        data: { statusCode: 400, message: 'invalid request' },
      },
      time: { completed: Date.now() },
    },
    parts: [],
  });
  const part = foregroundFailure('invalid request');
  const request = parentMessage(part, 'assistant');
  let finished = false;
  const transform = h.hooks['experimental.chat.messages.transform']?.(
    {},
    request as never,
  ).then(() => {
    finished = true;
  });
  await flush();
  expect(finished).toBe(true);
  await transform;
  expect(request.messages[0].parts[0]).toEqual(part);
});

test('v1 replay wait includes the configured retry delay', async () => {
  const h = await fallbackAssembly(6000);
  setChildError(h);
  const request = parentMessage({
    type: 'text',
    synthetic: true,
    text: nativeRefusal,
  });
  let finished = false;
  const transform = h.hooks['experimental.chat.messages.transform']?.(
    {},
    request as never,
  ).then(() => {
    finished = true;
  });
  await h.event('session.error', {
    sessionID: 'child',
    error: contentFilterError,
  });
  await h.advance(5001);
  expect(finished).toBe(false);
  await h.advance(999);
  await transform;
  expect(request.messages[0].parts[0].text).toBe(nativeRefusal);
  expect(request.messages.at(-1)?.parts[0].text).toContain('test/fallback');
});

test('v1 old refusal notice does not wait for replay', async () => {
  const h = await fallbackAssembly();
  const part = { type: 'text', synthetic: true, text: nativeRefusal };
  const request = parentMessage(part, 'user', Date.now() - 10_000);
  let finished = false;
  const transform = h.hooks['experimental.chat.messages.transform']?.(
    {},
    request as never,
  ).then(() => {
    finished = true;
  });
  await flush();
  expect(finished).toBe(true);
  await transform;
  expect(request.messages[0].parts[0]).toEqual(part);
});

test('fallback initial delay cannot replay a cancelled background child', async () => {
  const h = await fallbackAssembly();
  await h.fail();
  expect(h.promptAsync).not.toHaveBeenCalled();
  const cancellation = h.hooks.tool?.task_cancel.execute(
    { task_id: 'child' },
    h.context,
  );
  await flush();
  await h.advance(300);
  await cancellation;
  expect(h.board.get('child')?.state).toBe('cancelled');
  await h.advance(1700);
  expect(h.promptAsync).not.toHaveBeenCalled();
  expect(h.board.get('child')?.state).toBe('cancelled');
});

test('a hung fallback replay transcript read publishes the unrecovered error', async () => {
  const h = await fallbackAssembly();
  h.messages.mockImplementation(async (args: unknown) => {
    const { query } = args as {
      query?: { limit?: number; directory?: string };
    };
    if (query?.limit !== undefined && query.directory === undefined)
      return new Promise(() => {});
    return { data: h.history };
  });
  await h.fail();
  await h.idle();
  await h.runtime.reconcile();
  for (let i = 0; i < 4; i++) await h.advance(2000);
  expect(h.board.get('child')?.state).toBe('error');
  expect(h.board.get('child')?.resultSummary).toContain(
    'Model fallback did not recover',
  );
});

test('task_cancel retains an uncertain fallback observation until its bounded expiry', async () => {
  const h = await fallbackAssembly();
  let childSends = 0;
  h.promptAsync.mockImplementation(async (call: unknown) => {
    const { path } = call as { path: { id: string } };
    if (path.id === 'child') {
      childSends++;
      throw new Error('socket hang up');
    }
    return {};
  });
  await h.fail();
  await h.idle();
  await h.advance(2000);
  const generation = h.board.get('child')?.generation ?? 0;
  expect(childSends).toBe(1);
  expect(h.abort).not.toHaveBeenCalled();
  expect(h.revivedTracker?.isTracked('child', generation)).toBe(true);
  expect(h.revivedTracker?.isObservationPending('child', generation)).toBe(
    true,
  );

  const cancellation = h.hooks.tool?.task_cancel.execute(
    { task_id: 'child' },
    h.context,
  );
  await flush();
  await h.advance(300);
  await cancellation;
  expect(h.board.get('child')?.state).toBe('cancelled');
  expect(h.abort).toHaveBeenCalledTimes(1);
  expect(h.revivedTracker?.isObservationPending('child', generation)).toBe(
    true,
  );

  await h.advance(30_000);
  expect(childSends).toBe(1);
  expect(h.board.get('child')?.state).toBe('cancelled');
  expect(h.revivedTracker?.isObservationPending('child', generation)).toBe(
    false,
  );
  expect(h.revivedTracker?.isTracked('child', generation)).toBe(true);
});

test('a timed-out fallback replay retains its owner without aborting or resending', async () => {
  const h = await fallbackAssembly();
  const hung = Promise.withResolvers<Record<string, never>>();
  h.promptAsync.mockImplementation(async () => hung.promise);
  try {
    await h.fail();
    await h.idle();
    for (let i = 0; i < 38; i++) await h.advance(1000);
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.promptAsync).toHaveBeenCalledTimes(1);
    expect(
      h.revivedTracker?.isTracked(
        'child',
        h.board.get('child')?.generation ?? 0,
      ),
    ).toBe(true);
    expect(h.board.get('child')?.state).toBe('running');
    for (let i = 0; i < 12; i++) await h.advance(1000);
    expect(h.board.get('child')?.state).toBe('stopped');
  } finally {
    // Release the hung prompt so plugin disposal can settle during cleanup;
    // leaving it pending leaked a timed-out afterEach into the next test.
    hung.resolve({});
  }
});

test('terminal failover during a retry-armed delay waits for replay, notice and one result', async () => {
  const h = await fallbackAssembly(8000);
  const prompts = () =>
    h.promptAsync.mock.calls.map(
      ([call]) =>
        call as {
          path: { id: string };
          body: { messageID: string; parts: { text: string }[] };
        },
    );
  h.promptAsync.mockImplementation(async (call: unknown) => {
    const { path, body } = call as ReturnType<typeof prompts>[number];
    if (path.id === 'child') {
      setTimeout(() => {
        h.history.push({
          info: { id: body.messageID, role: 'user' },
          parts: body.parts,
        });
        h.setBusy(true);
        void h.busySignal();
      }, 50);
    }
    return {};
  });
  h.history.pop();
  for (let attempt = 1; attempt <= 4; attempt++) {
    await h.event('session.status', {
      sessionID: 'child',
      status: { type: 'retry', message: 'rate limit', attempt },
    });
  }
  const error = {
    name: 'APIError',
    data: {
      statusCode: 400,
      isRetryable: false,
      message: 'content_policy_violation',
    },
  };
  h.history.push({
    info: {
      id: 'filtered',
      role: 'assistant',
      error,
      time: { completed: Date.now() },
    },
    parts: [],
  });
  await h.event('session.error', { sessionID: 'child', error });
  await h.idle();
  await h.runtime.reconcile();
  expect(h.board.get('child')?.state).toBe('running');
  await h.advance(8000);
  expect(prompts().map(({ path }) => path.id)).toEqual(['child', 'parent']);
  expect(prompts()[1].body.parts[0].text).toContain('<task_fallback>');
  await h.advance(50);
  h.history.push(...transcript().data);
  h.setBusy(false);
  await h.idle();
  await h.runtime.reconcile();
  await flush();
  expect(h.board.get('child')?.state).toBe('completed');
  expect(h.board.get('child')?.terminalRevision).toBe(1);
  expect(prompts()).toHaveLength(3);
  expect(prompts().filter(({ path }) => path.id === 'parent')).toHaveLength(2);
  expect(prompts()[2].path.id).toBe('parent');
  expect(prompts()[2].body.parts[0].text).toContain(
    '<task_result>\nconfirmed result\n</task_result>',
  );
  await h.runtime.reconcile();
  await flush();
  expect(prompts()).toHaveLength(3);
});

test('production fallback wiring fences polling and announces the admitted replay before its result', async () => {
  const h = await fallbackAssembly();
  await h.fail();
  await h.idle();
  await h.runtime.reconcile();
  expect(h.board.get('child')).toMatchObject({
    state: 'running',
    statusUncertain: false,
  });
  const revival = h.hooks.tool?.task_revive
    .execute({ task_id: 'child', prompt: 'continue' }, h.context)
    .catch((error: Error) => error);
  await flush();
  await h.advance(300);
  const refusal = await revival;
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toMatch(
    /recovering on a fallback model.*wait for its result.*task_cancel/i,
  );
  expect(h.abort).not.toHaveBeenCalled();
  expect(h.promptAsync).not.toHaveBeenCalled();
  await h.advance(1700);
  const prompts = () =>
    h.promptAsync.mock.calls.map(
      ([call]) =>
        call as {
          path: { id: string };
          body: {
            messageID: string;
            parts: ReturnType<typeof createInternalAgentTextPart>[];
          };
        },
    );
  const parentParts = () =>
    prompts()
      .filter(({ path }) => path.id === 'parent')
      .map(({ body }) => body.parts[0]);
  expect(parentParts()).toHaveLength(1);
  const notice = parentParts()[0];
  expect(notice.text).toContain(
    'test/primary failed: rate limit\nContinuing on test/fallback. Do not revive or cancel; wait for the result.',
  );
  expect(notice.text).toContain('<task id="child" state="running">');
  expect(notice.text).toContain(
    'Background task continues on a fallback model: ordinary task',
  );
  expect(isInternalInitiatorPart(notice)).toBe(true);
  expect(isNativeBackgroundTaskNotification(notice)).toBe(false);
  h.setBusy(true);
  await h.busySignal();
  const reconcile = spyOn(h.gate, 'reconcile');
  cleanups.push(async () => {
    reconcile.mockRestore();
  });
  await h.hooks['chat.message']?.(
    {
      sessionID: 'parent',
      agent: 'orchestrator',
      messageID: 'notice',
    } as never,
    { parts: [notice] } as never,
  );
  await h.hooks['experimental.chat.messages.transform']?.({}, {
    messages: [
      {
        info: {
          id: 'notice',
          role: 'user',
          agent: 'orchestrator',
          sessionID: 'parent',
        },
        parts: [notice],
      },
    ],
  } as never);
  expect(reconcile).not.toHaveBeenCalled();
  expect(h.board.get('child')?.state).toBe('running');
  const replay = prompts().filter(({ path }) => path.id === 'child')[0].body;
  h.history.push(
    { info: { id: replay.messageID, role: 'user' }, parts: replay.parts },
    ...transcript().data,
  );
  h.setBusy(false);
  await h.idle();
  await h.runtime.reconcile();
  await flush();
  expect(h.board.get('child')?.state).toBe('completed');
  expect(parentParts()).toHaveLength(2);
  expect(parentParts()[1].text).toContain(
    '<task_result>\nconfirmed result\n</task_result>',
  );
  expect(
    parentParts().every(
      ({ text }) => !text.includes('Background task failed:'),
    ),
  ).toBe(true);
  await h.runtime.reconcile();
  await flush();
  expect(parentParts()).toHaveLength(2);
});

test('a managed background child keeps its failover error deferred through polling', async () => {
  const h = await fallbackAssembly();
  await h.hooks['tool.execute.before']?.(
    { tool: 'task', sessionID: 'child', callID: 'nested' },
    { args: undefined },
  );
  await h.fail();
  expect(h.taskHook.hasDeferredError('child')).toBe(true);
  await h.idle();
  await h.runtime.reconcile();
  expect(h.board.get('child')).toMatchObject({
    state: 'running',
    terminalRevision: 0,
    statusUncertain: false,
  });
  h.messages.mockImplementation(async () => ({ data: [] }));
  await h.advance(2000);
  await h.advance(2000);
  expect(h.board.get('child')?.resultSummary).toContain(
    'Model fallback did not recover',
  );
});

function publicationOf(h: Assembly) {
  const publication = h.board.get('child');
  if (publication?.completedAt === undefined)
    throw new Error('missing publication');
  expect(publication.state).toBe('completed');
  return publication;
}
async function complete(h: Assembly) {
  await h.begin();
  await h.after('completed');
  return publicationOf(h);
}
async function completeWhileBusy(h: Assembly) {
  await h.begin();
  const oldTranscript = transcript();
  const held = deferred<unknown>();
  h.messages.mockImplementationOnce(() => held.promise);
  const completion = h.after('completed');
  await flush();
  expect(h.messages).toHaveBeenCalledTimes(1);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  h.setBusy(true);
  const activityAt = Date.now();
  // Keep the pre-publication case distinct from the equality boundary.
  await Bun.sleep(2);
  held.resolve(oldTranscript);
  await completion;
  const publication = publicationOf(h);
  expect(activityAt).toBeLessThan(publication.completedAt);
  return { publication, activityAt };
}
function expectReopened(h: Assembly, publication: BackgroundJobRecord) {
  expect(h.board.get('child')).toMatchObject({
    state: 'running',
    generation: publication.generation,
    terminalRevision: publication.terminalRevision + 1,
    resultSummary: undefined,
  });
}

test('regression: unconfirmed native call with evidence timeout must remain unconfirmed until attributable evidence arrives', async () => {
  const timers = createTimerHarness();
  const h = await assembly(undefined, {
    configOverrides: { concurrency: { defaultConcurrency: 5 } },
    gateOptions: {
      readTimeoutMs: 10,
      graceMs: 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  });
  await h.requestTask('call-1', 'task one');
  await h.requestTask('call-2', 'task two');

  await h.event('session.created', {
    info: {
      id: 'child-1',
      parentID: 'parent',
      agent: 'explorer',
      title: 'task one',
    },
  });

  const readBegun = Promise.withResolvers<void>();
  const heldTranscript = Promise.withResolvers<unknown>();
  h.messages.mockImplementation(() => {
    readBegun.resolve();
    return heldTranscript.promise;
  });

  // Real tool.execute.after arrives without exact tool call ID match:
  // identity-recovery path takes pending by taskID, supplying callIDConfirmed: false.
  const afterHook = h.hooks['tool.execute.after']?.(
    {
      tool: 'task',
      sessionID: 'parent',
      callID: undefined as unknown as string,
    },
    {
      output:
        'task_id: child-1\nstate: completed\n<task_result>foreign stale text</task_result>',
    },
  );

  // Deterministically wait for read to begin, then advance timer harness past readTimeoutMs
  await readBegun.promise;
  await timers.advance(10);
  await timers.tick();
  await afterHook;

  await h.idle();
  await flush();

  // Unconfirmed native output must NOT publish before attributable host/transcript evidence arrives.
  expect(h.board.get('child-1')?.state).toBe('running');
  expect(h.board.get('child-1')?.resultSummary).not.toBe('foreign stale text');

  // Attributable transcript evidence arrives
  heldTranscript.resolve({
    data: [
      { info: { id: 'msg-u', role: 'user' }, parts: [] },
      {
        info: {
          id: 'msg-a',
          role: 'assistant',
          time: { completed: Date.now() },
          finish: 'stop',
        },
        parts: [{ type: 'text', text: 'attributable transcript result' }],
      },
    ],
  });
  const record = h.board.get('child-1');
  if (record) {
    await h.gate.reconcile(record);
  }
  await flush();

  expect(h.board.get('child-1')?.state).toBe('completed');
  expect(h.board.get('child-1')?.resultSummary).toBe(
    'attributable transcript result',
  );
});

test('positive control: confirmed native call with evidence timeout publishes confirmed result', async () => {
  const timers = createTimerHarness();
  const h = await assembly(undefined, {
    gateOptions: {
      readTimeoutMs: 10,
      graceMs: 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  });
  await h.requestTask('confirmed-call', 'confirmed task');
  await h.event('session.created', {
    info: { id: 'child-confirmed', parentID: 'parent', agent: 'explorer' },
  });

  const readBegun = Promise.withResolvers<void>();
  const heldTranscript = Promise.withResolvers<unknown>();
  h.messages.mockImplementation(() => {
    readBegun.resolve();
    return heldTranscript.promise;
  });

  const afterHook = h.hooks['tool.execute.after']?.(
    { tool: 'task', sessionID: 'parent', callID: 'confirmed-call' },
    {
      output:
        'task_id: child-confirmed\nstate: completed\n<task_result>confirmed native text</task_result>',
    },
  );

  await readBegun.promise;
  await timers.advance(10);
  await timers.tick();
  await afterHook;

  await h.idle();
  await flush();

  expect(h.board.get('child-confirmed')?.state).toBe('completed');
  expect(h.board.get('child-confirmed')?.resultSummary).toBe(
    'confirmed native text',
  );
  heldTranscript.resolve({ data: [] });
});

test('regression: idle-with-busy-host must query status and publish nothing', async () => {
  const h = await assembly();
  await h.begin();
  await h.after('running');
  h.setBusy(true);
  h.status.mockClear();
  const terminal = mock(() => {});
  h.board.addTerminalOutcomeListener(terminal);
  await h.idle();
  await flush();
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(h.board.get('child')?.state).toBe('running');
  expect(terminal).not.toHaveBeenCalled();
});

test.each(['missing outcome', 'lookup failure'])(
  'final idle without status retries a transient %s and releases capacity without another signal',
  async (failure) => {
    const h = await assembly(undefined, {
      statusAvailable: false,
      graceMs: 20,
    });
    await h.begin();
    await h.after('running');
    h.get.mockClear();
    h.get.mockImplementationOnce(async () => {
      if (failure === 'lookup failure')
        throw new Error('temporarily unavailable');
      return { data: { parentID: 'parent' } };
    });
    const release = spyOn(BackgroundTaskConcurrency.prototype, 'releaseTask');
    cleanups.push(async () => {
      release.mockRestore();
    });
    let admitted = false;
    const extra = h.requestTask('extra', 'queued before final idle').then(
      () => {
        admitted = true;
      },
      () => {},
    );
    await flush();
    expect(admitted).toBe(false);
    await h.idle();
    await flush();
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.board.get('child')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    expect(release).not.toHaveBeenCalled();
    // No more host events, transforms or manual gate reconciliations.
    for (let i = 0; i < 100 && h.board.get('child')?.state === 'running'; i++)
      await Bun.sleep(2);
    expect(h.board.get('child')).toMatchObject({
      state: 'completed',
      terminalRevision: 1,
      resultSummary: 'confirmed result',
    });
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.status).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    await extra;
    expect(admitted).toBe(true);
  },
);

test('regression: native-after-releases-reopened-run releases once and retains capacity', async () => {
  const h = await assembly();
  await h.begin();
  const release = spyOn(BackgroundTaskConcurrency.prototype, 'releaseTask');
  cleanups.push(async () => {
    release.mockRestore();
  });
  h.board.addTerminalOutcomeListener((record) => {
    const token = h.gate.capture(record);
    if (!token) throw new Error('missing current publication observation');
    h.gate.observe(token, {
      kind: 'busy',
      origin: 'session.status',
      readStartedAt: token.readStartedAt,
    });
  });
  await h.after('completed');
  let extraTaskAdmitted = false;
  const pending = h.requestTask('extra', 'extra');
  void pending?.then(
    () => {
      extraTaskAdmitted = true;
    },
    () => {},
  );
  await flush();
  expect(h.board.get('child')?.state).toBe('running');
  expect(
    release.mock.calls.filter(([taskID]) => taskID === 'child'),
  ).toHaveLength(1);
  expect(extraTaskAdmitted).toBe(false);
});

test('untimestamped busy needs a runtime contrast; reception alone cannot reopen', async () => {
  const h = await assembly();
  await complete(h);
  h.status.mockClear();
  await h.busySignal();
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(h.board.get('child')?.state).toBe('completed');
  h.setBusy(true);
  await h.busySignal();
  expect(h.board.get('child')?.state).toBe('running');
});

test('busy during transcript read delivered after commit triggers a fresh runtime contrast', async () => {
  const h = await assembly();
  const { publication, activityAt } = await completeWhileBusy(h);
  h.status.mockClear();
  await h.busySignal(activityAt);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expectReopened(h, publication);
});

test('busy at the exact publication timestamp triggers a runtime contrast', async () => {
  const h = await assembly();
  const publication = await complete(h);
  h.setBusy(true);
  h.status.mockClear();
  await h.busySignal(publication.completedAt);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expectReopened(h, publication);
});

test.each(['open', 'timed-out'] as const)(
  'deferred contrast survives collision with held polling and repairs without another signal (%s)',
  async (readState) => {
    const h = await assembly(undefined, {
      statusTimeoutMs: readState === 'timed-out' ? 1 : undefined,
    });
    const { publication, activityAt } = await completeWhileBusy(h);
    h.status.mockClear();
    const releaseStatus = h.holdStatus();
    // Drive the real polling pass, with its pre-event observation token.
    const polling = h.runtime.reconcile();
    await flush();
    expect(h.status).toHaveBeenCalledTimes(1);
    await h.busySignal(activityAt);
    expect(h.board.get('child')).toMatchObject({
      state: 'completed',
      terminalRevision: publication.terminalRevision,
    });
    expect(h.status).toHaveBeenCalledTimes(1);

    if (readState === 'timed-out') {
      await polling;
      expect(h.board.get('child')?.state).toBe('completed');
      expect(h.status).toHaveBeenCalledTimes(1);
    }
    releaseStatus();
    await polling;
    // No further event, tool call or manual reconciliation may drive recovery.
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
    expectReopened(h, publication);
  },
);

test('busy during the fresh gate read retains contrast through both read registries', async () => {
  const h = await assembly();
  const { publication, activityAt } = await completeWhileBusy(h);
  h.status.mockClear();
  const releasePolling = h.holdStatus();
  const releaseGateRead = h.holdStatus();
  const polling = h.runtime.reconcile();
  await flush();
  expect(h.status).toHaveBeenCalledTimes(1);
  await h.busySignal(activityAt);
  expect(h.status).toHaveBeenCalledTimes(1);
  releasePolling();
  await polling;
  await flush();
  expect(h.status).toHaveBeenCalledTimes(2);
  expect(h.statusMetrics.activeReads).toBe(1);

  // This signal invalidates the fresh gate read while it is still open.
  await h.busySignal(activityAt);
  expect(h.status).toHaveBeenCalledTimes(2);
  expect(h.board.get('child')).toMatchObject({
    state: 'completed',
    terminalRevision: publication.terminalRevision,
  });
  releaseGateRead();
  // Recovery must not require another event, tool call or manual reconcile.
  await flush();
  expect(h.status).toHaveBeenCalledTimes(3);
  expect(h.statusMetrics).toEqual({ activeReads: 0, maxActiveReads: 1 });
  expectReopened(h, publication);
});

test('historical busy with a quiescent host contrasts without withdrawing the publication', async () => {
  const h = await assembly();
  const publication = await complete(h);
  const activityAt = publication.lastLiveBusyAt ?? publication.runStartedAt;
  expect(activityAt).toBeLessThanOrEqual(publication.completedAt);
  h.setBusy(false);
  h.status.mockClear();
  const terminal = mock(() => {});
  h.board.addTerminalOutcomeListener(terminal);
  await h.busySignal(activityAt);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(h.board.get('child')).toMatchObject({
    state: 'completed',
    generation: publication.generation,
    terminalRevision: publication.terminalRevision,
    activityRevision: publication.activityRevision,
    resultSummary: publication.resultSummary,
  });
  expect(terminal).not.toHaveBeenCalled();
});

test('initialization failure disposes the gate owned by the production assembly', async () => {
  let assertDisposed: (() => Promise<void>) | undefined;
  await expect(
    assembly((board, gate) => {
      const run = board.registerLaunch({
        taskID: 'child',
        parentSessionID: 'parent',
        agent: 'explorer',
      });
      const token = gate.capture(run);
      if (!token) throw new Error('missing initial observation');
      const dispose = spyOn(gate, 'dispose');
      cleanups.push(async () => {
        dispose.mockRestore();
      });
      assertDisposed = async () => {
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(gate.capture(run)).toBeUndefined();
        expect(
          gate.observe(token, {
            kind: 'quiescent',
            origin: 'session.status',
            readStartedAt: token.readStartedAt,
          }),
        ).toEqual({ kind: 'stale' });
        expect(await gate.reconcile(run)).toEqual({ kind: 'stale' });
        expect(board.get(run.taskID)?.state).toBe('running');
      };
      throw new Error('forced assembly initialization failure');
    }),
  ).rejects.toThrow('forced assembly initialization failure');
  if (!assertDisposed) throw new Error('failure injection was not reached');
  await assertDisposed();
});

test.each(['dispose', 'event'] as const)(
  'regression: shared-gate-after-dispose through production %s',
  async (path) => {
    const h = await assembly();
    await h.begin();
    await h.after('running');
    const held = deferred<unknown>();
    h.messages.mockImplementationOnce(() => held.promise);
    const terminal = mock(() => {});
    h.board.addTerminalOutcomeListener(terminal);
    const run = h.board.get('child');
    if (!run) throw new Error('missing child run');
    const pending = h.gate.reconcile(run);
    await flush();
    expect(held.resolve).toBeFunction();
    expect(h.messages).toHaveBeenCalledTimes(1);
    if (path === 'dispose') await h.hooks.dispose?.();
    else await h.event('server.instance.disposed');
    held.resolve(transcript());
    await pending;
    await flush();
    expect(terminal).not.toHaveBeenCalled();
    expect(h.board.get('child')?.state).not.toBe('completed');
    expect(h.gate.capture({ taskID: 'child', generation: 1 })).toBeUndefined();
  },
);

test('regression: terminal-context-not-attached consolidates and prunes ordinary tasks', async () => {
  const h = await assembly();
  await h.begin();
  await h.after('running');
  await h.hooks['tool.execute.after']?.(
    { tool: 'read', sessionID: 'child', callID: 'read' },
    { output: `<path>${h.directory}/source.ts</path>\n1: first\n2: second` },
  );
  const trackerFiles = h.taskHook.contextFilesForTask('child');
  expect(trackerFiles).toHaveLength(1);
  h.prune.mockClear();
  await h.idle();
  await flush();
  expect(h.board.get('child')?.state).toBe('completed');
  expect(h.board.get('child')?.contextFiles).toEqual(trackerFiles);
  expect(h.prune).toHaveBeenCalledTimes(1);
  h.board.drop('child');
  h.taskHook.pruneTaskContext();
  expect(h.taskHook.contextFilesForTask('child')).toEqual([]);
});
