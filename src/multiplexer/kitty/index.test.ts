import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

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

describe('KittyMultiplexer', () => {
  const originalKittyPid = process.env.KITTY_PID;
  const originalKittyWindowId = process.env.KITTY_WINDOW_ID;
  const originalKittyListenOn = process.env.KITTY_LISTEN_ON;

  beforeEach(() => {
    process.env.KITTY_PID = '12345';
    process.env.KITTY_WINDOW_ID = '1';
    // kitty exports KITTY_LISTEN_ON to its children; the backend requires it.
    process.env.KITTY_LISTEN_ON = 'unix:/tmp/kitty-rc-test';

    logMock.mockClear();
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      // which kitten
      if (command[0] === 'which' && command[1] === 'kitten') {
        return createSpawnResult(0, '/usr/bin/kitten\n');
      }
      // which kitty (fallback)
      if (command[0] === 'which' && command[1] === 'kitty') {
        return createSpawnResult(1, '');
      }
      // kitten @ launch
      if (command.includes('@') && command.includes('launch')) {
        return createSpawnResult(0, '42\n');
      }
      return createSpawnResult();
    });
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
      if (command[0] === 'which' && command[1] === 'kitten') {
        return createSpawnResult(1, '');
      }
      if (command[0] === 'which' && command[1] === 'kitty') {
        return createSpawnResult(1, '');
      }
      return createSpawnResult();
    });
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();
    expect(await kitty.isAvailable()).toBe(false);
  });

  test('isInsideSession returns true when KITTY_PID is set', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();
    expect(kitty.isInsideSession()).toBe(true);
  });

  test('isInsideSession returns false when KITTY_PID is not set', async () => {
    delete process.env.KITTY_PID;
    delete process.env.KITTY_WINDOW_ID;
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();
    expect(kitty.isInsideSession()).toBe(false);
  });

  test('spawnPane returns failure when not inside a kitty session', async () => {
    delete process.env.KITTY_PID;
    delete process.env.KITTY_WINDOW_ID;
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    const result = await kitty.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result.success).toBe(false);
    // No kitten @ launch should have been attempted.
    const launchCmds = commands().filter(
      (c) => c.includes('@') && c.includes('launch'),
    );
    expect(launchCmds.length).toBe(0);
  });

  test('closePane returns false when not inside a kitty session', async () => {
    delete process.env.KITTY_PID;
    delete process.env.KITTY_WINDOW_ID;
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    const closed = await kitty.closePane('42');
    expect(closed).toBe(false);
  });

  test('applyLayout is a no-op when not inside a kitty session', async () => {
    delete process.env.KITTY_PID;
    delete process.env.KITTY_WINDOW_ID;
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    await kitty.applyLayout('tiled', 60);

    const layoutCmds = commands().filter((c) => c.includes('goto-layout'));
    expect(layoutCmds.length).toBe(0);
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
      if (command.includes('@') && command.includes('launch')) {
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

    expect(result.success).toBe(false);
  });

  test('closePane issues send-key then close-window', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    const closed = await kitty.closePane('42');
    expect(closed).toBe(true);

    const cmds = commands();
    const sendKeyCmds = cmds.filter((c) => c.includes('send-key'));
    const closeWindowCmds = cmds.filter((c) => c.includes('close-window'));

    expect(sendKeyCmds.length).toBeGreaterThanOrEqual(1);
    expect(closeWindowCmds.length).toBeGreaterThanOrEqual(1);

    // Verify correct arguments
    const sendKeyArgs = sendKeyCmds[0];
    expect(sendKeyArgs).toContain('@');
    expect(sendKeyArgs).toContain('send-key');
    expect(sendKeyArgs).toContain('--match');
    expect(sendKeyArgs).toContain('id:42');
    expect(sendKeyArgs).toContain('ctrl+c');

    const closeArgs = closeWindowCmds[0];
    expect(closeArgs).toContain('@');
    expect(closeArgs).toContain('close-window');
    expect(closeArgs).toContain('--match');
    expect(closeArgs).toContain('id:42');
  });

  test('applyLayout issues goto-layout tall for main-vertical', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    await kitty.applyLayout('main-vertical', 60);

    const cmds = commands();
    const layoutCmds = cmds.filter((c) => c.includes('goto-layout'));
    expect(layoutCmds.length).toBeGreaterThanOrEqual(1);
    expect(layoutCmds[0]).toContain('goto-layout');
    expect(layoutCmds[0]).toContain('tall');
  });

  test('applyLayout issues goto-layout fat for main-horizontal', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    await kitty.applyLayout('main-horizontal', 60);

    const cmds = commands();
    const layoutCmds = cmds.filter((c) => c.includes('goto-layout'));
    expect(layoutCmds.length).toBeGreaterThanOrEqual(1);
    expect(layoutCmds[0]).toContain('goto-layout');
    expect(layoutCmds[0]).toContain('fat');
  });

  test('applyLayout issues goto-layout grid for tiled', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    await kitty.applyLayout('tiled', 60);

    const cmds = commands();
    const layoutCmds = cmds.filter((c) => c.includes('goto-layout'));
    expect(layoutCmds.length).toBeGreaterThanOrEqual(1);
    expect(layoutCmds[0]).toContain('goto-layout');
    expect(layoutCmds[0]).toContain('grid');
  });

  test('applyLayout issues goto-layout horizontal for even-horizontal', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    await kitty.applyLayout('even-horizontal', 60);

    const cmds = commands();
    const layoutCmds = cmds.filter((c) => c.includes('goto-layout'));
    expect(layoutCmds.length).toBeGreaterThanOrEqual(1);
    expect(layoutCmds[0]).toContain('goto-layout');
    expect(layoutCmds[0]).toContain('horizontal');
  });

  test('applyLayout issues goto-layout vertical for even-vertical', async () => {
    const { KittyMultiplexer } = await importFreshKitty();
    const kitty = new KittyMultiplexer();

    await kitty.applyLayout('even-vertical', 60);

    const cmds = commands();
    const layoutCmds = cmds.filter((c) => c.includes('goto-layout'));
    expect(layoutCmds.length).toBeGreaterThanOrEqual(1);
    expect(layoutCmds[0]).toContain('goto-layout');
    expect(layoutCmds[0]).toContain('vertical');
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

    const cmds = commands();
    const layoutCmds = cmds.filter((c) => c.includes('goto-layout'));
    expect(layoutCmds.length).toBe(2);
    expect(layoutCmds[0]).toContain('tall');
    expect(layoutCmds[1]).toContain('grid');
  });
});
