/**
 * Unit tests for the TUI host wiring (task 3.6): admission three variants,
 * embedded-mode fail-closed, event projection with directory extraction,
 * host probe/reflection and dispose cleanup.
 *
 * The wiring imports no TUI rendering code, so these tests run headless.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MultiplexerConfig } from '../../config/schema';
import type { Multiplexer, PaneResult } from '../types';
import {
  createOnceGate,
  DIAGNOSTIC_EVENT_PANE_CREATED,
  type DiagnosticLogger,
  type OnceGate,
} from './diagnostics';
import { encodePaneTitle } from './pane-title';
import type { Clock, ClockTimerHandle } from './ports';
import type { SweepAdapter, SweepPane } from './sweep';
import {
  type ClientEventBus,
  createTuiPaneWiring,
  decideAdmission,
  detectClientAdapter,
  EMBEDDED_HOST_BASE_URL,
  type FetchLike,
  isEmbeddedHostUrl,
  type LoadedPaneConfig,
  loadPaneConfig,
  probeServerReachable,
  projectSessionEvent,
  reflectServerBaseUrl,
  resolveAnchoredTarget,
  type TuiPaneWiring,
} from './tui-wiring';
import type { AdapterType } from './types';

const DIRECTORY = '/project';
const PARENT = 'parent-1';
const CHILD = 'child-1';
const SERVER_URL = 'http://127.0.0.1:4321';
const PANE_ID = '%7';

interface LogEntry {
  message: string;
  data?: unknown;
}

class CapturingLogger implements DiagnosticLogger {
  readonly entries: LogEntry[] = [];

  log(message: string, data?: unknown): void {
    this.entries.push({ message, data });
  }

  /** Every `NoPaneReason` recorded through the structured diagnostics. */
  reasons(): string[] {
    return this.entries
      .map((entry) => (entry.data as { reason?: unknown } | undefined)?.reason)
      .filter((reason): reason is string => typeof reason === 'string');
  }

  events(): string[] {
    return this.entries
      .map((entry) => (entry.data as { event?: unknown } | undefined)?.event)
      .filter((event): event is string => typeof event === 'string');
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

class FakeEventBus implements ClientEventBus {
  private readonly handlers = new Map<string, Set<(event: unknown) => void>>();

  on(type: string, handler: (event: unknown) => void): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler);
    };
  }

  emit(type: string, event: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      handler(event);
    }
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.handlers.values()) count += set.size;
    return count;
  }
}

class FakeAdapter implements Multiplexer {
  readonly spawns: Array<{
    sessionId: string;
    description: string;
    serverUrl: string;
    directory: string;
  }> = [];
  readonly closes: string[] = [];
  /** FR-8 sweep capability: panes this fake multiplexer reports. */
  panes: SweepPane[] = [];
  spawnResult: PaneResult = { success: true, paneId: PANE_ID };

  constructor(readonly type: AdapterType) {}

  async listPanesWithTitles(): Promise<SweepPane[]> {
    return [...this.panes];
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
  ): Promise<PaneResult> {
    this.spawns.push({ sessionId, description, serverUrl, directory });
    return this.spawnResult;
  }

  async closePane(paneId: string): Promise<boolean> {
    this.closes.push(paneId);
    return true;
  }

  async applyLayout(): Promise<void> {}
}

type FakeSessionGetResult = 'found' | 'notfound' | 'error';

interface FakeClientState {
  baseUrl?: string;
  statuses: Record<string, { type: string }>;
  statusCalls: string[];
  sessions: Array<{ id: string; parentID?: string }>;
  listCalls: string[];
  /** `session.get` outcomes for the FR-8 terminal probe. */
  getResults: Record<string, FakeSessionGetResult>;
  getCalls: string[];
}

function createClientState(
  overrides: Partial<FakeClientState> = {},
): FakeClientState {
  return {
    baseUrl: SERVER_URL,
    statuses: { [CHILD]: { type: 'busy' } },
    statusCalls: [],
    sessions: [],
    listCalls: [],
    getResults: {},
    getCalls: [],
    ...overrides,
  };
}

function fakeHostClient(state: FakeClientState): unknown {
  return {
    client: { getConfig: () => ({ baseUrl: state.baseUrl }) },
    session: {
      status: async (input: { directory?: string }) => {
        state.statusCalls.push(input?.directory ?? '');
        return { data: state.statuses };
      },
      list: async (input: { directory?: string }) => {
        state.listCalls.push(input?.directory ?? '');
        return { data: state.sessions };
      },
      get: async (input: { sessionID?: string }) => {
        const sessionID = input?.sessionID ?? '';
        state.getCalls.push(sessionID);
        const outcome = state.getResults[sessionID] ?? 'notfound';
        if (outcome === 'found') return { data: { id: sessionID } };
        if (outcome === 'error') {
          return {
            error: { name: 'ServerError' },
            response: { status: 500 },
          };
        }
        return {
          error: { name: 'NotFoundError' },
          response: { status: 404 },
        };
      },
    },
  };
}

function defaultConfig(
  type: MultiplexerConfig['type'] = 'auto',
): LoadedPaneConfig {
  return {
    multiplexer: { type, layout: 'main-vertical', main_pane_size: 60 },
    invalid: false,
  };
}

function createdEvent(
  sessionId = CHILD,
  parentSessionId = PARENT,
  directory = DIRECTORY,
) {
  return {
    id: `evt-created-${sessionId}`,
    type: 'session.created',
    properties: {
      sessionID: sessionId,
      info: { id: sessionId, directory, parentID: parentSessionId },
    },
  };
}

function deletedEvent(sessionId = CHILD, directory = DIRECTORY) {
  return {
    id: `evt-deleted-${sessionId}`,
    type: 'session.deleted',
    properties: {
      sessionID: sessionId,
      info: { id: sessionId, directory },
    },
  };
}

function statusEvent(sessionId = CHILD, status = 'busy') {
  return {
    id: `evt-status-${sessionId}`,
    type: 'session.status',
    properties: { sessionID: sessionId, status: { type: status } },
  };
}

function idleEvent(sessionId = CHILD) {
  return {
    id: `evt-idle-${sessionId}`,
    type: 'session.idle',
    properties: { sessionID: sessionId },
  };
}

/** Lets queued async event handling settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

interface Harness {
  wiring: TuiPaneWiring;
  logger: CapturingLogger;
  bus: FakeEventBus;
  clock: FakeClock;
  state: FakeClientState;
  adapters: Map<AdapterType, FakeAdapter>;
  createdTypes: AdapterType[];
}

async function createHarness(
  options: {
    config?: LoadedPaneConfig;
    loadConfig?: (directory: string) => LoadedPaneConfig;
    env?: Record<string, string | undefined>;
    client?: unknown;
    state?: FakeClientState;
    fetchFn?: FetchLike;
    onceGate?: OnceGate;
    ownerPid?: number;
    reconcileIntervalMs?: number;
    sweepPanes?: SweepPane[];
    sweepAdapter?: SweepAdapter | null;
    isProcessAlive?: (pid: number) => boolean;
    isSessionTerminal?: (childSessionId: string) => Promise<boolean>;
  } = {},
): Promise<Harness> {
  const state = options.state ?? createClientState();
  const logger = new CapturingLogger();
  const bus = new FakeEventBus();
  const clock = new FakeClock();
  const adapters = new Map<AdapterType, FakeAdapter>();
  const createdTypes: AdapterType[] = [];
  // Pre-seed the tmux adapter so startup sweeps see panes injected by tests.
  const seeded = new FakeAdapter('tmux');
  seeded.panes = options.sweepPanes ?? [];
  adapters.set('tmux', seeded);
  const recorded = new Set<AdapterType>();
  const adapterFactory = {
    create: (type: AdapterType): Multiplexer => {
      if (!recorded.has(type)) {
        recorded.add(type);
        createdTypes.push(type);
      }
      const existing = adapters.get(type);
      if (existing) return existing;
      const adapter = new FakeAdapter(type);
      adapters.set(type, adapter);
      return adapter;
    },
  };

  const wiring = await createTuiPaneWiring({
    directory: DIRECTORY,
    getDisplayedSessionId: () => PARENT,
    eventBus: bus,
    client: options.client ?? fakeHostClient(state),
    env: options.env ?? { TMUX_PANE: '%1' },
    loadConfig:
      options.loadConfig ?? (() => options.config ?? defaultConfig('auto')),
    adapterFactory,
    logger,
    onceGate: options.onceGate ?? createOnceGate(),
    fetchFn: options.fetchFn ?? (async () => ({ ok: true })),
    clock,
    initLogging: () => {},
    stableIdleMs: 40,
    readiness: { maxAttempts: 3, retryDelayMs: 1 },
    ownerPid: options.ownerPid ?? 4242,
    reconcileIntervalMs: options.reconcileIntervalMs,
    sweepAdapter: options.sweepAdapter,
    isProcessAlive: options.isProcessAlive,
    isSessionTerminal: options.isSessionTerminal,
  });

  return { wiring, logger, bus, clock, state, adapters, createdTypes };
}

describe('client adapter detection (FR-9)', () => {
  test('detects each adapter from its client-local signal', () => {
    expect(detectClientAdapter({})).toBeNull();
    expect(detectClientAdapter({ TMUX_PANE: '%1' })).toBe('tmux');
    expect(detectClientAdapter({ ZELLIJ_PANE_ID: '3' })).toBe('zellij');
    expect(detectClientAdapter({ HERDR_PANE_ID: 'wP:p4' })).toBe('herdr');
    expect(detectClientAdapter({ KITTY_WINDOW_ID: '4' })).toBe('kitty');
    expect(detectClientAdapter({ CMUX_TUI_SOCKET: '/tmp/cmux.sock' })).toBe(
      'cmux',
    );
    expect(detectClientAdapter({ CMUX_MUX_SOCKET: '/tmp/cmux.sock' })).toBe(
      'cmux',
    );
  });

  test('prefers the cmux signal over a nested tmux pane', () => {
    expect(
      detectClientAdapter({ CMUX_TUI_SOCKET: '/s', TMUX_PANE: '%1' }),
    ).toBe('cmux');
  });
});

describe('admission decision (FR-9)', () => {
  test('none disables panes without consulting the environment', () => {
    expect(decideAdmission('none', 'tmux')).toMatchObject({
      enabled: false,
      adapter: null,
      reason: 'admission-none',
    });
  });

  test('explicit adapter requires a matching client environment', () => {
    expect(decideAdmission('zellij', 'tmux')).toMatchObject({
      enabled: false,
      reason: 'admission-mismatch',
    });
    expect(decideAdmission('tmux', 'tmux')).toMatchObject({
      enabled: true,
      adapter: 'tmux',
    });
  });

  test('auto uses the detected adapter and fails without one', () => {
    expect(decideAdmission('auto', 'kitty')).toMatchObject({
      enabled: true,
      adapter: 'kitty',
    });
    expect(decideAdmission('auto', null)).toMatchObject({
      enabled: false,
      reason: 'admission-unavailable',
    });
  });

  test('invalid config forces the feature off', () => {
    expect(decideAdmission('auto', 'tmux', true)).toMatchObject({
      enabled: false,
      reason: 'admission-unavailable',
      configInvalid: true,
    });
  });
});

describe('session event projection (FR-3)', () => {
  test('created/deleted take directory and parent from properties.info', () => {
    expect(projectSessionEvent('session.created', createdEvent())).toEqual({
      kind: 'created',
      sessionId: CHILD,
      parentSessionId: PARENT,
      directory: DIRECTORY,
    });
    expect(projectSessionEvent('session.deleted', deletedEvent())).toEqual({
      kind: 'deleted',
      sessionId: CHILD,
      parentSessionId: undefined,
      directory: DIRECTORY,
    });
  });

  test('status reads properties.status.type; idle carries no directory', () => {
    expect(
      projectSessionEvent('session.status', statusEvent(CHILD, 'retry')),
    ).toEqual({
      kind: 'status',
      sessionId: CHILD,
      directory: undefined,
      status: 'retry',
    });
    expect(projectSessionEvent('session.idle', idleEvent())).toEqual({
      kind: 'idle',
      sessionId: CHILD,
      directory: undefined,
    });
  });

  test('unknown types and malformed payloads are ignored', () => {
    expect(projectSessionEvent('message.updated', {})).toBeNull();
    expect(projectSessionEvent('session.created', null)).toBeNull();
    expect(
      projectSessionEvent('session.created', { properties: {} }),
    ).toBeNull();
    expect(
      projectSessionEvent('session.status', {
        properties: { sessionID: CHILD, status: { type: 'unknown' } },
      }),
    ).toEqual({ kind: 'status', sessionId: CHILD, directory: undefined });
  });
});

describe('project config reading (FR-12)', () => {
  let originalEnv: typeof process.env;
  let configHome: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-pane-config-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    fs.rmSync(configHome, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function writeProjectConfig(root: string, content: string): string {
    const projectDir = path.join(root, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'oh-my-opencode-slim.json'), content);
    return projectDir;
  }

  test('reads multiplexer type/layout/main_pane_size from the project config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-pane-project-'));
    try {
      const projectDir = writeProjectConfig(
        root,
        JSON.stringify({
          multiplexer: { type: 'tmux', layout: 'tiled', main_pane_size: 70 },
        }),
      );

      const loaded = loadPaneConfig(projectDir);

      expect(loaded.invalid).toBe(false);
      expect(loaded.multiplexer).toEqual({
        type: 'tmux',
        layout: 'tiled',
        main_pane_size: 70,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('invalid project config forces admission off with one diagnostic', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-pane-project-'));
    try {
      const projectDir = writeProjectConfig(root, '{ not json');
      const h = await createHarness({
        loadConfig: () => loadPaneConfig(projectDir),
      });

      expect(h.wiring.admission).toMatchObject({
        enabled: false,
        configInvalid: true,
      });
      expect(h.logger.reasons()).toEqual(['admission-unavailable']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('TUI pane wiring admission variants', () => {
  test('type:none creates no pane and logs one admission-none diagnostic', async () => {
    const h = await createHarness({ config: defaultConfig('none') });

    expect(h.wiring.admission).toMatchObject({
      enabled: false,
      reason: 'admission-none',
    });
    expect(h.wiring.lifecycle).toBeNull();

    h.bus.emit('session.created', createdEvent());
    await flush();

    expect(h.createdTypes).toEqual([]);
    expect(h.bus.listenerCount()).toBe(0);
    expect(h.logger.reasons()).toEqual(['admission-none']);
  });

  test('explicit zellij in a tmux client: no pane and exactly one diagnostic', async () => {
    const h = await createHarness({ config: defaultConfig('zellij') });

    expect(h.wiring.admission).toMatchObject({
      enabled: false,
      reason: 'admission-mismatch',
    });
    h.bus.emit('session.created', createdEvent());
    h.bus.emit('session.created', createdEvent('child-2'));
    await flush();

    expect(h.createdTypes).toEqual([]);
    expect(h.logger.reasons()).toEqual(['admission-mismatch']);
    const context = h.logger.entries[0]?.data as { adapter?: string };
    expect(context.adapter).toBe('zellij');
  });

  test('auto in tmux creates the pane through the client-local adapter', async () => {
    const h = await createHarness();

    expect(h.wiring.admission).toMatchObject({
      enabled: true,
      adapter: 'tmux',
    });

    h.bus.emit('session.created', createdEvent());
    await flush();

    const adapter = h.adapters.get('tmux');
    expect(h.createdTypes).toEqual(['tmux']);
    expect(adapter?.spawns).toHaveLength(1);
    expect(adapter?.spawns[0]).toMatchObject({
      sessionId: CHILD,
      serverUrl: SERVER_URL,
      directory: DIRECTORY,
    });
    expect(h.wiring.lifecycle?.getPane(CHILD)).toMatchObject({
      childSessionId: CHILD,
      parentSessionId: PARENT,
      adapter: 'tmux',
      anchoredTarget: '%1',
    });
    expect(h.state.statusCalls).toContain(DIRECTORY);
    expect(h.logger.reasons()).toEqual([]);
    expect(h.logger.events()).toContain(DIAGNOSTIC_EVENT_PANE_CREATED);
  });

  test('invalid config disables panes with one structured diagnostic', async () => {
    const h = await createHarness({
      config: { ...defaultConfig('auto'), invalid: true },
    });

    expect(h.wiring.admission).toMatchObject({
      enabled: false,
      configInvalid: true,
    });
    h.bus.emit('session.created', createdEvent());
    await flush();

    expect(h.createdTypes).toEqual([]);
    const noPane = h.logger.entries.filter(
      (entry) =>
        (entry.data as { event?: string })?.event === 'multiplexer.no-pane',
    );
    expect(noPane).toHaveLength(1);
    expect(noPane[0]?.data).toMatchObject({
      reason: 'admission-unavailable',
      configInvalid: true,
    });
  });

  test('admission diagnostics stay once per process across wirings', async () => {
    const onceGate = createOnceGate();
    const first = await createHarness({
      config: defaultConfig('zellij'),
      onceGate,
    });
    const second = await createHarness({
      config: defaultConfig('zellij'),
      onceGate,
    });

    expect(first.logger.reasons()).toEqual(['admission-mismatch']);
    expect(second.logger.reasons()).toEqual([]);
  });
});

describe('embedded host fail-closed (D3)', () => {
  test('sentinel baseUrl: no pane, no probe, exactly one host-unreachable diagnostic', async () => {
    const urls: string[] = [];
    const h = await createHarness({
      client: fakeHostClient(
        createClientState({ baseUrl: EMBEDDED_HOST_BASE_URL }),
      ),
      fetchFn: async (url) => {
        urls.push(url);
        return { ok: true };
      },
    });

    expect(h.wiring.admission).toMatchObject({
      enabled: true,
      adapter: 'tmux',
    });
    expect(h.wiring.lifecycle).toBeNull();
    expect(h.wiring.isHostReachable()).toBe(false);

    h.bus.emit('session.created', createdEvent());
    h.bus.emit('session.created', createdEvent('child-2'));
    await flush();

    expect(urls).toEqual([]);
    expect(h.createdTypes).toEqual([]);
    expect(h.bus.listenerCount()).toBe(0);
    expect(h.logger.reasons()).toEqual(['host-unreachable']);
  });

  test('missing reflection fields fail closed', async () => {
    const h = await createHarness({ client: {} });

    expect(h.wiring.lifecycle).toBeNull();
    expect(h.wiring.isHostReachable()).toBe(false);
    expect(h.logger.reasons()).toEqual(['host-unreachable']);
  });

  test('probe failure disables panes but recovers on a later event', async () => {
    let reachable = false;
    const h = await createHarness({
      fetchFn: async () => ({ ok: reachable }),
    });

    expect(h.wiring.lifecycle).not.toBeNull();
    expect(h.wiring.isHostReachable()).toBe(false);
    expect(h.logger.reasons()).toEqual(['host-unreachable']);

    h.bus.emit('session.created', createdEvent());
    await flush();
    expect(h.createdTypes).toEqual([]);

    reachable = true;
    h.clock.advance(5_000);
    h.bus.emit('session.created', createdEvent());
    await flush();

    expect(h.wiring.isHostReachable()).toBe(true);
    expect(h.createdTypes).toEqual(['tmux']);
    expect(h.logger.reasons().filter((r) => r === 'host-unreachable')).toEqual([
      'host-unreachable',
    ]);
  });
});

describe('event handling and dispose', () => {
  test('directory-less idle reaches a held pane and closes it on stable idle', async () => {
    const h = await createHarness();
    h.bus.emit('session.created', createdEvent());
    await flush();

    const adapter = h.adapters.get('tmux');
    expect(h.wiring.lifecycle?.getPane(CHILD)).toBeDefined();

    h.state.statuses[CHILD] = { type: 'idle' };
    h.bus.emit('session.idle', idleEvent());
    await flush();
    h.clock.advance(40);
    await flush();

    expect(adapter?.closes).toEqual([PANE_ID]);
    expect(h.wiring.lifecycle?.getPane(CHILD)).toBeUndefined();
  });

  test('events from another directory never create panes', async () => {
    const h = await createHarness();
    h.bus.emit('session.created', createdEvent(CHILD, PARENT, '/elsewhere'));
    await flush();

    expect(h.adapters.get('tmux')?.spawns).toEqual([]);
    expect(h.wiring.lifecycle?.getPane(CHILD)).toBeUndefined();
  });

  test('dispose unsubscribes, stops timers and closes owned panes', async () => {
    const h = await createHarness();
    h.bus.emit('session.created', createdEvent());
    await flush();

    const adapter = h.adapters.get('tmux');
    expect(h.bus.listenerCount()).toBe(4);

    h.state.statuses[CHILD] = { type: 'idle' };
    h.bus.emit('session.idle', idleEvent());
    await flush();

    await h.wiring.dispose();

    expect(h.bus.listenerCount()).toBe(0);
    expect(adapter?.closes).toEqual([PANE_ID]);
    expect(h.clock.pendingTimers).toBe(0);

    await h.wiring.dispose();
    expect(adapter?.closes).toEqual([PANE_ID]);

    h.bus.emit('session.created', createdEvent('child-late'));
    await flush();
    expect(adapter?.spawns).toHaveLength(1);
  });
});

describe('serverUrl reflection and probe (D3)', () => {
  test('reflects baseUrl defensively and never guesses a default', () => {
    expect(reflectServerBaseUrl(undefined)).toBeUndefined();
    expect(reflectServerBaseUrl({})).toBeUndefined();
    expect(reflectServerBaseUrl({ client: {} })).toBeUndefined();
    expect(
      reflectServerBaseUrl({ client: { getConfig: () => ({}) } }),
    ).toBeUndefined();
    expect(
      reflectServerBaseUrl({
        client: { getConfig: () => ({ baseUrl: SERVER_URL }) },
      }),
    ).toBe(SERVER_URL);
    expect(
      reflectServerBaseUrl({
        client: {
          getConfig: () => {
            throw new Error('reflection failed');
          },
        },
      }),
    ).toBeUndefined();
  });

  test('recognizes the embedded sentinel with trailing slashes', () => {
    expect(isEmbeddedHostUrl(EMBEDDED_HOST_BASE_URL)).toBe(true);
    expect(isEmbeddedHostUrl(`${EMBEDDED_HOST_BASE_URL}/`)).toBe(true);
    expect(isEmbeddedHostUrl(SERVER_URL)).toBe(false);
  });

  test('probes /session/status with the project directory', async () => {
    const urls: string[] = [];
    const reachable = await probeServerReachable(SERVER_URL, {
      directory: DIRECTORY,
      fetchFn: async (url) => {
        urls.push(url);
        return { ok: true };
      },
    });

    expect(reachable).toBe(true);
    expect(urls).toEqual([`${SERVER_URL}/session/status?directory=%2Fproject`]);
  });

  test('probe failures and non-ok responses are unreachable', async () => {
    expect(
      await probeServerReachable(SERVER_URL, {
        directory: DIRECTORY,
        fetchFn: async () => ({ ok: false }),
      }),
    ).toBe(false);
    expect(
      await probeServerReachable(SERVER_URL, {
        directory: DIRECTORY,
        fetchFn: async () => {
          throw new Error('down');
        },
      }),
    ).toBe(false);
  });

  test('resolves the native anchor from the admitted adapter environment', () => {
    expect(resolveAnchoredTarget('tmux', { TMUX_PANE: '%3' })).toBe('%3');
    expect(resolveAnchoredTarget('zellij', { ZELLIJ_PANE_ID: '3' })).toBe('3');
    expect(resolveAnchoredTarget('herdr', { HERDR_PANE_ID: 'wP:p4' })).toBe(
      'wP:p4',
    );
    expect(resolveAnchoredTarget('kitty', { KITTY_WINDOW_ID: '4' })).toBe('4');
    expect(
      resolveAnchoredTarget('cmux', { CMUX_TUI_TERMINAL_ID: 'term_1' }),
    ).toBe('term_1');
    expect(resolveAnchoredTarget('tmux', {})).toBeNull();
  });
});

describe('pane title encoding at spawn (FR-8)', () => {
  test('spawns carry the encoded owner pid + child session id', async () => {
    const h = await createHarness({ ownerPid: 4242 });
    h.bus.emit('session.created', createdEvent());
    await flush();

    const adapter = h.adapters.get('tmux');
    expect(adapter?.spawns).toHaveLength(1);
    expect(adapter?.spawns[0]?.description).toBe(`omosc:4242:${CHILD}`);
  });
});

describe('FR-7 reconcile trigger', () => {
  test('reconciles once at startup and again on the periodic cadence', async () => {
    const h = await createHarness({ reconcileIntervalMs: 30_000 });
    await flush();

    expect(h.state.listCalls).toHaveLength(1);

    h.clock.advance(30_000);
    await flush();
    expect(h.state.listCalls).toHaveLength(2);

    h.clock.advance(30_000);
    await flush();
    expect(h.state.listCalls).toHaveLength(3);
  });

  test('dispose stops the reconcile chain', async () => {
    const h = await createHarness({ reconcileIntervalMs: 30_000 });
    await flush();
    const calls = h.state.listCalls.length;

    await h.wiring.dispose();
    h.clock.advance(120_000);
    await flush();

    expect(h.state.listCalls).toHaveLength(calls);
  });

  test('reconcile is skipped while the host is unreachable', async () => {
    let reachable = false;
    const h = await createHarness({
      fetchFn: async () => ({ ok: reachable }),
      reconcileIntervalMs: 30_000,
    });
    await flush();
    expect(h.state.listCalls).toEqual([]);

    reachable = true;
    h.clock.advance(30_000);
    await flush();
    expect(h.state.listCalls).toHaveLength(1);
  });
});

describe('FR-8 leftover sweep', () => {
  test('startup sweep closes only dead-owner terminal leftovers', async () => {
    const state = createClientState({
      getResults: { ses_gone: 'notfound', ses_alive: 'found' },
    });
    const h = await createHarness({
      state,
      ownerPid: 1000,
      isProcessAlive: (pid) => pid !== 999,
      sweepPanes: [
        {
          paneId: 'pane-dead-terminal',
          title: encodePaneTitle(999, 'ses_gone'),
        },
        { paneId: 'pane-live-owner', title: encodePaneTitle(1000, 'ses_gone') },
        {
          paneId: 'pane-active-child',
          title: encodePaneTitle(999, 'ses_alive'),
        },
        { paneId: 'pane-user', title: 'user-title' },
        { paneId: 'pane-malformed', title: 'omosc:not-a-pid:ses_gone' },
      ],
    });
    await flush();

    expect(h.adapters.get('tmux')?.closes).toEqual(['pane-dead-terminal']);
    // Only dead-owner encoded panes reach the terminal probe, in list order.
    expect(state.getCalls).toEqual(['ses_gone', 'ses_alive']);
  });

  test('the default terminal probe closes only on a 404 from session.get', async () => {
    const state = createClientState({
      getResults: {
        ses_deleted: 'notfound',
        ses_alive: 'found',
        ses_error: 'error',
      },
    });
    const h = await createHarness({
      state,
      ownerPid: 1000,
      isProcessAlive: (pid) => pid !== 999,
      sweepPanes: [
        { paneId: 'pane-deleted', title: encodePaneTitle(999, 'ses_deleted') },
        { paneId: 'pane-alive', title: encodePaneTitle(999, 'ses_alive') },
        { paneId: 'pane-error', title: encodePaneTitle(999, 'ses_error') },
      ],
    });
    await flush();

    expect(h.adapters.get('tmux')?.closes).toEqual(['pane-deleted']);
    expect(state.getCalls).toEqual(['ses_deleted', 'ses_alive', 'ses_error']);
  });

  test('periodic reconcile sweeps leftovers that appear after startup', async () => {
    const state = createClientState({ getResults: { ses_gone: 'notfound' } });
    const h = await createHarness({
      state,
      ownerPid: 1000,
      isProcessAlive: (pid) => pid !== 999,
      reconcileIntervalMs: 30_000,
    });
    await flush();
    expect(h.adapters.get('tmux')?.closes).toEqual([]);

    h.adapters.get('tmux')?.panes.push({
      paneId: 'pane-late',
      title: encodePaneTitle(999, 'ses_gone'),
    });
    h.clock.advance(30_000);
    await flush();

    expect(h.adapters.get('tmux')?.closes).toEqual(['pane-late']);
  });

  test('an unavailable sweep capability leaves panes to the user fallback', async () => {
    const h = await createHarness({ sweepAdapter: null });
    h.adapters.get('tmux')?.panes.push({
      paneId: 'pane-leftover',
      title: encodePaneTitle(999, 'ses_gone'),
    });
    await flush();

    expect(h.adapters.get('tmux')?.closes).toEqual([]);
  });
});
