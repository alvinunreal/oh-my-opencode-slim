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

const SOCKET = '/tmp/tmux-test/default';
const TMUX_ENV = `${SOCKET},123,0`;

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

async function importFreshTmux() {
  return import(`./index?test=${importCounter++}`);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function commands(): string[][] {
  return crossSpawnMock.mock.calls.map((call) => call[0] as string[]);
}

/** Commands that actually talk to a tmux server (excludes discovery/version). */
function tmuxCommands(): string[][] {
  return commands().filter(
    (command) => command[0] !== 'which' && !command.includes('-V'),
  );
}

function commandContaining(name: string): string[] | undefined {
  return tmuxCommands().find((command) => command.includes(name));
}

function expectExplicitSocket(command: string[] | undefined): void {
  expect(command).toBeDefined();
  expect(command?.[1]).toBe('-S');
  expect(command?.[2]).toBe(SOCKET);
}

function installDefaultMock(): void {
  crossSpawnMock.mockImplementation((command: string[]) => {
    if (command[0] === 'which') return createSpawnResult(0, '/usr/bin/tmux\n');
    if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
    if (command.includes('split-window')) return createSpawnResult(0, '%2\n');
    return createSpawnResult();
  });
}

/** Default discovery/split mock, but the close backstop exits with `code`. */
function installMockWithKillExit(code: number): void {
  crossSpawnMock.mockImplementation((command: string[]) => {
    if (command[0] === 'which') return createSpawnResult(0, '/usr/bin/tmux\n');
    if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
    if (command.includes('split-window')) return createSpawnResult(0, '%2\n');
    if (command.includes('kill-pane')) return createSpawnResult(code);
    return createSpawnResult();
  });
}

describe('TmuxMultiplexer', () => {
  const originalTmux = process.env.TMUX;
  const originalTmuxPane = process.env.TMUX_PANE;

  beforeEach(() => {
    process.env.TMUX = TMUX_ENV;
    process.env.TMUX_PANE = '%1';

    logMock.mockClear();
    crossSpawnMock.mockReset();
    installDefaultMock();
  });

  afterEach(async () => {
    // Let any debounced layout timer from this test fire before the next
    // test resets the spawn mock, so commands never leak across tests.
    if (crossSpawnMock.mock.calls.length > 0) await wait(300);
    process.env.TMUX = originalTmux;
    process.env.TMUX_PANE = originalTmuxPane;
  });

  test('isInsideSession follows TMUX_PANE, not TMUX', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer();

    expect(tmux.isInsideSession()).toBe(true);

    delete process.env.TMUX_PANE;
    expect(tmux.isInsideSession()).toBe(false);
  });

  test('spawnPane explicitly addresses the tmux server with -S <socket>', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'child-session',
      'Attached worker',
      'http://localhost:4096',
      '/repo',
    );

    const sent = tmuxCommands();
    expect(sent.length).toBeGreaterThan(0);
    for (const command of sent) {
      expectExplicitSocket(command);
    }

    const splitCommand = commandContaining('split-window');
    expect(splitCommand).toContain('%1');
    expect(splitCommand).toContain('/usr/bin/tmux');
  });

  test('spawnPane re-resolves the anchor from the environment at spawn time', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    // Construction-time TMUX_PANE is %1; the spawn-time value must win.
    const tmux = new TmuxMultiplexer('main-vertical', 60);
    process.env.TMUX_PANE = '%42';

    await tmux.spawnPane(
      'child-session',
      'Attached worker',
      'http://localhost:4096',
      '/repo',
      { parentSessionId: 'root-session-b' },
    );

    const splitCommand = commandContaining('split-window');
    expect(splitCommand).toContain('%42');
    expect(splitCommand).not.toContain('%1');
  });

  test('spawnPane splits in the direction implied by the layout', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const cases: Array<[MultiplexerLayout, string]> = [
      ['main-vertical', '-h'],
      ['main-horizontal', '-v'],
      ['even-horizontal', '-h'],
      ['even-vertical', '-v'],
      ['tiled', '-h'],
    ];

    for (const [layout, direction] of cases) {
      crossSpawnMock.mockReset();
      installDefaultMock();
      const tmux = new TmuxMultiplexer(layout, 60);
      await tmux.spawnPane(
        'child-session',
        'Attached worker',
        'http://localhost:4096',
        '/repo',
      );

      const splitCommand = commandContaining('split-window');
      const splitIndex = splitCommand?.indexOf('split-window') ?? -1;
      expect(splitIndex).toBeGreaterThanOrEqual(0);
      expect(splitCommand?.[splitIndex + 1]).toBe(direction);
    }
  });

  test('spawnPane issues no command when the tmux socket is missing', async () => {
    delete process.env.TMUX;
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    const result = await tmux.spawnPane(
      'child-session',
      'Attached worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'not_found' });
    expect(commands()).toHaveLength(0);
  });

  test('spawnPane issues no command when TMUX_PANE is missing', async () => {
    delete process.env.TMUX_PANE;
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    const result = await tmux.spawnPane(
      'child-session',
      'Attached worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'not_found' });
    expect(commands()).toHaveLength(0);
  });

  test('spawnPane renames the created pane with explicit addressing', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'child-session',
      'Attached worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(commandContaining('select-pane')).toEqual([
      '/usr/bin/tmux',
      '-S',
      SOCKET,
      'select-pane',
      '-t',
      '%2',
      '-T',
      'Attached worker',
    ]);
  });

  test('coalesces layout application after bursty pane spawns', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );
    await tmux.spawnPane(
      'session-2',
      'Second worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(
      commands().filter((command) => command.includes('select-layout')),
    ).toHaveLength(0);

    await wait(300);

    const layoutCommands = commands().filter((command) =>
      command.includes('select-layout'),
    );
    const sizeCommands = commands().filter((command) =>
      command.includes('set-window-option'),
    );

    expect(layoutCommands).toHaveLength(2);
    expect(sizeCommands).toHaveLength(1);
    expect(sizeCommands[0]).toContain('main-pane-width');
    expect(sizeCommands[0]).toContain('60%');

    for (const command of [...layoutCommands, ...sizeCommands]) {
      expectExplicitSocket(command);
      expect(command).toContain('%1');
    }
  });

  test('logs and stops layout sequence when a tmux layout command fails', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
      if (command.includes('select-layout')) {
        return createSpawnResult(1, '', 'layout failed');
      }
      return createSpawnResult();
    });

    await tmux.applyLayout('main-vertical', 60);

    expect(
      commands().filter((command) => command.includes('set-window-option')),
    ).toHaveLength(0);
    expect(logMock).toHaveBeenCalledWith('[tmux] command failed', {
      command: 'select-layout',
      args: [
        '/usr/bin/tmux',
        '-S',
        SOCKET,
        'select-layout',
        '-t',
        '%1',
        'main-vertical',
      ],
      exitCode: 1,
      stderr: 'layout failed',
    });
    expect(logMock).not.toHaveBeenCalledWith(
      '[tmux] applyLayout: applied',
      expect.anything(),
    );
  });

  test('direct applyLayout cancels a pending debounced layout', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );
    await tmux.applyLayout('tiled', 60);
    await wait(300);

    const layoutCommands = commands().filter((command) =>
      command.includes('select-layout'),
    );

    expect(layoutCommands).toHaveLength(1);
    expect(layoutCommands[0]).toContain('tiled');
    expectExplicitSocket(layoutCommands[0]);
  });

  test('debounced layout keeps the anchor captured at spawn time', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );
    // Re-displayed elsewhere before the debounce window elapses.
    process.env.TMUX_PANE = '%9';

    await wait(300);

    const layoutCommands = commands().filter((command) =>
      command.includes('select-layout'),
    );
    expect(layoutCommands).toHaveLength(2);
    for (const command of layoutCommands) {
      expect(command).toContain('%1');
      expect(command).not.toContain('%9');
    }
  });

  test('applyLayout resolves the anchor from the environment at call time', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);
    process.env.TMUX_PANE = '%7';

    await tmux.applyLayout('even-horizontal', 60);

    const layoutCommand = commandContaining('select-layout');
    expect(layoutCommand).toContain('%7');
    expect(layoutCommand).not.toContain('%1');
  });

  test('closePane closes the given pane with explicit addressing', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'child-session',
      'Attached worker',
      'http://localhost:4096',
      '/repo',
    );

    // Drain the spawn's debounced layout before observing close commands.
    await wait(300);
    crossSpawnMock.mockClear();
    expect(await tmux.closePane('%2')).toBe(true);

    const sent = tmuxCommands();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual([
      '/usr/bin/tmux',
      '-S',
      SOCKET,
      'send-keys',
      '-t',
      '%2',
      'C-c',
    ]);
    expect(sent[1]).toEqual([
      '/usr/bin/tmux',
      '-S',
      SOCKET,
      'kill-pane',
      '-t',
      '%2',
    ]);
  });

  test('closePane treats kill-pane exit 1 as closed (pane already gone)', async () => {
    // Real tmux behavior: C-c makes the pane process exit, so the backstop
    // `kill-pane` fails with "can't find pane" (exit 1). The pane is closed.
    installMockWithKillExit(1);
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    expect(await tmux.closePane('%2')).toBe(true);

    const sent = tmuxCommands();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual([
      '/usr/bin/tmux',
      '-S',
      SOCKET,
      'kill-pane',
      '-t',
      '%2',
    ]);
  });

  test('closePane fails closed when kill-pane exits with any other code', async () => {
    installMockWithKillExit(2);
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    expect(await tmux.closePane('%2')).toBe(false);
  });

  test('closePane issues no command when the tmux socket is missing', async () => {
    delete process.env.TMUX;
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    expect(await tmux.closePane('%2')).toBe(false);
    expect(commands()).toHaveLength(0);
  });

  test('closePane does not rebalance windows it never split into', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    expect(await tmux.closePane('%99')).toBe(true);
    await wait(300);

    expect(
      commands().filter((command) => command.includes('select-layout')),
    ).toHaveLength(0);
  });

  test('keeps the full encoded FR-8 title when renaming the created pane', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);
    const encoded = 'omosc:4242:ses_f41e46f05ffeoEESP7f24NJ9d6';

    await tmux.spawnPane('child', encoded, 'http://localhost:4096', '/repo');

    expect(commandContaining('select-pane')?.at(-1)).toBe(encoded);
  });

  test('listPanesWithTitles parses list-panes output with explicit addressing', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
      if (command.includes('list-panes')) {
        return createSpawnResult(0, '%1|user-title\n%2|omosc:123:ses_abc\n\n');
      }
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    expect(await tmux.listPanesWithTitles()).toEqual([
      { paneId: '%1', title: 'user-title' },
      { paneId: '%2', title: 'omosc:123:ses_abc' },
    ]);
    expectExplicitSocket(commandContaining('list-panes'));
  });

  test('sweep closes only the dead-owner terminal pane it created (FR-8)', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
      if (command.includes('list-panes')) {
        return createSpawnResult(
          0,
          [
            '%1|user-title',
            '%2|omosc:999:ses_gone',
            '%3|omosc:4242:ses_gone',
            '%4|omosc:999:ses_alive',
          ].join('\n'),
        );
      }
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    const { sweepLeftoverPanes } = await import('../client/sweep');
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    const stats = await sweepLeftoverPanes({
      adapter: tmux,
      isProcessAlive: (pid) => pid !== 999,
      isSessionTerminal: async (child) => child === 'ses_gone',
    });

    expect(stats).toMatchObject({
      scanned: 4,
      encoded: 3,
      closed: 1,
      skippedLiveOwner: 1,
      skippedActiveSession: 1,
      skippedUnparsable: 1,
      closeFailures: 0,
    });
    const kills = commands().filter((command) => command.includes('kill-pane'));
    expect(kills).toHaveLength(1);
    expect(kills[0]).toEqual([
      '/usr/bin/tmux',
      '-S',
      SOCKET,
      'kill-pane',
      '-t',
      '%2',
    ]);
  });
});
