import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

const crossSpawnMock = mock((_command: string[]) => createSpawnResult());

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
function mockStandardImpl(version: string): void {
  crossSpawnMock.mockImplementation((command: string[]) => {
    if (command[0] === 'which' || command[0] === 'where') {
      return createSpawnResult(0, '/usr/bin/zellij\n');
    }
    if (command.includes('--version')) {
      return createSpawnResult(0, `zellij ${version}\n`);
    }
    if (command.includes('list-panes')) {
      return createSpawnResult(0, createPaneListJson());
    }
    if (command.includes('new-pane')) {
      return createSpawnResult(0, 'terminal_2\n');
    }
    return createSpawnResult();
  });
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
      "opencode attach 'http://localhost:4096' --session 'session-1' --dir '/repo'",
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
