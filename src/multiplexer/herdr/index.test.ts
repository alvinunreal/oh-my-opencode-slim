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

describe('HerdrMultiplexer', () => {
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalHerdrPaneId = process.env.HERDR_PANE_ID;

  beforeEach(() => {
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'w1:p1';

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
    process.env.HERDR_ENV = originalHerdrEnv;
    process.env.HERDR_PANE_ID = originalHerdrPaneId;
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

  test('uses --current when HERDR_PANE_ID is not set', async () => {
    delete process.env.HERDR_PANE_ID;

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.spawnPane(
      'session-1',
      'Herdr worker',
      'http://localhost:4096',
      '/repo',
    );

    const splitCommand = commands().find((command) =>
      command.includes('split'),
    );

    expect(splitCommand).toContain('--current');
    expect(splitCommand).not.toContain('w1:p1');
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

    expect(result).toEqual({ success: false });
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

    expect(result).toEqual({ success: false });
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

    expect(result).toEqual({ success: false });
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

    expect(result).toEqual({ success: false });
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

  test('isInsideSession returns true when HERDR_ENV is set', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    expect(herdr.isInsideSession()).toBe(true);
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

  test('applyLayout is a no-op', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-vertical', 60);

    await herdr.applyLayout('tiled', 50);

    // Only the binary check command should have been issued
    expect(commands()).toHaveLength(0);
  });
});
