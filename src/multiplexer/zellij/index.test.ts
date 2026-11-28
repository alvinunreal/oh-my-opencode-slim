import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

const logMock = mock(() => {});
type SpawnOptions = { env?: Record<string, string | undefined> };
const crossSpawnMock = mock((_command: string[], _options?: SpawnOptions) =>
  createSpawnResult(),
);

mock.module('../../utils/logger', () => ({
  log: logMock,
}));

mock.module('../../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

let importCounter = 0;

const SESSION_NAME = 'probe-session';

function createSpawnResult(
  exitCode = 0,
  stdout = '',
  stderr = '',
): SpawnResult {
  return {
    exited: Promise.resolve(exitCode),
    stdout: () => Promise.resolve(stdout),
    stderr: () => Promise.resolve(stderr),
    kill: () => true,
    exitCode,
    proc: {} as never,
  };
}

function createPaneListJson(parentTabId = 0): string {
  return JSON.stringify([
    {
      id: 0,
      is_plugin: false,
      tab_id: parentTabId,
    },
    {
      id: 4,
      is_plugin: false,
      tab_id: 1,
    },
  ]);
}

async function importFreshZellij() {
  return import(`./index?test=${importCounter++}`);
}

function commands(): string[][] {
  return crossSpawnMock.mock.calls.map((call) => call[0] as string[]);
}

function newPaneCommands(): string[][] {
  return commands().filter((command) => command.includes('new-pane'));
}

/**
 * Install the standard success mock set (binary found, supported version,
 * list-panes with the parent pane 0 in tab 0, new-pane emitting a valid id).
 */
function mockStandardImpl(
  version: string,
  action?: (command: string[]) => SpawnResult | undefined,
): void {
  crossSpawnMock.mockImplementation((command: string[]) => {
    if (command[0] === 'which' || command[0] === 'where') {
      return createSpawnResult(0, '/usr/bin/zellij\n');
    }
    if (command.includes('--version')) {
      return createSpawnResult(0, `zellij ${version}\n`);
    }
    const result = action?.(command);
    if (result) return result;
    if (command.includes('list-panes')) {
      return createSpawnResult(0, createPaneListJson());
    }
    if (command.includes('list-tabs')) {
      return createSpawnResult(
        0,
        '[{"tab_id":0,"are_floating_panes_visible":false}]',
      );
    }
    if (command.includes('new-pane')) {
      return createSpawnResult(0, 'terminal_2\n');
    }
    return createSpawnResult();
  });
}

function tile(id: number, x: number, y: number, width: number, rows: number) {
  return {
    id,
    tab_id: 0,
    is_plugin: false,
    is_floating: false,
    is_suppressed: false,
    is_collapsed: false,
    exited: false,
    pane_x: x,
    pane_y: y,
    pane_columns: width,
    pane_rows: rows,
  };
}

function placementCommands() {
  return crossSpawnMock.mock.calls
    .filter(([command]) => command[4] === 'new-pane')
    .map(([command, options]) => ({
      session: command.slice(1, 3),
      noFocus: command.includes('--no-focus'),
      tabTarget: command.includes('--tab-id'),
      paneTarget: command.includes('--pane-id'),
      anchor: options?.env?.ZELLIJ_PANE_ID,
      direction: command[command.indexOf('--direction') + 1],
    }));
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('ZellijMultiplexer', () => {
  const originalZellij = process.env.ZELLIJ;
  const originalZellijPaneId = process.env.ZELLIJ_PANE_ID;
  const originalZellijSessionName = process.env.ZELLIJ_SESSION_NAME;

  beforeEach(() => {
    process.env.ZELLIJ = '1';
    process.env.ZELLIJ_PANE_ID = '0';
    process.env.ZELLIJ_SESSION_NAME = SESSION_NAME;

    logMock.mockClear();
    crossSpawnMock.mockReset();
    mockStandardImpl('0.44.3');
  });

  afterEach(() => {
    setEnv('ZELLIJ', originalZellij);
    setEnv('ZELLIJ_PANE_ID', originalZellijPaneId);
    setEnv('ZELLIJ_SESSION_NAME', originalZellijSessionName);
  });

  describe('isInsideSession', () => {
    test('is true when ZELLIJ_PANE_ID is present', async () => {
      const { ZellijMultiplexer } = await importFreshZellij();

      expect(new ZellijMultiplexer().isInsideSession()).toBe(true);
    });

    test('is false when only ZELLIJ is set without a pane id', async () => {
      delete process.env.ZELLIJ_PANE_ID;

      const { ZellijMultiplexer } = await importFreshZellij();

      expect(new ZellijMultiplexer().isInsideSession()).toBe(false);
    });
  });

  describe('version gate', () => {
    test('isAvailable is false for zellij older than 0.44.1', async () => {
      mockStandardImpl('0.43.1');

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60);

      const result = await zellij.spawnPane(
        'session-1',
        'Old zellij worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: false, error: 'unavailable' });
      // Only binary discovery ran; no zellij actions were attempted.
      expect(commands().some((command) => command.includes('action'))).toBe(
        false,
      );
    });

    test('isAvailable is false for zellij 0.44.0 (new-pane --tab-id needs 0.44.1)', async () => {
      mockStandardImpl('0.44.0');

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60);

      const result = await zellij.spawnPane(
        'session-1',
        'Boundary worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: false, error: 'unavailable' });
      // Only binary discovery ran; no zellij actions were attempted.
      expect(commands().some((command) => command.includes('action'))).toBe(
        false,
      );
    });

    test('isAvailable is true for the 0.44.1 boundary release', async () => {
      mockStandardImpl('0.44.1');

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60);

      const result = await zellij.spawnPane(
        'session-1',
        'Boundary worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: true, paneId: 'terminal_2' });
    });

    test('isAvailable is true for zellij 0.44.3', async () => {
      mockStandardImpl('0.44.3');

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60);

      const result = await zellij.spawnPane(
        'session-1',
        'Modern worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: true, paneId: 'terminal_2' });
    });

    test('isAvailable is false when version output cannot be parsed', async () => {
      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which' || command[0] === 'where') {
          return createSpawnResult(0, '/usr/bin/zellij\n');
        }
        if (command.includes('--version')) {
          return createSpawnResult(0, 'zellij version unknown\n');
        }
        return createSpawnResult();
      });

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60);

      const result = await zellij.spawnPane(
        'session-1',
        'Unknown worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: false, error: 'unavailable' });
      expect(commands().some((command) => command.includes('action'))).toBe(
        false,
      );
    });

    test('isAvailable is false when the version probe fails', async () => {
      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which' || command[0] === 'where') {
          return createSpawnResult(0, '/usr/bin/zellij\n');
        }
        if (command.includes('--version')) {
          return createSpawnResult(1, '', 'probe failed');
        }
        return createSpawnResult();
      });

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60);

      const result = await zellij.spawnPane(
        'session-1',
        'Probe failure worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: false, error: 'unavailable' });
      expect(commands().some((command) => command.includes('action'))).toBe(
        false,
      );
    });

    test('a second availability check awaits the in-flight probe instead of returning false early', async () => {
      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60);

      let releaseWhich!: () => void;
      const whichGate = new Promise<void>((resolve) => {
        releaseWhich = resolve;
      });

      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which' || command[0] === 'where') {
          return {
            ...createSpawnResult(0, '/usr/bin/zellij\n'),
            exited: whichGate.then(() => 0),
          };
        }
        if (command.includes('--version')) {
          return createSpawnResult(0, 'zellij 0.44.1\n');
        }
        return createSpawnResult();
      });

      const first = zellij.isAvailable();
      // Second call while the binary probe is still pending: it must join the
      // in-flight probe rather than short-circuit to an early false.
      const second = zellij.isAvailable();

      let secondSettled = false;
      void second.then(() => {
        secondSettled = true;
      });

      // Flush microtasks deterministically; the probe is gated on `which`, so
      // the second call must not settle before the probe completes.
      for (let i = 0; i < 32; i++) {
        await Promise.resolve();
      }
      expect(secondSettled).toBe(false);

      releaseWhich();
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
      expect(secondSettled).toBe(true);

      // Only one probe ran: both calls shared the same in-flight promise.
      const discoveryCalls = commands().filter(
        (c) => c[0] === 'which' || c[0] === 'where',
      );
      expect(discoveryCalls).toHaveLength(1);
    });
  });

  test('creates the child pane in the parent tab (same tab as the parent) with explicit --session', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    const result = await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: 'terminal_2' });

    const allCommands = commands();
    const newPaneCommand = allCommands.find((command) =>
      command.includes('new-pane'),
    );

    expect(newPaneCommand).toEqual([
      '/usr/bin/zellij',
      '--session',
      SESSION_NAME,
      'action',
      'new-pane',
      '--tab-id',
      '0',
      '--direction',
      'right',
      '--name',
      'Same tab worker',
      '--close-on-exit',
      '--',
      'sh',
      '-lc',
      "env OH_MY_OPENCODE_SLIM_PANE_VIEWER=1 opencode attach 'http://localhost:4096' --session 'session-1' --dir '/repo'",
    ]);

    // The anchor lookup is also explicitly addressed.
    expect(
      allCommands.find((command) => command.includes('list-panes')),
    ).toEqual([
      '/usr/bin/zellij',
      '--session',
      SESSION_NAME,
      'action',
      'list-panes',
      '--json',
      '--tab',
      '--all',
    ]);

    // Same-tab is the only behavior: no dedicated agents tab is created, no
    // tab is switched, no pane is reused/renamed, and focus is never moved.
    expect(allCommands.some((command) => command.includes('new-tab'))).toBe(
      false,
    );
    expect(
      allCommands.some((command) => command.includes('go-to-tab-by-id')),
    ).toBe(false);
    expect(allCommands.some((command) => command.includes('list-tabs'))).toBe(
      false,
    );
    expect(allCommands.some((command) => command.includes('rename-pane'))).toBe(
      false,
    );
    expect(allCommands.some((command) => command.includes('write-chars'))).toBe(
      false,
    );
    expect(allCommands.some((command) => command.includes('focus-pane'))).toBe(
      false,
    );
  });

  test('new-pane bridges the v2 remote secret from the parent environ, never the command', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60);

      await zellij.spawnPane(
        'session-1',
        'Remote worker',
        'http://localhost:4096',
        '/repo',
        { viewerFlavor: 'v2-remote', viewerPassword: 'pw-9-secret' },
      );

      const remote = newPaneCommands()[0]?.at(-1) ?? '';
      expect(remote).toContain('--server');
      expect(remote).not.toContain('attach');
      // The secret is read from the parent process's /proc environ by the
      // pane script (`sh -lc`): no literal value appears in the command.
      expect(remote).not.toContain('pw-9-secret');
      expect(remote).toContain(`/proc/${process.pid}/environ`);
      expect(remote).toContain('s/^OPENCODE_PASSWORD=//p');
      expect(remote).toContain('s/^OPENCODE_SERVER_PASSWORD=//p');
      expect(remote.indexOf('/proc/')).toBeLessThan(
        remote.indexOf('opencode --server'),
      );

      crossSpawnMock.mockClear();
      await zellij.spawnPane(
        'session-2',
        'Shared worker',
        'http://localhost:4096',
        '/repo',
        { viewerFlavor: 'v2-shared' },
      );

      const shared = newPaneCommands()[0]?.at(-1) ?? '';
      expect(shared).toContain('--session');
      expect(shared).not.toContain('--server');
      expect(shared).not.toContain('attach');
      // No /proc bridge outside v2-remote.
      expect(shared).not.toContain('/proc/');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  test('viewer "mini" runs opencode mini and pins the pane directory', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    await zellij.spawnPane(
      'session-mini',
      'Mini worker',
      'http://localhost:4096',
      '/repo',
      { viewerFlavor: 'v2-shared', viewerSurface: 'mini' },
    );

    const args = newPaneCommands()[0] ?? [];
    // Mini commands omit the directory, so the pane pins it with `--cwd`.
    const cwdIndex = args.indexOf('--cwd');
    expect(cwdIndex).toBeGreaterThan(-1);
    expect(args[cwdIndex + 1]).toBe('/repo');
    const cmd = args.at(-1) ?? '';
    expect(cmd).toContain("opencode mini --session 'session-mini'");
    expect(cmd).not.toContain('/repo');
  });

  test('fails closed with one diagnostic when the password bridge cannot run (non-Linux)', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
    try {
      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60);

      const first = await zellij.spawnPane(
        'session-1',
        'Remote worker',
        'http://localhost:4096',
        '/repo',
        { viewerFlavor: 'v2-remote', viewerPassword: 'pw' },
      );
      const second = await zellij.spawnPane(
        'session-2',
        'Remote worker 2',
        'http://localhost:4096',
        '/repo',
        { viewerFlavor: 'v2-remote', viewerPassword: 'pw' },
      );

      expect(first).toEqual({ success: false, error: 'unavailable' });
      expect(second).toEqual({ success: false, error: 'unavailable' });
      // Fail closed: no pane is created.
      expect(newPaneCommands()).toHaveLength(0);

      // Exactly one structured diagnostic per process, carrying the reason.
      const diagnostics = logMock.mock.calls.filter((call: unknown[]) =>
        JSON.stringify(call).includes('password-bridge-requires-linux'),
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.[0]).toBe(
        '[zellij] spawnPane: viewer password bridge unavailable',
      );
      expect(diagnostics[0]?.[1]).toEqual({
        stage: 'viewer-secret',
        reason: 'password-bridge-requires-linux',
        platform: 'darwin',
      });
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  test('reports failure when zellij does not return a terminal pane id', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'plugin_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
  });

  test('new-pane retries without --direction when a directed create is silently dropped', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);
    let newPaneCalls = 0;

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        newPaneCalls++;
        if (newPaneCalls === 1) {
          // Zellij drops the split silently: exit 0, no terminal_ id.
          return createSpawnResult(0, '');
        }
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: 'terminal_2' });

    const newPaneCmds = newPaneCommands();
    expect(newPaneCmds).toHaveLength(2);
    expect(newPaneCmds[0]).toContain('--direction');
    // The fallback keeps session addressing, the same-tab anchor, the pane
    // name, close-on-exit, and the command part, but drops the direction hint
    // so Zellij picks the largest free space.
    expect(newPaneCmds[1]).not.toContain('--direction');
    expect(newPaneCmds[1]).toContain('--session');
    expect(newPaneCmds[1]).toContain(SESSION_NAME);
    expect(newPaneCmds[1]).toContain('--tab-id');
    expect(newPaneCmds[1]).toContain('--name');
    expect(newPaneCmds[1]).toContain('--close-on-exit');
    expect(newPaneCmds[1].join(' ')).toContain('opencode attach');
  });

  test('new-pane reports failure when both the directed create and the fallback fail', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'plugin_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });

    const newPaneCmds = newPaneCommands();
    expect(newPaneCmds).toHaveLength(2);
    expect(newPaneCmds[0]).toContain('--direction');
    expect(newPaneCmds[1]).not.toContain('--direction');
  });

  test('does not create a pane when the parent tab cannot be resolved', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(1, '', 'list failed');
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );

    // No anchor target -> no multiplexer command is issued; the adapter never
    // guesses the focused tab.
    expect(result).toEqual({ success: false, error: 'not_found' });
    expect(newPaneCommands()).toHaveLength(0);
  });

  test('retries a failed parent tab lookup on the next spawn', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);
    let listPanesCalls = 0;

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        listPanesCalls++;
        if (listPanesCalls === 1) {
          return createSpawnResult(1, '', 'list failed');
        }
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    const first = await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );
    const second = await zellij.spawnPane(
      'session-2',
      'Same tab worker 2',
      'http://localhost:4096',
      '/repo',
    );

    expect(first).toEqual({ success: false, error: 'not_found' });
    expect(second).toEqual({ success: true, paneId: 'terminal_2' });

    // A failed lookup is NOT cached as permanent null: the second spawn
    // queries again and targets the resolved parent tab.
    expect(listPanesCalls).toBe(2);
    const newPaneCmds = newPaneCommands();
    expect(newPaneCmds).toHaveLength(1);
    const tabIdArgIndex = newPaneCmds[0].indexOf('--tab-id');
    expect(tabIdArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCmds[0][tabIdArgIndex + 1]).toBe('0');
  });

  test('caches a successful parent tab lookup across spawns', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);
    let listPanesCalls = 0;

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        listPanesCalls++;
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );
    await zellij.spawnPane(
      'session-2',
      'Same tab worker 2',
      'http://localhost:4096',
      '/repo',
    );

    expect(listPanesCalls).toBe(1);
    for (const command of newPaneCommands()) {
      const tabIdArgIndex = command.indexOf('--tab-id');
      expect(tabIdArgIndex).toBeGreaterThanOrEqual(0);
      expect(command[tabIdArgIndex + 1]).toBe('0');
    }
  });

  test('issues no zellij command when ZELLIJ_PANE_ID is missing', async () => {
    delete process.env.ZELLIJ_PANE_ID;

    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    const result = await zellij.spawnPane(
      'session-1',
      'Unanchored worker',
      'http://localhost:4096',
      '/repo',
    );

    // Unresolvable anchor -> fail closed with a distinguishable reason and
    // zero process spawns (not even binary discovery).
    expect(result).toEqual({ success: false, error: 'not_found' });
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
  });

  test('issues no zellij command when ZELLIJ_SESSION_NAME is missing', async () => {
    delete process.env.ZELLIJ_SESSION_NAME;

    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    const result = await zellij.spawnPane(
      'session-1',
      'Unaddressed worker',
      'http://localhost:4096',
      '/repo',
    );

    // Without an explicit session there is no unambiguous target: no command
    // is issued and the failure is distinguishable.
    expect(result).toEqual({ success: false, error: 'not_found' });
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
  });

  test('accepts terminal-prefixed parent pane ids', async () => {
    process.env.ZELLIJ_PANE_ID = 'terminal_0';

    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = newPaneCommands()[0];
    const tabIdArgIndex = newPaneCommand.indexOf('--tab-id');

    expect(tabIdArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand[tabIdArgIndex + 1]).toBe('0');
  });

  test('main-horizontal layout opens same-tab panes down', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-horizontal', 60);

    await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = newPaneCommands()[0];
    const directionArgIndex = newPaneCommand.indexOf('--direction');

    expect(directionArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand[directionArgIndex + 1]).toBe('down');
  });

  test('even-horizontal layout uses zellij native same-tab pane placement', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('even-horizontal', 60);

    await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(newPaneCommands()[0]).not.toContain('--direction');
  });

  test('even-vertical layout uses zellij native same-tab pane placement', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('even-vertical', 60);

    await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(newPaneCommands()[0]).not.toContain('--direction');
  });

  test('tiled layout uses zellij native same-tab pane placement', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('tiled', 60);

    await zellij.spawnPane(
      'session-1',
      'Same tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(newPaneCommands()[0]).not.toContain('--direction');
  });

  test('concurrent spawnPane calls each create their own pane in the parent tab', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);
    let newPaneCalls = 0;

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        newPaneCalls++;
        return createSpawnResult(0, `terminal_${newPaneCalls + 1}\n`);
      }
      return createSpawnResult();
    });

    const [firstResult, secondResult] = await Promise.all([
      zellij.spawnPane(
        'session-1',
        'First worker',
        'http://localhost:4096',
        '/repo',
      ),
      zellij.spawnPane(
        'session-2',
        'Second worker',
        'http://localhost:4096',
        '/repo',
      ),
    ]);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);

    const newPaneCmds = newPaneCommands();
    expect(newPaneCmds).toHaveLength(2);
    for (const command of newPaneCmds) {
      expect(command).toContain('--session');
      expect(command).toContain(SESSION_NAME);
      const tabIdArgIndex = command.indexOf('--tab-id');
      expect(tabIdArgIndex).toBeGreaterThanOrEqual(0);
      expect(command[tabIdArgIndex + 1]).toBe('0');
    }
    const joined = newPaneCmds.map((command) => command.join(' '));
    expect(joined.some((command) => command.includes("'session-1'"))).toBe(
      true,
    );
    expect(joined.some((command) => command.includes("'session-2'"))).toBe(
      true,
    );
  });

  describe('Zellij 0.45+ placement', () => {
    test('sizes the real parent once and stacks four concurrent viewers without focus changes', async () => {
      process.env.ZELLIJ_PANE_ID = 'terminal_7';
      const column = (width: number) => [
        tile(7, 20, 4, width, 60),
        tile(10, 20 + width, 4, 190 - width, 60),
      ];
      const sizedParent = tile(7, 20, 4, 114, 60);
      const twoChildren = [
        sizedParent,
        tile(10, 134, 4, 76, 30),
        tile(11, 134, 34, 76, 30),
      ];
      const threeChildren = [
        sizedParent,
        tile(10, 134, 4, 76, 15),
        tile(12, 134, 19, 76, 15),
        tile(11, 134, 34, 76, 30),
      ];
      const snapshots = [
        [tile(7, 20, 4, 190, 60)],
        column(95),
        column(105),
        column(114),
        column(114),
        column(114),
        twoChildren,
        twoChildren,
        threeChildren,
        threeChildren,
        [
          ...threeChildren.slice(0, -1),
          tile(11, 134, 34, 76, 15),
          tile(13, 134, 49, 76, 15),
        ],
      ];
      let nextId = 10;
      mockStandardImpl('0.46.1', (command) => {
        if (command.includes('list-panes')) {
          return createSpawnResult(0, JSON.stringify(snapshots.shift()));
        }
        if (command.includes('new-pane')) {
          return createSpawnResult(0, `terminal_${nextId++}\n`);
        }
      });

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60);
      const results = await Promise.all(
        [10, 11, 12, 13].map((id) =>
          zellij.spawnPane(
            `child-${id}`,
            `Worker ${id}`,
            'http://localhost:4096',
            '/repo',
          ),
        ),
      );
      expect(results).toEqual(
        [10, 11, 12, 13].map((id) => ({
          success: true,
          paneId: `terminal_${id}`,
        })),
      );
      expect(snapshots).toHaveLength(0);
      expect(placementCommands()).toEqual(
        ['7', '10', '10', '11'].map((anchor, index) => ({
          session: ['--session', SESSION_NAME],
          noFocus: true,
          tabTarget: false,
          paneTarget: false,
          anchor,
          direction: index === 0 ? 'right' : 'down',
        })),
      );
      const actions = commands().filter((command) => command[3] === 'action');
      expect(
        actions
          .map((cmd) => cmd[4])
          .filter((action) => action !== 'list-panes'),
      ).toEqual([
        'new-pane',
        'resize',
        'resize',
        'new-pane',
        'new-pane',
        'new-pane',
      ]);
      for (const command of actions.filter((cmd) => cmd[4] === 'resize')) {
        expect(command.slice(1)).toEqual([
          '--session',
          SESSION_NAME,
          'action',
          'resize',
          '--pane-id',
          'terminal_7',
          'increase',
          'right',
        ]);
      }
      expect(process.env.ZELLIJ_PANE_ID).toBe('terminal_7');
    });

    test('shrinks the parent by growing the child and keeps the nearest reachable width', async () => {
      const widths = [190, 95, 95, 86, 76, 86, 86];
      mockStandardImpl('0.45.0', (command) => {
        if (!command.includes('list-panes')) return;
        const width = widths.shift() ?? 0;
        return createSpawnResult(
          0,
          JSON.stringify([
            tile(0, 0, 0, width, 60),
            ...(width === 190 ? [] : [tile(2, width, 0, 190 - width, 60)]),
          ]),
        );
      });

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 43);
      expect(
        await zellij.spawnPane(
          'child',
          'Worker',
          'http://localhost:4096',
          '/repo',
        ),
      ).toEqual({
        success: true,
        paneId: 'terminal_2',
      });
      expect(widths).toHaveLength(0);
      expect(
        commands()
          .filter((cmd) => cmd[4] === 'resize')
          .map((cmd) => cmd.slice(5)),
      ).toEqual([
        ['--pane-id', 'terminal_2', 'increase', 'left'],
        ['--pane-id', 'terminal_2', 'increase', 'left'],
        ['--pane-id', 'terminal_0', 'increase', 'right'],
      ]);
    });

    test('uses a surviving owned tile after manual close, never falling back to an unrelated tile', async () => {
      let panes = [tile(0, 0, 0, 190, 60)];
      let nextId = 2;
      let dropSplit = false;
      mockStandardImpl('0.46.1', (command) => {
        if (command.includes('list-panes')) {
          return createSpawnResult(0, JSON.stringify(panes));
        }
        if (!command.includes('new-pane')) return;
        if (dropSplit) return createSpawnResult();
        if (nextId === 2) {
          panes = [tile(0, 0, 0, 95, 60), tile(2, 95, 0, 95, 60)];
        } else if (nextId === 3) {
          panes = [panes[0], tile(2, 95, 0, 95, 30), tile(3, 95, 30, 95, 30)];
        } else if (nextId === 4) {
          panes = [tile(0, 20, 0, 85, 60), tile(4, 105, 0, 85, 60), panes[1]];
        }
        return createSpawnResult(0, `terminal_${nextId++}\n`);
      });

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 50);
      const spawn = (id: string) =>
        zellij.spawnPane(id, 'Worker', 'http://localhost:4096', '/repo');
      expect((await spawn('first')).success).toBe(true);
      expect((await spawn('second')).success).toBe(true);

      // The first owned child closed. Another right tile is taller, but
      // only the surviving owned child can receive a down split.
      panes = [
        tile(0, 0, 0, 95, 60),
        tile(3, 95, 45, 95, 15),
        tile(9, 95, 0, 95, 45),
      ];
      dropSplit = true;
      expect(await spawn('dropped')).toEqual({ success: false, error: 'hard' });
      dropSplit = false;

      // The survivor moves to another tab: do not treat it as the column.
      panes = [panes[0], { ...panes[1], tab_id: 1 }, panes[2]];
      expect(await spawn('displaced')).toEqual({
        success: false,
        error: 'invalid_state',
      });

      // With both owned tiles closed, the next viewer starts a new column
      // off the current parent rather than using stale geometry or a neighbor.
      panes = [tile(0, 20, 0, 170, 60), tile(9, 0, 0, 20, 60)];
      expect(await spawn('recreate')).toEqual({
        success: true,
        paneId: 'terminal_4',
      });
      expect(
        placementCommands().map(({ anchor, direction }) => [anchor, direction]),
      ).toEqual([
        ['0', 'right'],
        ['2', 'down'],
        ['3', 'down'],
        ['0', 'right'],
      ]);
      expect(commands().some((command) => command[4] === 'resize')).toBe(false);
    });

    test.each(['visible', 'hidden', 'missing', 'unreadable'] as const)(
      'checks that the parent tab floating layer is hidden in Zellij 0.45.x (%s)',
      async (state) => {
        let created = false;
        mockStandardImpl('0.45.3', (command) => {
          if (command[4] === 'list-tabs') {
            if (state === 'unreadable') return createSpawnResult(1);
            return createSpawnResult(
              0,
              JSON.stringify([
                { tab_id: 0, are_floating_panes_visible: state === 'hidden' },
                ...(state === 'missing'
                  ? []
                  : [
                      {
                        tab_id: 7,
                        are_floating_panes_visible: state === 'visible',
                      },
                    ]),
              ]),
            );
          }
          if (command[4] === 'list-panes') {
            const panes = created
              ? [tile(0, 0, 0, 95, 60), tile(2, 95, 0, 95, 60)]
              : [tile(0, 0, 0, 190, 60)];
            return createSpawnResult(
              0,
              JSON.stringify(panes.map((pane) => ({ ...pane, tab_id: 7 }))),
            );
          }
          if (command[4] === 'new-pane') created = true;
        });

        const { ZellijMultiplexer } = await importFreshZellij();
        const zellij = new ZellijMultiplexer('main-vertical', 50);
        const result = await zellij.spawnPane(
          'child',
          'Worker',
          'http://localhost:4096',
          '/repo',
        );
        expect(result).toEqual(
          state === 'hidden'
            ? { success: true, paneId: 'terminal_2' }
            : { success: false, error: 'invalid_state' },
        );
        expect(newPaneCommands()).toHaveLength(state === 'hidden' ? 1 : 0);
        expect(
          commands().filter((command) => command[4] === 'list-tabs'),
        ).toEqual([
          [
            '/usr/bin/zellij',
            '--session',
            SESSION_NAME,
            'action',
            'list-tabs',
            '--json',
            '--state',
          ],
        ]);
      },
    );

    test.each([
      'absent',
      'delayed',
      'misplaced',
      'exited',
      'unreadable',
    ] as const)(
      'verifies a reported 0.45.0 down split against %s geometry',
      async (state) => {
        let creates = 0;
        let postSplitReads = 0;
        let closed = false;
        const column = [tile(0, 0, 0, 95, 60), tile(2, 95, 0, 95, 60)];
        const child = tile(14, 95, 30, 95, 30);
        mockStandardImpl('0.45.0', (command) => {
          if (command[4] === 'new-pane') {
            return createSpawnResult(
              0,
              ++creates === 1 ? 'terminal_2' : 'terminal_14',
            );
          }
          if (command[4] === 'close-pane') {
            closed = true;
            return createSpawnResult();
          }
          if (command[4] !== 'list-panes') return;
          if (creates === 0) {
            return createSpawnResult(
              0,
              JSON.stringify([tile(0, 0, 0, 190, 60)]),
            );
          }
          if (creates === 2) {
            postSplitReads++;
            if (state === 'misplaced' && postSplitReads > 1 && !closed) {
              return createSpawnResult(
                0,
                JSON.stringify([...column, tile(14, 0, 59, 190, 1)]),
              );
            }
            if (
              state === 'exited' ||
              (state === 'delayed' && postSplitReads === 2)
            ) {
              return createSpawnResult(
                0,
                JSON.stringify([
                  column[0],
                  tile(2, 95, 0, 95, 30),
                  { ...child, exited: state === 'exited' },
                ]),
              );
            }
            if (state === 'unreadable' && postSplitReads === 2) {
              return createSpawnResult(1, '', 'list failed');
            }
          }
          return createSpawnResult(0, JSON.stringify(column));
        });

        const { ZellijMultiplexer } = await importFreshZellij();
        const zellij = new ZellijMultiplexer('main-vertical', 50);
        const spawn = (id: string) =>
          zellij.spawnPane(id, 'Worker', 'http://localhost:4096', '/repo');
        expect(await spawn('first')).toEqual({
          success: true,
          paneId: 'terminal_2',
        });
        const result = await spawn('second');
        if (state === 'misplaced') {
          expect(result).toEqual({
            success: false,
            error: 'invalid_state',
          });
          expect(postSplitReads).toBe(5); // Absent, misplaced twice, then absent twice.
        } else {
          expect(result).toEqual(
            state === 'absent' || state === 'exited'
              ? {
                  success: false,
                  error: 'hard',
                  ...(state === 'absent' ? { creationUncertain: true } : {}),
                }
              : { success: true, paneId: 'terminal_14' },
          );
          expect(postSplitReads).toBe(state === 'exited' ? 1 : 2);
        }
        expect(
          placementCommands().map(({ anchor, direction }) => [
            anchor,
            direction,
          ]),
        ).toEqual([
          ['0', 'right'],
          ['2', 'down'],
        ]);
        const cleanup = commands()
          .filter((cmd) => cmd[4] === 'write' || cmd[4] === 'close-pane')
          .map((cmd) => cmd.slice(4, 7));
        expect(cleanup).toEqual(
          state === 'misplaced'
            ? [['close-pane', '--pane-id', 'terminal_14']]
            : [],
        );
      },
    );

    test.each([
      [0, 'absent'],
      [1, 'listed'],
      [1, 'absent'],
      [2, 'unreadable'],
    ] as const)(
      'observes rollback (close exit %d, pane %s)',
      async (closeExit, afterClose) => {
        let panes = [tile(0, 0, 0, 190, 60)];
        let postCloseReads: number | undefined;
        mockStandardImpl('0.46.1', (command) => {
          switch (command[4]) {
            case 'list-panes':
              if (postCloseReads !== undefined) {
                postCloseReads++;
                if (afterClose === 'unreadable' && postCloseReads === 1) {
                  return createSpawnResult(1, '', 'list failed');
                }
              }
              return createSpawnResult(0, JSON.stringify(panes));
            case 'new-pane':
              panes = [tile(0, 0, 0, 95, 60), tile(2, 95, 0, 95, 60)];
              return createSpawnResult(0, 'terminal_2');
            case 'resize':
              panes = [tile(0, 0, 0, 190, 60), tile(2, 0, 59, 190, 1)];
              return createSpawnResult();
            case 'close-pane':
              postCloseReads = 0;
              if (afterClose === 'absent') panes = [tile(0, 0, 0, 190, 60)];
              return createSpawnResult(closeExit);
          }
        });

        const { ZellijMultiplexer } = await importFreshZellij();
        const zellij = new ZellijMultiplexer('main-vertical', 40);
        const spawn = (id: string) =>
          zellij.spawnPane(id, 'Worker', 'http://localhost:4096', '/repo');
        const result = await spawn('child');
        expect(result).toEqual(
          afterClose === 'absent'
            ? {
                success: false,
                error: 'invalid_state',
                ...(closeExit === 0 ? {} : { creationUncertain: true }),
              }
            : { success: true, paneId: 'terminal_2' },
        );
        expect(postCloseReads).toBe(afterClose === 'unreadable' ? 1 : 2);
        if (afterClose !== 'absent') {
          expect(logMock).toHaveBeenCalledWith(
            '[zellij] spawnPane: misplaced viewer rollback not confirmed',
            { paneId: 'terminal_2' },
          );
          // The tracked viewer is present but its placement is not an anchor.
          expect(await spawn('next')).toEqual({
            success: false,
            error: 'invalid_state',
          });
          expect(newPaneCommands()).toHaveLength(1);
        }
        const cleanup = commands().filter(
          (cmd) => cmd[4] === 'write' || cmd[4] === 'close-pane',
        );
        expect(cleanup.map((cmd) => cmd.slice(1))).toEqual([
          [
            '--session',
            SESSION_NAME,
            'action',
            'close-pane',
            '--pane-id',
            'terminal_2',
          ],
        ]);
      },
    );

    test('does not treat a failed geometry read as a bad placement', async () => {
      let created = false;
      mockStandardImpl('0.46.1', (command) => {
        if (command[4] === 'list-panes') {
          return created
            ? createSpawnResult(1, '', 'list failed')
            : createSpawnResult(0, JSON.stringify([tile(0, 0, 0, 190, 60)]));
        }
        if (command[4] === 'new-pane') created = true;
      });

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer();
      expect(
        await zellij.spawnPane(
          'child',
          'Worker',
          'http://localhost:4096',
          '/repo',
        ),
      ).toEqual({
        success: true,
        paneId: 'terminal_2',
      });
      expect(
        commands().some((cmd) =>
          ['resize', 'write', 'close-pane'].includes(cmd[4]),
        ),
      ).toBe(false);
    });

    test.each([
      ['main-horizontal', 'down'],
      ['even-horizontal', undefined],
      ['even-vertical', undefined],
      ['tiled', undefined],
    ] as const)(
      'keeps %s same-tab placement with no focus on every attempt',
      async (layout, direction) => {
        let attempts = 0;
        mockStandardImpl('0.45.0', (command) => {
          if (command.includes('new-pane') && direction && attempts++ === 0) {
            return createSpawnResult();
          }
        });

        const { ZellijMultiplexer } = await importFreshZellij();
        const zellij = new ZellijMultiplexer(layout, 60);
        expect(
          (
            await zellij.spawnPane(
              'child',
              'Worker',
              'http://localhost:4096',
              '/repo',
            )
          ).success,
        ).toBe(true);
        expect(newPaneCommands()).toHaveLength(direction ? 2 : 1);
        expect(commands().some((cmd) => cmd[4] === 'list-tabs')).toBe(false);
        for (const [index, command] of newPaneCommands().entries()) {
          expect(command.slice(5, 8)).toEqual(['--tab-id', '0', '--no-focus']);
          if (direction && index === 0) {
            expect(command.slice(8, 10)).toEqual(['--direction', direction]);
          } else {
            expect(command).not.toContain('--direction');
          }
        }
      },
    );
  });

  test('closePane addresses the pane within the explicit zellij session', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    const closed = await zellij.closePane('terminal_2');

    expect(closed).toBe(true);

    const writeCmd = commands().find(
      (command) =>
        command.includes('write') && !command.includes('write-chars'),
    );
    expect(writeCmd).toEqual([
      '/usr/bin/zellij',
      '--session',
      SESSION_NAME,
      'action',
      'write',
      '--pane-id',
      'terminal_2',
      '\u0003',
    ]);

    const closeCmd = commands().find((command) =>
      command.includes('close-pane'),
    );
    expect(closeCmd).toEqual([
      '/usr/bin/zellij',
      '--session',
      SESSION_NAME,
      'action',
      'close-pane',
      '--pane-id',
      'terminal_2',
    ]);
  });

  test('closePane fails closed without a session name', async () => {
    delete process.env.ZELLIJ_SESSION_NAME;

    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    expect(await zellij.closePane('terminal_2')).toBe(false);
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
  });

  test('keeps the full encoded FR-8 title as the new pane name', async () => {
    const encoded = 'omosc:4242:ses_f41e46f05ffeoEESP7f24NJ9d6';
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    await zellij.spawnPane('child', encoded, 'http://localhost:4096', '/repo');

    const nameIndex = newPaneCommands()[0]?.indexOf('--name') ?? -1;
    expect(newPaneCommands()[0]?.[nameIndex + 1]).toBe(encoded);
  });

  test('listPanesWithTitles parses titles for terminal panes only', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.45.1\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(
          0,
          JSON.stringify([
            { id: 0, is_plugin: true, tab_id: 0, title: 'zellij:link' },
            { id: 1, is_plugin: false, tab_id: 0, title: 'user-shell' },
            {
              id: 4,
              is_plugin: false,
              tab_id: 1,
              title: 'omosc:123:ses_abc',
            },
          ]),
        );
      }
      return createSpawnResult();
    });
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    expect(await zellij.listPanesWithTitles()).toEqual([
      { paneId: 'terminal_1', title: 'user-shell' },
      { paneId: 'terminal_4', title: 'omosc:123:ses_abc' },
    ]);
  });

  test('sweep closes only the dead-owner terminal pane (FR-8)', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.45.1\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(
          0,
          JSON.stringify([
            { id: 1, is_plugin: false, tab_id: 0, title: 'user-shell' },
            { id: 2, is_plugin: false, tab_id: 0, title: 'omosc:999:ses_gone' },
            {
              id: 3,
              is_plugin: false,
              tab_id: 0,
              title: 'omosc:4242:ses_gone',
            },
            {
              id: 4,
              is_plugin: false,
              tab_id: 0,
              title: 'omosc:999:ses_alive',
            },
          ]),
        );
      }
      return createSpawnResult();
    });
    const { ZellijMultiplexer } = await importFreshZellij();
    const { sweepLeftoverPanes } = await import('../client/sweep');
    const zellij = new ZellijMultiplexer('main-vertical', 60);

    const stats = await sweepLeftoverPanes({
      adapter: zellij,
      isProcessAlive: (pid) => pid !== 999,
      isSessionTerminal: async (child) => child === 'ses_gone',
    });

    expect(stats.closed).toBe(1);
    const closes = commands().filter((command) =>
      command.includes('close-pane'),
    );
    expect(closes).toHaveLength(1);
    expect(closes[0]).toContain('terminal_2');
    // Explicit session addressing is kept for the sweep close too.
    expect(closes[0]?.slice(1, 3)).toEqual(['--session', SESSION_NAME]);
  });
});
