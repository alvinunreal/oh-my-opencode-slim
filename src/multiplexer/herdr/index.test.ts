import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EqualizeAgentPanesOptions } from './layout-equalize';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

const crossSpawnMock = mock((_command: string[]) => createSpawnResult());

mock.module('../../utils/logger', () => ({
  log: mock(() => {}),
}));

mock.module('../../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

let importCounter = 0;

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

function createSplitResponse(paneId: string): string {
  return JSON.stringify({
    id: 'cli:pane:split',
    result: {
      type: 'pane_info',
      pane: {
        pane_id: paneId,
        tab_id: 'w1:t1',
        workspace_id: 'w1',
      },
    },
  });
}

async function importFreshHerdr() {
  return import(`./index?test=${importCounter++}`);
}

function commands(): string[][] {
  return crossSpawnMock.mock.calls.map((call) => call[0] as string[]);
}

const originalPlatform = process.platform;

async function spawnRunCommand(platform: NodeJS.Platform): Promise<string> {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  // A faked win32 platform makes findBinary probe `where`; answer it too.
  crossSpawnMock.mockImplementation((command: string[]) => {
    if (command[0] === 'which' || command[0] === 'where') {
      return createSpawnResult(0, '/usr/bin/herdr\n');
    }
    if (command.includes('split')) {
      return createSpawnResult(0, `${createSplitResponse('w1:p2')}\n`);
    }
    return createSpawnResult();
  });
  const { HerdrMultiplexer } = await importFreshHerdr();
  const dir = mkdtempSync(join(tmpdir(), 'omos-pane-'));
  const bin = join(dir, 'opencode.exe');
  writeFileSync(bin, '');
  const originalBin = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = bin;
  try {
    const herdr = new HerdrMultiplexer('main-vertical', 60);
    await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );
    const run = commands().find((command) => command.includes('run'));
    return run?.at(-1) ?? '';
  } finally {
    if (originalBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = originalBin;
    rmSync(dir, { recursive: true, force: true });
  }
}

function createEqualizer() {
  return mock(
    async (_opts: EqualizeAgentPanesOptions): Promise<boolean> => true,
  );
}

describe('HerdrMultiplexer', () => {
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalHerdrPaneId = process.env.HERDR_PANE_ID;
  const originalHerdrBinPath = process.env.HERDR_BIN_PATH;
  const originalHerdrTabId = process.env.HERDR_TAB_ID;
  const originalHerdrSocketPath = process.env.HERDR_SOCKET_PATH;

  beforeEach(() => {
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'w1:p1';
    delete process.env.HERDR_BIN_PATH;
    // Never let a real herdr socket leak into the suite.
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;

    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        return createSpawnResult(0, `${createSplitResponse('w1:p2')}\n`);
      }
      return createSpawnResult();
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.HERDR_ENV = originalHerdrEnv;
    process.env.HERDR_PANE_ID = originalHerdrPaneId;
    if (originalHerdrBinPath === undefined) {
      delete process.env.HERDR_BIN_PATH;
    } else {
      process.env.HERDR_BIN_PATH = originalHerdrBinPath;
    }
    if (originalHerdrTabId === undefined) {
      delete process.env.HERDR_TAB_ID;
    } else {
      process.env.HERDR_TAB_ID = originalHerdrTabId;
    }
    if (originalHerdrSocketPath === undefined) {
      delete process.env.HERDR_SOCKET_PATH;
    } else {
      process.env.HERDR_SOCKET_PATH = originalHerdrSocketPath;
    }
  });

  test('uses HERDR_BIN_PATH without discovering herdr on PATH', async () => {
    const configuredBinaryPath = '/custom/bin/herdr';
    process.env.HERDR_BIN_PATH = configuredBinaryPath;

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(commands().some((command) => command[0] === 'which')).toBe(false);
    expect(commands()[0]).toEqual([
      configuredBinaryPath,
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--ratio',
      '0.6',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
  });

  test('uses PATH discovery when HERDR_BIN_PATH is empty', async () => {
    process.env.HERDR_BIN_PATH = '';

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.isAvailable();

    expect(commands()).toEqual([['which', 'herdr']]);
  });

  test('spawns an opencode attach process in a herdr split pane', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const result = await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: 'w1:p2' });

    const allCommands = commands();

    // 1. which herdr
    expect(allCommands[0]).toEqual(['which', 'herdr']);

    // 2. pane split
    expect(allCommands[1]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--ratio',
      '0.6',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);

    // 3. pane rename
    expect(allCommands[2]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'rename',
      'w1:p2',
      'Herdr worker',
    ]);

    // 4. pane run
    expect(allCommands[3]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'run',
      'w1:p2',
      "opencode attach 'http://localhost:4096' --session 'session-1' --dir '/repo'",
    ]);
  });

  test('a Windows pane gets PowerShell command-position quoting', async () => {
    expect(await spawnRunCommand('win32')).toStartWith("& '");
  });

  test('a POSIX pane keeps the POSIX command-position quoting', async () => {
    expect(await spawnRunCommand('linux')).toStartWith("'");
  });

  test('pane split carries the v2 remote secret; pane run never does', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const runCommand = (): string =>
      commands()
        .filter((command) => command.includes('run'))
        .at(-1)
        ?.at(-1) ?? '';

    await herdr.spawnPane(
      'session-1',
      'Remote worker',
      'http://localhost:4096',
      '/repo',
      { viewerFlavor: 'v2-remote', viewerPassword: 'pw' },
    );

    // The secret travels as a spawn-time herdr environment entry (`--env`),
    // never in the `pane run` command text (which herdr types into the shell).
    const split = commands().find((command) => command.includes('split'));
    const envIndex = (split?.indexOf('OPENCODE_PASSWORD=pw') ?? 0) - 1;
    expect(envIndex).toBeGreaterThan(-1);
    expect(split?.[envIndex]).toBe('--env');
    expect(split?.[envIndex + 1]).toBe('OPENCODE_PASSWORD=pw');
    expect((split ?? []).filter((arg) => arg.includes('pw'))).toEqual([
      'OPENCODE_PASSWORD=pw',
    ]);

    const remote = runCommand();
    expect(remote).toContain('--server');
    expect(remote).not.toContain('attach');
    expect(remote).not.toContain('pw');

    crossSpawnMock.mockClear();
    await herdr.spawnPane(
      'session-2',
      'Shared worker',
      'http://localhost:4096',
      '/repo',
      { viewerFlavor: 'v2-shared' },
    );

    // No password environment is injected outside v2-remote.
    const sharedSplit = commands().find((command) => command.includes('split'));
    expect(
      sharedSplit?.filter((_, index) => sharedSplit[index - 1] === '--env'),
    ).toEqual(['OH_MY_OPENCODE_SLIM_PANE_VIEWER=1']);

    const shared = runCommand();
    expect(shared).toContain('--session');
    expect(shared).not.toContain('--server');
    expect(shared).not.toContain('attach');
  });

  test('returns not_found and issues no command when HERDR_PANE_ID is not set', async () => {
    delete process.env.HERDR_PANE_ID;

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const result = await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'not_found' });
    expect(commands()).toHaveLength(0);
  });

  test('closes herdr panes gracefully', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const success = await herdr.closePane('w1:p2');

    expect(success).toBe(true);
    expect(commands()).toEqual([
      ['which', 'herdr'],
      ['/usr/bin/herdr', 'pane', 'send-keys', 'w1:p2', 'ctrl+c'],
      ['/usr/bin/herdr', 'pane', 'close', 'w1:p2'],
    ]);
  });

  test('returns true when closing unknown pane id', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const success = await herdr.closePane('unknown');
    expect(success).toBe(true);
  });

  test('returns true when pane close exits with code 1 (already closed)', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('close')) {
        return createSpawnResult(1, '', 'pane not found');
      }
      return createSpawnResult();
    });

    const success = await herdr.closePane('w1:p2');
    expect(success).toBe(true);
  });

  test('returns false when pane close exits with code 2 (real failure)', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('close')) {
        return createSpawnResult(2, '', 'fatal error');
      }
      return createSpawnResult();
    });

    const success = await herdr.closePane('w1:p2');
    expect(success).toBe(false);
  });

  test('parses pane_id when split output has extra NDJSON lines', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const extraLine = JSON.stringify({
      id: 'cli:event',
      result: { type: 'progress', message: 'splitting...' },
    });
    const paneLine = createSplitResponse('w1:p9');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        return createSpawnResult(0, `${extraLine}\n${paneLine}\n`);
      }
      return createSpawnResult();
    });

    const result = await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: 'w1:p9' });
  });

  test('reports failure when split output has only non-pane JSON lines', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const progressOnly = JSON.stringify({
      id: 'cli:event',
      result: { type: 'progress', message: 'working...' },
    });

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        return createSpawnResult(0, `${progressOnly}\n`);
      }
      return createSpawnResult();
    });

    const result = await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
  });

  test('reports failure when split returns non-zero exit code', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        return createSpawnResult(1, '', 'split failed');
      }
      return createSpawnResult();
    });

    const result = await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
  });

  test('reports failure when split output has no pane_id', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        return createSpawnResult(0, 'not valid json\n');
      }
      return createSpawnResult();
    });

    const result = await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
  });

  test('reports failure when pane run returns non-zero exit code', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        return createSpawnResult(0, `${createSplitResponse('w1:p3')}\n`);
      }
      if (command.includes('run')) {
        return createSpawnResult(1, '', 'run failed');
      }
      return createSpawnResult();
    });

    const result = await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
  });

  test('closes orphaned pane when pane run fails (non-zero exit)', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        return createSpawnResult(0, `${createSplitResponse('w1:p2')}\n`);
      }
      // run returns non-zero; everything else (close, send-keys) succeeds
      if (command.includes('run')) {
        return createSpawnResult(1, '', 'run failed');
      }
      return createSpawnResult();
    });

    const result = await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });

    const closeCommands = commands().filter(
      (c) => c[1] === 'pane' && c[2] === 'close',
    );
    expect(closeCommands).toEqual([
      ['/usr/bin/herdr', 'pane', 'close', 'w1:p2'],
    ]);
  });

  test('main-horizontal layout opens panes down', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-horizontal', 60);

    await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    const splitCommand = commands().find((command) =>
      command.includes('split'),
    );
    const directionArgIndex = splitCommand?.indexOf('--direction') ?? -1;

    expect(directionArgIndex).toBeGreaterThanOrEqual(0);
    expect(splitCommand?.[directionArgIndex + 1]).toBe('down');
  });

  test('even-vertical layout opens panes down', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('even-vertical', 60);

    await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    const splitCommand = commands().find((command) =>
      command.includes('split'),
    );
    const directionArgIndex = splitCommand?.indexOf('--direction') ?? -1;

    expect(directionArgIndex).toBeGreaterThanOrEqual(0);
    expect(splitCommand?.[directionArgIndex + 1]).toBe('down');
    expect(splitCommand).not.toContain('--ratio');
  });

  test('tiled layout opens panes right', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('tiled', 60);

    await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    const splitCommand = commands().find((command) =>
      command.includes('split'),
    );
    const directionArgIndex = splitCommand?.indexOf('--direction') ?? -1;

    expect(directionArgIndex).toBeGreaterThanOrEqual(0);
    expect(splitCommand?.[directionArgIndex + 1]).toBe('right');
  });

  test('tiled layout always splits parent right without a ratio', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('tiled', 60);

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');

    const splitCommands = commands().filter((c) => c.includes('split'));
    expect(splitCommands[0]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
    expect(splitCommands[1]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
    // main_pane_size applies to main-* layouts only.
    expect(splitCommands[0]).not.toContain('--ratio');
    expect(splitCommands[1]).not.toContain('--ratio');
  });

  test('even-horizontal splits the parent right without a ratio', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('even-horizontal', 60);

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');

    const splitCommands = commands().filter((c) => c.includes('split'));
    expect(splitCommands).toHaveLength(2);
    for (const split of splitCommands) {
      expect(split[3]).toBe('w1:p1');
      expect(split).toContain('right');
      expect(split).not.toContain('--ratio');
    }
  });

  test('main-horizontal: first spawn creates the agent row below', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-horizontal', 60);

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s3', 'A3', 'http://localhost:4096', '/repo');

    const splitCommands = commands().filter((c) => c.includes('split'));
    // 1st: parent → down, sized by main_pane_size.
    expect(splitCommands[0]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'down',
      '--cwd',
      '/repo',
      '--no-focus',
      '--ratio',
      '0.6',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
    // Later children stack to the right INSIDE the agent row, unsized.
    expect(splitCommands[1]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p2',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
    expect(splitCommands[2]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p2',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
  });

  test('main-horizontal: equalizes after each successful spawn', async () => {
    process.env.HERDR_TAB_ID = 'w1:t1';
    process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

    const { HerdrMultiplexer } = await importFreshHerdr();
    const equalize = createEqualizer();
    const herdr = new HerdrMultiplexer('main-horizontal', 60, {
      equalizer: equalize,
    });

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s3', 'A3', 'http://localhost:4096', '/repo');

    expect(equalize.mock.calls).toMatchObject([
      [
        {
          socketPath: '/tmp/herdr-test.sock',
          tabId: 'w1:t1',
          mainPaneId: 'w1:p1',
        },
      ],
      [
        {
          socketPath: '/tmp/herdr-test.sock',
          tabId: 'w1:t1',
          mainPaneId: 'w1:p1',
        },
      ],
      [
        {
          socketPath: '/tmp/herdr-test.sock',
          tabId: 'w1:t1',
          mainPaneId: 'w1:p1',
        },
      ],
    ]);
  });

  test('main-horizontal: recreates the agent row from the parent after close', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-horizontal', 70);

    const first = await herdr.spawnPane(
      's1',
      'A1',
      'http://localhost:4096',
      '/repo',
    );
    await herdr.closePane(first.paneId as string);
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');

    const splitCommands = commands().filter((c) => c.includes('split'));
    expect(splitCommands).toHaveLength(2);
    expect(splitCommands[1]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'down',
      '--cwd',
      '/repo',
      '--no-focus',
      '--ratio',
      '0.7',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
  });

  test('isInsideSession returns false when only HERDR_ENV is set', async () => {
    delete process.env.HERDR_PANE_ID;

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    expect(herdr.isInsideSession()).toBe(false);
  });

  test('isInsideSession returns true when HERDR_PANE_ID is set', async () => {
    delete process.env.HERDR_ENV;

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    expect(herdr.isInsideSession()).toBe(true);
  });

  test('isInsideSession returns false when no herdr env vars are set', async () => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    expect(herdr.isInsideSession()).toBe(false);
  });

  test('stores layout from constructor', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);
    // @ts-expect-error - accessing private for test
    expect(herdr.layout).toBe('main-vertical');
    // @ts-expect-error
    expect(herdr.agentAreaPaneId).toBeNull();
  });

  test('main-vertical: 2nd spawn splits agent area down', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.spawnPane('s1', 'Agent 1', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s2', 'Agent 2', 'http://localhost:4096', '/repo');

    const splitCommands = commands().filter((c) => c.includes('split'));
    expect(splitCommands[0]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--ratio',
      '0.6',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
    // Stacked sibling inside the agent area: herdr's default 50/50, no ratio.
    expect(splitCommands[1]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p2',
      '--direction',
      'down',
      '--cwd',
      '/repo',
      '--no-focus',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
  });

  test('main-vertical: 3rd spawn splits same agent area down', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s3', 'A3', 'http://localhost:4096', '/repo');

    const splitCommands = commands().filter((c) => c.includes('split'));
    expect(splitCommands[2]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p2',
      '--direction',
      'down',
      '--cwd',
      '/repo',
      '--no-focus',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
    expect(splitCommands[2]).not.toContain('--ratio');
  });

  test('main-vertical: fallback to parent when agent area closed', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const r1 = await herdr.spawnPane(
      's1',
      'A1',
      'http://localhost:4096',
      '/repo',
    );
    // Simulate agent area pane being closed externally
    await herdr.closePane(r1.paneId as string);

    // Next spawn should split from parent (w1:p1) → right, not from stale w1:p2
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');

    const splitCommands = commands().filter((c) => c.includes('split'));
    // 1st: parent → right (w1:p1)
    expect(splitCommands[0]).toContain('w1:p1');
    // 2nd (after close): parent → right again (w1:p1), not w1:p2
    expect(splitCommands[1]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--ratio',
      '0.6',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
  });

  test('main-vertical: implicit fallback when agent area split fails', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    // First spawn creates agent area (w1:p2)
    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');

    // Mock so split targeting w1:p2 (agent area, direction=down) fails
    // but split targeting w1:p1 (parent, direction=right) succeeds
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (
        command.includes('split') &&
        command.includes('w1:p2') &&
        command.includes('down')
      ) {
        return createSpawnResult(1, '', 'agent area pane gone');
      }
      if (command.includes('split')) {
        return createSpawnResult(0, `${createSplitResponse('w1:p3')}\n`);
      }
      return createSpawnResult();
    });

    // Second spawn: agent area split fails → falls back to parent split
    const result = await herdr.spawnPane(
      's2',
      'A2',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: 'w1:p3' });

    const splitCommands = commands().filter((c) => c.includes('split'));

    // 1st: parent split → right (first spawn), sized by main_pane_size
    expect(splitCommands[0]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--ratio',
      '0.6',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);

    // 2nd: agent area split → down (second spawn) — fails; no ratio
    expect(splitCommands[1]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p2',
      '--direction',
      'down',
      '--cwd',
      '/repo',
      '--no-focus',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);

    // 3rd: agent-area split retried once (still fails)
    expect(splitCommands[2]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p2',
      '--direction',
      'down',
      '--cwd',
      '/repo',
      '--no-focus',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);

    // 4th: parent split → right, WITHOUT --ratio: the old agent area still
    // occupies space, so sizing here would shrink the main pane twice.
    expect(splitCommands[3]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);

    // agentAreaPaneId was updated to the new pane from the parent split
    // @ts-expect-error - accessing private for test
    expect(herdr.agentAreaPaneId).toBe('w1:p3');
  });

  test('main_pane_size 80 sizes the first split at ratio 0.8', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-horizontal', 80);

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');

    const split = commands().find((c) => c.includes('split'));
    const ratioIndex = split?.indexOf('--ratio') ?? -1;
    expect(ratioIndex).toBeGreaterThan(-1);
    expect(split?.[ratioIndex + 1]).toBe('0.8');
  });

  test('main-vertical: recreated agent area split is sized again', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 70);

    const first = await herdr.spawnPane(
      's1',
      'A1',
      'http://localhost:4096',
      '/repo',
    );
    await herdr.closePane(first.paneId as string);
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');

    const splitCommands = commands().filter((c) => c.includes('split'));
    expect(splitCommands).toHaveLength(2);
    expect(splitCommands[1]).toEqual([
      '/usr/bin/herdr',
      'pane',
      'split',
      'w1:p1',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--no-focus',
      '--ratio',
      '0.7',
      '--env',
      'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
    ]);
  });

  test('main-vertical: stacked sibling split carries no ratio', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');

    const splitCommands = commands().filter((c) => c.includes('split'));
    expect(splitCommands[0]).toContain('--ratio');
    expect(splitCommands[1]).toContain('w1:p2');
    expect(splitCommands[1]).not.toContain('--ratio');
  });

  test('closePane clears agentAreaPaneId when agent area closed', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const r1 = await herdr.spawnPane(
      's1',
      'A1',
      'http://localhost:4096',
      '/repo',
    );
    await herdr.closePane(r1.paneId as string);

    // @ts-expect-error - accessing private for test
    expect(herdr.agentAreaPaneId).toBeNull();
  });

  test('closePane does NOT clear agentAreaPaneId for non-agent pane', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    // Close a different pane (simulated)
    await herdr.closePane('w1:p99');

    // @ts-expect-error
    expect(herdr.agentAreaPaneId).not.toBeNull();
  });

  describe('agent-area equalization', () => {
    test('equalizes after a successful spawn', async () => {
      process.env.HERDR_TAB_ID = 'w1:t1';
      process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
      });

      await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');

      expect(equalize.mock.calls).toMatchObject([
        [
          {
            socketPath: '/tmp/herdr-test.sock',
            tabId: 'w1:t1',
            mainPaneId: 'w1:p1',
          },
        ],
      ]);
    });

    test('equalizes again after an agent pane close', async () => {
      process.env.HERDR_TAB_ID = 'w1:t1';
      process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
      });

      await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
      await herdr.closePane('w1:p2');

      expect(equalize.mock.calls).toHaveLength(2);
      expect(equalize.mock.calls[1][0]).toMatchObject({
        socketPath: '/tmp/herdr-test.sock',
        tabId: 'w1:t1',
        mainPaneId: 'w1:p1',
        mainPaneShare: 0.6,
      });
    });

    test('does not equalize after a spawn when equalize_panes is false', async () => {
      process.env.HERDR_TAB_ID = 'w1:t1';
      process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
        equalizePanes: false,
      });

      const result = await herdr.spawnPane(
        's1',
        'A1',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: true, paneId: 'w1:p2' });
      expect(equalize.mock.calls).toHaveLength(0);
    });

    test('does not equalize after an agent pane close when equalize_panes is false', async () => {
      process.env.HERDR_TAB_ID = 'w1:t1';
      process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
        equalizePanes: false,
      });

      await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
      await herdr.closePane('w1:p2');

      expect(equalize.mock.calls).toHaveLength(0);
    });

    test('equalizes with an explicit equalize_panes true', async () => {
      process.env.HERDR_TAB_ID = 'w1:t1';
      process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
        equalizePanes: true,
      });

      await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');

      expect(equalize.mock.calls).toHaveLength(1);
    });

    test('does not equalize after closing a pane it did not spawn', async () => {
      process.env.HERDR_TAB_ID = 'w1:t1';
      process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
      });

      await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
      await herdr.closePane('w1:p99');

      expect(equalize.mock.calls).toHaveLength(1);
    });

    test('skips equalization when HERDR_TAB_ID is absent', async () => {
      process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
      });

      const result = await herdr.spawnPane(
        's1',
        'A1',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: true, paneId: 'w1:p2' });
      expect(equalize.mock.calls).toHaveLength(0);
    });

    test('equalizer failures never change the spawn result', async () => {
      process.env.HERDR_TAB_ID = 'w1:t1';
      process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = mock(
        async (_opts: EqualizeAgentPanesOptions): Promise<boolean> => {
          throw new Error('socket exploded');
        },
      );
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
      });

      const result = await herdr.spawnPane(
        's1',
        'A1',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: true, paneId: 'w1:p2' });
      expect(equalize.mock.calls).toHaveLength(1);
    });

    test('does not equalize when the spawn fails', async () => {
      process.env.HERDR_TAB_ID = 'w1:t1';
      process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which') {
          return createSpawnResult(0, '/usr/bin/herdr\n');
        }
        if (command.includes('split')) {
          return createSpawnResult(1, '', 'split failed');
        }
        return createSpawnResult();
      });

      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
      });

      const result = await herdr.spawnPane(
        's1',
        'A1',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: false, error: 'hard' });
      expect(equalize.mock.calls).toHaveLength(0);
    });
  });

  // Regression: concurrent spawns must not race on agentAreaPaneId (#762)
  test('main-vertical: concurrent spawns produce one parent split + down splits', async () => {
    let splitCount = 0;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        splitCount++;
        // Return sequential pane IDs so we can track which split is which
        return createSpawnResult(
          0,
          `${createSplitResponse(`w1:p${splitCount + 1}`)}\n`,
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    // Fire both concurrently — before the fix, both would see
    // agentAreaPaneId === null and split from the parent (w1:p1).
    const [r1, r2] = await Promise.all([
      herdr.spawnPane('s1', 'Agent 1', 'http://localhost:4096', '/repo'),
      herdr.spawnPane('s2', 'Agent 2', 'http://localhost:4096', '/repo'),
    ]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    const splitCommands = commands().filter((c) => c.includes('split'));
    // Exactly 2 splits total
    expect(splitCommands.length).toBe(2);

    // First split: parent (w1:p1) → right
    expect(splitCommands[0][3]).toBe('w1:p1');
    expect(splitCommands[0]).toContain('right');

    // Second split: agent area (w1:p2) → down
    expect(splitCommands[1][3]).toBe('w1:p2');
    expect(splitCommands[1]).toContain('down');
  });

  test('keeps the full encoded FR-8 label when renaming a pane', async () => {
    const encoded = 'omosc:4242:ses_f41e46f05ffeoEESP7f24NJ9d6';
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.spawnPane('child', encoded, 'http://localhost:4096', '/repo');

    const rename = commands().find((command) => command.includes('rename'));
    expect(rename).toEqual([
      '/usr/bin/herdr',
      'pane',
      'rename',
      'w1:p2',
      encoded,
    ]);
  });

  test('listPanesWithTitles reads the label field from pane list', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('list')) {
        return createSpawnResult(
          0,
          `${JSON.stringify({
            id: 'cli:pane:list',
            result: {
              type: 'pane_list',
              panes: [
                { pane_id: 'w1:p1', terminal_title: 'shell' },
                { pane_id: 'w1:p2', label: 'omosc:123:ses_abc' },
              ],
            },
          })}\n`,
        );
      }
      return createSpawnResult();
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    expect(await herdr.listPanesWithTitles()).toEqual([
      { paneId: 'w1:p1', title: '' },
      { paneId: 'w1:p2', title: 'omosc:123:ses_abc' },
    ]);
  });

  test('sweep closes only the dead-owner terminal pane (FR-8)', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('list')) {
        return createSpawnResult(
          0,
          `${JSON.stringify({
            id: 'cli:pane:list',
            result: {
              type: 'pane_list',
              panes: [
                { pane_id: 'w1:p1', terminal_title: 'shell' },
                { pane_id: 'w1:p2', label: 'omosc:999:ses_gone' },
                { pane_id: 'w1:p3', label: 'omosc:4242:ses_gone' },
                { pane_id: 'w1:p4', label: 'omosc:999:ses_alive' },
              ],
            },
          })}\n`,
        );
      }
      return createSpawnResult();
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const { sweepLeftoverPanes } = await import('../client/sweep');
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const stats = await sweepLeftoverPanes({
      adapter: herdr,
      isProcessAlive: (pid) => pid !== 999,
      isSessionTerminal: async (child) => child === 'ses_gone',
    });

    expect(stats.closed).toBe(1);
    const closes = commands().filter((command) => command.includes('close'));
    expect(closes).toHaveLength(1);
    expect(closes[0]).toEqual(['/usr/bin/herdr', 'pane', 'close', 'w1:p2']);
  });

  test('retries a sized split without --ratio and latches for the process', async () => {
    let sizedFailures = 0;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        if (command.includes('--ratio')) {
          sizedFailures += 1;
          return createSpawnResult(1, '', 'error: unexpected argument --ratio');
        }
        return createSpawnResult(0, `${createSplitResponse('w1:p2')}\n`);
      }
      return createSpawnResult();
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const first = await herdr.spawnPane(
      's1',
      'A1',
      'http://localhost:4096',
      '/repo',
    );
    expect(first).toEqual({ success: true, paneId: 'w1:p2' });
    expect(sizedFailures).toBe(1);

    await herdr.closePane('w1:p2');
    const second = await herdr.spawnPane(
      's2',
      'A2',
      'http://localhost:4096',
      '/repo',
    );
    expect(second.success).toBe(true);

    const splits = commands().filter((command) => command.includes('split'));
    // Only the first attempt carried --ratio; the latch keeps later spawns
    // working on a herdr build that rejects the flag.
    expect(
      splits.filter((command) => command.includes('--ratio')),
    ).toHaveLength(1);
    expect(splits).toHaveLength(3);
  });

  test('prunes agent pane ids that vanished from the exported layout', async () => {
    process.env.HERDR_TAB_ID = 'w1:t1';
    process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

    let onPanesSeen: ((ids: Set<string>) => void) | undefined;
    const equalize = mock(async (opts: EqualizeAgentPanesOptions) => {
      onPanesSeen = opts.onPanesSeen;
      return true;
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60, {
      equalizer: equalize,
    });

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    // @ts-expect-error - accessing private for test
    expect(herdr.agentPaneIds.has('w1:p2')).toBe(true);

    // Simulate the user closing that pane: it is gone from the layout.
    onPanesSeen?.(new Set(['w1:p1']));

    // @ts-expect-error - accessing private for test
    expect(herdr.agentPaneIds.has('w1:p2')).toBe(false);
  });

  test('does not equalize or size even-*/tiled layouts', async () => {
    process.env.HERDR_TAB_ID = 'w1:t1';
    process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';

    for (const layout of [
      'even-horizontal',
      'even-vertical',
      'tiled',
    ] as const) {
      crossSpawnMock.mockReset();
      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which') {
          return createSpawnResult(0, '/usr/bin/herdr\n');
        }
        if (command.includes('split')) {
          return createSpawnResult(0, `${createSplitResponse('w1:p2')}\n`);
        }
        return createSpawnResult();
      });
      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer(layout, 80, {
        equalizer: equalize,
      });

      await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');

      // No correction pass and no ratio: these layouts keep their even split.
      expect(equalize.mock.calls).toHaveLength(0);
      const splits = commands().filter((command) => command.includes('split'));
      expect(splits).toHaveLength(1);
      expect(splits[0]).not.toContain('--ratio');
    }
  });

  test('does not latch ratio support on an unrelated split failure', async () => {
    let sizedAttempts = 0;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        if (command.includes('--ratio')) {
          sizedAttempts += 1;
          return createSpawnResult(1, '', 'error: pane would be too small');
        }
        return createSpawnResult(0, `${createSplitResponse('w1:p2')}\n`);
      }
      return createSpawnResult();
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    await herdr.closePane('w1:p2');
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');

    // A transient failure retried unsized, but sizing stays enabled: the
    // second parent split tries --ratio again.
    expect(sizedAttempts).toBe(2);
  });
});
