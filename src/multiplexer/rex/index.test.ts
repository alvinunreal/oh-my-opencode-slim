import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MultiplexerLayout } from '../../config/schema';
import { createTimerHarness } from '../../utils/test-timers';
import { PaneLifecycle } from '../client/lifecycle';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

const logMock = mock((..._args: unknown[]) => {});
const crossSpawnMock = mock((_args: string[]) => createSpawnResult());

mock.module('../../utils/logger', () => ({ log: logMock }));

// Keep compat's real exports: a crossSpawn-only mock leaks into later tests.
const actualCompat = await import('../../utils/compat');
mock.module('../../utils/compat', () => ({
  ...actualCompat,
  crossSpawn: crossSpawnMock,
}));

const ENV_KEYS = [
  'REX_SESSION',
  'REX_BLOCK',
  'SHELL',
  'OPENCODE_SERVER_PASSWORD',
] as const;

let importCounter = 0;
let splitNumber = 1;

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

function splitJson(
  anchorId = 'block:parent',
  blockId = `block:child-${splitNumber++}`,
): string {
  return JSON.stringify({
    anchor_id: anchorId,
    block_ids: [anchorId, blockId],
    split_ids: ['split:new'],
    revision: 2,
  });
}

async function importFreshRex() {
  return import(`./index?test=${importCounter++}`);
}

function rexCommands(): string[][] {
  return crossSpawnMock.mock.calls
    .map((call) => call[0] as string[])
    .filter((command) => command[0] !== 'which');
}

function splits(): string[][] {
  return rexCommands().filter((command) => command.includes('split'));
}

function closes(): string[][] {
  return rexCommands().filter((command) => command.includes('close'));
}

function flagValue(command: string[], flag: string): string | undefined {
  return command[command.indexOf(flag) + 1];
}

type Responder = (command: string[]) => SpawnResult | undefined;

function installMock(override?: Responder): void {
  crossSpawnMock.mockImplementation((command: string[]) => {
    const custom = override?.(command);
    if (custom) return custom;
    if (command[0] === 'which' && command[1] === 'rex') {
      return createSpawnResult(0, '/usr/bin/rex\n');
    }
    if (command.includes('split')) {
      return createSpawnResult(
        0,
        splitJson(flagValue(command, '--block') ?? 'block:parent'),
      );
    }
    if (command.includes('close')) return createSpawnResult(0, '{}');
    return createSpawnResult();
  });
}

describe('RexMultiplexer', () => {
  const originals = new Map<string, string | undefined>();
  const originalPlatform = process.platform;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.REX_SESSION = ' session:one ';
    process.env.REX_BLOCK = ' block:parent ';
    process.env.SHELL = '/bin/zsh';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    splitNumber = 1;
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

  test('isAvailable only resolves rex and does not pass unsupported -V', async () => {
    const { RexMultiplexer } = await importFreshRex();
    expect(await new RexMultiplexer().isAvailable()).toBe(true);
    expect(crossSpawnMock.mock.calls.map((call) => call[0])).toEqual([
      ['which', 'rex'],
    ]);
  });

  test('requires both trimmed session and block for detection and spawn', async () => {
    const { RexMultiplexer } = await importFreshRex();
    const rex = new RexMultiplexer();
    expect(rex.isInsideSession()).toBe(true);

    delete process.env.REX_BLOCK;
    expect(rex.isInsideSession()).toBe(false);
    expect(
      await rex.spawnPane('child', 'label', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'not_found' });
    expect(crossSpawnMock.mock.calls).toHaveLength(0);

    process.env.REX_BLOCK = '   ';
    expect(rex.isInsideSession()).toBe(false);
    expect(
      await rex.spawnPane('child', 'label', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'not_found' });
    expect(crossSpawnMock.mock.calls).toHaveLength(0);

    process.env.REX_BLOCK = 'block:parent';
    process.env.REX_SESSION = '   ';
    expect(rex.isInsideSession()).toBe(false);
    expect(
      await rex.spawnPane('child', 'label', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'not_found' });
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
  });

  test('splits the explicit block without focus and launches the shared viewer', async () => {
    const { RexMultiplexer } = await importFreshRex();
    const rex = new RexMultiplexer('main-vertical', 60);
    const description = 'oracle; echo not-a-command';
    const result = await rex.spawnPane(
      'child session',
      description,
      'http://127.0.0.1:4321',
      '/repo path',
      { viewerFlavor: 'v1' },
    );

    expect(result).toEqual({ success: true, paneId: 'block:child-1' });
    const split = splits()[0] as string[];
    expect(split.slice(0, 4)).toEqual([
      '/usr/bin/rex',
      '--autostart=false',
      '--timeout',
      '5s',
    ]);
    expect(split.slice(4, 8)).toEqual([
      'split',
      '--session',
      'session:one',
      '--block',
    ]);
    expect(flagValue(split, '--block')).toBe('block:parent');
    expect(flagValue(split, '--split')).toBe('right');
    expect(flagValue(split, '--ratio')).toBe('40');
    expect(flagValue(split, '--cwd')).toBe('/repo path');
    expect(flagValue(split, '--label')).toBe(description);
    expect(split).toContain('--focus=false');
    expect(split).toContain('--json');
    expect(split).toContain('--shell=none');
    const separator = split.indexOf('--');
    expect(split.slice(separator + 1, separator + 3)).toEqual([
      '/bin/zsh',
      '-l',
    ]);
    expect(split.at(-1)).toContain("attach 'http://127.0.0.1:4321'");
    expect(split.at(-1)).toContain('OH_MY_OPENCODE_SLIM_PANE_VIEWER=1');
    expect(split.at(-1)).not.toContain(description);
  });

  test('maps every supported layout to Rex direction and ratio', async () => {
    const cases: Array<[MultiplexerLayout, string, string]> = [
      ['main-vertical', 'right', '40'],
      ['main-horizontal', 'below', '40'],
      ['even-horizontal', 'right', '50'],
      ['even-vertical', 'below', '50'],
      ['tiled', 'right', '50'],
    ];
    for (const [layout, direction, ratio] of cases) {
      crossSpawnMock.mockReset();
      installMock();
      const { RexMultiplexer } = await importFreshRex();
      await new RexMultiplexer(layout, 60).spawnPane(
        'child',
        'label',
        'http://server',
        '/repo',
      );
      const split = splits()[0] as string[];
      expect(flagValue(split, '--split')).toBe(direction);
      expect(flagValue(split, '--ratio')).toBe(ratio);
    }
  });

  test('resolves the current Rex session and block for each spawn', async () => {
    const { RexMultiplexer } = await importFreshRex();
    const rex = new RexMultiplexer();
    const first = await rex.spawnPane(
      'child-1',
      'one',
      'http://server',
      '/repo',
    );
    process.env.REX_SESSION = 'session:two';
    process.env.REX_BLOCK = 'block:two';
    const second = await rex.spawnPane(
      'child-2',
      'two',
      'http://server',
      '/repo',
    );

    expect(first).toEqual({ success: true, paneId: 'block:child-1' });
    expect(second).toEqual({ success: true, paneId: 'block:child-2' });
    expect(splits().map((command) => flagValue(command, '--session'))).toEqual([
      'session:one',
      'session:two',
    ]);
    expect(splits().map((command) => flagValue(command, '--block'))).toEqual([
      'block:parent',
      'block:two',
    ]);
    expect(await rex.closePane('block:child-2')).toBe(true);
    expect(closes()[0]?.slice(-2)).toEqual(['session:two', 'block:child-2']);
  });

  test('accepts versioned anchor field and filters the original block ID', async () => {
    crossSpawnMock.mockReset();
    installMock((command) =>
      command.includes('split')
        ? createSpawnResult(
            0,
            JSON.stringify({
              anchor_block_id: 'block:parent',
              block_ids: ['block:parent', 'block:new'],
            }),
          )
        : undefined,
    );
    const { RexMultiplexer } = await importFreshRex();
    const result = await new RexMultiplexer().spawnPane(
      'child',
      'label',
      'http://server',
      '/repo',
    );
    expect(result).toEqual({ success: true, paneId: 'block:new' });
  });

  test('rejects a split response for a different anchor without retrying', async () => {
    crossSpawnMock.mockReset();
    installMock((command) =>
      command.includes('split')
        ? createSpawnResult(
            0,
            JSON.stringify({
              anchor_id: 'block:other',
              block_ids: ['block:other', 'block:new'],
            }),
          )
        : undefined,
    );
    const { RexMultiplexer } = await importFreshRex();

    expect(
      await new RexMultiplexer().spawnPane(
        'child',
        'label',
        'http://server',
        '/repo',
      ),
    ).toEqual({ success: false, error: 'hard', creationUncertain: true });
    expect(splits()).toHaveLength(1);
    expect(closes()).toHaveLength(0);
  });

  test('rejects malformed or anchor-only split results without retrying', async () => {
    for (const output of [
      'not json',
      JSON.stringify({ block_ids: ['block:new'] }),
      JSON.stringify({
        anchor_id: 'block:parent',
        block_ids: ['block:parent'],
      }),
      JSON.stringify({ anchor_id: 'block:parent', block_ids: [] }),
      JSON.stringify({
        anchor_id: 'block:parent',
        block_ids: ['block:new', ' '],
      }),
      JSON.stringify({
        anchor_id: 'block:parent',
        block_ids: ['block:new', 4],
      }),
      JSON.stringify({
        anchor_id: 'block:parent',
        anchor_block_id: 'block:other',
        block_ids: ['block:new'],
      }),
    ]) {
      crossSpawnMock.mockReset();
      installMock((command) =>
        command.includes('split') ? createSpawnResult(0, output) : undefined,
      );
      const { RexMultiplexer } = await importFreshRex();
      expect(
        await new RexMultiplexer().spawnPane(
          'child',
          'label',
          'http://server',
          '/repo',
        ),
      ).toEqual({ success: false, error: 'hard', creationUncertain: true });
      expect(splits()).toHaveLength(1);
      expect(closes()).toHaveLength(0);
    }
  });

  test('a nonzero split result is a hard failure without a blind retry', async () => {
    crossSpawnMock.mockReset();
    installMock((command) =>
      command.includes('split')
        ? createSpawnResult(1, '', 'split rejected')
        : undefined,
    );
    const { RexMultiplexer } = await importFreshRex();

    expect(
      await new RexMultiplexer().spawnPane(
        'child',
        'label',
        'http://server',
        '/repo',
      ),
    ).toEqual({ success: false, error: 'hard', creationUncertain: true });
    expect(splits()).toHaveLength(1);
  });

  test.each(['malformed', 'lost'] as const)(
    'lifecycle does not repeat a split after a %s response',
    async (failure) => {
      const createdBlocks: string[] = [];
      installMock((command) => {
        if (!command.includes('split')) return;
        createdBlocks.push(`block:created-${createdBlocks.length}`);
        return failure === 'lost'
          ? {
              ...createSpawnResult(),
              stdout: async () => {
                throw new Error('reply lost');
              },
            }
          : createSpawnResult(0, 'malformed reply');
      });
      const { RexMultiplexer } = await importFreshRex();
      const adapter = new RexMultiplexer();
      const timers = createTimerHarness();
      const statuses = new Map([['child', 'busy' as const]]);
      const lifecycle = new PaneLifecycle(
        {
          clock: timers,
          statusReader: { readStatus: async () => ({ statuses }) },
          sessionListReader: {
            listSessions: async () => ({ sessions: [{ sessionId: 'child' }] }),
          },
          adapterFactory: { create: () => adapter },
          resolveServerUrl: () => ({ url: 'http://server' }),
        },
        {
          directory: '/repo',
          displayedSessionId: 'parent',
          adapter: 'rex',
          stableIdleMs: 10,
          readiness: { maxAttempts: 1, retryDelayMs: 0 },
        },
        { log: logMock },
      );
      try {
        const event = {
          kind: 'created' as const,
          sessionId: 'child',
          parentSessionId: 'parent',
          directory: '/repo',
        };
        await lifecycle.handleEvent(event);
        for (let i = 0; i < 3; i++) {
          await lifecycle.onReconnect();
          await lifecycle.handleEvent({
            ...event,
            kind: 'status',
            status: 'busy',
          });
          await lifecycle.handleEvent(event);
        }
        expect(createdBlocks).toHaveLength(1);
        expect(splits()).toHaveLength(1);
        expect(lifecycle.getPane('child')).toBeUndefined();
      } finally {
        await lifecycle.dispose();
      }
      expect(closes()).toHaveLength(0);
    },
  );

  test('refuses remote viewer credentials before splitting and never logs them', async () => {
    const { RexMultiplexer } = await importFreshRex();
    const rex = new RexMultiplexer();
    expect(
      await rex.spawnPane('child', 'label', 'http://server', '/repo', {
        viewerFlavor: 'v2-remote',
        viewerPassword: 'secret-remote',
      }),
    ).toEqual({ success: false, error: 'unavailable' });
    expect(crossSpawnMock.mock.calls).toHaveLength(0);

    process.env.OPENCODE_SERVER_PASSWORD = 'secret-v1';
    expect(
      await rex.spawnPane('child', 'label', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'unavailable' });
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
    expect(JSON.stringify(logMock.mock.calls)).not.toContain('secret-');

    delete process.env.OPENCODE_SERVER_PASSWORD;
    expect(
      await rex.spawnPane('child', 'label', 'http://server', '/repo', {
        viewerFlavor: 'v2-remote',
        viewerPassword: '',
      }),
    ).toEqual({ success: false, error: 'unavailable' });
    process.env.OPENCODE_SERVER_PASSWORD = '';
    expect(
      await rex.spawnPane('child', 'label', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'unavailable' });
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
  });

  test('refuses Windows before invoking Rex', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { RexMultiplexer } = await importFreshRex();
    expect(
      await new RexMultiplexer().spawnPane(
        'child',
        'label',
        'http://server',
        '/repo',
      ),
    ).toEqual({ success: false, error: 'unavailable' });
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
  });

  test('close uses the spawn session even after the client environment changes', async () => {
    const { RexMultiplexer } = await importFreshRex();
    const rex = new RexMultiplexer();
    const result = await rex.spawnPane(
      'child',
      'label',
      'http://server',
      '/repo',
    );
    process.env.REX_SESSION = 'session:later';

    expect(await rex.closePane(result.paneId as string)).toBe(true);
    expect(closes()[0]).toEqual([
      '/usr/bin/rex',
      '--autostart=false',
      '--timeout',
      '5s',
      'block',
      'close',
      '--session',
      'session:one',
      'block:child-1',
    ]);
  });

  test('close refuses empty, unknown, parent, and unowned block handles', async () => {
    const { RexMultiplexer } = await importFreshRex();
    const rex = new RexMultiplexer();
    for (const paneId of [
      '',
      'unknown',
      'block:parent',
      'block:someone-else',
    ]) {
      expect(await rex.closePane(paneId)).toBe(false);
    }
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
  });

  test('failed close retains the owned block for a subsequent attempt', async () => {
    let failClose = true;
    crossSpawnMock.mockReset();
    installMock((command) =>
      command.includes('close')
        ? createSpawnResult(failClose ? 1 : 0, '', 'close failed')
        : undefined,
    );
    const { RexMultiplexer } = await importFreshRex();
    const rex = new RexMultiplexer();
    await rex.spawnPane('child', 'label', 'http://server', '/repo');
    expect(await rex.closePane('block:child-1')).toBe(false);
    failClose = false;
    expect(await rex.closePane('block:child-1')).toBe(true);
    expect(closes()).toHaveLength(2);
    expect(await rex.closePane('block:child-1')).toBe(false);
    expect(closes()).toHaveLength(2);
  });
});
