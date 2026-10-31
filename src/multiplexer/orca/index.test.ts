import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { MultiplexerLayout } from '../../config/schema';
import { createTimerHarness } from '../../utils/test-timers';

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

const ANCHOR = 'pane-1';
const ENV_KEYS = [
  'ORCA_TERMINAL_HANDLE',
  'ORCA_CLI_BIN_DIR',
  'TERM_PROGRAM',
  'SHELL',
] as const;

let importCounter = 0;
let nextHandle = 100;

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

/** A CLI call that never answers; only the injected timeout can settle it. */
function createHangingResult(): SpawnResult {
  return {
    exited: new Promise<number>(() => {}),
    stdout: () => Promise.resolve(''),
    stderr: () => Promise.resolve(''),
    kill: () => true,
    exitCode: null,
    proc: {} as never,
  };
}

function statusJson(running = true): string {
  return JSON.stringify({ ok: true, result: { app: { running } } });
}

function splitJson(handle = `split-${nextHandle++}`): string {
  return JSON.stringify({
    ok: true,
    result: {
      split: {
        handle,
        tabId: 'tab-1',
        paneRuntimeId: 'runtime-1',
        leafId: 'l1',
      },
    },
  });
}

async function importFreshOrca() {
  return import(`./index?test=${importCounter++}`);
}

/** Orca commands sent to the CLI (excludes binary discovery). */
function orcaCommands(): string[][] {
  return crossSpawnMock.mock.calls
    .map((call) => call[0] as string[])
    .filter((command) => command[0] !== 'which');
}

function splits(): string[][] {
  return orcaCommands().filter((command) => command.includes('split'));
}

function closes(): string[][] {
  return orcaCommands().filter((command) => command.includes('close'));
}

/** Value of a `--<flag>` option in an argv. */
function flagValue(command: string[], flag: string): string | undefined {
  return command[command.indexOf(flag) + 1];
}

type Responder = (command: string[]) => SpawnResult | undefined;

function installMock(override?: Responder): void {
  crossSpawnMock.mockImplementation((command: string[]) => {
    const custom = override?.(command);
    if (custom) return custom;
    if (command[0] === 'which' && command[1] === 'orca') {
      return createSpawnResult(0, '/usr/bin/orca\n');
    }
    if (command.includes('status')) return createSpawnResult(0, statusJson());
    if (command.includes('split')) return createSpawnResult(0, splitJson());
    if (command.includes('close')) return createSpawnResult(0, '{}');
    return createSpawnResult();
  });
}

function spawnWith(
  orca: { spawnPane: (...args: unknown[]) => Promise<unknown> },
  layoutOptions?: Record<string, unknown>,
) {
  return orca.spawnPane(
    'ses_a',
    'omosc:1:ses_a',
    'http://127.0.0.1:4096',
    '/repo',
    layoutOptions,
  );
}

describe('OrcaMultiplexer', () => {
  const originals = new Map<string, string | undefined>();
  const originalPlatform = process.platform;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.ORCA_TERMINAL_HANDLE = ANCHOR;
    process.env.TERM_PROGRAM = 'Orca';
    process.env.SHELL = '/bin/sh';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    nextHandle = 100;

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

  test('isAvailable probes orca status and follows a running app', async () => {
    const { OrcaMultiplexer } = await importFreshOrca();
    expect(await new OrcaMultiplexer().isAvailable()).toBe(true);
    expect(orcaCommands()[0]).toEqual(['/usr/bin/orca', 'status', '--json']);

    crossSpawnMock.mockReset();
    installMock((command) =>
      command.includes('status')
        ? createSpawnResult(0, statusJson(false))
        : undefined,
    );
    const { OrcaMultiplexer: NotRunning } = await importFreshOrca();
    expect(await new NotRunning().isAvailable()).toBe(false);
  });

  test('isAvailable is false when the binary is missing', async () => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(() => createSpawnResult(1, ''));

    const { OrcaMultiplexer } = await importFreshOrca();
    expect(await new OrcaMultiplexer().isAvailable()).toBe(false);
    expect(orcaCommands()).toHaveLength(0);
  });

  test('isAvailable prefers $ORCA_CLI_BIN_DIR/orca over PATH', async () => {
    const dir = `/tmp/opencode/omo-orca-test-${process.pid}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/orca`, '');
    process.env.ORCA_CLI_BIN_DIR = dir;
    try {
      const { OrcaMultiplexer } = await importFreshOrca();
      expect(await new OrcaMultiplexer().isAvailable()).toBe(true);
      expect(orcaCommands()[0]?.[0]).toBe(`${dir}/orca`);
      expect(
        crossSpawnMock.mock.calls.some((call) => call[0][0] === 'which'),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isInsideSession needs the handle and TERM_PROGRAM=Orca', async () => {
    const { OrcaMultiplexer } = await importFreshOrca();
    const orca = new OrcaMultiplexer();

    expect(orca.isInsideSession()).toBe(true);
    delete process.env.TERM_PROGRAM;
    expect(orca.isInsideSession()).toBe(false);
    process.env.TERM_PROGRAM = 'Orca';
    delete process.env.ORCA_TERMINAL_HANDLE;
    expect(orca.isInsideSession()).toBe(false);
  });

  test('spawnPane splits the anchor and returns the split handle', async () => {
    const { OrcaMultiplexer } = await importFreshOrca();
    const result = await spawnWith(new OrcaMultiplexer('main-vertical'));

    expect(result).toMatchObject({ success: true, paneId: 'split-100' });
    const split = splits()[0];
    expect(split?.slice(0, 3)).toEqual(['/usr/bin/orca', 'terminal', 'split']);
    expect(flagValue(split as string[], '--terminal')).toBe(ANCHOR);
    expect(flagValue(split as string[], '--direction')).toBe('horizontal');
    // The viewer command carries the marker as well as the attach arguments.
    expect(flagValue(split as string[], '--command')).toContain(
      "attach 'http://127.0.0.1:4096'",
    );
    expect(flagValue(split as string[], '--command')).toContain(
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    );
    expect(split).toContain('--json');
  });

  test('maps every layout to a split direction the way wezterm does', async () => {
    const cases: Array<[MultiplexerLayout, string]> = [
      ['main-vertical', 'horizontal'],
      ['even-horizontal', 'horizontal'],
      ['tiled', 'horizontal'],
      ['main-horizontal', 'vertical'],
      ['even-vertical', 'vertical'],
    ];
    for (const [layout, direction] of cases) {
      crossSpawnMock.mockReset();
      installMock();
      const { OrcaMultiplexer } = await importFreshOrca();
      await spawnWith(new OrcaMultiplexer(layout));
      expect(flagValue(splits()[0] as string[], '--direction')).toBe(direction);
    }
  });

  test('refuses to spawn on Windows instead of typing into cmd/PowerShell', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { OrcaMultiplexer } = await importFreshOrca();

    const result = await spawnWith(new OrcaMultiplexer());

    expect(result).toMatchObject({ success: false, error: 'unavailable' });
    expect(splits()).toHaveLength(0);
    expect(
      logMock.mock.calls.some((call) =>
        String(call[0]).includes('Windows hosts are unsupported'),
      ),
    ).toBe(true);
  });

  test('a v2 mini viewer changes into the project directory first', async () => {
    const { OrcaMultiplexer } = await importFreshOrca();
    await spawnWith(new OrcaMultiplexer(), {
      viewerFlavor: 'v2',
      viewerSurface: 'mini',
    });

    const command = flagValue(splits()[0] as string[], '--command');
    expect(command?.startsWith("cd '/repo' && ")).toBe(true);
  });

  test('a v2 remote password reaches the viewer through the env bridge', async () => {
    const { OrcaMultiplexer } = await importFreshOrca();
    await spawnWith(new OrcaMultiplexer(), {
      viewerFlavor: 'v2-remote',
      viewerPassword: 'pw-123',
    });

    const command = flagValue(splits()[0] as string[], '--command');
    expect(command).toContain('OPENCODE_PASSWORD');
    expect(command).not.toContain('pw-123');
  });

  test('a v2 remote password without the Linux bridge creates no pane', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { OrcaMultiplexer } = await importFreshOrca();
    const result = await spawnWith(new OrcaMultiplexer(), {
      viewerFlavor: 'v2-remote',
      viewerPassword: 'pw-123',
    });

    expect(result).toMatchObject({ success: false, error: 'unavailable' });
    expect(splits()).toHaveLength(0);
  });

  test('without an anchor no orca command is issued', async () => {
    delete process.env.ORCA_TERMINAL_HANDLE;
    const { OrcaMultiplexer } = await importFreshOrca();

    const result = await spawnWith(new OrcaMultiplexer());

    expect(result).toMatchObject({ success: false, error: 'not_found' });
    expect(orcaCommands()).toHaveLength(0);
  });

  test('a split timeout is a soft failure, never pane loss', async () => {
    const timers = createTimerHarness();
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/orca\n');
      if (command.includes('status')) return createSpawnResult(0, statusJson());
      if (command.includes('split')) return createHangingResult();
      return createSpawnResult();
    });

    const { OrcaMultiplexer } = await importFreshOrca();
    const orca = new OrcaMultiplexer('main-vertical', {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    const pending = spawnWith(orca);
    // Arm the split timer only after the availability probe has settled.
    await timers.tick();
    await timers.tick();
    expect(splits()).toHaveLength(1);
    await timers.advance(60_000);

    const result = await pending;
    expect(result).toMatchObject({ success: false, error: 'unavailable' });
    expect(
      logMock.mock.calls.some((call) =>
        String(call[0]).includes('split timed out'),
      ),
    ).toBe(true);
  });

  test('a split that fails without a handle is a hard failure', async () => {
    crossSpawnMock.mockReset();
    installMock((command) =>
      command.includes('split')
        ? createSpawnResult(1, '', 'split rejected')
        : undefined,
    );

    const { OrcaMultiplexer } = await importFreshOrca();
    const result = await spawnWith(new OrcaMultiplexer());

    expect(result).toMatchObject({ success: false, error: 'hard' });
  });

  test('closePane closes exactly one pane by handle', async () => {
    const { OrcaMultiplexer } = await importFreshOrca();
    const orca = new OrcaMultiplexer();

    expect(await orca.closePane('split-100')).toBe(true);
    expect(closes()[0]).toEqual([
      '/usr/bin/orca',
      'terminal',
      'close',
      '--terminal',
      'split-100',
      '--json',
    ]);

    crossSpawnMock.mockReset();
    installMock((command) =>
      command.includes('close') ? createSpawnResult(1, '', 'boom') : undefined,
    );
    const { OrcaMultiplexer: Failing } = await importFreshOrca();
    // A failed close keeps the pane tracked instead of forgetting a viewer.
    expect(await new Failing().closePane('split-100')).toBe(false);
  });

  test('applyLayout is a no-op and never changes the spawn direction', async () => {
    const { OrcaMultiplexer } = await importFreshOrca();
    const orca = new OrcaMultiplexer('main-vertical');

    await orca.applyLayout('even-vertical', 40);

    await spawnWith(orca);
    expect(flagValue(splits()[0] as string[], '--direction')).toBe(
      'horizontal',
    );
  });
});
