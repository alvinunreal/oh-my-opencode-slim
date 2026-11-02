import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

const logMock = mock((..._args: unknown[]) => {});
const crossSpawnMock = mock((_command: string[]) => createSpawnResult());

mock.module('../../utils/logger', () => ({
  log: logMock,
}));

// Keep compat's real exports: a mock with only `crossSpawn` leaks into later
// test files that import other compat helpers.
const actualCompat = await import('../../utils/compat');
mock.module('../../utils/compat', () => ({
  ...actualCompat,
  crossSpawn: crossSpawnMock,
}));

let importCounter = 0;
let nextPaneId = 100;

const ANCHOR_PANE_ID = '7';
const FOCUSED_PANE_ID = '25';
const SECRET = 'hunter2-not-in-argv';
const ENV_KEYS = [
  'WEZTERM_PANE',
  'WEZTERM_EXECUTABLE',
  'SHELL',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_PASSWORD',
] as const;

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

async function importFreshWezterm() {
  return import(`./index?test=${importCounter++}`);
}

/** Commands sent to wezterm (excludes binary discovery). */
function weztermCommands(): string[][] {
  return crossSpawnMock.mock.calls
    .map((call) => call[0] as string[])
    .filter((command) => command[0] !== 'which');
}

/** The `wezterm cli` subcommand of a command (after `--no-auto-start`). */
function subcommand(command: string[]): string {
  return command[3];
}

function byCommand(name: string): string[][] {
  return weztermCommands().filter((command) => subcommand(command) === name);
}

function splits(): string[][] {
  return byCommand('split-pane');
}

/** The split flags before `--` (target, direction, size, cwd). */
function splitFlags(command: string[]): string[] {
  return command.slice(4, command.indexOf('--', 4));
}

/** The shell script the pane runs (last argv entry). */
function paneScript(command: string[]): string {
  return command[command.length - 1];
}

function listClientsJson(): string {
  return JSON.stringify([
    {
      pid: 1,
      focused_pane_id: 3,
      idle_time: { secs: 900, nanos: 0 },
    },
    {
      pid: 2,
      focused_pane_id: Number(FOCUSED_PANE_ID),
      idle_time: { secs: 2, nanos: 0 },
    },
  ]);
}

type Responder = (command: string[]) => SpawnResult | undefined;

function installMock(override?: Responder): void {
  crossSpawnMock.mockImplementation((command: string[]) => {
    const custom = override?.(command);
    if (custom) return custom;
    if (command[0] === 'which' && command[1] === 'wezterm') {
      return createSpawnResult(0, '/usr/bin/wezterm\n');
    }
    if (command.includes('split-pane')) {
      return createSpawnResult(0, `${nextPaneId++}\n`);
    }
    if (command.includes('list-clients')) {
      return createSpawnResult(0, listClientsJson());
    }
    return createSpawnResult();
  });
}

function spawnWith(
  wezterm: {
    spawnPane: (...args: unknown[]) => Promise<unknown>;
  },
  sessionId = 'ses_a',
  options?: Record<string, unknown>,
) {
  return wezterm.spawnPane(
    sessionId,
    `omosc:1:${sessionId}`,
    'http://127.0.0.1:4096',
    '/repo',
    options,
  );
}

describe('WeztermMultiplexer', () => {
  const originals = new Map<string, string | undefined>();
  const originalPlatform = process.platform;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.WEZTERM_PANE = ANCHOR_PANE_ID;
    process.env.SHELL = '/bin/sh';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    nextPaneId = 100;

    logMock.mockClear();
    crossSpawnMock.mockReset();
    installMock();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originals.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  test('isAvailable follows the wezterm binary', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    expect(await new WeztermMultiplexer().isAvailable()).toBe(true);

    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(() => createSpawnResult(1, ''));
    const { WeztermMultiplexer: Missing } = await importFreshWezterm();
    expect(await new Missing().isAvailable()).toBe(false);
  });

  test('prefers the wezterm CLI next to WEZTERM_EXECUTABLE', async () => {
    const dir = `/tmp/opencode/omo-wezterm-test-${process.pid}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/wezterm`, '');
    process.env.WEZTERM_EXECUTABLE = `${dir}/wezterm-gui`;
    try {
      const { WeztermMultiplexer } = await importFreshWezterm();
      const wezterm = new WeztermMultiplexer();
      await spawnWith(wezterm);
      expect(splits()[0][0]).toBe(`${dir}/wezterm`);
      expect(
        crossSpawnMock.mock.calls.some((call) => call[0][0] === 'which'),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isInsideSession follows WEZTERM_PANE', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer();
    expect(wezterm.isInsideSession()).toBe(true);

    delete process.env.WEZTERM_PANE;
    expect(wezterm.isInsideSession()).toBe(false);
  });

  test('spawnPane issues no command without an anchor pane', async () => {
    delete process.env.WEZTERM_PANE;
    const { WeztermMultiplexer } = await importFreshWezterm();
    const result = await spawnWith(new WeztermMultiplexer());
    expect(result).toEqual({ success: false, error: 'not_found' });
    expect(weztermCommands()).toHaveLength(0);
  });

  test('every cli call passes --no-auto-start', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer();
    await spawnWith(wezterm);
    await wezterm.closePane('100');

    expect(weztermCommands().length).toBeGreaterThan(0);
    for (const command of weztermCommands()) {
      expect(command.slice(1, 3)).toEqual(['cli', '--no-auto-start']);
    }
  });

  test('main-vertical: first child splits the anchor right at the agent share', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const result = await spawnWith(new WeztermMultiplexer('main-vertical', 60));

    expect(result).toEqual({ success: true, paneId: '100' });
    const [split] = splits();
    expect(splitFlags(split)).toEqual([
      '--pane-id',
      ANCHOR_PANE_ID,
      '--right',
      '--percent',
      '40',
      '--cwd',
      '/repo',
    ]);
    expect(paneScript(split)).toContain('attach');
    expect(paneScript(split)).toContain('ses_a');
  });

  test('focus returns to the pane the user had focused, not the anchor', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    await spawnWith(new WeztermMultiplexer());

    const commands = weztermCommands().map(subcommand);
    expect(commands).toEqual(['list-clients', 'split-pane', 'activate-pane']);
    expect(byCommand('activate-pane')[0].slice(4)).toEqual([
      '--pane-id',
      FOCUSED_PANE_ID,
    ]);
  });

  test('focus falls back to the anchor when list-clients fails', async () => {
    installMock((command) =>
      command.includes('list-clients') ? createSpawnResult(1) : undefined,
    );
    const { WeztermMultiplexer } = await importFreshWezterm();
    await spawnWith(new WeztermMultiplexer());

    expect(byCommand('activate-pane')[0].slice(4)).toEqual([
      '--pane-id',
      ANCHOR_PANE_ID,
    ]);
  });

  test('a hung list-clients read times out and the spawn still proceeds', async () => {
    let killed = false;
    installMock((command) =>
      command.includes('list-clients')
        ? {
            exited: new Promise<number>(() => {}),
            stdout: () => new Promise<string>(() => {}),
            stderr: () => Promise.resolve(''),
            kill: () => {
              killed = true;
              return true;
            },
            exitCode: null,
            proc: {} as never,
          }
        : undefined,
    );
    const { WeztermMultiplexer } = await importFreshWezterm();
    const result = await spawnWith(new WeztermMultiplexer());

    expect(result).toEqual({ success: true, paneId: '100' });
    expect(killed).toBe(true);
    expect(byCommand('activate-pane')[0].slice(4)).toEqual([
      '--pane-id',
      ANCHOR_PANE_ID,
    ]);
  }, 10_000);

  test('a hung focus restore times out, keeps the pane and frees the mutex', async () => {
    let killed = false;
    installMock((command) =>
      command.includes('activate-pane')
        ? {
            exited: new Promise<number>(() => {}),
            stdout: () => new Promise<string>(() => {}),
            stderr: () => Promise.resolve(''),
            kill: () => {
              killed = true;
              return true;
            },
            exitCode: null,
            proc: {} as never,
          }
        : undefined,
    );
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer();
    const [first, second] = await Promise.all([
      spawnWith(wezterm, 'ses_a'),
      spawnWith(wezterm, 'ses_b'),
    ]);

    expect(first).toEqual({ success: true, paneId: '100' });
    expect(second).toEqual({ success: true, paneId: '101' });
    expect(killed).toBe(true);
  }, 10_000);

  test('a throwing focus restore still reports the split pane', async () => {
    installMock((command) => {
      if (command.includes('activate-pane')) throw new Error('spawn EPIPE');
      return undefined;
    });
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer();

    expect(await spawnWith(wezterm, 'ses_a')).toEqual({
      success: true,
      paneId: '100',
    });
    expect(await spawnWith(wezterm, 'ses_b')).toEqual({
      success: true,
      paneId: '101',
    });
  });

  test('main-vertical: later children stack below inside the agent pane', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer('main-vertical', 60);
    await spawnWith(wezterm, 'ses_a');
    await spawnWith(wezterm, 'ses_b');

    expect(splitFlags(splits()[1])).toEqual([
      '--pane-id',
      '100',
      '--bottom',
      '--cwd',
      '/repo',
    ]);
  });

  test('main-horizontal mirrors main-vertical', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer('main-horizontal', 70);
    await spawnWith(wezterm, 'ses_a');
    await spawnWith(wezterm, 'ses_b');

    expect(splitFlags(splits()[0]).slice(0, 5)).toEqual([
      '--pane-id',
      ANCHOR_PANE_ID,
      '--bottom',
      '--percent',
      '30',
    ]);
    expect(splitFlags(splits()[1]).slice(0, 3)).toEqual([
      '--pane-id',
      '100',
      '--right',
    ]);
  });

  test('even layouts always split the anchor without sizing', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer('even-vertical', 60);
    await spawnWith(wezterm, 'ses_a');
    await spawnWith(wezterm, 'ses_b');

    for (const split of splits()) {
      expect(splitFlags(split)).toEqual([
        '--pane-id',
        ANCHOR_PANE_ID,
        '--bottom',
        '--cwd',
        '/repo',
      ]);
    }
  });

  test('concurrent spawns are serialized and stack in order', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer('main-vertical', 60);
    await Promise.all([
      spawnWith(wezterm, 'ses_a'),
      spawnWith(wezterm, 'ses_b'),
      spawnWith(wezterm, 'ses_c'),
    ]);

    const targets = splits().map((split) => splitFlags(split)[1]);
    expect(targets).toEqual([ANCHOR_PANE_ID, '100', '100']);
  });

  test('a gone agent pane falls back to the anchor', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer('main-vertical', 60);
    await spawnWith(wezterm, 'ses_a');

    installMock((command) =>
      command.includes('split-pane') && command.includes('100')
        ? createSpawnResult(1, '', 'Error: pane_id 100 invalid')
        : undefined,
    );
    const result = await spawnWith(wezterm, 'ses_b');

    expect(result).toEqual({ success: true, paneId: '101' });
    expect(splitFlags(splits().at(-1) ?? []).slice(0, 3)).toEqual([
      '--pane-id',
      ANCHOR_PANE_ID,
      '--right',
    ]);
  });

  test('any other agent-pane failure is hard and never splits again', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer('main-vertical', 60);
    await spawnWith(wezterm, 'ses_a');
    crossSpawnMock.mockClear();

    // A mismatched CLI can act and then fail to decode the reply.
    installMock((command) =>
      command.includes('split-pane')
        ? createSpawnResult(1, '', 'Error while decoding response pdu')
        : undefined,
    );
    const result = await spawnWith(wezterm, 'ses_b');

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(splits()).toHaveLength(1);
  });

  test('exit 0 with unparsable output is hard, not a success', async () => {
    installMock((command) =>
      command.includes('split-pane')
        ? createSpawnResult(0, 'garbage\n')
        : undefined,
    );
    const { WeztermMultiplexer } = await importFreshWezterm();
    const result = await spawnWith(new WeztermMultiplexer());
    expect(result).toEqual({ success: false, error: 'hard' });
    expect(splits()).toHaveLength(1);
  });

  test('v1 without a server password runs the viewer directly', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    await spawnWith(new WeztermMultiplexer());
    expect(paneScript(splits()[0])).not.toContain('/proc/');
    expect(paneScript(splits()[0])).toContain(
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    );
  });

  test('v1 with OPENCODE_SERVER_PASSWORD forwards only that variable', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = SECRET;
    process.env.OPENCODE_PASSWORD = 'stray-v2-value';
    const { WeztermMultiplexer } = await importFreshWezterm();
    await spawnWith(new WeztermMultiplexer());

    const script = paneScript(splits()[0]);
    expect(script).toContain(`/proc/${process.pid}/environ`);
    expect(script).toContain('export OPENCODE_SERVER_PASSWORD="$_omo_pw"');
    expect(script).not.toContain('s/^OPENCODE_PASSWORD=//p');
    expect(splits()[0].join(' ')).not.toContain(SECRET);
  });

  test('v1 forwards a custom OPENCODE_SERVER_USERNAME', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = SECRET;
    process.env.OPENCODE_SERVER_USERNAME = "matt's";
    const { WeztermMultiplexer } = await importFreshWezterm();
    await spawnWith(new WeztermMultiplexer());

    expect(paneScript(splits()[0])).toContain(
      `export OPENCODE_SERVER_USERNAME='matt'\\''s'`,
    );
  });

  test('v2 remote forwards the viewer password as OPENCODE_PASSWORD', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    await spawnWith(new WeztermMultiplexer(), 'ses_a', {
      viewerFlavor: 'v2-remote',
      viewerPassword: SECRET,
    });

    const split = splits()[0];
    expect(paneScript(split)).toContain('export OPENCODE_PASSWORD="$_omo_pw"');
    expect(split.join(' ')).not.toContain(SECRET);
  });

  test('v2 shared viewers are never wrapped', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = SECRET;
    const { WeztermMultiplexer } = await importFreshWezterm();
    await spawnWith(new WeztermMultiplexer(), 'ses_a', {
      viewerFlavor: 'v2-shared',
    });
    expect(paneScript(splits()[0])).not.toContain('/proc/');
  });

  test('v2 mini viewers get the directory as the pane cwd only', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    await spawnWith(new WeztermMultiplexer(), 'ses_a', {
      viewerFlavor: 'v2-shared',
      viewerSurface: 'mini',
    });

    const split = splits()[0];
    expect(splitFlags(split)).toContain('/repo');
    expect(paneScript(split)).toContain(' mini ');
    expect(paneScript(split)).not.toContain("'/repo'");
  });

  test('the password never reaches a log payload', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = SECRET;
    installMock((command) =>
      command.includes('split-pane')
        ? createSpawnResult(1, '', `echoed script ${paneScript(command)}`)
        : undefined,
    );
    const { WeztermMultiplexer } = await importFreshWezterm();
    await spawnWith(new WeztermMultiplexer());

    expect(logMock.mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logMock.mock.calls)).not.toContain(SECRET);
  });

  test('a password-protected viewer fails closed off Linux, logging once', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = SECRET;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer();
    expect(await spawnWith(wezterm, 'ses_a')).toEqual({
      success: false,
      error: 'unavailable',
    });
    await spawnWith(wezterm, 'ses_b');

    expect(splits()).toHaveLength(0);
    const gateLogs = logMock.mock.calls.filter((call) =>
      String(call[0]).includes('viewer password bridge unavailable'),
    );
    expect(gateLogs).toHaveLength(1);
    expect(gateLogs[0][1]).toMatchObject({
      stage: 'viewer-secret',
      reason: 'password-bridge-requires-linux',
    });
  });

  test('a password-protected viewer fails closed under a non-POSIX shell', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = SECRET;
    process.env.SHELL = '/usr/bin/fish';
    const { WeztermMultiplexer } = await importFreshWezterm();
    const result = await spawnWith(new WeztermMultiplexer());
    expect(result).toEqual({ success: false, error: 'unavailable' });
    expect(splits()).toHaveLength(0);
  });

  test('native Windows without SHELL is unavailable instead of a dead pane', async () => {
    delete process.env.SHELL;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { WeztermMultiplexer } = await importFreshWezterm();
    const result = await spawnWith(new WeztermMultiplexer());
    expect(result).toEqual({ success: false, error: 'unavailable' });
    expect(splits()).toHaveLength(0);
  });

  test('closePane sends Ctrl+C, kills the pane and resets the agent pane', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer('main-vertical', 60);
    await spawnWith(wezterm, 'ses_a');
    crossSpawnMock.mockClear();

    expect(await wezterm.closePane('100')).toBe(true);
    expect(weztermCommands()).toEqual([
      [
        '/usr/bin/wezterm',
        'cli',
        '--no-auto-start',
        'send-text',
        '--pane-id',
        '100',
        '--no-paste',
        '\x03',
      ],
      [
        '/usr/bin/wezterm',
        'cli',
        '--no-auto-start',
        'kill-pane',
        '--pane-id',
        '100',
      ],
    ]);

    // The agent pane is gone, so the next child splits the anchor again.
    await spawnWith(wezterm, 'ses_b');
    expect(splitFlags(splits().at(-1) ?? []).slice(0, 3)).toEqual([
      '--pane-id',
      ANCHOR_PANE_ID,
      '--right',
    ]);
  });

  test('closePane treats an already-missing pane as closed', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer('main-vertical', 60);
    await spawnWith(wezterm, 'ses_a');
    installMock((command) =>
      command.includes('kill-pane')
        ? createSpawnResult(1, '', 'Error: no such pane 100')
        : undefined,
    );

    expect(await wezterm.closePane('100')).toBe(true);

    // Closed, so the agent pane is forgotten and the anchor is split again.
    installMock();
    await spawnWith(wezterm, 'ses_b');
    expect(splitFlags(splits().at(-1) ?? []).slice(0, 3)).toEqual([
      '--pane-id',
      ANCHOR_PANE_ID,
      '--right',
    ]);
  });

  test('closePane only accepts a missing-pane error for its own pane id', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer();
    installMock((command) =>
      command.includes('kill-pane')
        ? createSpawnResult(1, '', 'Error: no such pane 1000')
        : undefined,
    );
    expect(await wezterm.closePane('100')).toBe(false);
  });

  test('closePane keeps a pane tracked when kill-pane fails for another reason', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer('main-vertical', 60);
    await spawnWith(wezterm, 'ses_a');
    // A mismatched or broken CLI can exit 1 while the pane still exists.
    installMock((command) =>
      command.includes('kill-pane')
        ? createSpawnResult(1, '', 'Error while decoding response pdu')
        : undefined,
    );

    expect(await wezterm.closePane('100')).toBe(false);

    // Still tracked: the next child stacks into the same agent pane.
    installMock();
    await spawnWith(wezterm, 'ses_b');
    expect(splitFlags(splits().at(-1) ?? []).slice(0, 3)).toEqual([
      '--pane-id',
      '100',
      '--bottom',
    ]);
  });

  test('closePane refuses outside WezTerm', async () => {
    const { WeztermMultiplexer } = await importFreshWezterm();
    const wezterm = new WeztermMultiplexer();
    delete process.env.WEZTERM_PANE;
    expect(await wezterm.closePane('100')).toBe(false);
    expect(weztermCommands()).toHaveLength(0);
  });
});
