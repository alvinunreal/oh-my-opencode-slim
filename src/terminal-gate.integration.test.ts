import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as hookFactories from './hooks';
import { isVolatileTaggedMessage } from './hooks/cache-safe-injection';
import { resetOrchestratorWakeGateForTests } from './hooks/orchestrator-wake/wake-gate';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from './hooks/task-session-manager/board-injection';
import type { RevivedRunTracker } from './hooks/task-session-manager/revived-run-tracker';
import * as runtimeFactories from './hooks/task-session-manager/runtime-status-reconciliation';
import { OhMyOpenCodeLite as plugin } from './index';
import type { BackgroundJobRecord } from './utils/background-job-board';
import type { BackgroundJobCoordinator } from './utils/background-job-coordinator';
import * as gateFactories from './utils/background-job-terminal-gate';
import { BackgroundTaskConcurrency } from './utils/background-task-concurrency';
import * as loggerModule from './utils/logger';
import { buildPluginInput } from './v2/client-shim';
import { mapV2EventToV1 } from './v2/event-adapter';

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
    board: BackgroundJobCoordinator,
    gate: gateFactories.BackgroundJobTerminalGate,
  ) => void,
  setup: {
    statusTimeoutMs?: number;
    statusAvailable?: boolean;
    graceMs?: number;
    /** Whole-client replacement (v2 shim-shaped hosts). Suppresses the
     * default v1 client so capability probes see honest method absence. */
    client?: unknown;
    /** Host flavor stamp forwarded to the plugin input exactly as the v2
     * client shim does (`buildPluginInput` stamps `hostFlavor: 'v2'`). */
    hostFlavor?: string;
    /** Flat `backgroundJobs` config overrides merged into the written
     * config file (e.g. orchestrator-wake knobs for wake-sensitive
     * fixtures). */
    configOverrides?: Record<string, unknown>;
    /** Build the gate WITHOUT the production `hostOutcomeClock`
     * contract, pinning the #1225 dependency: no shared clock, no
     * attribution window, no host-outcome publication. */
    withoutHostOutcomeClock?: boolean;
  } = {},
) {
  const env = { ...process.env };
  const directory = await mkdtemp('/tmp/slim-terminal-assembly-');
  process.env.OPENCODE_CONFIG_DIR = directory;
  process.env.XDG_CONFIG_HOME = directory;
  process.env.XDG_DATA_HOME = directory;
  process.env.XDG_CACHE_HOME = directory;
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  await Bun.write(
    `${directory}/oh-my-opencode-slim.json`,
    JSON.stringify({
      backgroundJobs: {
        concurrency: { defaultConcurrency: 1 },
        readContextMinLines: 1,
        ...(setup.configOverrides ?? {}),
      },
    }),
  );
  let board!: BackgroundJobCoordinator;
  let gate!: gateFactories.BackgroundJobTerminalGate;
  let taskHook!: ReturnType<typeof hookFactories.createTaskSessionManagerHook>;
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
    board = options.backgroundJobBoard as BackgroundJobCoordinator;
    gate = originalGate({
      ...options,
      graceMs: setup.graceMs ?? options.graceMs,
      ...(setup.withoutHostOutcomeClock ? { hostOutcomeClock: undefined } : {}),
    });
    return gate;
  });
  const originalHook = hookFactories.createTaskSessionManagerHook;
  let prune!: ReturnType<typeof spyOn>;
  const hookSpy = spyOn(
    hookFactories,
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
  const session = new Proxy(
    {
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
  // v2 shim-shaped hosts replace the client wholesale; the default v1
  // client (with a live session.status) stays for every other test.
  const client = setup.client ?? builtClient;
  const instance: { hooks?: Awaited<ReturnType<typeof plugin>> } = {};
  cleanups.push(async () => {
    await instance.hooks?.dispose?.();
    prune?.mockRestore();
    hookSpy.mockRestore();
    gateSpy.mockRestore();
    runtimeSpy.mockRestore();
    process.env = env;
    await rm(directory, { recursive: true, force: true });
  });
  const hooks = await plugin({
    client,
    directory,
    worktree: directory,
    serverUrl: new URL('http://127.0.0.1:4096'),
    ...(setup.hostFlavor ? { hostFlavor: setup.hostFlavor } : {}),
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

// ── Task 3.5: adapter-driven starvation reproduction (live incident) ──
//
// Live 2.0.8 incident (verified twice): a background child whose host
// had already committed `Session.Info.idle_outcome='succeeded'` at idle
// time never received a terminal publication — the board stayed
// `running, status uncertain` until `EVIDENCE_UNAVAILABLE` exhausted
// its retry budget. This drives the REAL chain, not hand-fed v1 shapes:
// raw v2 events pumped through `mapV2EventToV1`, every product (raw
// first, then the synthesized v1 shapes) dispatched to the production
// event hook in the same order as the v2 pump in `src/v2/setup.ts`,
// against a shim-shaped client — no `session.status`, no
// `session.list`, no `session.messages`; `session.get` returns the
// v2 `Session.Info` with `outcome` + `time.idle` (the envelope
// `outcomeFromRead`/`attributableHostOutcome` unwraps; the production
// assembly already wires `hostOutcomeClock: 'shared-unix-ms'` in
// src/index.ts, and the assembly's gate spy spreads it through).
//
// Attribution timing: the gate binds `Date.now` at CONSTRUCTION, so a
// frozen Date.now mock would desynchronize the attribution window from
// the timestamps the fixture controls. Instead everything shares the
// real clock, and the fixture enforces strict ordering (>=2ms sleeps)
// between the three boundaries the window compares —
// runStartedAt/lastLiveBusyAt (the execution envelope's `created`) <
// the host-committed `time.idle` <= the gate's read completion — so
// no rejection boundary can fire spuriously.

/** v2 host probe: shim-shaped client + the host-side outcome commit. */
interface V2HostProbe {
  client: unknown;
  /** Host commits idle_outcome when it publishes the terminal
   * execution event (live-verified: outcome already set at idle). */
  commitTerminalOutcome(idleAt: number): void;
  readonly get: ReturnType<typeof mock>;
  /** Present ONLY on hosts that expose a transcript source; the
   * starving shim shape (live incident) has none at all. */
  readonly messages?: ReturnType<typeof mock>;
  /** The wake surface's promptAsync mock (present only when
   * `wakeSurface` was requested — live v2 hosts expose it via the
   * client shim). */
  readonly promptAsync?: ReturnType<typeof mock>;
}

function v2ShimClient(options: {
  outcome: string;
  /** Transcript source: a host that exposes `session.messages`.
   * Omitted by default — honest method absence on the session. */
  transcript?: () => unknown;
  /** Probe: keep `session.get` reporting the running shape (no
   * outcome/idle) for the first N reads even after the host committed
   * its terminal outcome; reveal it only on read N+1 onward. */
  hideOutcomeForReads?: number;
  /** Live-v2 wake surface: `session.list` + `session.promptAsync`, the
   * exact pair the client shim exposes and `probeSessionApis` requires
   * for the v2 wake capability. Absent by default — the starving shim
   * shape (live incident) exposes neither, so the wake capability must
   * stay honestly not-ready there. `listChildren` is re-evaluated on
   * every list call so host-side state changes (running → terminal)
   * surface like a live host. */
  wakeSurface?: {
    listChildren?: () => Array<Record<string, unknown>>;
    promptAsync?: ReturnType<typeof mock>;
  };
}): V2HostProbe {
  const host = {
    outcome: options.outcome,
    idleAt: undefined as number | undefined,
  };
  let reads = 0;
  const get = mock(async (_args: unknown): Promise<unknown> => {
    reads += 1;
    // v2 Session.Info carries `outcome`/`time.idle` only after the
    // terminal transition; a running child has neither. The probe delay
    // hides the committed transition from the first N reads.
    const visible =
      host.idleAt !== undefined && reads > (options.hideOutcomeForReads ?? 0);
    return {
      data: visible
        ? {
            parentID: 'parent',
            outcome: host.outcome,
            time: { idle: host.idleAt },
          }
        : { parentID: 'parent' },
    };
  });
  const messages = options.transcript
    ? mock(async (_args: unknown): Promise<unknown> => options.transcript?.())
    : undefined;
  const promptAsync =
    options.wakeSurface?.promptAsync ?? mock(async () => ({}));
  // Shim shape: ONLY session.get (plus the optional transcript source
  // and wake surface). `session` is a plain object so absent methods
  // stay absent (capability probes must see honest absence, never an
  // auto-filled stub); other client domains still degrade through the
  // outer proxy like the v1 assembly default.
  const session = {
    get,
    ...(messages ? { messages } : {}),
    ...(options.wakeSurface
      ? {
          list: mock(async () => ({
            data: options.wakeSurface?.listChildren?.() ?? [],
          })),
          promptAsync,
        }
      : {}),
  };
  const client = new Proxy(
    { session, app: { log: async () => ({}) } },
    {
      get: (target, key) =>
        Reflect.get(target, key) ??
        new Proxy({}, { get: () => async () => ({ data: [] }) }),
    },
  );
  return {
    client,
    get,
    ...(messages ? { messages } : {}),
    ...(options.wakeSurface ? { promptAsync } : {}),
    commitTerminalOutcome(idleAt: number) {
      host.idleAt = idleAt;
    },
  };
}

type V2RawEventSpec = {
  type: string;
  data: Record<string, unknown>;
};

async function driveV2Lifecycle(
  probe: V2HostProbe,
  events: V2RawEventSpec[],
  setup: { withoutHostOutcomeClock?: boolean } = {},
): Promise<BackgroundJobCoordinator> {
  const childID = String(
    events.find((event) => event.type === 'session.created')?.data.sessionID ??
      events[0]?.data.sessionID ??
      'child',
  );
  const h = await assembly(undefined, {
    graceMs: 20,
    client: probe.client,
    withoutHostOutcomeClock: setup.withoutHostOutcomeClock,
  });
  const dispatch = async (event: Record<string, unknown>) => {
    await h.hooks.event?.({ event } as never);
  };
  // The real chain: the host's task tool call returns after the child
  // session exists (pending call → session.created → tool.execute.after
  // with a running-state output), then the durable v2 lifecycle runs.
  // Each step sleeps >=2ms so the host timestamps it stamps stay
  // strictly ordered (run start < busy activity < committed idle).
  await h.requestTask('native', 'v2 adapter lifecycle probe');
  let notifiedToolReturn = false;
  for (const spec of events) {
    await Bun.sleep(2);
    if (
      spec.type !== 'session.execution.started' &&
      spec.type.startsWith('session.execution.')
    )
      probe.commitTerminalOutcome(Date.now());
    const raw: Record<string, unknown> = {
      id: `evt-${spec.type}-${String(spec.data.sessionID ?? '')}`,
      created: Date.now(),
      type: spec.type,
      data: spec.data,
    };
    // Production pump order (src/v2/setup.ts): raw event first, then
    // every synthesized v1 shape, each through the real event hook.
    for (const event of mapV2EventToV1(raw)) await dispatch(event);
    await flush();
    // After the child is registered, the host's task tool call returns
    // a running-state output (background:true registration + the
    // native running candidate signal), before execution starts.
    if (spec.type === 'session.created' && !notifiedToolReturn) {
      notifiedToolReturn = true;
      await Bun.sleep(2);
      await h.after('running');
      await flush();
    }
  }
  // Let the gate's evidence-retry schedule (graceMs-bounded timers)
  // run to publication or exhaustion, whichever comes first; real time
  // advancing past the quiescence grace keeps the stable branches live
  // rather than accidentally skipped.
  for (let i = 0; i < 200 && h.board.get(childID)?.state === 'running'; i++) {
    await Bun.sleep(5);
  }
  return h.board;
}

// verdict A (un-skipped by the starvation-fix task): reproduces the live
// v2 starvation — attributed host success + no transcript source.
test('v2 lifecycle through the real adapter terminalizes a completed child', async () => {
  const capture = captureGateLogs();
  try {
    const probe = v2ShimClient({ outcome: 'succeeded' });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'child' } },
    ]);
    expect(board.get('child')).toMatchObject({
      state: 'completed',
      resultSummary: 'Host reported outcome: succeeded.',
    });
    // The publication must flow through the instrumented commit path:
    // Task 2's INFO log with host-outcome attribution.
    const published = capture.of('[terminal-gate] terminal published', 'child');
    expect(published).toHaveLength(1);
    expect(published[0]?.data).toMatchObject({
      taskID: 'child',
      state: 'completed',
      attribution: 'host-outcome',
      parentSessionID: 'parent',
    });
  } finally {
    capture.restore();
  }
});

// ── Starvation-fix guards (fences around the early-publish path) ──
//
// The fix commits `completed` from a window-attributed host success ONLY
// when the transcript SOURCE is absent (capability: no session.messages).
// Source-unavailable ≠ pending: a host that HAS a source whose transcript
// is still unfinalized must keep waiting exactly as before, and an
// outcome the #1225 window cannot attribute to this run authorizes
// nothing even with no transcript source at all.

function captureGateLogs() {
  const entries: Array<{ message: string; data: unknown }> = [];
  const spy = spyOn(loggerModule, 'log').mockImplementation(
    (message: string, data?: unknown) => {
      entries.push({ message, data });
    },
  );
  return {
    of: (message: string, taskID: string) =>
      entries.filter(
        (entry) =>
          entry.message === message &&
          (entry.data as { taskID?: string } | undefined)?.taskID === taskID,
      ),
    /** Every captured line (cache-monitor warnings key on sessionID, not
     * taskID, so they are unreachable through `of`). */
    all: () => entries.slice(),
    restore: () => spy.mockRestore(),
  };
}

test('guard: attributed success with a real pending transcript never early-publishes', async () => {
  const capture = captureGateLogs();
  try {
    // The ONLY capability delta from the starving shim: this host
    // exposes a transcript source. Its transcript is genuinely
    // unfinalized (trailing assistant still on tool-calls), so no
    // amount of waiting could ever justify inventing a result.
    const probe = v2ShimClient({
      outcome: 'succeeded',
      transcript: () => ({
        data: [
          {
            info: { id: 'turn', role: 'assistant', finish: 'tool-calls' },
            parts: [{ type: 'text', text: 'streaming' }],
          },
        ],
      }),
    });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'child' } },
    ]);
    // The source was consulted and the host outcome WAS attributed
    // (accepted, succeeded) — the guard is not accidentally passing
    // because the outcome read never happened.
    expect(probe.messages).toHaveBeenCalled();
    const attributions = capture.of(
      '[terminal-gate] host-outcome attribution',
      'child',
    );
    expect(attributions.length).toBeGreaterThan(0);
    expect(attributions[attributions.length - 1]?.data).toMatchObject({
      outcome: 'succeeded',
      verdict: 'accepted',
    });
    // ...and still nothing may publish off a pending transcript.
    expect(board.get('child')?.state).toBe('running');
    expect(capture.of('[terminal-gate] terminal published', 'child')).toEqual(
      [],
    );
  } finally {
    capture.restore();
  }
});

test('guard: unattributable succeeded outcome with no transcript source publishes nothing', async () => {
  const capture = captureGateLogs();
  try {
    const probe = v2ShimClient({ outcome: 'succeeded' });
    const hostCommit = probe.commitTerminalOutcome;
    // The host committed its success well before this run started (a
    // historical idle): the #1225 window must reject it, and capability
    // absence may not substitute for attribution.
    const historical = {
      ...probe,
      commitTerminalOutcome: (idleAt: number) => hostCommit(idleAt - 60_000),
    };
    const board = await driveV2Lifecycle(historical, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'child' } },
    ]);
    const attributions = capture.of(
      '[terminal-gate] host-outcome attribution',
      'child',
    );
    expect(attributions.length).toBeGreaterThan(0);
    expect(attributions[attributions.length - 1]?.data).toMatchObject({
      verdict: 'rejected',
      reason: 'idle-not-after-window-lower',
    });
    expect(board.get('child')?.state).toBe('running');
    expect(capture.of('[terminal-gate] terminal published', 'child')).toEqual(
      [],
    );
  } finally {
    capture.restore();
  }
});

// ── Task 4 live gap: the REAL shim factory, not a hand-shaped session ──
//
// Live 2.0.8 verification (plugin log 2026-09-18T19:18/23:42) proved the
// hand-shaped `{get}`-only fixture above lied about the production client
// shape: at the time `buildPluginInput` ALWAYS defined `session.messages`
// (mapped from `session.context`, with a `{data: []}` fallback), so the
// gate's transcriptSourceAbsent predicate was false on every v2 host and
// the starvation-fix commit path was unreachable in production. The shim
// has since been corrected to expose `messages` ONLY when the host
// provides `session.context` (capability omission mirroring `get`), so
// the predicate reads honest capability absence and the host-outcome
// commit path is reachable exactly for genuinely source-absent hosts.
// The real starvation lived in the mapped transcript itself: the live
// probe child (DB-verified) ends with user → assistant(tool, finish
// tool-calls) → assistant(finish 'stop', time.completed set, text) → an
// `{type:'idle', outcome}` lifecycle marker, and the mapping reduced
// every entry to `{id, role}` — so the trailing-turn scan hit the
// non-assistant `idle` role and classification retried forever (4
// accepted host-outcome attributions, zero publications, gave-up). This
// probe builds the client through the REAL shim factory over a ctx
// mirroring the adapter session domain — `get` AND `context`, the latter
// returning full 2.0.8-shaped SessionMessage.Info entries — so the
// divergence is reproducible in vitro.

/** Live 2.0.8 transcript shape (from the starving probe child's durable
 * messages): user prompt, tool-calling assistant turn, final assistant
 * turn with terminal metadata, and the trailing idle marker. Timestamps
 * for the FINAL turn are read-time so they land after runStartedAt. */
function liveProbeTranscript(): Array<Record<string, unknown>> {
  const now = Date.now();
  return [
    {
      id: 'msg_user',
      type: 'user',
      time: { created: now - 9_000 },
      text: 'Live-verification probe: count the files. Reply PROBE-OK: <N>.',
    },
    {
      id: 'msg_turn1',
      type: 'assistant',
      agent: 'explorer',
      time: { created: now - 8_000, completed: now - 7_000 },
      finish: 'tool-calls',
      content: [
        {
          type: 'reasoning',
          text: 'Use glob with a non-recursive pattern.',
          state: { reasoningField: 'reasoning_content' },
          time: { created: now - 7_500, completed: now - 7_400 },
        },
        {
          type: 'tool',
          id: 'call_1',
          name: 'glob',
          executed: false,
          state: {
            status: 'completed',
            input: { pattern: 'src/utils/*.ts' },
            content: [{ type: 'text', text: 'a.ts\nb.ts' }],
          },
          time: { created: now - 7_300, completed: now - 7_200 },
        },
      ],
    },
    {
      id: 'msg_turn2',
      type: 'assistant',
      agent: 'explorer',
      time: { created: now, streamed: now, completed: now },
      finish: 'stop',
      content: [
        {
          type: 'reasoning',
          text: '55 entries.',
          state: { reasoningField: 'reasoning_content' },
          time: { created: now, completed: now },
        },
        { type: 'text', text: 'PROBE-OK: 55' },
      ],
    },
    {
      id: 'msg_idle',
      type: 'idle',
      time: { created: now },
      outcome: 'succeeded',
    },
  ];
}

/** Real-shim v2 host probe: the client comes from `buildPluginInput` —
 * the production v1-shaped client for v2 hosts — over a ctx with the
 * adapter session domain's `get` and (when `transcript` is given)
 * `context`. A ctx WITHOUT `context` models the context-less host: the
 * shim must omit `session.messages` entirely (capability absence), not
 * install a fake-empty stub. */
function realShimV2Client(options: {
  outcome: string;
  transcript?: () => Array<Record<string, unknown>>;
}): V2HostProbe & { contextCalls: () => number } {
  const host = {
    outcome: options.outcome,
    idleAt: undefined as number | undefined,
  };
  const get = mock(
    async (_args: unknown): Promise<unknown> => ({
      parentID: 'parent',
      // v2 Session.Info carries outcome/time.idle only after the terminal
      // transition (live-verified: already set at idle).
      ...(host.idleAt !== undefined
        ? { outcome: host.outcome, time: { idle: host.idleAt } }
        : {}),
    }),
  );
  let calls = 0;
  const input = buildPluginInput({
    location: { directory: '/proj', project: { id: 'proj_1' } },
    session: {
      get: async (_i: { sessionID: string }) => get({}),
      ...(options.transcript
        ? {
            context: async () => {
              calls += 1;
              return options.transcript?.();
            },
          }
        : {}),
    },
  } as never);
  return {
    client: input.client,
    get,
    contextCalls: () => calls,
    commitTerminalOutcome(idleAt: number) {
      host.idleAt = idleAt;
    },
  };
}

test('live gap: the real client shim publishes the transcript result of a completed child', async () => {
  const capture = captureGateLogs();
  try {
    const probe = realShimV2Client({
      outcome: 'succeeded',
      transcript: liveProbeTranscript,
    });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'child' } },
    ]);
    // The transcript source WAS consulted through the real shim
    // (session.messages → session.context), and the host outcome was
    // attributed — the live incident's exact preconditions.
    expect(probe.contextCalls()).toBeGreaterThan(0);
    const attributions = capture.of(
      '[terminal-gate] host-outcome attribution',
      'child',
    );
    expect(attributions.length).toBeGreaterThan(0);
    expect(attributions[attributions.length - 1]?.data).toMatchObject({
      outcome: 'succeeded',
      verdict: 'accepted',
    });
    // The mapped transcript must classify normally: the trailing idle
    // marker is skipped, the final assistant turn carries its terminal
    // metadata, and the child publishes with its REAL result text.
    expect(board.get('child')).toMatchObject({
      state: 'completed',
      resultSummary: 'PROBE-OK: 55',
    });
    const published = capture.of('[terminal-gate] terminal published', 'child');
    expect(published).toHaveLength(1);
    expect(published[0]?.data).toMatchObject({
      taskID: 'child',
      state: 'completed',
      attribution: 'transcript',
      parentSessionID: 'parent',
    });
  } finally {
    capture.restore();
  }
});

// The context-less complement of the live-gap probe above: a real-shim
// host whose session domain exposes `get` but NOT `context`. The shim
// used to install a fake-empty `messages` stub there (`{data: []}`),
// which the terminal gate read as "source present but empty" —
// classifier verdict `absent` → a baseline-less gen-1 child
// STOPPED_WITHOUT_TERMINAL_RESULT — while the window-attributed
// `succeeded` publish path (transcriptSourceAbsent = messages is not a
// function) stayed dead. With the stub omitted, capability absence is
// honest: the host-outcome publish path fires for genuinely
// source-absent hosts and the absent→STOP misroute is gone.
test('real shim on a context-less host omits messages: attributed success publishes via host-outcome, never stopped', async () => {
  const capture = captureGateLogs();
  try {
    const probe = realShimV2Client({ outcome: 'succeeded' });
    // The omitted-capability shape: no session.context → no
    // session.messages on the v1-shaped client the gate probes.
    const session = (probe.client as { session: Record<string, unknown> })
      .session;
    expect(typeof session.messages).toBe('undefined');
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'child' } },
    ]);
    const record = board.get('child');
    if (record?.completedAt === undefined)
      throw new Error('source-absent completion never published');
    // The window-attributed success publishes `completed` — not the
    // absent-evidence STOPPED_WITHOUT_TERMINAL_RESULT the fake-empty
    // stub produced.
    expect(record.state).toBe('completed');
    expect(record.state).not.toBe('stopped');
    expect(record.resultSummary).not.toContain('stopped without');
    const published = capture.of('[terminal-gate] terminal published', 'child');
    expect(published).toHaveLength(1);
    expect(published[0]?.data).toMatchObject({
      taskID: 'child',
      state: 'completed',
      attribution: 'host-outcome',
      parentSessionID: 'parent',
    });
  } finally {
    capture.restore();
  }
});

// ── Task 5: attribution guard-rails and interruption mapping ──
//
// Task 4's fix publishes from a window-attributed host outcome when the
// transcript source is absent. These pins lock the surrounding rails:
// the stop/interrupt family must not surface as a false error, a failed
// outcome must surface as an error with the host payload, the #1225
// attribution window must depend on the explicit hostOutcomeClock
// contract, and the post-exhaustion dead end stays recorded honestly.

test('guard: attributed interrupted outcome publishes from the stop/cancel family, never error', async () => {
  const capture = captureGateLogs();
  try {
    const probe = v2ShimClient({ outcome: 'interrupted' });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.interrupted', data: { sessionID: 'child' } },
    ]);
    const record = board.get('child');
    if (record?.completedAt === undefined)
      throw new Error('interrupted outcome never published');
    // The host distinguished an interruption from a failure; the board
    // vocabulary for a stop without a plugin-verified cancel lease is
    // the stop/cancel family — never a false 'error'.
    expect(['stopped', 'cancelled']).toContain(record.state);
    expect(record.state).not.toBe('error');
    const published = capture.of('[terminal-gate] terminal published', 'child');
    expect(published).toHaveLength(1);
    expect(published[0]?.data).toMatchObject({
      taskID: 'child',
      attribution: 'host-outcome',
      parentSessionID: 'parent',
    });
    expect(published[0]?.data).toMatchObject({ state: record.state });
  } finally {
    capture.restore();
  }
});

test('guard: attributed failed outcome publishes error and carries the host error payload', async () => {
  const capture = captureGateLogs();
  try {
    const probe = v2ShimClient({ outcome: 'failed' });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      {
        type: 'session.execution.failed',
        data: {
          sessionID: 'child',
          error: { message: 'host-side detonation payload' },
        },
      },
    ]);
    const record = board.get('child');
    if (record?.completedAt === undefined)
      throw new Error('failed outcome never published');
    expect(record.state).toBe('error');
    // The host's failure payload must reach the record's diagnostic
    // surface (the summary the parent reconciles against), never be
    // dropped in favor of a bare state label.
    expect(record.resultSummary).toContain('host-side detonation payload');
    const published = capture.of('[terminal-gate] terminal published', 'child');
    expect(published).toHaveLength(1);
    expect(published[0]?.data).toMatchObject({
      taskID: 'child',
      state: 'error',
      parentSessionID: 'parent',
    });
  } finally {
    capture.restore();
  }
});

test('guard: without the hostOutcomeClock contract the attribution window never opens and nothing publishes', async () => {
  const capture = captureGateLogs();
  try {
    const probe = v2ShimClient({ outcome: 'succeeded' });
    // The gate is built WITHOUT `hostOutcomeClock: 'shared-unix-ms'`
    // (the production wiring in src/index.ts is stripped by the
    // fixture): the host and plugin clocks are then not declared
    // comparable, so #1225's window must refuse to attribute even a
    // fresh outcome — capability absence may not publish anything.
    const board = await driveV2Lifecycle(
      probe,
      [
        {
          type: 'session.created',
          data: {
            sessionID: 'child',
            parentID: 'parent',
            agent: 'explorer',
          },
        },
        {
          type: 'session.execution.started',
          data: { sessionID: 'child' },
        },
        {
          type: 'session.execution.succeeded',
          data: { sessionID: 'child' },
        },
      ],
      { withoutHostOutcomeClock: true },
    );
    const attributions = capture.of(
      '[terminal-gate] host-outcome attribution',
      'child',
    );
    expect(attributions.length).toBeGreaterThan(0);
    expect(attributions[attributions.length - 1]?.data).toMatchObject({
      outcome: 'succeeded',
      verdict: 'rejected',
      reason: 'clock-not-comparable',
    });
    // Honest end state: the busy runtime observation is never
    // contradicted (no polling capability on the shim host), so the
    // board simply keeps deferring — running, never terminalized.
    expect(board.get('child')?.state).toBe('running');
    expect(board.get('child')?.completedAt).toBeUndefined();
    expect(capture.of('[terminal-gate] terminal published', 'child')).toEqual(
      [],
    );
  } finally {
    capture.restore();
  }
});

// probe: late-attributable outcome after exhaustion — dead end recorded; adjudication pending
//
// HONEST RESULT (fail — board stranded): the gate consults session.get
// only twice in this scenario (initial inspect + one follow-up), then
// never again — the busy runtime observation from the synthesized
// status event is never contradicted (no polling capability on the
// shim), and a rejected attribution leaves the busy defer path without
// a retry timer. Neither a later idle pair (deduped by the continuous
// idle guard, per the double-idle invariant) nor a later busy→idle
// contrast cycle re-arms an outcome read. The board stays `running`
// forever even with the outcome long since attributable.
test.skip('probe: late-attributable outcome after exhaustion terminalizes the stranded board', async () => {
  const capture = captureGateLogs();
  try {
    // The host commits its outcome on schedule, but session.get hides it
    // for the first 12 reads — far beyond the gate's evidence retry
    // budget (maxEvidenceRetries defaults to 3). The desired behavior:
    // once the outcome becomes attributable, SOMETHING (a timer, a
    // poll, a later reconcile trigger) picks it up and the board
    // terminalizes instead of staying stranded post-exhaustion.
    const probe = v2ShimClient({
      outcome: 'succeeded',
      hideOutcomeForReads: 12,
    });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'child' } },
    ]);
    expect(board.get('child')?.state).toBe('completed');
  } finally {
    capture.restore();
  }
});

// ── Task 7: reopen-after-reconcile full chain (CameraFTP pattern) ──
//
// The live pattern: a background child completes → the gate publishes →
// the parent consumes and reconciles the report → the child is later
// resumed by its own background-shell notification → runs again →
// completes again. This locks the WHOLE loop through the real chain:
// raw v2 envelopes pumped through `mapV2EventToV1` (the resume busy
// carries the host envelope `created` timestamp, so the gate's
// ambiguous-event demotion cannot pass vacuously), the parent's real
// request cycle (`experimental.chat.messages.transform`) performing the
// injection-time reconcile and the Task 6 reopen corrective notice, and
// the second publication firing the Task 6 terminal-publication wake
// for the idle parent through the production listener wiring.

/** Interactive v2 driver: the SAME production pump order as
 * `driveV2Lifecycle` (host outcome committed before terminal execution
 * events; raw event first, then every synthesized v1 shape, each through
 * the real event hook; the host task tool returns a running-state output
 * right after session.created), but controllable event-by-event so a
 * test can interleave parent request cycles and later runs. */
async function openV2Lifecycle(
  probe: V2HostProbe,
  setup: {
    hostFlavor?: string;
    configOverrides?: Record<string, unknown>;
  } = {},
) {
  const h = await assembly(undefined, {
    graceMs: 20,
    client: probe.client,
    ...(setup.hostFlavor ? { hostFlavor: setup.hostFlavor } : {}),
    ...(setup.configOverrides
      ? { configOverrides: setup.configOverrides }
      : {}),
  });
  let pumped = 0;
  let notifiedToolReturn = false;
  const dispatch = async (event: Record<string, unknown>) => {
    await h.hooks.event?.({ event } as never);
  };
  const pump = async (spec: V2RawEventSpec) => {
    pumped += 1;
    await Bun.sleep(2);
    if (
      spec.type !== 'session.execution.started' &&
      spec.type.startsWith('session.execution.')
    )
      probe.commitTerminalOutcome(Date.now());
    const raw: Record<string, unknown> = {
      id: `evt-${pumped}-${spec.type}-${String(spec.data.sessionID ?? '')}`,
      created: Date.now(),
      type: spec.type,
      data: spec.data,
    };
    // Production pump order (src/v2/setup.ts): raw event first, then
    // every synthesized v1 shape, each through the real event hook.
    for (const event of mapV2EventToV1(raw)) await dispatch(event);
    await flush();
    // After the child is registered, the host's task tool call returns
    // a running-state output, before execution starts.
    if (spec.type === 'session.created' && !notifiedToolReturn) {
      notifiedToolReturn = true;
      await Bun.sleep(2);
      await h.after('running');
      await flush();
    }
  };
  const awaitPublication = async (
    taskID: string,
    sinceRevision: number,
  ): Promise<BackgroundJobRecord> => {
    for (let i = 0; i < 400; i++) {
      const record = h.board.get(taskID);
      if (
        record &&
        record.state !== 'running' &&
        record.terminalRevision > sinceRevision
      )
        return record;
      await Bun.sleep(5);
    }
    throw new Error(
      `publication beyond revision ${sinceRevision} never landed`,
    );
  };
  return { h, pump, awaitPublication };
}

/** Terminal-part metadata of a message, when it has exactly one part
 * (same shape contract as the reopen-correction suite). */
function solePartMetadata(
  message: unknown,
): Record<string, unknown> | undefined {
  const parts = (message as { parts?: Array<Record<string, unknown>> })?.parts;
  if (parts?.length !== 1) return undefined;
  return parts[0]?.metadata as Record<string, unknown> | undefined;
}

test('reopen-after-reconcile: child self-continuation republishes, wakes the idle parent, and corrects the parent', async () => {
  resetOrchestratorWakeGateForTests();
  const capture = captureGateLogs();
  try {
    const promptAsync = mock(async () => ({}));
    // Live v2 host: get (host outcome) + the wake surface pair the v2
    // client shim exposes (list + promptAsync); transcript source absent
    // (the starving shim shape), so publication rides the attributed
    // host outcome on both runs.
    let hostChildren: Array<Record<string, unknown>> = [
      { id: 'child', parentID: 'parent' },
    ];
    const probe = v2ShimClient({
      outcome: 'succeeded',
      wakeSurface: {
        listChildren: () => hostChildren,
        promptAsync,
      },
    });
    const { h, pump, awaitPublication } = await openV2Lifecycle(probe, {
      hostFlavor: 'v2',
      // Schema floor (1s) instead of the 30s default so the SECOND
      // publication wake is observable without a half-minute sleep.
      configOverrides: {
        orchestratorWake: { publicationWakeMinIntervalMs: 1_000 },
      },
    });

    // Run 1: launch → execution → terminal → publication #1.
    await h.requestTask('native', 'v2 reopen chain probe');
    await pump({
      type: 'session.created',
      data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
    });
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const first = await awaitPublication('child', 0);
    expect(first).toMatchObject({ state: 'completed' });

    const wakingPublicationWakes = () =>
      capture
        .of('[orchestrator-wake] terminal publication wake', 'child')
        .filter(
          (entry) =>
            (entry.data as { verdict?: string } | undefined)?.verdict ===
            'waking',
        );
    const firstPublicationSkips = () =>
      capture
        .of('[orchestrator-wake] terminal publication wake skipped', 'child')
        .filter(
          (entry) =>
            (entry.data as { reason?: string } | undefined)?.reason ===
            'first-publication-native-owned',
        );

    // Wake #1 is the NATIVE notifier's: the first publication of the
    // original launch lineage is natively delivered even to an idle
    // parent, so the plugin wake must NOT fire for it (I1).
    await flush();
    await Bun.sleep(30);
    expect(wakingPublicationWakes()).toHaveLength(0);
    expect(firstPublicationSkips()).toHaveLength(1);
    expect(promptAsync).not.toHaveBeenCalled();

    // The parent consumes the report: two real request cycles (deliver,
    // then reconcile once the prompt shape advanced past the delivery).
    const userMsg = (id: string, text: string) => ({
      info: {
        id,
        sessionID: 'parent',
        role: 'user',
        agent: 'orchestrator',
        time: { created: Date.now() },
      },
      parts: [{ type: 'text', text }],
    });
    const assistantMsg = (id: string, text: string) => ({
      info: {
        id,
        sessionID: 'parent',
        role: 'assistant',
        time: { completed: Date.now() },
      },
      parts: [{ type: 'text', text }],
    });
    const requestCycle = async (messages: Array<Record<string, unknown>>) => {
      await h.hooks['experimental.chat.messages.transform']?.(
        {} as never,
        { messages } as never,
      );
      await flush();
    };
    await requestCycle([userMsg('u1', 'check the background result')]);
    await requestCycle([
      userMsg('u1', 'check the background result'),
      assistantMsg('a1', 'consumed the report'),
      userMsg('u2', 'next step'),
    ]);
    expect(h.board.getState('child')).toBe('reconciled');

    // Past the publication-wake throttle window (and strictly past every
    // host timestamp so far — the resume busy must be unambiguous).
    await Bun.sleep(1_100);

    // Run 2: the child's own background-shell notification resumes it.
    // The busy event rides the RAW v2 envelope (created = host time),
    // which mapV2EventToV1 preserves as activityAt — without it the
    // gate's ambiguous-event demotion would make this pass vacuously.
    hostChildren = [
      { id: 'child', parentID: 'parent', time: { updated: Date.now() } },
    ];
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    expectReopened(h, first);

    // The parent's next request cycle delivers EXACTLY ONE reopen
    // corrective notice (Task 6's injection-time detection), as a
    // trailing volatile message in the cache-safe tail zone.
    const correctedCycle = [userMsg('u3', 'meanwhile the child resumed')];
    await requestCycle(correctedCycle);
    const corrections = correctedCycle.filter(
      (message) => solePartMetadata(message)?.reopenCorrection === true,
    );
    expect(corrections).toHaveLength(1);
    const correction = corrections[0];
    expect(
      isVolatileTaggedMessage(correction, BACKGROUND_JOB_BOARD_METADATA_KEY),
    ).toBe(true);
    expect(correctedCycle.at(-1)).toBe(correction);
    const correctionText = (correction as { parts: Array<{ text: string }> })
      .parts[0].text;
    expect(correctionText).toContain('child');
    expect(correctionText).toContain('running again');
    expect(correctionText).toContain('superseded');
    // ...and never repeats on a later cycle.
    const laterCycle = [
      userMsg('u3', 'meanwhile the child resumed'),
      assistantMsg('a3', 'noted the correction'),
      userMsg('u4', 'carry on'),
    ];
    await requestCycle(laterCycle);
    expect(
      laterCycle.filter(
        (message) => solePartMetadata(message)?.reopenCorrection === true,
      ),
    ).toHaveLength(0);

    // Run 2 completes again: a second terminal publication for the SAME
    // generation (new attempt, advanced terminalRevision).
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const second = await awaitPublication('child', first.terminalRevision + 1);
    expect(second).toMatchObject({
      state: 'completed',
      generation: first.generation,
    });
    expect(
      capture.of('[terminal-gate] terminal published', 'child'),
    ).toHaveLength(2);

    // Wake #2: the second publication re-fires the Task 6 wake for the
    // idle parent — the queue delivery the CameraFTP loop depends on.
    await flush();
    await Bun.sleep(30);
    expect(wakingPublicationWakes()).toHaveLength(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const lastWakeCall = promptAsync.mock.calls.at(-1)?.[0] as {
      path?: { id?: string };
      delivery?: string;
      modelSelection?: string;
      body?: { agent?: string };
    };
    expect(lastWakeCall).toMatchObject({
      path: { id: 'parent' },
      delivery: 'queue',
      modelSelection: 'inherit',
    });
    expect(lastWakeCall?.body?.agent).toBe('orchestrator');
  } finally {
    capture.restore();
  }
});

// ── Final-review pin: exactly-once queued admission for a revived run ──
//
// A revived run (task_revive) is owned by the revived-run tracker: its
// completion is delivered to the parent by the tracker's notifyParent
// (a queued `<task>` notification via promptAsync). The publication-wake
// listener in src/index.ts fires for the SAME terminal publication — on
// an idle parent that wake passes its busy/throttle gates and would queue
// a SECOND admission. The wake must be suppressed when the tracker will
// deliver for that exact (taskID, generation); non-revived publications
// keep waking exactly once (regression pin below).

test('revived-run completion on an idle parent queues exactly one admission: the tracker delivery, no publication wake', async () => {
  resetOrchestratorWakeGateForTests();
  const capture = captureGateLogs();
  try {
    const promptAsync = mock(async () => ({}));
    let hostChildren: Array<Record<string, unknown>> = [
      { id: 'child', parentID: 'parent' },
    ];
    const probe = v2ShimClient({
      outcome: 'succeeded',
      wakeSurface: {
        listChildren: () => hostChildren,
        promptAsync,
      },
    });
    const { h, pump, awaitPublication } = await openV2Lifecycle(probe, {
      hostFlavor: 'v2',
      // Schema floor (1s) instead of the 30s default so the revived
      // publication sits past the throttle window without a
      // half-minute sleep (same shape as the reopen-chain probe above).
      configOverrides: {
        orchestratorWake: { publicationWakeMinIntervalMs: 1_000 },
      },
    });
    const tracker = h.revivedTracker;
    if (!tracker) {
      throw new Error('assembly did not expose the revived-run tracker');
    }

    // Run 1 (non-revived): the original launch the parent spawned.
    await h.requestTask('native', 'v2 revived-run double-admission probe');
    await pump({
      type: 'session.created',
      data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
    });
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const first = await awaitPublication('child', 0);
    expect(first).toMatchObject({ state: 'completed' });
    // Run 1 (non-revived): publication #1 is the lineage's first —
    // natively delivered, so the plugin wake stays suppressed (I1).
    await flush();
    await Bun.sleep(30);
    expect(
      capture
        .of('[orchestrator-wake] terminal publication wake skipped', 'child')
        .filter(
          (entry) =>
            (entry.data as { reason?: string } | undefined)?.reason ===
            'first-publication-native-owned',
        ),
    ).toHaveLength(1);
    expect(promptAsync).not.toHaveBeenCalled();

    // Past the publication-wake throttle window, revive the child: the
    // exact post-admission state task_revive leaves behind
    // (task-revive.ts registerLaunch + tracker.register) — the board
    // runs a NEW generation and the tracker owns observing it.
    await Bun.sleep(1_100);
    const lease = h.board.acquireRelaunchLease('child', first.generation);
    if (!lease) throw new Error('missing relaunch lease');
    const relaunched = h.board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'parent',
      agent: 'explorer',
      description: 'revived continuation',
      background: true,
      relaunchLease: lease,
    });
    h.board.releaseLease(lease);
    tracker.register({
      taskID: 'child',
      generation: relaunched.generation,
      parentSessionID: 'parent',
      description: 'revived continuation',
    });
    const sinceRevision = h.board.get('child')?.terminalRevision ?? 0;

    // The revived run executes and completes: the resume busy re-arms
    // the gate's observation (a bare second idle pair is deduped by the
    // continuous-idle guard), then the terminal event publishes.
    hostChildren = [
      { id: 'child', parentID: 'parent', time: { updated: Date.now() } },
    ];
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    // A fresh generation resets terminalRevision to 0; await the
    // terminal publication of the REVIVED generation explicitly.
    let second: BackgroundJobRecord | undefined;
    for (let i = 0; i < 400 && second === undefined; i++) {
      const record = h.board.get('child');
      if (
        record &&
        record.state !== 'running' &&
        record.generation === relaunched.generation &&
        record.terminalRevision > sinceRevision
      ) {
        second = record;
      } else {
        await Bun.sleep(5);
      }
    }
    if (!second) throw new Error('revived publication never landed');
    expect(second).toMatchObject({
      state: 'completed',
      generation: relaunched.generation,
    });

    // Exactly ONE queued admission across the whole assembly for the
    // revived completion: the tracker's `<task>` delivery (the only
    // promptAsync call — run 1's first publication was natively owned
    // and never woke). The publication wake must NOT have fired for the
    // revived publication — wake + tracker delivery double-notifying is
    // a failure.
    await flush();
    await Bun.sleep(30);
    expect(
      capture
        .of('[orchestrator-wake] terminal publication wake', 'child')
        .filter(
          (entry) =>
            (entry.data as { verdict?: string } | undefined)?.verdict ===
            'waking',
        ),
    ).toHaveLength(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const trackerCall = promptAsync.mock.calls.at(-1)?.[0] as {
      path?: { id?: string };
      delivery?: string;
      body?: { parts?: Array<{ text?: string }> };
    };
    expect(trackerCall).toMatchObject({
      path: { id: 'parent' },
      delivery: 'queue',
    });
    expect(trackerCall?.body?.parts?.[0]?.text).toContain('<task ');
    expect(trackerCall?.body?.parts?.[0]?.text).toContain('state="completed"');
  } finally {
    capture.restore();
  }
});

// ── Exhausted revived-run tracker: the suppressed publication is
// re-emitted exactly once as the degraded fallback ──
//
// When EVERY tracker notification attempt fails, ownership is released
// at the organic retry-exhaustion give-up point — but the publication
// the listener already suppressed (revived-tracker-owns-delivery) must
// not stay swallowed: the idle parent would get neither the <task>
// notification nor a wake. The release hook re-emits the publication
// wake DIRECTLY through the scheduler, bypassing the listener's
// suppression chain (a revived lineage has no native notifier, so the
// first-publication-native-owned skip must not apply) while the
// scheduler's own guards (canSchedule, one-flight, throttle) still do.

test('revived-run tracker exhaustion re-emits exactly one publication wake to the idle parent', async () => {
  resetOrchestratorWakeGateForTests();
  const capture = captureGateLogs();
  try {
    const isTrackerNotification = (args: unknown) => {
      const parts = (
        args as { body?: { parts?: Array<{ text?: string }> } } | undefined
      )?.body?.parts;
      return Boolean(
        Array.isArray(parts) && parts[0]?.text?.startsWith('<task '),
      );
    };
    // The tracker's <task> transport fails for its whole retry budget
    // (default 3 attempts); any other promptAsync consumer (the wake)
    // succeeds.
    let notificationFailures = 3;
    const promptAsync = mock(async (args: unknown) => {
      if (isTrackerNotification(args) && notificationFailures > 0) {
        notificationFailures -= 1;
        throw new Error('parent transport unavailable');
      }
      return {};
    });
    let hostChildren: Array<Record<string, unknown>> = [
      { id: 'child', parentID: 'parent' },
    ];
    const probe = v2ShimClient({
      outcome: 'succeeded',
      wakeSurface: {
        listChildren: () => hostChildren,
        promptAsync,
      },
    });
    const { h, pump, awaitPublication } = await openV2Lifecycle(probe, {
      hostFlavor: 'v2',
      configOverrides: {
        orchestratorWake: { publicationWakeMinIntervalMs: 1_000 },
      },
    });
    const tracker = h.revivedTracker;
    if (!tracker) {
      throw new Error('assembly did not expose the revived-run tracker');
    }

    // Run 1 (non-revived): the lineage's first publication is natively
    // owned — no plugin wake, no promptAsync.
    await h.requestTask('native', 'v2 tracker-exhaustion fallback probe');
    await pump({
      type: 'session.created',
      data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
    });
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const first = await awaitPublication('child', 0);
    expect(first).toMatchObject({ state: 'completed' });
    await flush();
    await Bun.sleep(30);
    expect(promptAsync).not.toHaveBeenCalled();

    // Past the throttle window, revive the child (the exact
    // post-admission state task_revive leaves behind).
    await Bun.sleep(1_100);
    const lease = h.board.acquireRelaunchLease('child', first.generation);
    if (!lease) throw new Error('missing relaunch lease');
    const relaunched = h.board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'parent',
      agent: 'explorer',
      description: 'revived continuation',
      background: true,
      relaunchLease: lease,
    });
    h.board.releaseLease(lease);
    tracker.register({
      taskID: 'child',
      generation: relaunched.generation,
      parentSessionID: 'parent',
      description: 'revived continuation',
    });
    const sinceRevision = h.board.get('child')?.terminalRevision ?? 0;

    // The revived run executes and completes; the tracker owns the
    // delivery, so the publication listener suppresses the wake.
    hostChildren = [
      { id: 'child', parentID: 'parent', time: { updated: Date.now() } },
    ];
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    let revived: BackgroundJobRecord | undefined;
    for (let i = 0; i < 400 && revived === undefined; i++) {
      const record = h.board.get('child');
      if (
        record &&
        record.state !== 'running' &&
        record.generation === relaunched.generation &&
        record.terminalRevision > sinceRevision
      ) {
        revived = record;
      } else {
        await Bun.sleep(5);
      }
    }
    if (!revived) throw new Error('revived publication never landed');
    expect(revived).toMatchObject({
      state: 'completed',
      generation: relaunched.generation,
    });
    expect(
      capture
        .of('[orchestrator-wake] terminal publication wake skipped', 'child')
        .filter(
          (entry) =>
            (entry.data as { reason?: string } | undefined)?.reason ===
            'revived-tracker-owns-delivery',
        ),
    ).toHaveLength(1);

    // The tracker burns its whole retry budget (3 attempts, 1s retry
    // delay), gives up, and the release hook must deliver EXACTLY ONE
    // publication wake to the idle parent — poll rather than sleep a
    // fixed window so the assertion is timing-tolerant.
    const wakeCalls = () =>
      promptAsync.mock.calls.filter((call) => !isTrackerNotification(call[0]));
    for (let i = 0; i < 600 && wakeCalls().length === 0; i += 1) {
      await Bun.sleep(10);
    }
    await flush();

    const notificationCalls = promptAsync.mock.calls.filter((call) =>
      isTrackerNotification(call[0]),
    );
    expect(notificationCalls).toHaveLength(3);
    expect(wakeCalls()).toHaveLength(1);
    expect(promptAsync).toHaveBeenCalledTimes(4);
    expect(
      capture
        .of('[orchestrator-wake] terminal publication wake', 'child')
        .filter(
          (entry) =>
            (entry.data as { verdict?: string } | undefined)?.verdict ===
            'waking',
        ),
    ).toHaveLength(1);
    const wakeCall = wakeCalls()[0]?.[0] as {
      path?: { id?: string };
      delivery?: string;
      modelSelection?: string;
      body?: { agent?: string; parts?: Array<{ text?: string }> };
    };
    expect(wakeCall).toMatchObject({
      path: { id: 'parent' },
      delivery: 'queue',
      modelSelection: 'inherit',
    });
    expect(wakeCall?.body?.agent).toBe('orchestrator');
    expect(wakeCall?.body?.parts?.[0]?.text).not.toContain('<task ');
  } finally {
    capture.restore();
  }
});

test('regression: first publication is native-owned; a later publication of the same lineage still wakes exactly once', async () => {
  resetOrchestratorWakeGateForTests();
  const capture = captureGateLogs();
  try {
    const promptAsync = mock(async () => ({}));
    let hostChildren: Array<Record<string, unknown>> = [
      { id: 'child', parentID: 'parent' },
    ];
    const probe = v2ShimClient({
      outcome: 'succeeded',
      wakeSurface: {
        listChildren: () => hostChildren,
        promptAsync,
      },
    });
    const { h, pump, awaitPublication } = await openV2Lifecycle(probe, {
      hostFlavor: 'v2',
      configOverrides: {
        orchestratorWake: { publicationWakeMinIntervalMs: 1_000 },
      },
    });

    // A plain (never-revived) background task: the FIRST completion is
    // the native notifier's (suppressed plugin wake); a LATER
    // completion of the same lineage must wake exactly once.
    await h.requestTask('native', 'v2 publication-wake regression probe');
    await pump({
      type: 'session.created',
      data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
    });
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const first = await awaitPublication('child', 0);
    expect(first).toMatchObject({ state: 'completed' });

    const waking = () =>
      capture
        .of('[orchestrator-wake] terminal publication wake', 'child')
        .filter(
          (entry) =>
            (entry.data as { verdict?: string } | undefined)?.verdict ===
            'waking',
        );

    // Publication #1 is the launch lineage's FIRST: natively delivered
    // to the idle parent, so the plugin wake stays suppressed (I1).
    await flush();
    await Bun.sleep(30);
    expect(waking()).toHaveLength(0);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(
      capture
        .of('[orchestrator-wake] terminal publication wake skipped', 'child')
        .filter(
          (entry) =>
            (entry.data as { reason?: string } | undefined)?.reason ===
            'first-publication-native-owned',
        ),
    ).toHaveLength(1);

    // A LATER publication of the same lineage (the child resumes and
    // finishes again) has no native notifier: the publication wake must
    // fire EXACTLY once and queue exactly one admission (the wake).
    await Bun.sleep(1_100);
    hostChildren = [
      { id: 'child', parentID: 'parent', time: { updated: Date.now() } },
    ];
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    expectReopened(h, first);
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    await awaitPublication('child', first.terminalRevision);
    await flush();
    await Bun.sleep(30);
    expect(waking()).toHaveLength(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const wakeCall = promptAsync.mock.calls[0]?.[0] as {
      path?: { id?: string };
      delivery?: string;
      modelSelection?: string;
    };
    expect(wakeCall).toMatchObject({
      path: { id: 'parent' },
      delivery: 'queue',
      modelSelection: 'inherit',
    });
  } finally {
    capture.restore();
  }
});

// ── I1 pin: the launch-lineage discriminator ──────────────────────────────
//
// The native notifier owns the FIRST terminal publication of EVERY
// generation (terminalRevision 1 — live-verified on a 2.0.8 host: a probe
// child's first completion woke an idle parent via native execution.wake
// with zero plugin wake). On v2 every plugin task launch AND relaunch is a
// host `subagent` tool call that arms the native background notifier — a
// relaunch re-arms it with a fresh `started_at`, defeating the notify
// dedupe — so even an UNOWNED second generation's first publication is
// natively delivered. Only later revisions of the same generation (rev>1:
// child self-continuation, a direct prompt to the child session) have no
// native notifier and keep the plugin wake as their only notifier.

test('first publication of an unowned second generation is native-owned: skipped, zero plugin wakes', async () => {
  resetOrchestratorWakeGateForTests();
  const capture = captureGateLogs();
  try {
    const promptAsync = mock(async () => ({}));
    let hostChildren: Array<Record<string, unknown>> = [
      { id: 'child', parentID: 'parent' },
    ];
    const probe = v2ShimClient({
      outcome: 'succeeded',
      wakeSurface: {
        listChildren: () => hostChildren,
        promptAsync,
      },
    });
    const { h, pump, awaitPublication } = await openV2Lifecycle(probe, {
      hostFlavor: 'v2',
      configOverrides: {
        orchestratorWake: { publicationWakeMinIntervalMs: 1_000 },
      },
    });

    // Run 1: original lineage — first publication natively owned.
    await h.requestTask('native', 'v2 second-generation wake probe');
    await pump({
      type: 'session.created',
      data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
    });
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const first = await awaitPublication('child', 0);
    expect(first).toMatchObject({ state: 'completed' });

    // Past the throttle window, relaunch WITHOUT tracker registration —
    // the exact ownership shape of a tracker that exhausted its retry
    // budget (willNotifyParent false). Under the native-contract
    // correction this is STILL a natively-notified publication: on v2
    // the relaunch is itself a host `subagent` tool call that re-arms
    // the native background notifier with a fresh `started_at` (defeating
    // the notify dedupe), so the plugin wake must NOT fire beside the
    // native delivery (F1).
    await Bun.sleep(1_100);
    const lease = h.board.acquireRelaunchLease('child', first.generation);
    if (!lease) throw new Error('missing relaunch lease');
    const relaunched = h.board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'parent',
      agent: 'explorer',
      description: 'unowned relaunch',
      background: true,
      relaunchLease: lease,
    });
    h.board.releaseLease(lease);

    hostChildren = [
      { id: 'child', parentID: 'parent', time: { updated: Date.now() } },
    ];
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    let second: BackgroundJobRecord | undefined;
    for (let i = 0; i < 400 && second === undefined; i++) {
      const record = h.board.get('child');
      if (
        record &&
        record.state !== 'running' &&
        record.generation === relaunched.generation
      ) {
        second = record;
      } else {
        await Bun.sleep(5);
      }
    }
    if (!second) throw new Error('second-generation publication never landed');

    // The second generation's FIRST publication (fresh generation,
    // terminalRevision 1) is delivered by the host's native notifier —
    // the `subagent` tool call that relaunched the child armed it — and
    // the plugin wake beside it would double-notify: exactly the skip
    // with `first-publication-native-owned`, zero plugin wakes. If that
    // native delivery is ever lost host-side, the fallback is board
    // injection on the parent's next activity (pre-branch parity), never
    // a speculative plugin wake.
    await flush();
    await Bun.sleep(30);
    const waking = capture
      .of('[orchestrator-wake] terminal publication wake', 'child')
      .filter(
        (entry) =>
          (entry.data as { verdict?: string } | undefined)?.verdict ===
          'waking',
      );
    const nativeOwnedSkips = capture
      .of('[orchestrator-wake] terminal publication wake skipped', 'child')
      .filter(
        (entry) =>
          (entry.data as { reason?: string; generation?: number } | undefined)
            ?.reason === 'first-publication-native-owned',
      );
    expect(waking).toHaveLength(0);
    // One native-owned skip per generation's first publication: run 1's
    // rev-1 (the original launch) AND the relaunched generation's rev-1
    // — each armed its own host `subagent` notifier call.
    expect(nativeOwnedSkips).toHaveLength(2);
    expect(
      nativeOwnedSkips.filter(
        (entry) =>
          (entry.data as { generation?: number } | undefined)?.generation ===
          relaunched.generation,
      ),
    ).toHaveLength(1);
    expect(promptAsync).not.toHaveBeenCalled();
  } finally {
    capture.restore();
  }
});

// ── M4+M1 pin: symmetric tracker suppression + honest stop reason ────────
//
// A revived run that STOPS must produce exactly one notification. When the
// tracker owns this generation's delivery (it already delivered the run's
// terminal <task>), the stopped-job recovery wake stays suppressed beside
// it; when nothing else delivers (a fresh revived generation whose first
// terminal publication IS the stop), the recovery wake is the one delivery
// and its delta must tell the truth about a host-attributed interruption.

test('revived stop with no prior tracker delivery wakes once and carries the attributed reason', async () => {
  resetOrchestratorWakeGateForTests();
  const capture = captureGateLogs();
  try {
    const promptAsync = mock(async () => ({}));
    let hostChildren: Array<Record<string, unknown>> = [
      { id: 'child', parentID: 'parent' },
    ];
    const probe = v2ShimClient({
      outcome: 'succeeded',
      wakeSurface: {
        listChildren: () => hostChildren,
        promptAsync,
      },
    });
    // Mutable host outcome: run 1 succeeds, the revived run is
    // interrupted. `pump`'s commitTerminalOutcome writes the probe's
    // closed-over state, so the outcome read is driven from here.
    let hostOutcome: string | undefined = 'succeeded';
    let hostIdleAt: number | undefined;
    probe.get.mockImplementation(async () => ({
      data:
        hostIdleAt !== undefined && hostOutcome !== undefined
          ? {
              parentID: 'parent',
              outcome: hostOutcome,
              time: { idle: hostIdleAt },
            }
          : { parentID: 'parent' },
    }));
    const { h, pump, awaitPublication } = await openV2Lifecycle(probe, {
      hostFlavor: 'v2',
      configOverrides: {
        orchestratorWake: { publicationWakeMinIntervalMs: 1_000 },
      },
    });
    const tracker = h.revivedTracker;
    if (!tracker) {
      throw new Error('assembly did not expose the revived-run tracker');
    }

    // Run 1 completes: first publication of the native lineage.
    await h.requestTask('native', 'v2 revived-stop probe');
    await pump({
      type: 'session.created',
      data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
    });
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    // Stamp the host idle strictly past the started event's busy stamp
    // (the attribution window rejects idle-not-after-window-lower on
    // same-millisecond ties).
    await Bun.sleep(2);
    hostIdleAt = Date.now();
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const first = await awaitPublication('child', 0);
    expect(first).toMatchObject({ state: 'completed' });
    await flush();
    await Bun.sleep(30);
    expect(promptAsync).not.toHaveBeenCalled();

    // Revive (task_revive's post-admission shape), then the host
    // interrupts the revived run before it ever completes.
    await Bun.sleep(1_100);
    const lease = h.board.acquireRelaunchLease('child', first.generation);
    if (!lease) throw new Error('missing relaunch lease');
    const relaunched = h.board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'parent',
      agent: 'explorer',
      description: 'revived stop probe',
      background: true,
      relaunchLease: lease,
    });
    h.board.releaseLease(lease);
    tracker.register({
      taskID: 'child',
      generation: relaunched.generation,
      parentSessionID: 'parent',
      description: 'revived stop probe',
    });

    hostOutcome = 'interrupted';
    hostIdleAt = undefined;
    hostChildren = [
      { id: 'child', parentID: 'parent', time: { updated: Date.now() } },
    ];
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    // Stamp the host idle strictly past the started event's busy stamp
    // (the attribution window rejects idle-not-after-window-lower on
    // same-millisecond ties).
    await Bun.sleep(2);
    hostIdleAt = Date.now();
    await pump({
      type: 'session.execution.interrupted',
      data: { sessionID: 'child' },
    });
    let stopped: BackgroundJobRecord | undefined;
    for (let i = 0; i < 400 && stopped === undefined; i++) {
      const record = h.board.get('child');
      if (
        record &&
        record.state === 'stopped' &&
        record.generation === relaunched.generation
      ) {
        stopped = record;
      } else {
        await Bun.sleep(5);
      }
    }
    if (!stopped) throw new Error('revived stop never published');
    expect(stopped.resultSummary).toBe('Host reported outcome: interrupted.');

    // Exactly ONE queued admission for the revived stop — the recovery
    // wake (the tracker delivers nothing for stops) — and its delta
    // must carry the attributed-interruption reason, not the missing-
    // result slander.
    await flush();
    await Bun.sleep(30);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const wakeCall = promptAsync.mock.calls[0]?.[0] as {
      path?: { id?: string };
      delivery?: string;
      body?: { parts?: Array<{ text?: string }> };
    };
    expect(wakeCall).toMatchObject({
      path: { id: 'parent' },
      delivery: 'queue',
    });
    const wakeText = wakeCall?.body?.parts?.[0]?.text ?? '';
    const deltaText = wakeText.slice(wakeText.indexOf('<stopped-job>'));
    expect(deltaText).toContain('<stopped-job>');
    expect(deltaText).toContain('host-attributed interruption');
    expect(deltaText).not.toContain('stopped without a terminal result');
  } finally {
    capture.restore();
  }
});

test('recovery wake stays suppressed beside a tracker-delivered terminal for the same generation', async () => {
  resetOrchestratorWakeGateForTests();
  const capture = captureGateLogs();
  try {
    const promptAsync = mock(async () => ({}));
    let hostChildren: Array<Record<string, unknown>> = [
      { id: 'child', parentID: 'parent' },
    ];
    const probe = v2ShimClient({
      outcome: 'succeeded',
      wakeSurface: {
        listChildren: () => hostChildren,
        promptAsync,
      },
    });
    let hostOutcome: string | undefined = 'succeeded';
    let hostIdleAt: number | undefined;
    probe.get.mockImplementation(async () => ({
      data:
        hostIdleAt !== undefined && hostOutcome !== undefined
          ? {
              parentID: 'parent',
              outcome: hostOutcome,
              time: { idle: hostIdleAt },
            }
          : { parentID: 'parent' },
    }));
    const { h, pump, awaitPublication } = await openV2Lifecycle(probe, {
      hostFlavor: 'v2',
      configOverrides: {
        orchestratorWake: { publicationWakeMinIntervalMs: 1_000 },
      },
    });
    const tracker = h.revivedTracker;
    if (!tracker) {
      throw new Error('assembly did not expose the revived-run tracker');
    }

    // Run 1 completes (native-owned first publication, no wake).
    await h.requestTask('native', 'v2 revived-stop suppression probe');
    await pump({
      type: 'session.created',
      data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
    });
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    // Stamp the host idle strictly past the started event's busy stamp
    // (the attribution window rejects idle-not-after-window-lower on
    // same-millisecond ties).
    await Bun.sleep(2);
    hostIdleAt = Date.now();
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const first = await awaitPublication('child', 0);

    // Revive; the revived generation completes and the tracker delivers
    // its <task> notification (the generation's one admission).
    await Bun.sleep(1_100);
    const lease = h.board.acquireRelaunchLease('child', first.generation);
    if (!lease) throw new Error('missing relaunch lease');
    const relaunched = h.board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'parent',
      agent: 'explorer',
      description: 'revived completion before stop',
      background: true,
      relaunchLease: lease,
    });
    h.board.releaseLease(lease);
    tracker.register({
      taskID: 'child',
      generation: relaunched.generation,
      parentSessionID: 'parent',
      description: 'revived completion before stop',
    });

    hostIdleAt = undefined;
    hostChildren = [
      { id: 'child', parentID: 'parent', time: { updated: Date.now() } },
    ];
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostOutcome = 'succeeded';
    await Bun.sleep(2);
    hostIdleAt = Date.now();
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    let completed: BackgroundJobRecord | undefined;
    for (let i = 0; i < 400 && completed === undefined; i++) {
      const record = h.board.get('child');
      if (
        record &&
        record.state === 'completed' &&
        record.generation === relaunched.generation
      ) {
        completed = record;
      } else {
        await Bun.sleep(5);
      }
    }
    if (!completed) throw new Error('revived completion never landed');
    await flush();
    await Bun.sleep(30);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // The delivered generation resumes and is then interrupted: the
    // stop is a LATER revision of a lineage the parent already heard
    // from. The recovery wake must stay suppressed beside the tracker's
    // delivered terminal (M4) — exactly one admission for the
    // generation, no second wake for the stop.
    await Bun.sleep(1_100);
    hostOutcome = 'interrupted';
    hostIdleAt = undefined;
    hostChildren = [
      { id: 'child', parentID: 'parent', time: { updated: Date.now() } },
    ];
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    // Stamp the host idle strictly past the started event's busy stamp
    // (the attribution window rejects idle-not-after-window-lower on
    // same-millisecond ties).
    await Bun.sleep(2);
    hostIdleAt = Date.now();
    await pump({
      type: 'session.execution.interrupted',
      data: { sessionID: 'child' },
    });
    let stopped: BackgroundJobRecord | undefined;
    for (let i = 0; i < 400 && stopped === undefined; i++) {
      const record = h.board.get('child');
      if (
        record &&
        record.state === 'stopped' &&
        record.generation === relaunched.generation
      ) {
        stopped = record;
      } else {
        await Bun.sleep(5);
      }
    }
    if (!stopped) throw new Error('post-completion stop never published');

    await flush();
    await Bun.sleep(30);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(
      capture.of(
        '[orchestrator-wake] stopped-job recovery wake skipped',
        'child',
      ),
    ).toHaveLength(1);
  } finally {
    capture.restore();
  }
});

// ── Runbook §3-D: cache-safety probe across a revival/notification turn ──
//
// The deleted v2-wake runbook's §3-D checked, live, that a full revival
// window produces exactly one queued admission (the revived-run
// tracker's `<task>` notification) with the publication wake suppressed
// beside it — and ZERO [cache-monitor] warnings across the whole window:
// the wake, tracker notification, and corrective surfaces ride the
// cache-safe trailing zone, so a revival turn that busts the provider
// prefix is a regression. This pin automates the automatable core: the
// REAL plugin factory (cache-monitor, wake listeners, tracker all wired
// by src/index.ts), the REAL v2 event mapping (session.usage.updated →
// message.updated through mapV2EventToV1, production pump order), and
// realistic per-turn usage telemetry for the parent (turn 1 cold
// cache.read=0 with a prefix write, every later turn cache.read>0 and
// growing — never zero again). A live model turn is the only piece
// `bun test` cannot run; the telemetry events are exactly what the host
// reports per completed request, so the residual gap is the provider
// itself, not the pipeline. The trailing CONTROL leg replays the proven
// bust signature (setup.e2e.test.ts "event pump maps v2 events…")
// through this same harness to prove the monitor is armed and WOULD
// have warned — the zero above is a property of the revival turn, not a
// dead monitor.

test('runbook §3-D: zero cache-monitor warnings across a full revival/notification turn', async () => {
  resetOrchestratorWakeGateForTests();
  const capture = captureGateLogs();
  try {
    const promptAsync = mock(async () => ({}));
    let hostChildren: Array<Record<string, unknown>> = [
      { id: 'child', parentID: 'parent' },
    ];
    const probe = v2ShimClient({
      outcome: 'succeeded',
      wakeSurface: {
        listChildren: () => hostChildren,
        promptAsync,
      },
    });
    const { h, pump, awaitPublication } = await openV2Lifecycle(probe, {
      hostFlavor: 'v2',
      configOverrides: {
        orchestratorWake: { publicationWakeMinIntervalMs: 1_000 },
      },
    });
    const tracker = h.revivedTracker;
    if (!tracker) {
      throw new Error('assembly did not expose the revived-run tracker');
    }
    // Parent usage telemetry (session.usage.updated, live wire shape):
    // one completed assistant request per turn, keyed like the host
    // reports it. Pumped through the REAL event hook chain.
    const parentTurn = (tokens: {
      input: number;
      read: number;
      write?: number;
    }) =>
      pump({
        type: 'session.usage.updated',
        data: {
          sessionID: 'parent',
          tokens: {
            input: tokens.input,
            output: 5,
            reasoning: 0,
            cache: { read: tokens.read, write: tokens.write ?? 0 },
          },
        },
      });

    // Turn 1 — the launch request (cold): no prefix to read yet, the
    // turn WRITES it. cache.read=0 here is the honest cold-start
    // signature, never a bust (the monitor arms only after a hit).
    await h.requestTask('native', 'v2 runbook 3-D revival probe');
    await parentTurn({ input: 9_000, read: 0, write: 8_200 });

    // Run 1: launch → execution → terminal → publication #1 (gen 1,
    // rev 1 — natively owned per the corrected contract; zero plugin
    // wakes beside the native delivery).
    await pump({
      type: 'session.created',
      data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
    });
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const first = await awaitPublication('child', 0);
    expect(first).toMatchObject({ state: 'completed' });
    await flush();
    await Bun.sleep(30);
    expect(
      capture
        .of('[orchestrator-wake] terminal publication wake skipped', 'child')
        .filter(
          (entry) =>
            (entry.data as { reason?: string } | undefined)?.reason ===
            'first-publication-native-owned',
        ),
    ).toHaveLength(1);
    expect(promptAsync).not.toHaveBeenCalled();

    // Turn 2 — the parent consumes the natively delivered report: warm,
    // the prefix is read and grows.
    await parentTurn({ input: 3_000, read: 8_500, write: 1_200 });

    // Revival past the throttle window: tracker-owned relaunch
    // (task_revive's exact post-admission shape).
    await Bun.sleep(1_100);
    const lease = h.board.acquireRelaunchLease('child', first.generation);
    if (!lease) throw new Error('missing relaunch lease');
    const relaunched = h.board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'parent',
      agent: 'explorer',
      description: 'runbook 3-D revival',
      background: true,
      relaunchLease: lease,
    });
    h.board.releaseLease(lease);
    tracker.register({
      taskID: 'child',
      generation: relaunched.generation,
      parentSessionID: 'parent',
      description: 'runbook 3-D revival',
    });

    hostChildren = [
      { id: 'child', parentID: 'parent', time: { updated: Date.now() } },
    ];
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    let revived: BackgroundJobRecord | undefined;
    for (let i = 0; i < 400 && revived === undefined; i++) {
      const record = h.board.get('child');
      if (
        record &&
        record.state !== 'running' &&
        record.generation === relaunched.generation
      ) {
        revived = record;
      } else {
        await Bun.sleep(5);
      }
    }
    if (!revived) throw new Error('revived publication never landed');

    // §3-D's exactly-one-admission contract: the tracker's `<task>`
    // notification is the ONE queued admission for the revived
    // completion; the publication wake stays suppressed beside it.
    await flush();
    await Bun.sleep(30);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const trackerCall = promptAsync.mock.calls.at(-1)?.[0] as {
      path?: { id?: string };
      delivery?: string;
      body?: { parts?: Array<{ text?: string }> };
    };
    expect(trackerCall).toMatchObject({
      path: { id: 'parent' },
      delivery: 'queue',
    });
    expect(trackerCall?.body?.parts?.[0]?.text).toContain('<task ');
    expect(
      capture
        .of('[orchestrator-wake] terminal publication wake skipped', 'child')
        .filter(
          (entry) =>
            (entry.data as { reason?: string } | undefined)?.reason ===
            'revived-tracker-owns-delivery',
        ),
    ).toHaveLength(1);
    expect(
      capture
        .of('[orchestrator-wake] terminal publication wake', 'child')
        .filter(
          (entry) =>
            (entry.data as { verdict?: string } | undefined)?.verdict ===
            'waking',
        ),
    ).toHaveLength(0);

    // Turn 3 — the woken turn (consuming the tracker notification) and
    // turn 4 — the post-notification reconcile: both warm, the read
    // prefix keeps growing, never zero again.
    await parentTurn({ input: 3_600, read: 9_700, write: 300 });
    await parentTurn({ input: 3_100, read: 10_200, write: 200 });
    await flush();

    // THE §3-D assertion: across the whole revival/notification window
    // the captured plugin log contains zero [cache-monitor] warnings —
    // none of the three runbook §3-D signatures.
    const cacheMonitorLines = capture
      .all()
      .filter((entry) => entry.message.startsWith('[cache-monitor]'));
    expect(cacheMonitorLines).toEqual([]);
    const wholeLog = capture
      .all()
      .map((entry) => entry.message)
      .join('\n');
    expect(wholeLog).not.toContain('prompt-cache bust');
    expect(wholeLog).not.toContain('never hit the provider cache');
    expect(wholeLog).not.toContain('cache-read plateau');

    // Non-vacuous control (same harness, same mapping layer): the
    // proven bust signature for a separate session DOES warn, proving
    // the monitor was armed across the window above.
    await pump({
      type: 'session.usage.updated',
      data: {
        sessionID: 'ses_control',
        tokens: {
          input: 8_000,
          output: 5,
          reasoning: 0,
          cache: { read: 0, write: 7_000 },
        },
      },
    });
    await pump({
      type: 'session.usage.updated',
      data: {
        sessionID: 'ses_control',
        tokens: {
          input: 500,
          output: 5,
          reasoning: 0,
          cache: { read: 9_000, write: 0 },
        },
      },
    });
    await pump({
      type: 'session.usage.updated',
      data: {
        sessionID: 'ses_control',
        tokens: {
          input: 12_000,
          output: 5,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    });
    await flush();
    const controlWarnings = capture
      .all()
      .filter(
        (entry) =>
          entry.message.startsWith('[cache-monitor]') &&
          entry.message.includes('prompt-cache bust'),
      );
    expect(controlWarnings).toHaveLength(1);
    expect(controlWarnings[0]?.data).toMatchObject({
      sessionID: 'ses_control',
    });
  } finally {
    capture.restore();
  }
});

// ── Runbook §6: attribution window containment (DB-row ground truth) ──
//
// The deleted v2-wake runbook's §6 cross-checked the gate's accepted
// attribution windows against the host DB row — `session_v2.idle_outcome`
// (one of the host's schema literals) plus `session_v2.time_idle`
// (integer epoch ms recorded at the idle transition) — and required
// `windowLower < time_idle <= windowUpper` for the row the gate
// accepted, with a stale prior run's row rejected. These pins make the
// containment contract explicit and named, so a future regression reads
// as "window containment broken" instead of a diffuse attribution
// failure. The fixture rows mirror the DB semantics exactly: outcome +
// integer-ms time.idle surfaced through session.get, committed at the
// idle transition.

/** Drive one v2 child lifecycle whose session.get serves a FIXED host
 * DB row ({idle_outcome, time_idle}) once the run is live, then settle
 * the gate's evidence-retry cadence. `idleFor` receives the board's
 * live lower bound (the started event's busy stamp — the max of
 * runStartedAt/attemptStartedAt/lastLiveBusyAt the window uses) so each
 * test constructs its row relative to the real boundary. */
async function driveHostRowLifecycle(options: {
  outcome: string;
  idleFor: (lowerBoundFromBoard: number) => number;
}) {
  const capture = captureGateLogs();
  const probe = v2ShimClient({ outcome: 'succeeded' });
  const { h, pump } = await openV2Lifecycle(probe, { hostFlavor: 'v2' });
  await h.requestTask('native', 'v2 window containment probe');
  await pump({
    type: 'session.created',
    data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
  });
  await pump({
    type: 'session.execution.started',
    data: { sessionID: 'child' },
  });
  const lowerBoundFromBoard = h.board.get('child')?.lastLiveBusyAt;
  if (lowerBoundFromBoard === undefined)
    throw new Error('run never went busy on the board');
  const idle = options.idleFor(lowerBoundFromBoard);
  if (!Number.isInteger(idle))
    throw new Error('DB-row time_idle must be integer epoch ms');
  probe.get.mockImplementation(async () => ({
    data: { parentID: 'parent', outcome: options.outcome, time: { idle } },
  }));
  await pump({
    type: 'session.execution.succeeded',
    data: { sessionID: 'child' },
  });
  // Settle: wait for the first attribution read, then let the retry
  // cadence run out (the guard suites' polling pattern).
  for (
    let i = 0;
    i < 400 &&
    capture.of('[terminal-gate] host-outcome attribution', 'child').length ===
      0;
    i++
  )
    await Bun.sleep(5);
  for (let i = 0; i < 40; i++) await Bun.sleep(5);
  const attributions = capture.of(
    '[terminal-gate] host-outcome attribution',
    'child',
  );
  return {
    capture,
    board: h.board,
    lowerBoundFromBoard,
    idle,
    attributions: attributions.map(
      (entry) =>
        entry.data as {
          verdict?: string;
          reason?: string;
          windowLower?: number;
          windowUpper?: number;
          outcome?: string;
        },
    ),
  };
}

test('window containment: an accepted attribution satisfies windowLower < time_idle <= windowUpper', async () => {
  const capture = captureGateLogs();
  try {
    // Default v2 probe semantics: the row commits at the idle transition
    // (the terminal execution event) — exactly when the host DB writes
    // time_idle — with integer epoch ms.
    const committedIdles: number[] = [];
    const base = v2ShimClient({ outcome: 'succeeded' });
    const probe = {
      ...base,
      commitTerminalOutcome: (idleAt: number) => {
        committedIdles.push(idleAt);
        base.commitTerminalOutcome(idleAt);
      },
    };
    const { h, pump } = await openV2Lifecycle(probe, { hostFlavor: 'v2' });
    await h.requestTask('native', 'v2 window containment accepted probe');
    await pump({
      type: 'session.created',
      data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
    });
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    await Bun.sleep(2);
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    for (let i = 0; i < 400 && h.board.get('child')?.state === 'running'; i++)
      await Bun.sleep(5);
    expect(h.board.get('child')).toMatchObject({
      state: 'completed',
      resultSummary: 'Host reported outcome: succeeded.',
    });
    const accepted = capture
      .of('[terminal-gate] host-outcome attribution', 'child')
      .map(
        (entry) =>
          entry.data as {
            verdict?: string;
            windowLower?: number;
            windowUpper?: number;
          },
      )
      .filter((data) => data.verdict === 'accepted');
    expect(accepted.length).toBeGreaterThan(0);
    expect(committedIdles.length).toBeGreaterThan(0);
    for (const data of accepted) {
      // The committed DB row (integer epoch ms, stamped at the idle
      // transition) sits strictly inside the logged window: a failure
      // here IS the window containment contract breaking.
      const inside = committedIdles.some(
        (idle) =>
          Number.isInteger(idle) &&
          (data.windowLower ?? Number.NaN) < idle &&
          idle <= (data.windowUpper ?? Number.NaN),
      );
      expect(
        inside,
        `window containment broken: windowLower=${data.windowLower} windowUpper=${data.windowUpper} time_idle=[${committedIdles.join(', ')}]`,
      ).toBe(true);
    }
  } finally {
    capture.restore();
  }
});

test('window containment: a stale prior run (time_idle below windowLower) is rejected and publishes nothing', async () => {
  const { capture, board, lowerBoundFromBoard, idle, attributions } =
    await driveHostRowLifecycle({
      outcome: 'succeeded',
      // A row from a PRIOR run: its idle transition predates this run's
      // every boundary.
      idleFor: (lowerBound) => lowerBound - 60_000,
    });
  try {
    expect(attributions.length).toBeGreaterThan(0);
    for (const data of attributions) {
      expect(data.verdict).toBe('rejected');
      expect(data.reason).toBe('idle-not-after-window-lower');
    }
    // The fixture's bound identity: the logged window lower bound IS
    // the board's live busy stamp the row was constructed against.
    expect(attributions[0]?.windowLower).toBe(lowerBoundFromBoard);
    expect(idle).toBeLessThan(lowerBoundFromBoard);
    expect(board.get('child')?.state).toBe('running');
    expect(capture.of('[terminal-gate] terminal published', 'child')).toEqual(
      [],
    );
  } finally {
    capture.restore();
  }
});

test('window containment: time_idle exactly ON windowLower (stale tie) is rejected, not accepted', async () => {
  const { capture, board, lowerBoundFromBoard, idle, attributions } =
    await driveHostRowLifecycle({
      outcome: 'succeeded',
      // Same-millisecond tie with the run's last boundary: equality is
      // ambiguous (the idle may predate the run), so the window must
      // reject it — the strict lower inequality is load-bearing.
      idleFor: (lowerBound) => lowerBound,
    });
  try {
    expect(attributions.length).toBeGreaterThan(0);
    for (const data of attributions) {
      expect(data.verdict).toBe('rejected');
      expect(data.reason).toBe('idle-not-after-window-lower');
    }
    expect(attributions[0]?.windowLower).toBe(lowerBoundFromBoard);
    expect(idle).toBe(lowerBoundFromBoard);
    expect(board.get('child')?.state).toBe('running');
    expect(capture.of('[terminal-gate] terminal published', 'child')).toEqual(
      [],
    );
  } finally {
    capture.restore();
  }
});

test('window containment: time_idle above windowUpper (clock-skew row) is rejected — the upper fence', async () => {
  const { capture, board, idle, attributions } = await driveHostRowLifecycle({
    outcome: 'succeeded',
    // On a shared unix-ms clock this row cannot exist by construction:
    // the host writes time_idle at the idle transition, strictly before
    // the gate's read completes, and windowUpper IS that read-completion
    // stamp. A future-dated row is only reachable through clock skew —
    // and the window must still refuse it.
    idleFor: (lowerBound) => lowerBound + 120_000,
  });
  try {
    expect(attributions.length).toBeGreaterThan(0);
    for (const data of attributions) {
      expect(data.verdict).toBe('rejected');
      expect(data.reason).toBe('idle-after-read-completion');
      expect(data.windowUpper).toBeDefined();
      expect(data.windowUpper as number).toBeLessThan(idle);
    }
    expect(board.get('child')?.state).toBe('running');
    expect(capture.of('[terminal-gate] terminal published', 'child')).toEqual(
      [],
    );
  } finally {
    capture.restore();
  }
});

// ── Runbook §6: host-schema drift contract ──
//
// The gate's attributable-outcome vocabulary is an intentional SUPERSET
// of the host schema's emitted literals (the extra 'cancelled' is the
// stop-family fail-safe). Host literals must stay a subset and unknown
// strings must route to the unrecognized-outcome rejection — never a
// publication. This pin reads the CLONED host schema source so a host
// schema change (literal added/removed) surfaces as a visible test
// signal instead of a silent misclassification.

const HOST_SCHEMA_PATH = path.join(
  path.resolve(import.meta.dir, '..'),
  '.slim/clonedeps/repos/opencode/packages/schema/src/session.ts',
);
const hostSchemaAvailable = existsSync(HOST_SCHEMA_PATH);
const driftTest = hostSchemaAvailable ? test : test.skip;

driftTest(
  'runbook §6 — host-schema drift: gate outcome literals track the cloned host session schema' +
    (hostSchemaAvailable
      ? ''
      : ' [SKIPPED: host clone absent — fetch it with the clonedeps skill into .slim/clonedeps/repos/opencode]'),
  async () => {
    const source = readFileSync(HOST_SCHEMA_PATH, 'utf8');
    // Info.outcome Literals — the host's idle_outcome vocabulary
    // ("Outcome of the last completed execution, recorded at
    // time.idle. Absent until a run reaches a terminal transition.").
    const outcomeMatch = source.match(
      /outcome:\s*Schema\.Literals\(\s*\[([^\]]*)\]/,
    );
    expect(outcomeMatch).toBeDefined();
    const hostLiterals = [...(outcomeMatch?.[1] ?? '').matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(hostLiterals.length).toBeGreaterThan(0);
    // time.idle is millis-since-epoch on the host schema — the DB row's
    // time_idle semantics the window-containment fixtures mirror.
    expect(source).toMatch(/idle:\s*DateTimeUtcFromMillis/);
    // The pinned host vocabulary: additions AND removals both trip
    // (either is host-schema drift this test exists to surface).
    expect(hostLiterals).toEqual(['failed', 'interrupted', 'succeeded']);
    // Contract: host literals ⊆ gate accepted. The gate's extra
    // 'cancelled' is the documented stop-family fail-safe superset.
    const gateAccepted = gateFactories.ACCEPTED_HOST_OUTCOMES;
    for (const literal of hostLiterals) {
      expect(gateAccepted).toContain(literal);
    }
    expect(gateAccepted).toContain('cancelled');
    expect(hostLiterals).not.toContain('cancelled');
    // And a string outside BOTH vocabularies routes to the
    // unrecognized-outcome rejection, never a publication — the literal
    // gate precedes the window check in the rejection cascade, so an
    // unknown outcome refuses publication regardless of where its
    // time_idle sits.
    const { capture, board, attributions } = await driveHostRowLifecycle({
      outcome: 'detonated-unknown',
      idleFor: (lowerBound) => lowerBound + 1,
    });
    try {
      expect(attributions.length).toBeGreaterThan(0);
      for (const data of attributions) {
        expect(data.verdict).toBe('rejected');
        expect(data.reason).toBe('unrecognized-outcome:detonated-unknown');
      }
      expect(board.get('child')?.state).toBe('running');
      expect(capture.of('[terminal-gate] terminal published', 'child')).toEqual(
        [],
      );
    } finally {
      capture.restore();
    }
  },
);
