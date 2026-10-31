import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import type { MultiplexerLayout } from '../../config/schema';
import * as logger from '../../utils/logger';
import { createTimerHarness } from '../../utils/test-timers';

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
  ...logger,
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

function viewerCommand(command: string[] | undefined): string {
  return command?.find((arg) => arg.startsWith('env OPENCODE_DISABLE_')) ?? '';
}

async function withCloseClock<T>(run: () => Promise<T>): Promise<T> {
  const clock = createTimerHarness();
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay: number,
  ) => clock.setTimeout(callback, delay)) as unknown as typeof setTimeout);
  try {
    const result = run();
    await clock.tick();
    await clock.advance(250);
    return await result;
  } finally {
    timer.mockRestore();
  }
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

  afterEach(() => {
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

  test('marks spawned viewers so they do not manage panes', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    await new TmuxMultiplexer().spawnPane(
      'child',
      'child',
      'http://host',
      '/repo',
    );
    expect(viewerCommand(commandContaining('split-window'))).toContain(
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    );
  });

  test('forwards v1 viewer credentials without logging either value', async () => {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    const username = process.env.OPENCODE_SERVER_USERNAME;
    process.env.OPENCODE_SERVER_PASSWORD = 'test-secret';
    process.env.OPENCODE_SERVER_USERNAME = 'test-user';
    try {
      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which')
          return createSpawnResult(0, '/usr/bin/tmux\n');
        if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
        if (command.includes('split-window'))
          return createSpawnResult(0, '%2\n', 'test-user test-secret');
        return createSpawnResult();
      });
      const { TmuxMultiplexer } = await importFreshTmux();
      await new TmuxMultiplexer().spawnPane(
        'child',
        'child',
        'http://host',
        '/repo',
      );
      const split = commandContaining('split-window') ?? [];
      expect(split).toContain('OPENCODE_SERVER_PASSWORD=test-secret');
      expect(split).toContain('OPENCODE_SERVER_USERNAME=test-user');
      expect(JSON.stringify(logMock.mock.calls)).not.toContain('test-secret');
      expect(JSON.stringify(logMock.mock.calls)).not.toContain('test-user');
    } finally {
      if (password === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = password;
      if (username === undefined) delete process.env.OPENCODE_SERVER_USERNAME;
      else process.env.OPENCODE_SERVER_USERNAME = username;
    }
  });

  test('tmux 2.9 keeps inherited v1 credentials without unsupported split flags', async () => {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    const username = process.env.OPENCODE_SERVER_USERNAME;
    process.env.OPENCODE_SERVER_PASSWORD = 'test-secret';
    process.env.OPENCODE_SERVER_USERNAME = 'test-user';
    try {
      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which')
          return createSpawnResult(0, '/usr/bin/tmux\n');
        if (command.includes('-V')) return createSpawnResult(0, 'tmux 2.9');
        if (command.includes('split-window'))
          return createSpawnResult(0, '%2\n');
        return createSpawnResult();
      });
      const { TmuxMultiplexer } = await importFreshTmux();
      expect(
        await new TmuxMultiplexer().spawnPane(
          'child',
          'child',
          'http://host',
          '/repo',
        ),
      ).toEqual({ success: true, paneId: '%2' });
      expect(commandContaining('split-window')).not.toContain('-e');
      expect(JSON.stringify(logMock.mock.calls)).not.toContain('test-secret');
      expect(JSON.stringify(logMock.mock.calls)).not.toContain('test-user');
    } finally {
      if (password === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = password;
      if (username === undefined) delete process.env.OPENCODE_SERVER_USERNAME;
      else process.env.OPENCODE_SERVER_USERNAME = username;
    }
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
    expect(splitCommand).not.toContain('-e');
    expect(viewerCommand(splitCommand)).toMatch(
      /^env OPENCODE_DISABLE_TERMINAL_TITLE=1 /,
    );
  });

  test('spawnPane builds the viewer command for the requested v2 flavor', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'session-1',
      'Remote worker',
      'http://localhost:4096',
      '/repo',
      { viewerFlavor: 'v2-remote', viewerPassword: 'pw' },
    );

    const remoteSplit = commandContaining('split-window');
    const remote = viewerCommand(remoteSplit);
    expect(remote).toContain('--server');
    expect(remote).not.toContain('attach');

    // The secret travels as a spawn-time tmux environment entry (`-e`),
    // never in the shell command text.
    const envIndex = remoteSplit?.indexOf('-e') ?? -1;
    expect(envIndex).toBeGreaterThan(-1);
    expect(remoteSplit?.[envIndex + 1]).toBe('OPENCODE_PASSWORD=pw');
    expect(remote).not.toContain('pw');
    expect((remoteSplit ?? []).filter((arg) => arg.includes('pw'))).toEqual([
      'OPENCODE_PASSWORD=pw',
    ]);

    crossSpawnMock.mockClear();
    await tmux.spawnPane(
      'session-2',
      'Shared worker',
      'http://localhost:4096',
      '/repo',
      { viewerFlavor: 'v2-shared' },
    );

    const sharedSplit = commandContaining('split-window');
    const shared = viewerCommand(sharedSplit);
    expect(shared).toContain('--session');
    expect(shared).not.toContain('--server');
    expect(shared).not.toContain('attach');
    // No password environment is injected outside v2-remote.
    expect(sharedSplit).not.toContain('-e');
    expect(sharedSplit).not.toContain('OPENCODE_PASSWORD');
  });

  test('viewer "mini" runs opencode mini and pins the split directory', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'session-mini',
      'Mini worker',
      'http://localhost:4096',
      '/repo',
      { viewerFlavor: 'v2-shared', viewerSurface: 'mini' },
    );

    const split = commandContaining('split-window');
    // Mini commands omit the directory, so the split pins it with `-c`.
    const cwdIndex = split?.indexOf('-c') ?? -1;
    expect(cwdIndex).toBeGreaterThan(-1);
    expect(split?.[cwdIndex + 1]).toBe('/repo');
    const cmd = viewerCommand(split);
    expect(cmd).toContain("opencode mini --session 'session-mini'");
    expect(cmd).not.toContain('/repo');
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
      ';',
      'set-option',
      '-p',
      '-t',
      '%2',
      '@omosc',
      'Attached worker',
    ]);
  });

  test('splits and lays out together, then writes title and metadata together', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);
    await tmux.spawnPane('child', 'omosc:1:child', 'http://host', '/repo');

    const split = commandContaining('split-window') ?? [];
    expect(split.slice(split.indexOf(';'))).toEqual([
      ';',
      'select-layout',
      '-t',
      '%1',
      'main-vertical',
      ';',
      'set-window-option',
      '-t',
      '%1',
      'main-pane-width',
      '60%',
      ';',
      'select-layout',
      '-t',
      '%1',
      'main-vertical',
    ]);
    expect(commandContaining('select-pane')).toEqual([
      '/usr/bin/tmux',
      '-S',
      SOCKET,
      'select-pane',
      '-t',
      '%2',
      '-T',
      'omosc:1:child',
      ';',
      'set-option',
      '-p',
      '-t',
      '%2',
      '@omosc',
      'omosc:1:child',
    ]);
  });

  test('stacks before the pane following the anchor, or splits the anchor', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
      if (command.includes('list-panes'))
        return createSpawnResult(0, '%1\n%8\n');
      if (command.includes('split-window')) return createSpawnResult(0, '%2\n');
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);
    await tmux.spawnPane('child', 'child', 'http://host', '/repo');
    const split = commandContaining('split-window') ?? [];
    expect(split.slice(3, 11)).toEqual([
      'split-window',
      '-v',
      '-b',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
    ]);
    expect(split[11]).toBe('%8');
  });

  test('retries the anchor if the pane following it disappears before splitting', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
      if (command.includes('list-panes'))
        return createSpawnResult(0, '%1\n%8\n');
      if (command.includes('split-window'))
        return command.includes('-b')
          ? createSpawnResult(1, '', "can't find pane: %8\n")
          : createSpawnResult(0, '%2\n');
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer();
    expect(
      await tmux.spawnPane('child', 'child', 'http://host', '/repo'),
    ).toEqual({ success: true, paneId: '%2' });
    const splits = tmuxCommands().filter((command) =>
      command.includes('split-window'),
    );
    expect(splits).toHaveLength(2);
    expect(splits[1]).toContain('%1');
    expect(splits[1]).not.toContain('-b');
  });

  test('keeps a pane when a later layout command fails', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
      if (command.includes('split-window'))
        return createSpawnResult(1, '%2\n', 'layout failed');
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer();
    expect(
      await tmux.spawnPane('child', 'child', 'http://host', '/repo'),
    ).toEqual({ success: true, paneId: '%2' });
    expect(logMock).toHaveBeenCalledWith(
      '[tmux] spawnPane: result',
      expect.objectContaining({
        exitCode: 1,
        stderr: 'layout failed',
      }),
    );
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

    crossSpawnMock.mockClear();
    expect(await withCloseClock(() => tmux.closePane('%2'))).toBe(true);

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
      ';',
      'select-layout',
      '-t',
      '%1',
      'main-vertical',
    ]);
  });

  test('closePane treats kill-pane exit 1 as closed (pane already gone)', async () => {
    // Real tmux behavior: C-c makes the pane process exit, so the backstop
    // `kill-pane` fails with "can't find pane" (exit 1). The pane is closed.
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
      if (command.includes('split-window')) return createSpawnResult(0, '%2\n');
      if (command.includes('kill-pane'))
        return createSpawnResult(1, '', "can't find pane: %2\n");
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane('child', 'child', 'http://host', '/repo');
    crossSpawnMock.mockClear();
    expect(await withCloseClock(() => tmux.closePane('%2'))).toBe(true);

    const sent = tmuxCommands();
    expect(sent).toHaveLength(3);
    expect(sent[1]).toEqual([
      '/usr/bin/tmux',
      '-S',
      SOCKET,
      'kill-pane',
      '-t',
      '%2',
      ';',
      'select-layout',
      '-t',
      '%1',
      'main-vertical',
    ]);
    expect(sent[2]).toEqual([
      '/usr/bin/tmux',
      '-S',
      SOCKET,
      'select-layout',
      '-t',
      '%1',
      'main-vertical',
    ]);
  });

  test('closePane treats a missing parent pane as closed', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
      if (command.includes('split-window')) return createSpawnResult(0, '%2\n');
      if (command.includes('kill-pane'))
        return createSpawnResult(1, '', "can't find pane: %1\n");
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer();
    await tmux.spawnPane('child', 'child', 'http://host', '/repo');
    crossSpawnMock.mockClear();
    expect(await withCloseClock(() => tmux.closePane('%2'))).toBe(true);
    expect(tmuxCommands()).toHaveLength(2);
  });

  test('closePane keeps tracking a pane when tmux reports a transport error', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.6a');
      if (command.includes('kill-pane'))
        return createSpawnResult(1, '', 'error connecting to socket');
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    expect(
      await withCloseClock(() => new TmuxMultiplexer().closePane('%2')),
    ).toBe(false);
  });

  test('closePane fails closed when kill-pane exits with any other code', async () => {
    installMockWithKillExit(2);
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    expect(await withCloseClock(() => tmux.closePane('%2'))).toBe(false);
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

    expect(await withCloseClock(() => tmux.closePane('%99'))).toBe(true);

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

  test('tmux 3.0 falls back to pane titles without pane options', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.0');
      if (command.includes('split-window')) return createSpawnResult(0, '%2\n');
      if (command.includes('list-panes'))
        return createSpawnResult(0, '%2|omosc:123:child\n');
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer();
    await tmux.spawnPane('child', 'omosc:123:child', 'http://host', '/repo');
    expect(commandContaining('set-option')).toBeUndefined();
    expect(await tmux.listPanesWithTitles()).toEqual([
      { paneId: '%2', title: 'omosc:123:child' },
    ]);
    expect(tmuxCommands().find((command) => command.includes('-a'))).toContain(
      '#{pane_id}|#{pane_title}',
    );
  });

  test('tmux 3.0a sweep metadata survives a viewer changing its pane title', async () => {
    let metadata = '';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command.includes('-V')) return createSpawnResult(0, 'tmux 3.0a');
      if (command.includes('split-window')) return createSpawnResult(0, '%2\n');
      if (command.includes('set-option') && command.includes('@omosc'))
        metadata = command.at(-1) ?? '';
      if (command.includes('list-panes')) {
        const title =
          command.at(-1)?.includes('@omosc') && metadata
            ? metadata
            : 'OC | child';
        return createSpawnResult(0, `%1|user-title\n%2|${title}\n`);
      }
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer();
    const encoded = 'omosc:123:ses_child';
    await tmux.spawnPane('child', encoded, 'http://localhost', '/repo');
    expect(await tmux.listPanesWithTitles()).toEqual([
      { paneId: '%1', title: 'user-title' },
      { paneId: '%2', title: encoded },
    ]);
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

    const stats = await withCloseClock(() =>
      sweepLeftoverPanes({
        adapter: tmux,
        isProcessAlive: (pid) => pid !== 999,
        isSessionTerminal: async (child) => child === 'ses_gone',
      }),
    );

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
