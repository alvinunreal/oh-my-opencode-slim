import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MultiplexerLayout } from '../../config/schema';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

const logMock = mock(() => {});
const crossSpawnMock = mock((_command: string[]) => createSpawnResult());

mock.module('../../utils/logger', () => ({
  log: logMock,
}));

mock.module('../../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

let importCounter = 0;

const PARENT_WINDOW_ID = '4';

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

async function importFreshKitty() {
  return import(`./index?test=${importCounter++}`);
}

function commands(): string[][] {
  return crossSpawnMock.mock.calls.map((call) => call[0] as string[]);
}

/** Commands that talk to the kitty instance (excludes binary discovery). */
function kittyCommands(): string[][] {
  return commands().filter((command) => command[0] !== 'which');
}

function commandContaining(name: string): string[] | undefined {
  return kittyCommands().find((command) => command.includes(name));
}

function installDefaultMock(): void {
  crossSpawnMock.mockImplementation((command: string[]) => {
    if (command[0] === 'which' && command[1] === 'kitten') {
      return createSpawnResult(0, '/usr/bin/kitten\n');
    }
    if (command[0] === 'which' && command[1] === 'kitty') {
      return createSpawnResult(1, '');
    }
    if (command.includes('launch')) return createSpawnResult(0, '42\n');
    return createSpawnResult();
  });
}

describe('KittyMultiplexer', () => {
  const originalKittyPid = process.env.KITTY_PID;
  const originalKittyWindowId = process.env.KITTY_WINDOW_ID;
  const originalKittyListenOn = process.env.KITTY_LISTEN_ON;

  beforeEach(() => {
    process.env.KITTY_PID = '12345';
    process.env.KITTY_WINDOW_ID = PARENT_WINDOW_ID;
    // kitty exports KITTY_LISTEN_ON to its children; the backend requires it.
    process.env.KITTY_LISTEN_ON = 'unix:/tmp/kitty-rc-test';

    logMock.mockClear();
    crossSpawnMock.mockReset();
    installDefaultMock();
  });

  afterEach(() => {
    process.env.KITTY_PID = originalKittyPid;
    process.env.KITTY_WINDOW_ID = originalKittyWindowId;
    process.env.KITTY_LISTEN_ON = originalKittyListenOn;
  });

  test('isAvailable returns true when kitten is found', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();
    expect(await kitty.isAvailable()).toBe(true);
  });

  test('isAvailable returns false when kitten is not found', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') return createSpawnResult(1, '');
      return createSpawnResult();
    });
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();
    expect(await kitty.isAvailable()).toBe(false);
  });

  test('isInsideSession follows KITTY_WINDOW_ID, not KITTY_PID', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    expect(kitty.isInsideSession()).toBe(true);

    delete process.env.KITTY_WINDOW_ID;
    expect(kitty.isInsideSession()).toBe(false);
    expect(process.env.KITTY_PID).toBe('12345');
  });

  test('spawnPane issues no command when KITTY_WINDOW_ID is missing', async () => {
    delete process.env.KITTY_WINDOW_ID;
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    const result = await kitty.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'not_found' });
    expect(commands()).toHaveLength(0);
  });

  test('spawnPane issues no kitty command when KITTY_LISTEN_ON is missing', async () => {
    delete process.env.KITTY_LISTEN_ON;
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    const result = await kitty.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'unavailable' });
    expect(kittyCommands()).toHaveLength(0);
  });

  test('spawnPane anchors to the parent window tab and never the active tab', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    const result = await kitty.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: '42' });

    const layoutCommand = commandContaining('goto-layout');
    expect(layoutCommand).toEqual([
      '/usr/bin/kitten',
      '@',
      'goto-layout',
      `--match=window_id:${PARENT_WINDOW_ID}`,
      'tall',
    ]);

    const launchCommand = commandContaining('launch');
    expect(launchCommand).toContain('--type=window');
    expect(launchCommand).toContain(`--match=window_id:${PARENT_WINDOW_ID}`);
    expect(launchCommand).toContain(`--next-to=id:${PARENT_WINDOW_ID}`);
    expect(launchCommand).toContain('--location=after');
    expect(launchCommand).toContain('--keep-focus');
    expect(launchCommand).toContain('--title=First worker');
    expect(launchCommand).toContain('--cwd=/repo');

    // No tab is ever switched or created implicitly.
    for (const command of kittyCommands()) {
      if (command.includes('goto-layout') || command.includes('launch')) {
        expect(command).toContain(`--match=window_id:${PARENT_WINDOW_ID}`);
      }
      expect(command).not.toContain('--type=tab');
      expect(command).not.toContain('activate-tab');
    }
  });

  test('spawnPane parses integer window id from launch stdout', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    const result = await kitty.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result.success).toBe(true);
    expect(result.paneId).toBe('42');
  });

  test('spawnPane returns failure when exit code is non-zero', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' && command[1] === 'kitten') {
        return createSpawnResult(0, '/usr/bin/kitten\n');
      }
      if (command.includes('launch')) {
        return createSpawnResult(1, '', 'launch failed');
      }
      return createSpawnResult();
    });
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    const result = await kitty.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
  });

  test('closePane issues send-key then close-window by window id', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    const closed = await kitty.closePane('42');
    expect(closed).toBe(true);

    const cmds = kittyCommands();
    const sendKeyArgs = cmds.find((c) => c.includes('send-key'));
    const closeArgs = cmds.find((c) => c.includes('close-window'));

    expect(sendKeyArgs).toEqual([
      '/usr/bin/kitten',
      '@',
      'send-key',
      '--match=id:42',
      'ctrl+c',
    ]);
    expect(closeArgs).toEqual([
      '/usr/bin/kitten',
      '@',
      'close-window',
      '--match=id:42',
    ]);
    for (const command of cmds) {
      expect(command.join(' ')).not.toContain('window_id:');
    }
  });

  test('closePane returns false and issues no command outside kitty', async () => {
    delete process.env.KITTY_WINDOW_ID;
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    const closed = await kitty.closePane('42');
    expect(closed).toBe(false);
    expect(commands()).toHaveLength(0);
  });

  test('applyLayout maps each layout with an explicit parent-window match', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const cases: Array<[MultiplexerLayout, string]> = [
      ['main-vertical', 'tall'],
      ['main-horizontal', 'fat'],
      ['tiled', 'grid'],
      ['even-horizontal', 'horizontal'],
      ['even-vertical', 'vertical'],
    ];

    for (const [layout, kittyLayout] of cases) {
      crossSpawnMock.mockReset();
      installDefaultMock();
      const kitty = new KittyMultiplexer();
      await kitty.applyLayout(layout, 60);

      expect(commandContaining('goto-layout')).toEqual([
        '/usr/bin/kitten',
        '@',
        'goto-layout',
        `--match=window_id:${PARENT_WINDOW_ID}`,
        kittyLayout,
      ]);
    }
  });

  test('applyLayout ignores main_pane_size', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    await kitty.applyLayout('main-vertical', 80);

    for (const command of kittyCommands()) {
      expect(command).not.toContain('--bias');
      expect(command.join(' ')).not.toContain('80');
    }
  });

  test('applyLayout is a no-op when KITTY_WINDOW_ID is missing', async () => {
    delete process.env.KITTY_WINDOW_ID;
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    await kitty.applyLayout('tiled', 60);

    expect(kittyCommands()).toHaveLength(0);
  });

  test('applyLayout switches layout after a spawn', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer('main-vertical');

    // First spawn applies 'tall'
    await kitty.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );
    // applyLayout to a different layout must re-apply (goto-layout grid)
    await kitty.applyLayout('tiled', 60);

    const layoutCmds = kittyCommands().filter((c) => c.includes('goto-layout'));
    expect(layoutCmds).toHaveLength(2);
    expect(layoutCmds[0]).toContain('tall');
    expect(layoutCmds[1]).toContain('grid');
    for (const command of layoutCmds) {
      expect(command).toContain(`--match=window_id:${PARENT_WINDOW_ID}`);
    }
  });

  test('keeps the full encoded FR-8 title at launch', async () => {
    const encoded = 'omosc:4242:ses_f41e46f05ffeoEESP7f24NJ9d6';
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer('main-vertical', 60);

    await kitty.spawnPane('child', encoded, 'http://localhost:4096', '/repo');

    const launch = commandContaining('launch');
    expect(launch).toContain(`--title=${encoded}`);
  });

  test('listPanesWithTitles flattens kitty ls window titles', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' && command[1] === 'kitten') {
        return createSpawnResult(0, '/usr/bin/kitten\n');
      }
      if (command[0] === 'which') return createSpawnResult(1, '');
      if (command.includes('ls')) {
        return createSpawnResult(
          0,
          JSON.stringify([
            {
              id: 1,
              tabs: [
                {
                  id: 1,
                  windows: [
                    { id: 4, title: 'user-shell' },
                    { id: 5, title: 'omosc:123:ses_abc' },
                  ],
                },
              ],
            },
          ]),
        );
      }
      return createSpawnResult();
    });
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer('main-vertical', 60);

    expect(await kitty.listPanesWithTitles()).toEqual([
      { paneId: '4', title: 'user-shell' },
      { paneId: '5', title: 'omosc:123:ses_abc' },
    ]);
  });

  test('listPanesWithTitles issues no command without KITTY_LISTEN_ON', async () => {
    delete process.env.KITTY_LISTEN_ON;
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer('main-vertical', 60);

    expect(await kitty.listPanesWithTitles()).toEqual([]);
    expect(commands()).toHaveLength(0);
  });

  test('sweep closes only the dead-owner terminal window (FR-8)', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' && command[1] === 'kitten') {
        return createSpawnResult(0, '/usr/bin/kitten\n');
      }
      if (command[0] === 'which') return createSpawnResult(1, '');
      if (command.includes('ls')) {
        return createSpawnResult(
          0,
          JSON.stringify([
            {
              id: 1,
              tabs: [
                {
                  id: 1,
                  windows: [
                    { id: 4, title: 'user-shell' },
                    { id: 5, title: 'omosc:999:ses_gone' },
                    { id: 6, title: 'omosc:4242:ses_gone' },
                    { id: 7, title: 'omosc:999:ses_alive' },
                  ],
                },
              ],
            },
          ]),
        );
      }
      return createSpawnResult();
    });
    const { KittyMultiplexer } = await importFreshKitty();
    const { sweepLeftoverPanes } = await import('../client/sweep');
    const kitty = new KittyMultiplexer('main-vertical', 60);

    const stats = await sweepLeftoverPanes({
      adapter: kitty,
      isProcessAlive: (pid) => pid !== 999,
      isSessionTerminal: async (child) => child === 'ses_gone',
    });

    expect(stats.closed).toBe(1);
    const closes = commands().filter((command) =>
      command.includes('close-window'),
    );
    expect(closes).toHaveLength(1);
    expect(closes[0]).toContain('--match=id:5');
  });
});
