import { describe, expect, test } from 'bun:test';
import type { MultiplexerLayout } from '../../config/schema';
import type { Multiplexer, PaneResult } from '../types';
import {
  DIAGNOSTIC_EVENT_NO_PANE,
  DIAGNOSTIC_EVENT_PANE_CREATED,
  type DiagnosticLogger,
} from './diagnostics';
import {
  PaneLifecycle,
  type PaneLifecycleConfig,
  UNKNOWN_ANCHORED_TARGET,
} from './lifecycle';
import type {
  AdapterFactory,
  ClientPorts,
  Clock,
  ClockTimerHandle,
  SessionListRead,
  SessionListReader,
  SessionStatusRead,
  SessionStatusReader,
} from './ports';
import type {
  AdapterType,
  SessionLifecycleEvent,
  SessionRuntimeStatus,
} from './types';

const DIRECTORY = '/project';
const PARENT = 'parent-1';
const CHILD = 'child-1';
const STABLE_IDLE_MS = 40;
const RETRY_DELAY_MS = 20;
const SERVER_URL = 'http://127.0.0.1:4321';

interface LogEntry {
  message: string;
  data?: unknown;
}

class CapturingLogger implements DiagnosticLogger {
  readonly entries: LogEntry[] = [];

  log(message: string, data?: unknown): void {
    this.entries.push({ message, data });
  }
}

class FakeClock implements Clock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { due: number; handler: () => void }
  >();

  now(): number {
    return this.current;
  }

  setTimeout(handler: () => void, delayMs: number): ClockTimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { due: this.current + Math.max(0, delayMs), handler });
    return id;
  }

  clearTimeout(handle: ClockTimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Advances time and fires every timer that became due, in due order. */
  advance(milliseconds: number): void {
    this.current += milliseconds;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.due <= this.current)
      .sort((a, b) => a[1].due - b[1].due);
    for (const [id, timer] of due) {
      if (!this.timers.has(id)) continue;
      this.timers.delete(id);
      timer.handler();
    }
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

class FakeStatusReader implements SessionStatusReader {
  readonly calls: string[] = [];
  readonly statuses = new Map<string, SessionRuntimeStatus>();
  error?: string;
  /** When set, reads block on it (models a status read in flight). */
  readBarrier: Promise<void> | null = null;

  async readStatus(directory: string): Promise<SessionStatusRead> {
    this.calls.push(directory);
    if (this.readBarrier) await this.readBarrier;
    return { statuses: new Map(this.statuses), error: this.error };
  }
}

class FakeSessionListReader implements SessionListReader {
  readonly calls: Array<{ directory: string; parentID: string }> = [];
  sessionIds: string[] = [];
  error?: string;

  async listSessions(
    directory: string,
    parentID: string,
  ): Promise<SessionListRead> {
    this.calls.push({ directory, parentID });
    return { sessionIds: [...this.sessionIds], error: this.error };
  }
}

interface SpawnCall {
  sessionId: string;
  description: string;
  serverUrl: string;
  directory: string;
  parentSessionId?: string;
}

class FakeAdapter implements Multiplexer {
  readonly type: AdapterType;
  readonly spawnCalls: SpawnCall[] = [];
  readonly closeCalls: string[] = [];
  readonly layoutCalls: Array<{
    layout: MultiplexerLayout;
    mainPaneSize: number;
  }> = [];
  spawnResult: PaneResult = { success: true, paneId: 'pane-1' };
  spawnError: Error | null = null;
  spawnBarrier: Promise<void> | null = null;
  closeResult = true;

  constructor(type: AdapterType = 'tmux') {
    this.type = type;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  isInsideSession(): boolean {
    return true;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: { parentSessionId?: string },
  ): Promise<PaneResult> {
    this.spawnCalls.push({
      sessionId,
      description,
      serverUrl,
      directory,
      parentSessionId: options?.parentSessionId,
    });
    if (this.spawnBarrier) await this.spawnBarrier;
    if (this.spawnError) throw this.spawnError;
    return this.spawnResult;
  }

  async closePane(paneId: string): Promise<boolean> {
    this.closeCalls.push(paneId);
    return this.closeResult;
  }

  async applyLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    this.layoutCalls.push({ layout, mainPaneSize });
  }
}

class FakeAdapterFactory implements AdapterFactory {
  readonly created: AdapterType[] = [];
  adapter: Multiplexer | null;

  constructor(adapter: Multiplexer | null) {
    this.adapter = adapter;
  }

  create(type: AdapterType): Multiplexer | null {
    this.created.push(type);
    return this.adapter;
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface HarnessOptions {
  config?: Partial<PaneLifecycleConfig>;
  ports?: Partial<ClientPorts>;
  adapter?: Multiplexer | null;
}

interface Harness {
  lifecycle: PaneLifecycle;
  clock: FakeClock;
  reader: FakeStatusReader;
  list: FakeSessionListReader;
  adapter: FakeAdapter;
  factory: FakeAdapterFactory;
  logger: CapturingLogger;
  setAnchoredTarget(value: string | null): void;
  getAnchoredTargetCalls(): number;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock();
  const reader = new FakeStatusReader();
  const list = new FakeSessionListReader();
  const adapter = new FakeAdapter();
  const factory = new FakeAdapterFactory(
    options.adapter === undefined ? adapter : options.adapter,
  );
  const logger = new CapturingLogger();
  let anchoredTarget: string | null = '%0';
  let anchoredTargetCalls = 0;

  const ports: ClientPorts = {
    clock,
    statusReader: reader,
    sessionListReader: list,
    adapterFactory: factory,
    resolveServerUrl: () => ({ url: SERVER_URL }),
    resolveAnchoredTarget: () => {
      anchoredTargetCalls += 1;
      return anchoredTarget;
    },
    ...options.ports,
  };
  const config: PaneLifecycleConfig = {
    directory: DIRECTORY,
    displayedSessionId: PARENT,
    adapter: 'tmux',
    layout: 'main-vertical',
    mainPaneSize: 60,
    stableIdleMs: STABLE_IDLE_MS,
    readiness: { maxAttempts: 3, retryDelayMs: RETRY_DELAY_MS },
    ...options.config,
  };
  const lifecycle = new PaneLifecycle(ports, config, logger);

  return {
    lifecycle,
    clock,
    reader,
    list,
    adapter,
    factory,
    logger,
    setAnchoredTarget: (value) => {
      anchoredTarget = value;
    },
    getAnchoredTargetCalls: () => anchoredTargetCalls,
  };
}

function createdEvent(
  overrides: Partial<SessionLifecycleEvent> = {},
): SessionLifecycleEvent {
  return {
    kind: 'created',
    sessionId: CHILD,
    parentSessionId: PARENT,
    directory: DIRECTORY,
    ...overrides,
  };
}

function lifecycleEvent(
  kind: SessionLifecycleEvent['kind'],
  overrides: Partial<SessionLifecycleEvent> = {},
): SessionLifecycleEvent {
  return { kind, sessionId: CHILD, directory: DIRECTORY, ...overrides };
}

function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function noPaneReasons(logger: CapturingLogger): string[] {
  return logger.entries
    .map((entry) => (entry.data as { reason?: string } | undefined)?.reason)
    .filter((reason): reason is string => reason !== undefined);
}

/** Brings CHILD to an active pane through the normal creation path. */
async function activatePane(h: Harness): Promise<void> {
  h.reader.statuses.set(CHILD, 'busy');
  await h.lifecycle.handleEvent(createdEvent());
}

describe('event filtering and readiness (2.2)', () => {
  test('ignores created events from another directory with no pane action', async () => {
    const h = createHarness();
    await h.lifecycle.handleEvent(
      createdEvent({ directory: '/other-project' }),
    );

    expect(h.adapter.spawnCalls).toHaveLength(0);
    expect(h.lifecycle.getPanes().size).toBe(0);
    expect(h.logger.entries).toHaveLength(0);
  });

  test('ignores created events without a directory (fail-closed)', async () => {
    const h = createHarness();
    await h.lifecycle.handleEvent(createdEvent({ directory: undefined }));

    expect(h.adapter.spawnCalls).toHaveLength(0);
    expect(h.logger.entries).toHaveLength(0);
  });

  test('logs not-our-child and skips the spawn for a foreign child', async () => {
    const h = createHarness();
    await h.lifecycle.handleEvent(
      createdEvent({ parentSessionId: 'parent-other' }),
    );

    expect(h.adapter.spawnCalls).toHaveLength(0);
    expect(h.lifecycle.getPanes().size).toBe(0);
    expect(h.logger.entries).toHaveLength(1);
    expect(h.logger.entries[0]?.data).toMatchObject({
      event: DIAGNOSTIC_EVENT_NO_PANE,
      reason: 'not-our-child',
      childSessionId: CHILD,
      parentSessionId: 'parent-other',
    });
  });

  test('stays silent when admission is off (wiring logs the one-time reason)', async () => {
    const h = createHarness({ config: { adapter: null } });
    await h.lifecycle.handleEvent(createdEvent());

    expect(h.adapter.spawnCalls).toHaveLength(0);
    expect(h.logger.entries).toHaveLength(0);
  });

  test('spawns an eligible child and records the FR-13 success fields', async () => {
    const h = createHarness();
    h.reader.statuses.set(CHILD, 'busy');
    await h.lifecycle.handleEvent(createdEvent());

    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.adapter.spawnCalls[0]).toMatchObject({
      sessionId: CHILD,
      serverUrl: SERVER_URL,
      directory: DIRECTORY,
      parentSessionId: PARENT,
    });
    expect(h.lifecycle.getPane(CHILD)).toMatchObject({
      childSessionId: CHILD,
      parentSessionId: PARENT,
      paneId: 'pane-1',
      adapter: 'tmux',
      anchoredTarget: '%0',
      status: 'active',
    });
    expect(h.logger.entries).toHaveLength(1);
    expect(h.logger.entries[0]?.data).toMatchObject({
      event: DIAGNOSTIC_EVENT_PANE_CREATED,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      adapter: 'tmux',
      paneId: 'pane-1',
      anchoredTarget: '%0',
    });
    expect(h.adapter.layoutCalls).toEqual([
      { layout: 'main-vertical', mainPaneSize: 60 },
    ]);
  });

  test('falls back to the unknown anchor without blocking creation', async () => {
    const h = createHarness();
    h.setAnchoredTarget(null);
    h.reader.statuses.set(CHILD, 'busy');
    await h.lifecycle.handleEvent(createdEvent());

    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.lifecycle.getPane(CHILD)?.anchoredTarget).toBe(
      UNKNOWN_ANCHORED_TARGET,
    );
  });

  test('probes readiness with the directory and retries within the bound', async () => {
    const h = createHarness();
    const pending = h.lifecycle.handleEvent(createdEvent());
    await flushAsync();

    // First attempt: the child is not published yet.
    expect(h.reader.calls).toEqual([DIRECTORY]);

    h.reader.statuses.set(CHILD, 'busy');
    h.clock.advance(RETRY_DELAY_MS);
    await pending;

    expect(h.reader.calls).toEqual([DIRECTORY, DIRECTORY]);
    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.lifecycle.getPane(CHILD)).toBeDefined();
  });

  test('records readiness-timeout and never spawns when probes stay empty', async () => {
    const h = createHarness();
    const pending = h.lifecycle.handleEvent(createdEvent());
    await flushAsync();
    h.clock.advance(RETRY_DELAY_MS);
    await flushAsync();
    h.clock.advance(RETRY_DELAY_MS);
    await pending;

    expect(h.reader.calls).toEqual([DIRECTORY, DIRECTORY, DIRECTORY]);
    expect(h.adapter.spawnCalls).toHaveLength(0);
    expect(h.lifecycle.getPanes().size).toBe(0);
    expect(h.logger.entries).toHaveLength(1);
    expect(h.logger.entries[0]?.data).toMatchObject({
      reason: 'readiness-timeout',
      childSessionId: CHILD,
      parentSessionId: PARENT,
    });
  });

  test('records host-unreachable without probing when no listener exists', async () => {
    const h = createHarness({
      ports: { resolveServerUrl: () => ({ unreachable: true }) },
    });
    await h.lifecycle.handleEvent(createdEvent());

    expect(h.reader.calls).toHaveLength(0);
    expect(h.adapter.spawnCalls).toHaveLength(0);
    expect(h.logger.entries[0]?.data).toMatchObject({
      reason: 'host-unreachable',
    });
  });

  test('records adapter-unavailable when the factory returns null', async () => {
    const h = createHarness({ adapter: null });
    h.reader.statuses.set(CHILD, 'busy');
    await h.lifecycle.handleEvent(createdEvent());

    expect(h.adapter.spawnCalls).toHaveLength(0);
    expect(h.logger.entries[0]?.data).toMatchObject({
      reason: 'adapter-unavailable',
    });
  });

  test('maps adapter spawn failures to the FR-13 adapter reasons', async () => {
    const cases = [
      ['unavailable', 'adapter-unavailable'],
      ['not_found', 'adapter-not-found'],
      ['hard', 'adapter-hard'],
      ['invalid_state', 'adapter-hard'],
    ] as const;

    for (const [error, reason] of cases) {
      const h = createHarness();
      h.reader.statuses.set(CHILD, 'busy');
      h.adapter.spawnResult = { success: false, error };
      await h.lifecycle.handleEvent(createdEvent());

      expect(h.logger.entries[0]?.data).toMatchObject({ reason });
      expect(h.lifecycle.getPanes().size).toBe(0);
    }
  });

  test('records adapter-hard when the adapter spawn throws', async () => {
    const h = createHarness();
    h.reader.statuses.set(CHILD, 'busy');
    h.adapter.spawnError = new Error('boom');
    await h.lifecycle.handleEvent(createdEvent());

    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.logger.entries[0]?.data).toMatchObject({
      reason: 'adapter-hard',
    });
  });

  test('keeps processing held panes after the displayed session changes', async () => {
    const h = createHarness();
    await activatePane(h);
    h.lifecycle.setDisplayedSession('parent-2');

    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();

    expect(h.adapter.closeCalls).toEqual(['pane-1']);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();
  });

  test('ignores status/idle/deleted for sessions without a pane', async () => {
    const h = createHarness();
    await h.lifecycle.handleEvent(
      lifecycleEvent('status', { sessionId: 'stranger', status: 'idle' }),
    );
    await h.lifecycle.handleEvent(
      lifecycleEvent('idle', { sessionId: 'stranger' }),
    );
    await h.lifecycle.handleEvent(
      lifecycleEvent('deleted', { sessionId: 'stranger' }),
    );

    expect(h.adapter.spawnCalls).toHaveLength(0);
    expect(h.adapter.closeCalls).toHaveLength(0);
    expect(h.logger.entries).toHaveLength(0);
  });
});

describe('dedup and stable-idle close (2.3)', () => {
  test('spawns exactly one pane when the same created event arrives twice concurrently', async () => {
    const h = createHarness();
    h.reader.statuses.set(CHILD, 'busy');

    const first = h.lifecycle.handleEvent(createdEvent());
    const second = h.lifecycle.handleEvent(createdEvent());
    await Promise.all([first, second]);

    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.lifecycle.getPanes().size).toBe(1);
    expect(h.lifecycle.getPane(CHILD)?.paneId).toBe('pane-1');
  });

  test('does not respawn when a created event is replayed after activation', async () => {
    const h = createHarness();
    await activatePane(h);
    await h.lifecycle.handleEvent(createdEvent());

    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.lifecycle.getPanes().size).toBe(1);
  });

  test('does not close the pane before the stable-idle window elapses', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));

    expect(h.clock.pendingTimers).toBe(1);
    h.clock.advance(STABLE_IDLE_MS - 1);
    await flushAsync();

    expect(h.adapter.closeCalls).toHaveLength(0);
    expect(h.lifecycle.getPane(CHILD)).toBeDefined();
  });

  test('keeps the pane when the child turns busy inside the debounce window', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));

    h.clock.advance(STABLE_IDLE_MS - 5);
    await h.lifecycle.handleEvent(lifecycleEvent('status', { status: 'busy' }));
    h.clock.advance(STABLE_IDLE_MS * 2);
    await flushAsync();

    expect(h.clock.pendingTimers).toBe(0);
    expect(h.adapter.closeCalls).toHaveLength(0);
    expect(h.lifecycle.getPane(CHILD)).toBeDefined();
  });

  test('closes after the window when the pre-close re-check is still idle', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));

    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();

    expect(h.reader.calls.at(-1)).toBe(DIRECTORY);
    expect(h.adapter.closeCalls).toEqual(['pane-1']);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();
    expect(h.clock.pendingTimers).toBe(0);
  });

  test('keeps the pane when the pre-close re-check reports busy', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));

    h.reader.statuses.set(CHILD, 'busy');
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();

    expect(h.adapter.closeCalls).toHaveLength(0);
    expect(h.lifecycle.getPane(CHILD)).toBeDefined();
  });

  test('keeps the pane when the pre-close re-check reports retry', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));

    h.reader.statuses.set(CHILD, 'retry');
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();

    expect(h.adapter.closeCalls).toHaveLength(0);
    expect(h.lifecycle.getPane(CHILD)).toBeDefined();
  });

  test('a busy event while the pre-close re-check is in flight keeps the pane', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));

    // The final re-check hangs while the child turns busy: the snapshot it
    // returns still says idle, and the busy event has already been consumed.
    const deferred = createDeferred();
    h.reader.readBarrier = deferred.promise;
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();
    expect(h.reader.calls).toHaveLength(2);

    await h.lifecycle.handleEvent(lifecycleEvent('status', { status: 'busy' }));
    deferred.resolve();
    h.reader.readBarrier = null;
    await flushAsync();

    expect(h.adapter.closeCalls).toHaveLength(0);
    expect(h.lifecycle.getPane(CHILD)).toBeDefined();
  });

  test('closes after the window when the pre-close re-check no longer lists the child', async () => {
    // Real-host semantics: opencode removes the session entry from
    // `/session/status` when a turn ends, so absence is quiescent, not busy.
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));

    h.reader.statuses.delete(CHILD);
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();

    expect(h.reader.calls.at(-1)).toBe(DIRECTORY);
    expect(h.adapter.closeCalls).toEqual(['pane-1']);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();
  });

  test('keeps the pane when the pre-close re-check fails (fail-closed)', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));

    h.reader.error = 'session status read failed';
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();

    expect(h.adapter.closeCalls).toHaveLength(0);
    expect(h.lifecycle.getPane(CHILD)).toBeDefined();
  });

  test('closes immediately on a deleted event without waiting for the window', async () => {
    const h = createHarness();
    await activatePane(h);

    await h.lifecycle.handleEvent(lifecycleEvent('deleted'));

    expect(h.adapter.closeCalls).toEqual(['pane-1']);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();
    expect(h.clock.pendingTimers).toBe(0);
  });

  test('closes a pane whose child was deleted while the spawn was in flight', async () => {
    const h = createHarness();
    h.reader.statuses.set(CHILD, 'busy');
    const barrier = createDeferred();
    h.adapter.spawnBarrier = barrier.promise;

    const pending = h.lifecycle.handleEvent(createdEvent());
    await flushAsync();
    expect(h.adapter.spawnCalls).toHaveLength(1);

    await h.lifecycle.handleEvent(lifecycleEvent('deleted'));
    barrier.resolve();
    await pending;

    expect(h.adapter.closeCalls).toEqual(['pane-1']);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();
  });
});

describe('rebuild and reconnect backfill (2.4)', () => {
  test('rebuilds with a freshly resolved anchor after the display position moves', async () => {
    const h = createHarness();
    await activatePane(h);
    expect(h.lifecycle.getPane(CHILD)?.anchoredTarget).toBe('%0');
    expect(h.getAnchoredTargetCalls()).toBe(1);

    // Stable idle closes the pane, keeping the child watched for rebuild.
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();
    expect(h.adapter.closeCalls).toEqual(['pane-1']);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();

    // The user moved the parent session to another pane/multiplexer.
    h.setAnchoredTarget('pane-new-anchor');
    h.adapter.spawnResult = { success: true, paneId: 'pane-2' };
    h.reader.statuses.set(CHILD, 'busy');
    await h.lifecycle.handleEvent(lifecycleEvent('status', { status: 'busy' }));

    expect(h.adapter.spawnCalls).toHaveLength(2);
    expect(h.lifecycle.getPane(CHILD)).toMatchObject({
      paneId: 'pane-2',
      anchoredTarget: 'pane-new-anchor',
      status: 'active',
    });
    // The anchor was re-resolved for the rebuild, not replayed from memory.
    expect(h.getAnchoredTargetCalls()).toBe(2);
    expect(h.logger.entries.at(-1)?.data).toMatchObject({
      event: DIAGNOSTIC_EVENT_PANE_CREATED,
      paneId: 'pane-2',
      anchoredTarget: 'pane-new-anchor',
    });
  });

  test('does not rebuild when the parent is no longer the displayed session', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();

    h.lifecycle.setDisplayedSession('parent-2');
    h.reader.statuses.set(CHILD, 'busy');
    await h.lifecycle.handleEvent(lifecycleEvent('status', { status: 'busy' }));

    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();
  });

  test('does not rebuild a child closed by deletion', async () => {
    const h = createHarness();
    await activatePane(h);
    await h.lifecycle.handleEvent(lifecycleEvent('deleted'));
    expect(h.adapter.closeCalls).toEqual(['pane-1']);

    h.reader.statuses.set(CHILD, 'busy');
    await h.lifecycle.handleEvent(lifecycleEvent('status', { status: 'busy' }));

    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();
  });

  test('forgets a watched child when its deleted event arrives', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();

    await h.lifecycle.handleEvent(lifecycleEvent('deleted'));
    h.reader.statuses.set(CHILD, 'busy');
    await h.lifecycle.handleEvent(lifecycleEvent('status', { status: 'busy' }));

    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();
  });

  test('backfills a child created while the event stream was down', async () => {
    const h = createHarness();
    h.list.sessionIds = [CHILD];
    h.reader.statuses.set(CHILD, 'busy');

    await h.lifecycle.onReconnect();

    expect(h.list.calls).toEqual([{ directory: DIRECTORY, parentID: PARENT }]);
    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.adapter.spawnCalls[0]).toMatchObject({
      sessionId: CHILD,
      parentSessionId: PARENT,
    });
    expect(h.lifecycle.getPane(CHILD)?.paneId).toBe('pane-1');
  });

  test('closes a local pane whose child no longer exists on the server', async () => {
    const h = createHarness();
    await activatePane(h);
    h.list.sessionIds = [];

    await h.lifecycle.onReconnect();

    expect(h.adapter.closeCalls).toEqual(['pane-1']);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();
  });

  test('skips already-held children and records backfill-skipped', async () => {
    const h = createHarness();
    await activatePane(h);
    h.list.sessionIds = [CHILD];

    await h.lifecycle.onReconnect();

    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.lifecycle.getPanes().size).toBe(1);
    expect(noPaneReasons(h.logger)).toEqual(['backfill-skipped']);
    expect(h.logger.entries.at(-1)?.data).toMatchObject({
      childSessionId: CHILD,
      parentSessionId: PARENT,
    });
  });

  test('keeps local state when the session list cannot be read', async () => {
    const h = createHarness();
    await activatePane(h);
    h.list.error = 'boom';

    await h.lifecycle.onReconnect();

    expect(h.adapter.closeCalls).toHaveLength(0);
    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.lifecycle.getPanes().size).toBe(1);
  });

  test('rebuilds a watched child that turned busy while the stream was down', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();

    // The busy event was lost during the outage; the live status map has it.
    h.list.sessionIds = [CHILD];
    h.reader.statuses.set(CHILD, 'busy');
    h.adapter.spawnResult = { success: true, paneId: 'pane-2' };

    await h.lifecycle.onReconnect();

    expect(h.adapter.spawnCalls).toHaveLength(2);
    expect(h.lifecycle.getPane(CHILD)?.paneId).toBe('pane-2');
  });

  test('drops a watched child the server no longer has', async () => {
    const h = createHarness();
    await activatePane(h);
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(lifecycleEvent('idle'));
    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();

    h.list.sessionIds = []; // deleted during the outage
    h.reader.statuses.set(CHILD, 'busy');
    await h.lifecycle.onReconnect();

    expect(h.adapter.spawnCalls).toHaveLength(1);
    // A later busy event must not rebuild a child the server no longer has.
    await h.lifecycle.handleEvent(lifecycleEvent('status', { status: 'busy' }));
    expect(h.adapter.spawnCalls).toHaveLength(1);
  });

  test('does not backfill a child whose spawn is already in flight', async () => {
    const h = createHarness();
    h.reader.statuses.set(CHILD, 'busy');
    const barrier = createDeferred();
    h.adapter.spawnBarrier = barrier.promise;
    const pending = h.lifecycle.handleEvent(createdEvent());
    await flushAsync();
    expect(h.adapter.spawnCalls).toHaveLength(1);

    h.list.sessionIds = [CHILD];
    await h.lifecycle.onReconnect();

    expect(h.adapter.spawnCalls).toHaveLength(1);
    barrier.resolve();
    await pending;
    expect(h.lifecycle.getPanes().size).toBe(1);
  });

  test('arms the stable-idle close when the child is idle at creation', async () => {
    const h = createHarness();
    h.reader.statuses.set(CHILD, 'idle');
    await h.lifecycle.handleEvent(createdEvent());

    expect(h.lifecycle.getPane(CHILD)).toBeDefined();
    expect(h.clock.pendingTimers).toBe(1);

    h.clock.advance(STABLE_IDLE_MS);
    await flushAsync();
    expect(h.adapter.closeCalls).toEqual(['pane-1']);
    expect(h.lifecycle.getPane(CHILD)).toBeUndefined();
  });
});

describe('pane title metadata (FR-8)', () => {
  test('passes the injected encoded pane title as the spawn description', async () => {
    const h = createHarness({
      ports: {
        resolvePaneTitle: (childSessionId) => `omosc:4242:${childSessionId}`,
      },
    });
    h.reader.statuses.set(CHILD, 'busy');

    await h.lifecycle.handleEvent(createdEvent());

    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.adapter.spawnCalls[0]?.description).toBe(`omosc:4242:${CHILD}`);
  });

  test('falls back to the child session id without a title resolver', async () => {
    const h = createHarness();
    h.reader.statuses.set(CHILD, 'busy');

    await h.lifecycle.handleEvent(createdEvent());

    expect(h.adapter.spawnCalls[0]?.description).toBe(CHILD);
  });
});
