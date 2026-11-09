import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTimerHarness } from '../../utils/test-timers';
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
const loggerEntries: Array<{ message: string; data?: unknown }> = [];
const loggerMock = mock((message: string, data?: unknown) => {
  loggerEntries.push({ message, data });
});

mock.module('../../utils/logger', () => ({
  initLogger: mock(() => {}),
  log: loggerMock,
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

function createHerdrAppListing(
  spaceId: string,
  tabId: string,
  terminalId: string,
  paneId = 'p-child',
): string {
  return JSON.stringify({
    spaces: [
      {
        id: spaceId,
        tabs: [
          {
            id: tabId,
            terminals: [{ terminal: terminalId, pane: paneId }],
          },
        ],
      },
    ],
  });
}

async function importFreshHerdr() {
  return import(`./index?test=${importCounter++}`);
}

function commands(): string[][] {
  return crossSpawnMock.mock.calls.map((call) => call[0] as string[]);
}

function spawnTokenFromCalls(): string {
  const run = [...commands()].reverse().find((command) => command[1] === 'run');
  const label = run?.find((arg) => arg.startsWith('omosc.spawn='));
  return label?.slice('omosc.spawn='.length) ?? '';
}

const originalPlatform = process.platform;
const lookupCommand = originalPlatform === 'win32' ? 'where' : 'which';

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

const waitForGrace = async () => {};

describe('HerdrMultiplexer', () => {
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalHerdrPaneId = process.env.HERDR_PANE_ID;
  const originalHcTerminalId = process.env.HC_TERMINAL_ID;
  const originalHerdrBinPath = process.env.HERDR_BIN_PATH;
  const originalHerdrTabId = process.env.HERDR_TAB_ID;
  const originalHerdrSocketPath = process.env.HERDR_SOCKET_PATH;

  beforeEach(() => {
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'w1:p1';
    delete process.env.HC_TERMINAL_ID;
    delete process.env.HERDR_BIN_PATH;
    // Never let a real herdr socket leak into the suite.
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;

    crossSpawnMock.mockReset();
    loggerMock.mockClear();
    loggerEntries.length = 0;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === lookupCommand) {
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
    if (originalHcTerminalId === undefined) {
      delete process.env.HC_TERMINAL_ID;
    } else {
      process.env.HC_TERMINAL_ID = originalHcTerminalId;
    }
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

    expect(commands().some((command) => command[0] === lookupCommand)).toBe(
      false,
    );
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

  test('desktop mode anchors the child to the exact core terminal', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let childFinished = false;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command.includes('get')) {
        if (command[2] === 't-child') {
          return createSpawnResult(
            0,
            JSON.stringify({
              address: 't-child',
              parent: 't-parent',
              state: childFinished ? 'finished' : 'live',
              foreground: childFinished ? null : { pid: 42 },
              labels: {
                'herdr.space': 'space-1',
                'herdr.tab': 'tab-1',
                'omosc.owner': 't-parent',
                'omosc.spawn': spawnTokenFromCalls(),
                omosc: `omosc:${process.pid}:session-1`,
              },
            }),
          );
        }
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
            },
          }),
        );
      }
      if (command.includes('run')) {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-child',
            parent: 't-parent',
            state: 'live',
            foreground: { pid: 42 },
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              'omosc.spawn': spawnTokenFromCalls(),
              omosc: `omosc:${process.pid}:session-1`,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        return createSpawnResult(
          0,
          createHerdrAppListing('space-1', 'tab-1', 't-child'),
        );
      }
      if (command[1] === 'kill' && command[2] === 't-child') {
        childFinished = true;
        return createSpawnResult();
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer(undefined, undefined, {
      desktopAdoptionWait: async () => {},
    });
    const result = await adapter.spawnPane(
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    );
    expect(result).toEqual({ success: true, paneId: 't-child' });
    const calls = commands();
    expect(calls.find((command) => command.includes('get'))).toEqual([
      '/usr/bin/hc',
      'get',
      't-parent',
      '--json',
    ]);
    const run = calls.find((command) => command.includes('run'));
    expect(run).toContain('--parent');
    expect(run).toContain('--no-notify');
    expect(run).toContain('t-parent');
    expect(run).toContain('omosc.owner=t-parent');
    expect(run).toContain('herdr.space=space-1');
    expect(run).toContain('herdr.tab=tab-1');
    expect(run).toContain('--');
    expect(calls.find((command) => command[1] === 'ls')).toEqual([
      '/usr/bin/herdr-app',
      'ls',
    ]);
    expect(await adapter.closePane('t-child')).toBe(true);
    expect(commands().some((command) => command[1] === 'kill')).toBe(true);
    expect(commands().some((command) => command[1] === 'rm')).toBe(true);
  });

  test('desktop run names satisfy hc rules for mixed-case IDs and descriptions', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    const cases = [
      {
        description: '  --___ odd / worker 🐈  ',
        sessionId: 'SeS_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      },
      {
        description: '___',
        sessionId: 'Z',
      },
      {
        description: '._--',
        sessionId: '_',
      },
      {
        description: 'A'.repeat(80),
        sessionId: `${'AbCd_'.repeat(12)}WXYZ`,
      },
    ];
    const names: string[] = [];

    for (const [index, entry] of cases.entries()) {
      const address = `t-child-${index}`;
      const firstCall = commands().length;
      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which') {
          return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
        }
        if (command[1] === 'get' && command[2] === 't-parent') {
          return createSpawnResult(
            0,
            JSON.stringify({
              address: 't-parent',
              parent: null,
              state: 'live',
              labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
            }),
          );
        }
        if (command[1] === 'run') {
          return createSpawnResult(
            0,
            JSON.stringify({ address, parent: 't-parent' }),
          );
        }
        if (command[1] === 'get' && command[2] === address) {
          return createSpawnResult(
            0,
            JSON.stringify({
              address,
              parent: 't-parent',
              state: 'live',
              foreground: { pid: 42 },
              labels: {
                'herdr.space': 'space-1',
                'herdr.tab': 'tab-1',
                'omosc.owner': 't-parent',
                'omosc.spawn': spawnTokenFromCalls(),
                omosc: `omosc:${process.pid}:${entry.sessionId}`,
              },
            }),
          );
        }
        if (command[1] === 'ls') {
          return createSpawnResult(
            0,
            createHerdrAppListing('space-1', 'tab-1', address),
          );
        }
        return createSpawnResult();
      });

      const { HerdrMultiplexer } = await importFreshHerdr();
      const result = await new HerdrMultiplexer().spawnPane(
        entry.sessionId,
        entry.description,
        'http://localhost:4096',
        '/repo',
      );
      expect(result).toEqual({ success: true, paneId: address });

      const calls = commands().slice(firstCall);
      const run = calls.find((command) => command[1] === 'run');
      expect(run).toBeDefined();
      const name = run?.[run.indexOf('--name') + 1] ?? '';
      names.push(name);
      expect(name).toMatch(/^[a-z0-9][a-z0-9._-]{0,31}$/);
      expect(name.length).toBeLessThanOrEqual(32);
      const normalizedSessionId = entry.sessionId
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(-30);
      expect(name.endsWith(`-${normalizedSessionId}`)).toBe(true);

      const separator = run?.indexOf('--') ?? -1;
      const viewerArgv = run?.slice(separator + 1) ?? [];
      expect(viewerArgv.slice(0, 4)).toEqual([
        'env',
        'OH_MY_OPENCODE_SLIM_PANE_VIEWER=1',
        'sh',
        '-lc',
      ]);
      expect(viewerArgv.at(-1)).toContain(`--session '${entry.sessionId}'`);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  test('desktop cleans a malformed hc run result by its unique verified label', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let spawnToken = '';
    let orphanFinished = false;
    const calls: string[][] = [];
    crossSpawnMock.mockImplementation((command: string[]) => {
      calls.push(command);
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        spawnToken =
          command
            .find((arg) => arg.startsWith('omosc.spawn='))
            ?.slice('omosc.spawn='.length) ?? '';
        return createSpawnResult(0, 'truncated child output');
      }
      if (
        command[1] === 'ls' &&
        command.includes(`omosc.spawn=${spawnToken}`)
      ) {
        return createSpawnResult(
          0,
          JSON.stringify({ terminals: [{ address: 't-orphan' }] }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-orphan') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-orphan',
            parent: 't-parent',
            state: orphanFinished ? 'finished' : 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: `omosc:${process.pid}:session-1`,
              'omosc.spawn': spawnToken,
            },
          }),
        );
      }
      if (command[1] === 'kill' && command[2] === 't-orphan') {
        orphanFinished = true;
        return createSpawnResult();
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().spawnPane(
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(spawnToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      calls.some(
        (command) =>
          command[1] === 'kill' &&
          command[2] === 't-orphan' &&
          command[3] === '--json',
      ),
    ).toBe(true);
    expect(
      calls.some(
        (command) =>
          command[1] === 'rm' &&
          command[2] === 't-orphan' &&
          command[3] === '--json',
      ),
    ).toBe(true);
  });

  test('desktop blocks a duplicate spawn while rollback lookup keeps failing', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let runCount = 0;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      if (command[1] === 'get' && command[2] === 't-parent')
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      if (command[1] === 'run') {
        runCount += 1;
        return createSpawnResult(0, '{invalid');
      }
      if (command[1] === 'ls') return createSpawnResult(1, '', 'lookup failed');
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer(undefined, undefined, {
      desktopAdoptionWait: async () => {},
    });
    const args = [
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    ] as const;
    expect(await adapter.spawnPane(...args)).toEqual({
      success: false,
      error: 'hard',
    });
    expect(
      await adapter.spawnPane(
        'session-2',
        'Worker',
        'http://localhost:4096',
        '/repo',
      ),
    ).toEqual({
      success: false,
      error: 'hard',
    });
    expect(await adapter.spawnPane(...args)).toEqual({
      success: false,
      error: 'hard',
    });
    expect(runCount).toBe(2);
  });

  test('desktop retries a failed rollback before spawning the same child', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    const calls: string[][] = [];
    let spawnToken = '';
    let state: 'live' | 'finished' = 'live';
    let killCount = 0;
    let rmCount = 0;
    let runCount = 0;
    crossSpawnMock.mockImplementation((command: string[]) => {
      calls.push(command);
      if (command[0] === 'which')
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      if (command[1] === 'get' && command[2] === 't-parent')
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      if (command[1] === 'run') {
        runCount += 1;
        spawnToken =
          command
            .find((arg) => arg.startsWith('omosc.spawn='))
            ?.slice('omosc.spawn='.length) ?? '';
        return createSpawnResult(0, '{invalid');
      }
      if (command[1] === 'ls' && command.includes(`omosc.spawn=${spawnToken}`))
        return createSpawnResult(
          0,
          JSON.stringify({ terminals: [{ address: 't-orphan' }] }),
        );
      if (command[1] === 'get' && command[2] === 't-orphan')
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-orphan',
            parent: 't-parent',
            state,
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: `omosc:${process.pid}:session-1`,
              'omosc.spawn': spawnToken,
            },
          }),
        );
      if (command[1] === 'kill' && command[2] === 't-orphan') {
        killCount += 1;
        if (killCount === 1) return createSpawnResult(1, '', 'kill failed');
        state = 'finished';
      }
      if (command[1] === 'rm' && command[2] === 't-orphan') {
        rmCount += 1;
        if (rmCount === 1) return createSpawnResult(1, '', 'rm failed');
        return createSpawnResult();
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer(undefined, undefined, {
      desktopAdoptionWait: async () => {},
    });
    const args = [
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    ] as const;
    expect(await adapter.spawnPane(...args)).toEqual({
      success: false,
      error: 'hard',
    });
    expect(await adapter.spawnPane(...args)).toEqual({
      success: false,
      error: 'hard',
    });
    expect(await adapter.spawnPane(...args)).toEqual({
      success: false,
      error: 'hard',
    });
    const nextRun = calls.findIndex(
      (command, index) => index > 0 && command[1] === 'run',
    );
    const secondRun = calls.findIndex(
      (command, index) => index > nextRun && command[1] === 'run',
    );
    expect(
      calls.findIndex(
        (command) => command[1] === 'rm' && command[2] === 't-orphan',
      ),
    ).toBeLessThan(secondRun);
    expect(killCount).toBe(2);
    expect(rmCount).toBe(3);
    expect(runCount).toBe(2);
  });

  test('desktop retries an empty rollback scan before another spawn', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    const calls: string[][] = [];
    let token = '';
    let listCount = 0;
    let waitCount = 0;
    let childState: 'live' | 'finished' = 'live';
    crossSpawnMock.mockImplementation((command: string[]) => {
      calls.push(command);
      if (command[0] === 'which')
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      if (command[1] === 'get' && command[2] === 't-parent')
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: childState,
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      if (command[1] === 'run') {
        token =
          command
            .find((arg) => arg.startsWith('omosc.spawn='))
            ?.slice('omosc.spawn='.length) ?? '';
        return createSpawnResult(0, '{invalid');
      }
      if (command[1] === 'ls' && command.includes(`omosc.spawn=${token}`)) {
        listCount += 1;
        return createSpawnResult(
          0,
          JSON.stringify({
            terminals: listCount === 1 ? [] : [{ address: 't-late' }],
          }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-late')
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-late',
            parent: 't-parent',
            state: childState,
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: `omosc:${process.pid}:session-1`,
              'omosc.spawn': token,
            },
          }),
        );
      if (command[1] === 'kill' && command[2] === 't-late')
        childState = 'finished';
      if (command[1] === 'kill' && command[2] === 't-late')
        return createSpawnResult();
      if (command[1] === 'rm' && command[2] === 't-late')
        return createSpawnResult();
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer(undefined, undefined, {
      desktopAdoptionWait: async (milliseconds) => {
        expect(milliseconds).toBe(500);
        waitCount += 1;
      },
    });
    const args = [
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    ] as const;
    expect(await adapter.spawnPane(...args)).toEqual({
      success: false,
      error: 'hard',
    });
    expect(await adapter.spawnPane(...args)).toEqual({
      success: false,
      error: 'hard',
    });
    const runs = calls
      .map((command, index) => (command[1] === 'run' ? index : -1))
      .filter((index) => index >= 0);
    expect(runs).toHaveLength(2);
    expect(waitCount).toBeGreaterThan(0);
    expect(
      calls
        .slice(runs[0] + 1, runs[1])
        .some((command) => command[1] === 'kill'),
    ).toBe(true);
  });

  test('desktop does not clean a malformed-run candidate with different ownership', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let spawnToken = '';
    let scanCount = 0;
    let runCount = 0;
    const calls: string[][] = [];
    crossSpawnMock.mockImplementation((command: string[]) => {
      calls.push(command);
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        runCount += 1;
        spawnToken =
          command
            .find((arg) => arg.startsWith('omosc.spawn='))
            ?.slice('omosc.spawn='.length) ?? '';
        return createSpawnResult(0, '{invalid');
      }
      if (
        command[1] === 'ls' &&
        command.includes(`omosc.spawn=${spawnToken}`)
      ) {
        scanCount += 1;
        return createSpawnResult(
          0,
          JSON.stringify({
            terminals: scanCount < 3 ? [{ address: 't-unowned' }] : [],
          }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-unowned') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-unowned',
            parent: 't-other',
            state: 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-other',
              omosc: `omosc:${process.pid}:someone-else`,
              'omosc.spawn': spawnToken,
            },
          }),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer(undefined, undefined, {
      desktopAdoptionWait: async () => {},
    });
    const args = [
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    ] as const;
    const first = await adapter.spawnPane(...args);
    const blocked = await adapter.spawnPane(...args);
    const afterCandidateGone = await adapter.spawnPane(...args);

    expect(first).toEqual({ success: false, error: 'hard' });
    expect(blocked).toEqual({ success: false, error: 'hard' });
    // Candidate disappears: bounded scan window elapses, then a new spawn is
    // attempted (it still fails in this mock), but the foreign terminal is
    // never killed.
    expect(afterCandidateGone).toEqual({ success: false, error: 'hard' });
    expect(runCount).toBe(2);
    expect(calls.some((command) => command[1] === 'kill')).toBe(false);
    expect(calls.some((command) => command[1] === 'rm')).toBe(false);
    expect(loggerEntries).toContainEqual({
      message: '[herdr] desktop spawn: rollback ownership check failed',
      data: {
        paneId: 't-unowned',
        hasParent: true,
        state: 'live',
      },
    });
  });

  test('desktop removes a verified finished orphan without killing it', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let spawnToken = '';
    const calls: string[][] = [];
    crossSpawnMock.mockImplementation((command: string[]) => {
      calls.push(command);
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        spawnToken =
          command
            .find((arg) => arg.startsWith('omosc.spawn='))
            ?.slice('omosc.spawn='.length) ?? '';
        return createSpawnResult(0, 'unreadable run response');
      }
      if (
        command[1] === 'ls' &&
        command.includes(`omosc.spawn=${spawnToken}`)
      ) {
        return createSpawnResult(
          0,
          JSON.stringify({ terminals: [{ address: 't-finished' }] }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-finished') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-finished',
            parent: 't-parent',
            state: 'finished',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: `omosc:${process.pid}:session-1`,
              'omosc.spawn': spawnToken,
            },
          }),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().spawnPane(
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(calls.some((command) => command[1] === 'kill')).toBe(false);
    expect(calls).toContainEqual(['/usr/bin/hc', 'rm', 't-finished', '--json']);
  });

  test('desktop v2-shared mini pins cwd instead of passing it positionally', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    const sessionId = 'ses_miniViewer';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-mini', parent: 't-parent' }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-mini') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-mini',
            parent: 't-parent',
            state: 'live',
            foreground: { pid: 42 },
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              'omosc.spawn': spawnTokenFromCalls(),
              omosc: `omosc:${process.pid}:${sessionId}`,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        return createSpawnResult(
          0,
          createHerdrAppListing('space-1', 'tab-1', 't-mini'),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().spawnPane(
      sessionId,
      'Mini viewer',
      'http://localhost:4096',
      '/repo',
      { viewerFlavor: 'v2-shared', viewerSurface: 'mini' },
    );

    expect(result).toEqual({ success: true, paneId: 't-mini' });
    const run = commands().find((command) => command[1] === 'run');
    expect(run).toBeDefined();
    expect(run?.[run.indexOf('--cwd') + 1]).toBe('/repo');
    const separator = run?.indexOf('--') ?? -1;
    const shellCommand = run?.[separator + 5] ?? '';
    expect(shellCommand).toBe(`opencode mini --session '${sessionId}'`);
    expect(shellCommand).not.toContain('/repo');
  });

  test('desktop v2-shared full viewer keeps its positional directory', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    const sessionId = 'ses_fullViewer';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-full', parent: 't-parent' }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-full') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-full',
            parent: 't-parent',
            state: 'live',
            foreground: { pid: 42 },
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              'omosc.spawn': spawnTokenFromCalls(),
              omosc: `omosc:${process.pid}:${sessionId}`,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        return createSpawnResult(
          0,
          createHerdrAppListing('space-1', 'tab-1', 't-full'),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().spawnPane(
      sessionId,
      'Full viewer',
      'http://localhost:4096',
      '/repo',
      { viewerFlavor: 'v2-shared' },
    );

    expect(result).toEqual({ success: true, paneId: 't-full' });
    const run = commands().find((command) => command[1] === 'run');
    expect(run).toBeDefined();
    expect(run?.includes('--cwd')).toBe(false);
    const separator = run?.indexOf('--') ?? -1;
    const shellCommand = run?.[separator + 5] ?? '';
    expect(shellCommand).toBe(`opencode --session '${sessionId}' '/repo'`);
  });

  test('desktop waits for Herdr to adopt the labeled child', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let appScans = 0;
    const adoptionDelays: number[] = [];
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-child', parent: 't-parent' }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-child') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-child',
            parent: 't-parent',
            state: 'live',
            foreground: { pid: 42 },
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              'omosc.spawn': spawnTokenFromCalls(),
              omosc: `omosc:${process.pid}:session-1`,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        appScans += 1;
        return createSpawnResult(
          0,
          appScans === 1
            ? JSON.stringify({ spaces: [] })
            : createHerdrAppListing('space-1', 'tab-1', 't-child'),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer('main-vertical', 60, {
      desktopAdoptionWait: async (milliseconds) => {
        adoptionDelays.push(milliseconds);
      },
    }).spawnPane('session-1', 'Worker', 'http://localhost:4096', '/repo');

    expect(result).toEqual({ success: true, paneId: 't-child' });
    expect(appScans).toBe(2);
    expect(adoptionDelays).toEqual([500]);
    expect(commands().some((command) => command[1] === 'do')).toBe(false);
  });

  test('desktop retries temporary core and app reads but logs each failure', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let childGets = 0;
    let appScans = 0;
    const delays: number[] = [];
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-child', parent: 't-parent' }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-child') {
        childGets += 1;
        if (childGets === 1) {
          return createSpawnResult(
            1,
            '',
            JSON.stringify({
              error: { kind: 'unavailable', message: 'core is restarting' },
            }),
          );
        }
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-child',
            parent: 't-parent',
            state: 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              'omosc.spawn': spawnTokenFromCalls(),
              omosc: `omosc:${process.pid}:session-1`,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        appScans += 1;
        if (appScans === 1) {
          return createSpawnResult(1, '', 'window is catching up');
        }
        return createSpawnResult(
          0,
          createHerdrAppListing('space-1', 'tab-1', 't-child'),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer('main-vertical', 60, {
      desktopAdoptionWait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    }).spawnPane('session-1', 'Worker', 'http://localhost:4096', '/repo');

    expect(result).toEqual({ success: true, paneId: 't-child' });
    expect(delays).toEqual([500, 500]);
    expect(loggerEntries).toContainEqual({
      message: '[herdr] desktop terminal lookup failed',
      data: {
        address: 't-child',
        exitCode: 1,
        errorKind: 'unavailable',
        error:
          '{"error":{"kind":"unavailable","message":"core is restarting"}}',
      },
    });
    expect(loggerEntries).toContainEqual({
      message: '[herdr] desktop pane scan failed',
      data: { exitCode: 1, stderr: 'window is catching up', stdout: '' },
    });
  });

  test('desktop logs and rejects malformed Herdr app listing shapes', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    const delays: number[] = [];
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-child', parent: 't-parent' }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-child') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-child',
            parent: 't-parent',
            state: 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              'omosc.spawn': spawnTokenFromCalls(),
              omosc: `omosc:${process.pid}:session-1`,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        return createSpawnResult(0, JSON.stringify({ spaces: [{ id: 7 }] }));
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer('main-vertical', 60, {
      desktopAdoptionWait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    }).spawnPane('session-1', 'Worker', 'http://localhost:4096', '/repo');

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(delays).toEqual([]);
    expect(loggerEntries).toContainEqual({
      message: '[herdr] desktop pane scan found an invalid space entry',
      data: { entryType: 'object' },
    });
  });

  test('desktop removes a malformed hc run result only after marker ownership checks', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let spawnToken = '';
    let orphanFinished = false;
    const calls: string[][] = [];
    crossSpawnMock.mockImplementation((command: string[]) => {
      calls.push(command);
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        spawnToken =
          command
            .find((arg) => arg.startsWith('omosc.spawn='))
            ?.slice('omosc.spawn='.length) ?? '';
        return createSpawnResult(0, 'truncated JSON output');
      }
      if (
        command[1] === 'ls' &&
        command.includes(`omosc.spawn=${spawnToken}`)
      ) {
        return createSpawnResult(
          0,
          JSON.stringify({ terminals: [{ address: 't-orphan' }] }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-orphan') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-orphan',
            parent: 't-parent',
            state: orphanFinished ? 'finished' : 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: `omosc:${process.pid}:session-1`,
              'omosc.spawn': spawnToken,
            },
          }),
        );
      }
      if (command[1] === 'kill' && command[2] === 't-orphan') {
        orphanFinished = true;
        return createSpawnResult();
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().spawnPane(
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(spawnToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toContainEqual(['/usr/bin/hc', 'kill', 't-orphan', '--json']);
    expect(calls).toContainEqual(['/usr/bin/hc', 'rm', 't-orphan', '--json']);
  });

  test('desktop leaves a malformed-run candidate alone when its parent does not match', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let spawnToken = '';
    const calls: string[][] = [];
    crossSpawnMock.mockImplementation((command: string[]) => {
      calls.push(command);
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        spawnToken =
          command
            .find((arg) => arg.startsWith('omosc.spawn='))
            ?.slice('omosc.spawn='.length) ?? '';
        return createSpawnResult(0, '{not-json');
      }
      if (
        command[1] === 'ls' &&
        command.includes(`omosc.spawn=${spawnToken}`)
      ) {
        return createSpawnResult(
          0,
          JSON.stringify({ terminals: [{ address: 't-unowned' }] }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-unowned') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-unowned',
            parent: 't-other',
            state: 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-other',
              omosc: `omosc:${process.pid}:someone-else`,
              'omosc.spawn': spawnToken,
            },
          }),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().spawnPane(
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(calls.some((command) => command[1] === 'kill')).toBe(false);
    expect(calls.some((command) => command[1] === 'rm')).toBe(false);
    expect(loggerEntries).toContainEqual({
      message: '[herdr] desktop spawn: rollback ownership check failed',
      data: {
        paneId: 't-unowned',
        hasParent: true,
        state: 'live',
      },
    });
  });

  test('desktop does not retry adoption after the child has exited', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let childGets = 0;
    const retryDelays: number[] = [];
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-child', parent: 't-parent' }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-child') {
        childGets += 1;
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-child',
            parent: 't-parent',
            state: childGets === 1 ? 'live' : 'finished',
            foreground: childGets === 1 ? { pid: 42 } : null,
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              'omosc.spawn': spawnTokenFromCalls(),
              omosc: `omosc:${process.pid}:session-1`,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        return createSpawnResult(0, JSON.stringify({ spaces: [] }));
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer('main-vertical', 60, {
      desktopAdoptionWait: async (milliseconds) => {
        retryDelays.push(milliseconds);
      },
    }).spawnPane('session-1', 'Worker', 'http://localhost:4096', '/repo');

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(retryDelays).toEqual([]);
    expect(commands().filter((command) => command[1] === 'ls')).toHaveLength(0);
  });

  test('desktop rolls back after pane adoption retries are exhausted', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    const retryDelays: number[] = [];
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-child', parent: 't-parent' }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-child') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-child',
            parent: 't-parent',
            state: 'live',
            foreground: { pid: 42 },
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              'omosc.spawn': spawnTokenFromCalls(),
              omosc: `omosc:${process.pid}:session-1`,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        return createSpawnResult(0, JSON.stringify({ spaces: [] }));
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer('main-vertical', 60, {
      desktopAdoptionWait: async (milliseconds) => {
        retryDelays.push(milliseconds);
      },
    }).spawnPane('session-1', 'Worker', 'http://localhost:4096', '/repo');

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(retryDelays).toEqual([500, 500, 500]);
    expect(commands().filter((command) => command[1] === 'ls')).toHaveLength(4);
    expect(commands().some((command) => command[1] === 'kill')).toBe(true);
  });

  test('desktop mode refuses to spawn when the anchor lacks Herdr labels', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command.includes('get')) {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: {},
          }),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().spawnPane(
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'not_found' });
    expect(commands().some((command) => command.includes('run'))).toBe(false);
  });

  test('desktop mode refuses a stale anchor without running a child', async () => {
    process.env.HC_TERMINAL_ID = 't-stale-parent';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-stale-parent') {
        return createSpawnResult(
          1,
          JSON.stringify({
            error: { kind: 'not_found', message: 'terminal not found' },
          }),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().spawnPane(
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'not_found' });
    expect(commands().some((command) => command[1] === 'run')).toBe(false);
  });

  test('desktop fails closed and logs an invalid parent response shape', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-parent', parent: null, labels: [] }),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().spawnPane(
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(commands().some((command) => command[1] === 'run')).toBe(false);
    expect(loggerEntries).toContainEqual({
      message: '[herdr] desktop terminal lookup returned invalid fields',
      data: {
        address: 't-parent',
        stdout: '{"address":"t-parent","parent":null,"labels":[]}',
      },
    });
  });

  test('desktop close refuses a terminal this adapter did not create', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().closePane('t-child');

    expect(result).toBe(false);
    expect(commands()).toEqual([]);
  });

  test('desktop close removes a finished owned terminal without killing it', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/hc\n');
      }
      if (command[1] === 'get' && command[2] === 't-finished') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-finished',
            parent: 't-parent',
            state: 'finished',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: 'omosc:12:finishedChild',
              'omosc.spawn': 'spawn-token-12',
            },
          }),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer();
    (
      adapter as unknown as {
        desktopOwnedTerminals: Map<
          string,
          {
            parentId: string;
            title: string;
            spaceId: string;
            tabId: string;
            spawnToken: string;
          }
        >;
      }
    ).desktopOwnedTerminals.set('t-finished', {
      parentId: 't-parent',
      title: 'omosc:12:finishedChild',
      spaceId: 'space-1',
      tabId: 'tab-1',
      spawnToken: 'spawn-token-12',
    });

    expect(await adapter.closePane('t-finished')).toBe(true);
    expect(commands()).not.toContainEqual([
      '/usr/bin/hc',
      'kill',
      't-finished',
      '--json',
    ]);
    expect(commands()).toContainEqual([
      '/usr/bin/hc',
      'rm',
      't-finished',
      '--json',
    ]);
  });

  test('desktop close retains ownership after hc kill and rm errors', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let terminalState: 'live' | 'finished' = 'live';
    let killCalls = 0;
    let rmCalls = 0;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/hc\n');
      }
      if (command[1] === 'get' && command[2] === 't-owned') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-owned',
            parent: 't-parent',
            state: terminalState,
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: 'omosc:12:liveChild',
              'omosc.spawn': 'spawn-token-12',
            },
          }),
        );
      }
      if (command[1] === 'kill' && command[2] === 't-owned') {
        killCalls += 1;
        if (killCalls === 1) return createSpawnResult(1, '', 'kill denied');
        terminalState = 'finished';
        return createSpawnResult();
      }
      if (command[1] === 'rm' && command[2] === 't-owned') {
        rmCalls += 1;
        if (rmCalls === 1) return createSpawnResult(1, '', 'rm denied');
        return createSpawnResult(0, JSON.stringify({ removed: 't-owned' }));
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer();
    (
      adapter as unknown as {
        desktopOwnedTerminals: Map<
          string,
          {
            parentId: string;
            title: string;
            spaceId: string;
            tabId: string;
            spawnToken: string;
          }
        >;
      }
    ).desktopOwnedTerminals.set('t-owned', {
      parentId: 't-parent',
      title: 'omosc:12:liveChild',
      spaceId: 'space-1',
      tabId: 'tab-1',
      spawnToken: 'spawn-token-12',
    });

    expect(await adapter.closePane('t-owned')).toBe(false);
    expect(await adapter.closePane('t-owned')).toBe(false);
    expect(await adapter.closePane('t-owned')).toBe(true);
    expect(killCalls).toBe(2);
    expect(rmCalls).toBe(2);
    expect(await adapter.closePane('t-owned')).toBe(false);
    expect(killCalls).toBe(2);
    expect(rmCalls).toBe(2);
  });

  test('desktop sweep removes a finished orphan with dead owner and gone session', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    const terminal = {
      address: 't-finished',
      parent: 't-parent',
      state: 'finished',
      labels: {
        'herdr.space': 'space-1',
        'herdr.tab': 'tab-1',
        'omosc.owner': 't-parent',
        omosc: 'omosc:12:ses_gone',
        'omosc.spawn': 'spawn-12',
      },
    };
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'ls') {
        return createSpawnResult(
          0,
          JSON.stringify({ terminals: [{ address: 't-finished' }] }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-finished') {
        return createSpawnResult(0, JSON.stringify(terminal));
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const { sweepLeftoverPanes } = await import('../client/sweep');
    const adapter = new HerdrMultiplexer();
    const stats = await sweepLeftoverPanes({
      adapter,
      isProcessAlive: () => false,
      isSessionTerminal: async (sessionId) => sessionId === 'ses_gone',
    });

    expect(stats.closed).toBe(1);
    expect(commands()).not.toContainEqual([
      '/usr/bin/hc',
      'kill',
      't-finished',
      '--json',
    ]);
    expect(commands()).toContainEqual([
      '/usr/bin/hc',
      'rm',
      't-finished',
      '--json',
    ]);
    expect(commands()).toContainEqual([
      '/usr/bin/hc',
      'rm',
      't-finished',
      '--json',
    ]);
  });

  test('desktop close retains ownership across kill and rm failures', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let state: 'live' | 'finished' = 'live';
    let killCalls = 0;
    let rmCalls = 0;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/hc\n');
      }
      if (command[1] === 'get' && command[2] === 't-owned') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-owned',
            parent: 't-parent',
            state,
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: 'omosc:42:session-1',
              'omosc.spawn': 'spawn-42',
            },
          }),
        );
      }
      if (command[1] === 'kill' && command[2] === 't-owned') {
        killCalls += 1;
        if (killCalls === 1) return createSpawnResult(1, '', 'kill failed');
        state = 'finished';
        return createSpawnResult();
      }
      if (command[1] === 'rm' && command[2] === 't-owned') {
        rmCalls += 1;
        if (rmCalls === 1) return createSpawnResult(1, '', 'rm failed');
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer();
    (
      adapter as unknown as {
        desktopOwnedTerminals: Map<
          string,
          {
            parentId: string;
            title: string;
            spaceId: string;
            tabId: string;
            spawnToken: string;
          }
        >;
      }
    ).desktopOwnedTerminals.set('t-owned', {
      parentId: 't-parent',
      title: 'omosc:42:session-1',
      spaceId: 'space-1',
      tabId: 'tab-1',
      spawnToken: 'spawn-42',
    });

    expect(await adapter.closePane('t-owned')).toBe(false);
    expect(await adapter.closePane('t-owned')).toBe(false);
    expect(await adapter.closePane('t-owned')).toBe(true);
    expect(killCalls).toBe(2);
    expect(rmCalls).toBe(2);
    expect(await adapter.closePane('t-owned')).toBe(false);
    expect(killCalls).toBe(2);
    expect(rmCalls).toBe(2);
  });

  test('desktop rollback does not kill a terminal whose ownership changed', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let childGets = 0;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command.includes('get') && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command.includes('run')) {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-child', parent: 't-parent' }),
        );
      }
      if (command.includes('get') && command[2] === 't-child') {
        childGets += 1;
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-child',
            parent: childGets === 1 ? 't-parent' : 't-other',
            state: 'live',
            foreground: { pid: 42 },
            labels:
              childGets === 1
                ? {
                    'herdr.space': 'space-1',
                    'herdr.tab': 'tab-1',
                    'omosc.owner': 't-parent',
                    'omosc.spawn': spawnTokenFromCalls(),
                    omosc: `omosc:${process.pid}:session-1`,
                  }
                : { 'omosc.owner': 't-other', omosc: 'omosc:2:other' },
          }),
        );
      }
      if (command[1] === 'ls') {
        return createSpawnResult(0, JSON.stringify({ spaces: [] }));
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer().spawnPane(
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(commands().some((command) => command[1] === 'kill')).toBe(false);
  });

  test('desktop sweep lists only owned, correctly parented terminals', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'ls') {
        return createSpawnResult(
          0,
          JSON.stringify({
            terminals: [{ address: 't-owned' }, { address: 't-foreign' }],
          }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-owned') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-owned',
            parent: 't-parent',
            state: 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: 'omosc:55:session-1',
            },
          }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-foreign') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-foreign',
            parent: 't-someone-else',
            state: 'live',
            labels: {
              'omosc.owner': 't-parent',
              omosc: 'omosc:55:session-2',
            },
          }),
        );
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer();
    const panes = await adapter.listPanesWithTitles();

    expect(panes).toEqual([{ paneId: 't-owned', title: 'omosc:55:session-1' }]);
    expect(commands()[1]).toEqual([
      '/usr/bin/hc',
      'ls',
      '--json',
      '--all',
      '--label',
      'omosc.owner=t-parent',
    ]);
    expect(await adapter.closePane('t-foreign')).toBe(false);
    expect(commands().some((command) => command[1] === 'kill')).toBe(false);
  });

  test('desktop sweep reports a partial scan when one terminal cannot be read', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'ls') {
        return createSpawnResult(
          0,
          JSON.stringify({
            terminals: [{ address: 't-readable' }, { address: 't-unreadable' }],
          }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-readable') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-readable',
            parent: 't-parent',
            state: 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: 'omosc:55:session-1',
            },
          }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-unreadable') {
        return createSpawnResult(1, '', 'terminal unavailable');
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const panes = await new HerdrMultiplexer('main-vertical', 60, {
      desktopAdoptionWait: async () => {},
    }).listPanesWithTitles();

    expect(panes).toEqual({
      panes: [{ paneId: 't-readable', title: 'omosc:55:session-1' }],
      incomplete: true,
    });
  });

  test('desktop sweep rejects a failed whole-terminal scan', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'ls') {
        return createSpawnResult(1, '', 'core unavailable');
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    await expect(
      new HerdrMultiplexer('main-vertical', 60, {
        desktopAdoptionWait: async () => {},
      }).listPanesWithTitles(),
    ).rejects.toThrow('hc ls temporary-error: core unavailable');
    expect(loggerEntries).toContainEqual({
      message: '[herdr] desktop core terminal list failed',
      data: {
        exitCode: 1,
        errorKind: null,
        stdout: '',
        stderr: 'core unavailable',
      },
    });
    expect(commands().some((command) => command[1] === 'kill')).toBe(false);
  });

  test('desktop sweep recovers a journaled unverified spawn with verified ownership', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    const dir = mkdtempSync(join(tmpdir(), 'omos-herdr-journal-'));
    const journalPath = join(dir, 'recovery.json');
    const spawnToken = '11111111-1111-4111-8111-111111111111';
    const title = `omosc:${process.pid - 1}:session-old`;
    writeFileSync(
      journalPath,
      JSON.stringify([
        {
          spawnToken,
          parentId: 't-parent',
          title,
          spaceId: 'space-1',
          tabId: 'tab-1',
          createdAt: Date.now(),
        },
      ]),
    );

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (
        command[1] === 'ls' &&
        command.includes('--label') &&
        command.includes('omosc.owner=t-parent')
      ) {
        return createSpawnResult(0, JSON.stringify({ terminals: [] }));
      }
      if (
        command[1] === 'ls' &&
        command.includes(`omosc.spawn=${spawnToken}`)
      ) {
        return createSpawnResult(
          0,
          JSON.stringify({ terminals: [{ address: 't-orphan' }] }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-orphan') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-orphan',
            parent: 't-parent',
            state: 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: title,
              'omosc.spawn': spawnToken,
            },
          }),
        );
      }
      return createSpawnResult();
    });

    try {
      const { HerdrMultiplexer } = await importFreshHerdr();
      const adapter = new HerdrMultiplexer(undefined, undefined, {
        desktopAdoptionWait: async () => {},
        recoveryJournalPath: journalPath,
      });
      const panes = await adapter.listPanesWithTitles();
      expect(panes).toEqual([{ paneId: 't-orphan', title }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('desktop sweep journal recovery ignores candidates without verified ownership', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    const dir = mkdtempSync(join(tmpdir(), 'omos-herdr-journal-'));
    const journalPath = join(dir, 'recovery.json');
    const spawnToken = '22222222-2222-4222-8222-222222222222';
    writeFileSync(
      journalPath,
      JSON.stringify([
        {
          spawnToken,
          parentId: 't-parent',
          title: `omosc:${process.pid - 1}:session-old`,
          spaceId: 'space-1',
          tabId: 'tab-1',
          createdAt: Date.now(),
        },
      ]),
    );

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'ls' && command.includes('omosc.owner=t-parent')) {
        return createSpawnResult(0, JSON.stringify({ terminals: [] }));
      }
      if (
        command[1] === 'ls' &&
        command.includes(`omosc.spawn=${spawnToken}`)
      ) {
        return createSpawnResult(
          0,
          JSON.stringify({ terminals: [{ address: 't-foreign' }] }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-foreign') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-foreign',
            parent: 't-other',
            state: 'live',
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-other',
              omosc: `omosc:${process.pid - 1}:someone-else`,
              'omosc.spawn': spawnToken,
            },
          }),
        );
      }
      return createSpawnResult();
    });

    try {
      const { HerdrMultiplexer } = await importFreshHerdr();
      const adapter = new HerdrMultiplexer(undefined, undefined, {
        desktopAdoptionWait: async () => {},
        recoveryJournalPath: journalPath,
      });
      expect(await adapter.listPanesWithTitles()).toEqual([]);
      expect(commands().some((command) => command[1] === 'kill')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('desktop close keeps ownership metadata after a temporary get failure', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let childGets = 0;
    let childFinished = false;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-child', parent: 't-parent' }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-child') {
        childGets += 1;
        if (childGets >= 3 && childGets <= 6) {
          return createSpawnResult(1, '', 'core temporarily unavailable');
        }
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-child',
            parent: 't-parent',
            state: childFinished ? 'finished' : 'live',
            foreground: childFinished ? null : { pid: 42 },
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              'omosc.spawn': spawnTokenFromCalls(),
              omosc: `omosc:${process.pid}:session-1`,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        return createSpawnResult(
          0,
          createHerdrAppListing('space-1', 'tab-1', 't-child'),
        );
      }
      if (command[1] === 'kill' && command[2] === 't-child') {
        childFinished = true;
        return createSpawnResult();
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer('main-vertical', 60, {
      desktopAdoptionWait: async () => {},
    });
    const spawned = await adapter.spawnPane(
      'session-1',
      'Worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(spawned.success).toBe(true);
    expect(await adapter.closePane('t-child')).toBe(false);
    expect(await adapter.closePane('t-child')).toBe(true);
    expect(commands().filter((command) => command[1] === 'kill')).toHaveLength(
      1,
    );
    expect(commands().filter((command) => command[1] === 'rm')).toHaveLength(1);
  });

  test('desktop close keeps ownership after kill and rm errors', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    let spawnToken = '';
    let terminalState: 'live' | 'finished' = 'live';
    let killCalls = 0;
    let rmCalls = 0;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        spawnToken =
          command
            .find((arg) => arg.startsWith('omosc.spawn='))
            ?.slice('omosc.spawn='.length) ?? '';
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-cleanup', parent: 't-parent' }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-cleanup') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-cleanup',
            parent: 't-parent',
            state: terminalState,
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              omosc: `omosc:${process.pid}:session-1`,
              'omosc.spawn': spawnToken,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        return createSpawnResult(
          0,
          createHerdrAppListing('space-1', 'tab-1', 't-cleanup'),
        );
      }
      if (command[1] === 'kill' && command[2] === 't-cleanup') {
        killCalls += 1;
        if (killCalls === 1) {
          return createSpawnResult(1, '', 'program still running');
        }
        terminalState = 'finished';
        return createSpawnResult();
      }
      if (command[1] === 'rm' && command[2] === 't-cleanup') {
        rmCalls += 1;
        if (rmCalls === 1) return createSpawnResult(1, '', 'record busy');
        return createSpawnResult(0, JSON.stringify({ removed: 't-cleanup' }));
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const adapter = new HerdrMultiplexer();
    expect(
      await adapter.spawnPane(
        'session-1',
        'Worker',
        'http://localhost:4096',
        '/repo',
      ),
    ).toEqual({ success: true, paneId: 't-cleanup' });

    expect(await adapter.closePane('t-cleanup')).toBe(false);
    expect(await adapter.closePane('t-cleanup')).toBe(false);
    expect(await adapter.closePane('t-cleanup')).toBe(true);
    expect(killCalls).toBe(2);
    expect(rmCalls).toBe(2);
    expect(loggerEntries).toContainEqual({
      message: '[herdr] desktop close: hc kill failed',
      data: {
        paneId: 't-cleanup',
        exitCode: 1,
        stdout: '',
        stderr: 'program still running',
      },
    });
    expect(loggerEntries).toContainEqual({
      message: '[herdr] desktop close: hc rm failed',
      data: {
        paneId: 't-cleanup',
        exitCode: 1,
        stdout: '',
        stderr: 'record busy',
      },
    });
  });

  test('desktop pane scan failure logs stderr and rolls back an owned child', async () => {
    process.env.HC_TERMINAL_ID = 't-parent';
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, `/usr/bin/${command[1]}\n`);
      }
      if (command[1] === 'get' && command[2] === 't-parent') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-parent',
            parent: null,
            state: 'live',
            labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1' },
          }),
        );
      }
      if (command[1] === 'run') {
        return createSpawnResult(
          0,
          JSON.stringify({ address: 't-child', parent: 't-parent' }),
        );
      }
      if (command[1] === 'get' && command[2] === 't-child') {
        return createSpawnResult(
          0,
          JSON.stringify({
            address: 't-child',
            parent: 't-parent',
            state: 'live',
            foreground: { pid: 42 },
            labels: {
              'herdr.space': 'space-1',
              'herdr.tab': 'tab-1',
              'omosc.owner': 't-parent',
              'omosc.spawn': spawnTokenFromCalls(),
              omosc: `omosc:${process.pid}:session-1`,
            },
          }),
        );
      }
      if (command[1] === 'ls') {
        return createSpawnResult(1, '', 'Herdr app unavailable');
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const result = await new HerdrMultiplexer('main-vertical', 60, {
      desktopAdoptionWait: async () => {},
    }).spawnPane('session-1', 'Worker', 'http://localhost:4096', '/repo');

    expect(result).toEqual({ success: false, error: 'hard' });
    expect(loggerEntries).toContainEqual({
      message: '[herdr] desktop pane scan failed',
      data: { exitCode: 1, stderr: 'Herdr app unavailable', stdout: '' },
    });
    expect(commands().some((command) => command[1] === 'kill')).toBe(true);
  });

  test('uses PATH discovery when HERDR_BIN_PATH is empty', async () => {
    process.env.HERDR_BIN_PATH = '';

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.isAvailable();

    expect(commands()).toEqual([[lookupCommand, 'herdr']]);
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

    // 1. Find herdr on PATH.
    expect(allCommands[0]).toEqual([lookupCommand, 'herdr']);

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
      [lookupCommand, 'herdr'],
      ['/usr/bin/herdr', 'pane', 'send-keys', 'w1:p2', 'ctrl+c'],
      ['/usr/bin/herdr', 'pane', 'close', 'w1:p2'],
    ]);
  });

  test('concurrent close grace periods do not block a spawn', async () => {
    let nextPane = 2;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === lookupCommand) {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        return createSpawnResult(0, createSplitResponse(`w1:p${nextPane++}`));
      }
      return createSpawnResult();
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const clock = createTimerHarness();
    const herdr = new HerdrMultiplexer('main-vertical', 60, {
      waitForGrace: () =>
        new Promise((resolve) => clock.setTimeout(resolve, 250)),
    });
    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s3', 'A3', 'http://localhost:4096', '/repo');

    const closes = ['w1:p2', 'w1:p3', 'w1:p4'].map((pane) =>
      herdr.closePane(pane),
    );
    const spawn = herdr.spawnPane('s4', 'A4', 'http://localhost:4096', '/repo');
    await clock.tick();
    const beforeGrace = commands();
    await clock.advance(250);
    await clock.advance(250);
    await clock.advance(250);
    await Promise.all([...closes, spawn]);

    expect(beforeGrace.filter((c) => c.includes('send-keys'))).toHaveLength(3);
    expect(beforeGrace.filter((c) => c.includes('split'))).toHaveLength(4);
    expect(beforeGrace.filter((c) => c.includes('close'))).toHaveLength(0);
  });

  test('returns true when closing unknown pane id', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    const success = await herdr.closePane('unknown');
    expect(success).toBe(true);
  });

  test('returns true when pane close reports pane_not_found', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60, { waitForGrace });

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === lookupCommand) {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('close')) {
        return createSpawnResult(
          1,
          '',
          '{"error":{"code":"pane_not_found","message":"pane w1:p2 not found"},"id":"cli:pane:close"}\n',
        );
      }
      return createSpawnResult();
    });

    const success = await herdr.closePane('w1:p2');
    expect(success).toBe(true);
  });

  test('returns false when pane close reports a transport failure', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60, { waitForGrace });

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === lookupCommand) {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('close')) {
        return createSpawnResult(
          1,
          '',
          '{"id":"cli:pane:close","error":{"code":"server_not_running","message":"no herdr server is running"}}\n',
        );
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
      if (command[0] === lookupCommand) {
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
      if (command[0] === lookupCommand) {
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
      if (command[0] === lookupCommand) {
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
      if (command[0] === lookupCommand) {
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
      if (command[0] === lookupCommand) {
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
      if (command[0] === lookupCommand) {
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

  test('main-vertical: closing the anchor promotes a surviving agent pane', async () => {
    let nextPane = 2;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === lookupCommand) {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('split')) {
        return createSpawnResult(0, createSplitResponse(`w1:p${nextPane++}`));
      }
      return createSpawnResult();
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60, { waitForGrace });

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s3', 'A3', 'http://localhost:4096', '/repo');
    await herdr.closePane('w1:p2');
    await herdr.spawnPane('s4', 'A4', 'http://localhost:4096', '/repo');

    const split = commands()
      .filter((c) => c.includes('split'))
      .at(-1);
    expect(split?.[3]).toBe('w1:p3');
    expect(split).toContain('down');
    expect(split).not.toContain('--ratio');
  });

  test('main-vertical: promotes an anchor that survives layout pruning', async () => {
    process.env.HERDR_TAB_ID = 'w1:t1';
    process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';
    const live = new Set(['w1:p1']);
    let nextPane = 2;
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === lookupCommand)
        return createSpawnResult(0, '/usr/bin/herdr\n');
      if (command.includes('split')) {
        const paneId = `w1:p${nextPane++}`;
        live.add(paneId);
        return createSpawnResult(0, createSplitResponse(paneId));
      }
      if (command.includes('close')) live.delete(command[3]);
      return createSpawnResult();
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60, {
      waitForGrace,
      equalizer: async (options) => {
        options.onPanesSeen?.(new Set(live));
        return true;
      },
    });

    await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');
    await herdr.spawnPane('s3', 'A3', 'http://localhost:4096', '/repo');
    live.delete('w1:p3');
    await herdr.closePane('w1:p2');
    await herdr.spawnPane('s4', 'A4', 'http://localhost:4096', '/repo');

    const split = commands()
      .filter((c) => c.includes('split'))
      .at(-1);
    expect(split?.[3]).toBe('w1:p4');
    expect(split).toContain('down');
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
      if (command[0] === lookupCommand) {
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

      let nextPane = 2;
      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === lookupCommand) {
          return createSpawnResult(0, '/usr/bin/herdr\n');
        }
        if (command.includes('split')) {
          return createSpawnResult(0, createSplitResponse(`w1:p${nextPane++}`));
        }
        return createSpawnResult();
      });

      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
        waitForGrace,
      });

      await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
      await herdr.spawnPane('s2', 'A2', 'http://localhost:4096', '/repo');
      await herdr.closePane('w1:p2');

      expect(equalize.mock.calls).toHaveLength(3);
      expect(equalize.mock.calls[2][0]).toMatchObject({
        socketPath: '/tmp/herdr-test.sock',
        tabId: 'w1:t1',
        mainPaneId: 'w1:p1',
        mainPaneShare: 0.6,
      });
    });

    test('does not equalize after closing the last agent pane', async () => {
      process.env.HERDR_TAB_ID = 'w1:t1';
      process.env.HERDR_SOCKET_PATH = '/tmp/herdr-test.sock';
      const { HerdrMultiplexer } = await importFreshHerdr();
      const equalize = createEqualizer();
      const herdr = new HerdrMultiplexer('main-vertical', 60, {
        equalizer: equalize,
        waitForGrace,
      });

      await herdr.spawnPane('s1', 'A1', 'http://localhost:4096', '/repo');
      await herdr.closePane('w1:p2');

      expect(equalize.mock.calls).toHaveLength(1);
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
        if (command[0] === lookupCommand) {
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
      if (command[0] === lookupCommand) {
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
      if (command[0] === lookupCommand) {
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

  test('sweep reports failed herdr scans rather than an empty scan', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === lookupCommand) {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command.includes('list')) return createSpawnResult(1, '', 'offline');
      return createSpawnResult();
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const { sweepLeftoverPanes } = await import('../client/sweep');
    const herdr = new HerdrMultiplexer();

    const stats = await sweepLeftoverPanes({
      adapter: herdr,
      isProcessAlive: () => false,
      isSessionTerminal: async () => true,
    });
    expect(stats.scanFailed).toBe(true);

    crossSpawnMock.mockImplementation(() => {
      throw new Error('cannot start herdr');
    });
    await expect(herdr.listPanesWithTitles()).rejects.toThrow(
      'cannot start herdr',
    );
  test('legacy sweep throws on a failed pane list and keeps stderr', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command[1] === 'pane' && command[2] === 'list') {
        return createSpawnResult(1, '', 'pane list unavailable');
      }
      return createSpawnResult();
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await expect(herdr.listPanesWithTitles()).rejects.toThrow(
      'herdr pane list exited 1: pane list unavailable',
    );
    expect(loggerEntries).toContainEqual({
      message: '[herdr] legacy sweep: pane list failed',
      data: {
        exitCode: 1,
        stdout: '',
        stderr: 'pane list unavailable',
      },
    });
  });

  test('legacy sweep returns an empty list when pane list succeeds with no panes', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/herdr\n');
      }
      if (command[1] === 'pane' && command[2] === 'list') {
        return createSpawnResult(
          0,
          `${JSON.stringify({
            id: 'cli:pane:list',
            result: { type: 'pane_list', panes: [] },
          })}\n`,
        );
      }
      return createSpawnResult();
    });
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    expect(await herdr.listPanesWithTitles()).toEqual([]);
  });

  test('sweep closes only the dead-owner terminal pane (FR-8)', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === lookupCommand) {
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
      if (command[0] === lookupCommand) {
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
        if (command[0] === lookupCommand) {
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
      if (command[0] === lookupCommand) {
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
