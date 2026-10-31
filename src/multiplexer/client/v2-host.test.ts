import { describe, expect, test } from 'bun:test';
import {
  buildV2PaneWiringOptions,
  createV2HostProbe,
  createV2SessionListReader,
  createV2StatusReader,
  createV2TerminalProbe,
  detectV2HostMode,
  projectV2SessionEvent,
  resolveV2BaseUrl,
  subscribeV2SessionEvents,
  V2_SESSION_EVENT_TYPES,
} from './v2-host';

function pagedChildren(count: number, bump = false) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `child-${String(index).padStart(4, '0')}`,
    time: { updated: Math.floor(index / 2) },
  }));
  const calls: Array<Record<string, unknown>> = [];
  const cursors = new Map<string, Record<string, any>>();
  const compare = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    a.time.updated - b.time.updated || a.id.localeCompare(b.id);
  return {
    calls,
    session: {
      list: async (input: Record<string, unknown> = {}) => {
        calls.push(input);
        const { limit = 50, ...initialQuery } = input;
        const query =
          typeof input.cursor === 'string'
            ? cursors.get(input.cursor)
            : initialQuery;
        const direction = query.order === 'asc' ? 1 : -1;
        const data = rows
          .filter(
            (row) =>
              !query.anchor || direction * compare(row, query.anchor) > 0,
          )
          .sort((a, b) => direction * compare(a, b))
          .slice(0, Number(limit));
        const last = data.at(-1);
        const next = last ? `cursor-${calls.length}` : undefined;
        if (next) {
          cursors.set(next, { ...query, anchor: structuredClone(last) });
        }
        if (bump && calls.length === 1) {
          const unseen = rows.find((row) => !data.includes(row));
          if (unseen) unseen.time.updated = 10_000;
        }
        return { data, cursor: { next } };
      },
    },
  };
}

describe('detectV2HostMode', () => {
  test('bare argv is the shared background service mode', () => {
    expect(detectV2HostMode(['bun', '/$bunfs/root/opencode'])).toEqual({
      mode: 'shared',
    });
    expect(detectV2HostMode(['opencode', '--auto', '/tmp/project'])).toEqual({
      mode: 'shared',
    });
  });

  test('--server <url> is the remote mode and carries the URL', () => {
    expect(
      detectV2HostMode([
        'bun',
        '/$bunfs/root/opencode',
        '--server',
        'http://192.168.5.212:8192',
      ]),
    ).toEqual({ mode: 'remote', serverUrl: 'http://192.168.5.212:8192' });
  });

  test('--server=<url> is accepted as a single argument', () => {
    expect(
      detectV2HostMode(['opencode', '--server=http://127.0.0.1:49374']),
    ).toEqual({ mode: 'remote', serverUrl: 'http://127.0.0.1:49374' });
  });

  test('--standalone is the standalone mode', () => {
    expect(
      detectV2HostMode(['bun', '/$bunfs/root/opencode', '--standalone']),
    ).toEqual({ mode: 'standalone' });
  });

  test('standalone plus --server is invalid (mutually exclusive)', () => {
    expect(
      detectV2HostMode(['opencode', '--standalone', '--server', 'http://x']),
    ).toEqual({
      mode: 'invalid',
      reason: '--standalone and --server are mutually exclusive',
    });
  });

  test('--server without a URL is invalid', () => {
    expect(detectV2HostMode(['opencode', '--server'])).toEqual({
      mode: 'invalid',
      reason: '--server requires a URL',
    });
    expect(detectV2HostMode(['opencode', '--server', '--auto'])).toEqual({
      mode: 'invalid',
      reason: '--server requires a URL',
    });
  });

  test('opencode2 spike argv shapes all classify (regression pin)', () => {
    // Shapes captured from live 2.0.18 processes during the v2 pane spike
    // (/tmp/opencode/v2pane-spike/runs/*.jsonl).
    expect(detectV2HostMode(['bun', '/$bunfs/root/opencode']).mode).toBe(
      'shared',
    );
    expect(
      detectV2HostMode([
        'bun',
        '/$bunfs/root/opencode',
        '--server',
        'http://192.168.5.212:8192',
      ]).mode,
    ).toBe('remote');
    expect(
      detectV2HostMode(['bun', '/$bunfs/root/opencode', '--standalone']).mode,
    ).toBe('standalone');
  });
});

describe('projectV2SessionEvent', () => {
  test('subscribes to exactly the lifecycle event types', () => {
    expect(V2_SESSION_EVENT_TYPES).toEqual([
      'session.created',
      'session.execution.started',
      'session.execution.succeeded',
      'session.execution.failed',
      'session.execution.interrupted',
      'session.idle',
      'session.deleted',
    ]);
  });

  test('created child carries parentID, agent and directory', () => {
    const event = projectV2SessionEvent('session.created', {
      data: {
        sessionID: 'ses_child',
        parentID: 'ses_parent',
        agent: 'explorer',
      },
      location: { directory: '/tmp/project' },
    });
    expect(event).toEqual({
      kind: 'created',
      sessionId: 'ses_child',
      parentSessionId: 'ses_parent',
      directory: '/tmp/project',
      subagentType: 'explorer',
    });
  });

  test('created reads the directory from the payload when the envelope lacks one', () => {
    expect(
      projectV2SessionEvent('session.created', {
        data: {
          sessionID: 'ses_child',
          location: { directory: '/tmp/from-data' },
        },
      }),
    ).toEqual({
      kind: 'created',
      sessionId: 'ses_child',
      directory: '/tmp/from-data',
    });
  });

  test('execution events carry only the session id (no location)', () => {
    expect(
      projectV2SessionEvent('session.execution.started', {
        data: { sessionID: 'ses_child' },
      }),
    ).toEqual({ kind: 'status', sessionId: 'ses_child', status: 'busy' });
    for (const type of [
      'session.execution.succeeded',
      'session.execution.failed',
      'session.execution.interrupted',
    ]) {
      expect(
        projectV2SessionEvent(type, { data: { sessionID: 'ses_child' } }),
      ).toEqual({ kind: 'status', sessionId: 'ses_child', status: 'idle' });
    }
  });

  test('idle and deleted map to their direct edges', () => {
    expect(
      projectV2SessionEvent('session.idle', { data: { sessionID: 'ses_x' } }),
    ).toEqual({ kind: 'idle', sessionId: 'ses_x' });
    expect(
      projectV2SessionEvent('session.deleted', {
        data: { sessionID: 'ses_x' },
      }),
    ).toEqual({ kind: 'deleted', sessionId: 'ses_x' });
  });

  test('unknown types and events without a session id are ignored', () => {
    expect(
      projectV2SessionEvent('session.updated', {
        data: { sessionID: 'ses_x' },
      }),
    ).toBeNull();
    expect(projectV2SessionEvent('session.created', { data: {} })).toBeNull();
    expect(projectV2SessionEvent('session.created', null)).toBeNull();
    expect(projectV2SessionEvent('session.created', 'junk')).toBeNull();
  });
});

describe('v2 host ports', () => {
  test('status reader marks active sessions busy and the rest idle', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const client = {
      session: {
        list: async (input?: Record<string, unknown>) => {
          calls.push(input);
          return { data: [{ id: 'ses_a' }, { id: 'ses_b' }] };
        },
        // The SDK returns the unwrapped `data` map of GET /api/session/active.
        active: async () => ({
          ses_a: { type: 'running' },
          ses_old: { type: 'running' },
        }),
      },
    };
    const read = await createV2StatusReader(client).readStatus('/tmp/proj');
    expect(read.error).toBeUndefined();
    expect(read.statuses.get('ses_a')).toBe('busy');
    expect(read.statuses.get('ses_b')).toBe('idle');
    expect(read.statuses.get('ses_old')).toBe('busy');
    // The directory scope and newest-first page keep a fresh child visible.
    expect(calls[0]).toEqual({
      directory: '/tmp/proj',
      order: 'desc',
      limit: 200,
    });
  });

  test('status reader fails soft without the API or on an array active', async () => {
    const read = await createV2StatusReader(undefined).readStatus('/tmp/proj');
    expect(read.error).toBe('v2 session API unavailable');
    expect(read.statuses.size).toBe(0);
    const session = {
      list: async () => [],
      active: async () => ({ data: [] }),
    };
    const bad = await createV2StatusReader({ session }).readStatus('/tmp/proj');
    expect(bad.error).toBe('invalid v2 active response');
  });

  test('list reader maps children with their agent type', async () => {
    const client = {
      session: {
        list: async () => [
          { id: 'ses_child', agent: 'explorer' },
          { id: 'ses_plain' },
          { nope: true },
        ],
      },
    };
    const read = await createV2SessionListReader(client).listSessions(
      '/tmp/proj',
      'ses_parent',
    );
    expect(read.sessions).toEqual([
      { sessionId: 'ses_child', subagentType: 'explorer' },
      { sessionId: 'ses_plain' },
    ]);
  });

  test('list reader reads every asc page despite a child metadata update', async () => {
    const client = pagedChildren(450, true);
    const read = await createV2SessionListReader(client).listSessions(
      '/tmp/proj',
      'ses_parent',
    );
    const ids = new Set(read.sessions.map((entry) => entry.sessionId));
    expect(read.error).toBeUndefined();
    expect(ids.size).toBe(450);
    expect(client.calls).toHaveLength(3);
    expect(client.calls[0]).toEqual({
      parentID: 'ses_parent',
      order: 'asc',
      limit: 200,
    });
  });

  test('list reader fails closed beyond the page cap without partial children', async () => {
    const client = pagedChildren(5001);
    const read = await createV2SessionListReader(client).listSessions(
      '/tmp/proj',
      'ses_parent',
    );
    expect(read.error).toBeDefined();
    expect(read.sessions).toEqual([]);
    expect(client.calls).toHaveLength(25);
  });

  test('host probe reflects server.info success and failure', async () => {
    let alive = true;
    const client = {
      server: {
        info: async () => {
          if (!alive) throw new Error('down');
          return { urls: [] };
        },
      },
    };
    const probe = createV2HostProbe(client);
    expect(await probe()).toBe(true);
    alive = false;
    expect(await probe()).toBe(false);
  });

  test('terminal probe returns true only for not-found errors', async () => {
    const client = {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === 'ses_gone') {
            // SDK 2.0.10 throws this plain tagged value; 2.0.22 adds Error/name.
            throw { _tag: 'SessionNotFoundError', sessionID, message: 'gone' };
          }
          return { id: sessionID };
        },
      },
    };
    const probe = createV2TerminalProbe(client);
    expect(await probe('ses_live')).toBe(false);
    expect(await probe('ses_gone')).toBe(true);
    expect(await createV2TerminalProbe(undefined)('ses_x')).toBe(false);
  });

  test('base URL resolution prefers the argv URL in remote mode', async () => {
    const client = {
      server: { info: async () => ({ urls: ['http://other'] }) },
    };
    expect(
      await resolveV2BaseUrl(
        { mode: 'remote', serverUrl: 'http://argv' },
        client,
      ),
    ).toBe('http://argv');
    expect(await resolveV2BaseUrl({ mode: 'shared' }, client)).toBe(
      'http://other',
    );
    expect(
      await resolveV2BaseUrl({ mode: 'shared' }, undefined),
    ).toBeUndefined();
    expect(
      await resolveV2BaseUrl({ mode: 'standalone' }, client),
    ).toBeUndefined();
  });

  test('event subscription projects payloads and unsubscribes every type', () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const unsubscribed: string[] = [];
    const data = {
      on: (type: string, handler: (event: unknown) => void) => {
        handlers.set(type, handler);
        return () => {
          unsubscribed.push(type);
        };
      },
    };
    const events: unknown[] = [];
    const dispose = subscribeV2SessionEvents(data, (event) =>
      events.push(event),
    );
    handlers.get('session.created')?.({
      data: { sessionID: 'ses_c', parentID: 'ses_p', agent: 'oracle' },
      location: { directory: '/d' },
    });
    handlers.get('session.execution.started')?.({
      data: { sessionID: 'ses_c' },
    });
    expect(events).toEqual([
      {
        kind: 'created',
        sessionId: 'ses_c',
        parentSessionId: 'ses_p',
        directory: '/d',
        subagentType: 'oracle',
      },
      { kind: 'status', sessionId: 'ses_c', status: 'busy' },
    ]);
    dispose();
    expect(unsubscribed).toHaveLength(V2_SESSION_EVENT_TYPES.length);
  });
});

describe('buildV2PaneWiringOptions', () => {
  test('standalone and malformed modes never get a wiring', async () => {
    for (const argv of [
      ['opencode', '--standalone'],
      ['opencode', '--server'],
    ]) {
      const setup = await buildV2PaneWiringOptions({
        argv,
        client: { server: { info: async () => ({ urls: ['http://x'] }) } },
      });
      expect(setup.options).toBeNull();
    }
  });

  test('shared startup reuses server info for the first probe only', async () => {
    let reads = 0;
    let alive = true;
    const setup = await buildV2PaneWiringOptions({
      argv: ['opencode'],
      client: {
        server: {
          info: async () => {
            reads += 1;
            if (!alive) throw new Error('offline');
            return { urls: ['http://shared:1'] };
          },
        },
      },
    });
    expect(reads).toBe(1);
    expect(await setup.options?.probeHost?.()).toBe(true);
    expect(reads).toBe(1);
    expect(await setup.options?.probeHost?.()).toBe(true);
    expect(reads).toBe(2);
    alive = false;
    expect(await setup.options?.probeHost?.()).toBe(false);
    expect(reads).toBe(3);
  });

  test('shared mode wires with the discovered URL, flavor and password', async () => {
    const setup = await buildV2PaneWiringOptions({
      argv: ['opencode'],
      location: { directory: '/tmp/proj' },
      client: { server: { info: async () => ({ urls: ['http://shared:1'] }) } },
      data: { on: () => () => {} },
      ui: {
        router: { current: () => ({ type: 'session', sessionID: 'ses_vis' }) },
      },
      env: { OPENCODE_PASSWORD: 'pw' },
    });
    expect(setup.mode).toEqual({ mode: 'shared' });
    expect(setup.options?.baseUrl).toBe('http://shared:1');
    expect(setup.options?.viewerFlavor).toBe('v2-shared');
    expect(setup.options?.viewerPassword).toBe('pw');
    expect(setup.options?.directory).toBe('/tmp/proj');
    expect(setup.options?.getDisplayedSessionId?.()).toBe('ses_vis');
  });

  test('remote mode carries the argv URL and uses the v2-remote flavor', async () => {
    const setup = await buildV2PaneWiringOptions({
      argv: ['opencode', '--server', 'http://remote:8192'],
      location: { directory: '/tmp/proj' },
      client: {
        server: { info: async () => ({ urls: ['http://remote:8192'] }) },
      },
      env: {},
    });
    expect(setup.options?.baseUrl).toBe('http://remote:8192');
    expect(setup.options?.viewerFlavor).toBe('v2-remote');
    expect(setup.options?.viewerPassword).toBeUndefined();
  });

  test('an unresolvable shared URL fails closed', async () => {
    const setup = await buildV2PaneWiringOptions({
      argv: ['opencode'],
      client: undefined,
      env: {},
    });
    expect(setup.options).toBeNull();
    expect(setup.mode).toEqual({
      mode: 'invalid',
      reason: 'server URL unavailable',
    });
  });
});
