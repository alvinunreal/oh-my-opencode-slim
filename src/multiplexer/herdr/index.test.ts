/**
 * Tests for HerdrMultiplexer
 *
 * Mocks HerdrSocketClient at the module level so RPC calls are controllable.
 * Mocks crossSpawn for binary detection (which + --version).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

// ---------------------------------------------------------------------------
// CrossSpawn mock (for binary detection)
// ---------------------------------------------------------------------------

const crossSpawnMock = mock((_command: string[]) => createSpawnResult());

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

// ---------------------------------------------------------------------------
// HerdrSocketClient mock (provided via mock.module)
// ---------------------------------------------------------------------------

let mockClientInstance: MockHerdrSocketClient | null = null;

class MockHerdrSocketClient {
  call = mock(
    async (
      _method: string,
      _params: Record<string, unknown>,
    ): Promise<unknown> => {
      return {};
    },
  );

  ping = mock(async (): Promise<boolean> => true);
  close = mock(async (): Promise<void> => {});

  constructor(_socketPath?: string) {
    mockClientInstance = this;
  }
}

/**
 * Inline copy of isHerdrError from client.ts so we don't need to import the
 * real module (which would be replaced by the mock).
 */
function isHerdrError(e: unknown, code?: string): boolean {
  if (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as Record<string, unknown>).code === 'string'
  ) {
    if (code !== undefined) {
      return (e as Record<string, unknown>).code === code;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Module-level mocks (applied before any dynamic import)
// ---------------------------------------------------------------------------

mock.module('../../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

mock.module('./client', () => ({
  HerdrSocketClient: MockHerdrSocketClient,
  isHerdrError,
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let importCounter = 0;

async function importFreshHerdr() {
  return import(`./index?test=${importCounter++}`);
}

function commands(): string[][] {
  return crossSpawnMock.mock.calls.map((call) => call[0] as string[]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HerdrMultiplexer', () => {
  const origHerdrEnv = process.env.HERDR_ENV;
  const origHerdrPaneId = process.env.HERDR_PANE_ID;
  const origHerdrTabId = process.env.HERDR_TAB_ID;
  const origHerdrWorkspaceId = process.env.HERDR_WORKSPACE_ID;

  beforeEach(() => {
    mockClientInstance = null;
    crossSpawnMock.mockReset();

    // Default env: inside herdr session
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'w654950b6cb01c6:p0';
    process.env.HERDR_TAB_ID = 'w654950b6cb01c6:t1';
    process.env.HERDR_WORKSPACE_ID = 'w654950b6cb01c6';

    // Default crossSpawn: herdr binary found and verified
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/local/bin/herdr\n');
      }
      if (command[1] === '--version') {
        return createSpawnResult(0, 'herdr 0.1.0');
      }
      return createSpawnResult();
    });
  });

  afterEach(() => {
    process.env.HERDR_ENV = origHerdrEnv;
    process.env.HERDR_PANE_ID = origHerdrPaneId;
    process.env.HERDR_TAB_ID = origHerdrTabId;
    process.env.HERDR_WORKSPACE_ID = origHerdrWorkspaceId;
    mockClientInstance = null;
  });

  // -----------------------------------------------------------------------
  // isInsideSession
  // -----------------------------------------------------------------------

  test('isInsideSession returns true when HERDR_ENV=1', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();
    expect(herdr.isInsideSession()).toBe(true);
  });

  test('isInsideSession returns false when HERDR_ENV is not set', async () => {
    delete process.env.HERDR_ENV;
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();
    expect(herdr.isInsideSession()).toBe(false);
  });

  test('isInsideSession returns false when HERDR_ENV is not "1"', async () => {
    process.env.HERDR_ENV = '0';
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();
    expect(herdr.isInsideSession()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  test('isAvailable returns true when binary found and ping succeeds', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    // ping() defaults to true
    const result = await herdr.isAvailable();
    expect(result).toBe(true);

    // Should have called which and --version
    const cmds = commands();
    expect(cmds.some((c) => c[0] === 'which' && c[1] === 'herdr')).toBe(true);
    expect(
      cmds.some((c) => c[0] === '/usr/local/bin/herdr' && c[1] === '--version'),
    ).toBe(true);
  });

  test('isAvailable caches result and does not re-run which on second call', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    await herdr.isAvailable();
    const callCount1 = commands().length;

    await herdr.isAvailable();
    const callCount2 = commands().length;

    // No new calls on second invocation
    expect(callCount2).toBe(callCount1);
  });

  test('isAvailable returns false when which herdr fails', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(1, '', 'not found');
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();
    expect(await herdr.isAvailable()).toBe(false);
  });

  test('isAvailable returns false when binary found but ping fails', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    // Set up ping to return false after the mock client is created
    // We need to configure it before isAvailable is called.
    // The mock client is created when the multiplexer is constructed.

    // Wait for the constructor's field initializer to set mockClientInstance
    // (it happens synchronously in the constructor)
    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.ping.mockImplementation(async () => false);

    const result = await herdr.isAvailable();
    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // spawnPane success
  // -----------------------------------------------------------------------

  test('spawnPane returns success with paneId on happy path', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(
      async (method: string, _params: Record<string, unknown>) => {
        if (method === 'pane.list') {
          return { panes: [] };
        }
        if (method === 'pane.split') {
          return { pane: { pane_id: 'w1:p2' } };
        }
        if (method === 'pane.send_text') {
          return { type: 'ok' };
        }
        return {};
      },
    );

    const result = await herdr.spawnPane(
      'sess-123',
      'test desc',
      'http://localhost:4096',
      '/tmp',
    );

    expect(result).toEqual({ success: true, paneId: 'w1:p2' });

    // Verify pane.split was called with correct params
    const splitCall = mockClientInstance?.call.mock.calls.find(
      ([method]) => method === 'pane.split',
    );
    expect(splitCall).toBeDefined();
    expect(splitCall?.[1]).toEqual({
      pane_id: 'w654950b6cb01c6:p0',
      workspace_id: 'w654950b6cb01c6',
      tab_id: 'w654950b6cb01c6:t1',
      direction: 'right',
      ratio: 0.4,
      cwd: '/tmp',
      label: 'test desc',
    });

    // Verify pane.send_text was called with correct params
    const sendTextCall = mockClientInstance?.call.mock.calls.find(
      ([method]) => method === 'pane.send_text',
    );
    expect(sendTextCall).toBeDefined();
    expect(sendTextCall?.[1]).toHaveProperty('pane_id', 'w1:p2');
    expect(sendTextCall?.[1]).toHaveProperty('text');
    const text = sendTextCall?.[1].text as string;
    expect(text).toMatch(/opencode attach/);
    expect(text).toMatch(/--session 'sess-123'/);
    expect(text).toMatch(/--dir '\/tmp'/);
    expect(text).toEndWith('\n');
  });

  test('spawnPane splits right by default (main-vertical)', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer(); // defaults to main-vertical

    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(async (method: string) => {
      if (method === 'pane.list') return { panes: [] };
      if (method === 'pane.split') return { pane: { pane_id: 'w1:p2' } };
      if (method === 'pane.send_text') return { type: 'ok' };
      return {};
    });

    await herdr.spawnPane('sess-1', 'desc', 'http://localhost:4096', '/tmp');

    const splitCall = mockClientInstance?.call.mock.calls.find(
      ([m]) => m === 'pane.split',
    );
    expect(splitCall).toBeDefined();
    // main-vertical, first agent → split MAIN in layout direction = RIGHT
    expect(splitCall?.[1]).toEqual({
      pane_id: 'w654950b6cb01c6:p0',
      workspace_id: 'w654950b6cb01c6',
      tab_id: 'w654950b6cb01c6:t1',
      direction: 'right',
      ratio: 0.4,
      cwd: '/tmp',
      label: 'desc',
    });
  });

  test('spawnPane splits down for main-horizontal layout', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-horizontal', 60);

    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(async (method: string) => {
      if (method === 'pane.list') return { panes: [] };
      if (method === 'pane.split') return { pane: { pane_id: 'w1:p2' } };
      if (method === 'pane.send_text') return { type: 'ok' };
      return {};
    });

    await herdr.spawnPane('sess-1', 'desc', 'http://localhost:4096', '/tmp');

    const splitCall = mockClientInstance?.call.mock.calls.find(
      ([m]) => m === 'pane.split',
    );
    expect(splitCall).toBeDefined();
    // main-horizontal, first agent → split MAIN in layout direction = DOWN
    expect(splitCall?.[1]).toEqual({
      pane_id: 'w654950b6cb01c6:p0',
      workspace_id: 'w654950b6cb01c6',
      tab_id: 'w654950b6cb01c6:t1',
      direction: 'down',
      ratio: 0.4,
      cwd: '/tmp',
      label: 'desc',
    });
  });

  // -----------------------------------------------------------------------
  // spawnPane — findSplitSource / anchor logic
  // -----------------------------------------------------------------------

  test('subsequent agent splits first agent in perpendicular direction (main-vertical)', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer(); // main-vertical

    expect(mockClientInstance).not.toBeNull();
    // pane.list returns an existing agent (not main)
    mockClientInstance?.call.mockImplementation(async (method: string) => {
      if (method === 'pane.list') {
        return {
          panes: [
            { pane_id: 'w654950b6cb01c6:p5', tab_id: 'w654950b6cb01c6:t1' },
          ],
        };
      }
      if (method === 'pane.split') return { pane: { pane_id: 'w1:p2' } };
      if (method === 'pane.send_text') return { type: 'ok' };
      return {};
    });

    await herdr.spawnPane('sess-1', 'desc', 'http://localhost:4096', '/tmp');

    const splitCall = mockClientInstance?.call.mock.calls.find(
      ([m]) => m === 'pane.split',
    );
    expect(splitCall).toBeDefined();
    // main-vertical layout direction = right, but since we have an existing
    // agent, we split that agent in the PERPENDICULAR direction = down
    expect(splitCall?.[1]).toEqual({
      pane_id: 'w654950b6cb01c6:p5',
      workspace_id: 'w654950b6cb01c6',
      tab_id: 'w654950b6cb01c6:t1',
      direction: 'down',
      ratio: 0.5,
      cwd: '/tmp',
      label: 'desc',
    });
  });

  test('subsequent agent splits first agent in perpendicular direction (main-horizontal)', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer('main-horizontal', 60);

    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(async (method: string) => {
      if (method === 'pane.list') {
        return {
          panes: [
            { pane_id: 'w654950b6cb01c6:p5', tab_id: 'w654950b6cb01c6:t1' },
          ],
        };
      }
      if (method === 'pane.split') return { pane: { pane_id: 'w1:p2' } };
      if (method === 'pane.send_text') return { type: 'ok' };
      return {};
    });

    await herdr.spawnPane('sess-1', 'desc', 'http://localhost:4096', '/tmp');

    const splitCall = mockClientInstance?.call.mock.calls.find(
      ([m]) => m === 'pane.split',
    );
    expect(splitCall).toBeDefined();
    // main-horizontal layout direction = down, perpendicular = right
    expect(splitCall?.[1]).toEqual({
      pane_id: 'w654950b6cb01c6:p5',
      workspace_id: 'w654950b6cb01c6',
      tab_id: 'w654950b6cb01c6:t1',
      direction: 'right',
      ratio: 0.5,
      cwd: '/tmp',
      label: 'desc',
    });
  });

  test('pane.list failure falls back to splitting from main', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(async (method: string) => {
      if (method === 'pane.list') throw new Error('pane.list failed');
      if (method === 'pane.split') return { pane: { pane_id: 'w1:p2' } };
      if (method === 'pane.send_text') return { type: 'ok' };
      return {};
    });

    await herdr.spawnPane('sess-1', 'desc', 'http://localhost:4096', '/tmp');

    const splitCall = mockClientInstance?.call.mock.calls.find(
      ([m]) => m === 'pane.split',
    );
    expect(splitCall).toBeDefined();
    // Falls back to main pane, layout direction = right
    expect(splitCall?.[1]).toHaveProperty('pane_id', 'w654950b6cb01c6:p0');
    expect(splitCall?.[1]).toHaveProperty('direction', 'right');
  });

  test('HERDR_TAB_ID unset returns failure (cannot target safely)', async () => {
    delete process.env.HERDR_TAB_ID;

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    // spawnPane checks HERDR_TAB_ID before calling pane.split — without it,
    // we cannot target the correct tab, so it fails early.
    const result = await herdr.spawnPane(
      'sess-1',
      'desc',
      'http://localhost:4096',
      '/tmp',
    );
    expect(result).toEqual({ success: false });
    expect(mockClientInstance?.call.mock.calls.length).toBe(0);
  });

  test('HERDR_WORKSPACE_ID unset returns failure without calling pane.split', async () => {
    delete process.env.HERDR_WORKSPACE_ID;

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    const result = await herdr.spawnPane(
      'sess-1',
      'desc',
      'http://localhost:4096',
      '/tmp',
    );
    expect(result).toEqual({ success: false });
    expect(mockClientInstance?.call.mock.calls.length).toBe(0);
  });

  test('HERDR_PANE_ID unset returns failure without calling pane.list', async () => {
    delete process.env.HERDR_PANE_ID;

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    const result = await herdr.spawnPane(
      'sess-1',
      'desc',
      'http://localhost:4096',
      '/tmp',
    );

    expect(result).toEqual({ success: false });
    // pane.list should NOT have been called
    const listCalls = mockClientInstance?.call.mock.calls.filter(
      ([m]) => m === 'pane.list',
    );
    expect(listCalls).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // spawnPane not inside session
  // -----------------------------------------------------------------------

  test('spawnPane returns failure when not inside a herdr session', async () => {
    delete process.env.HERDR_ENV;

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    const result = await herdr.spawnPane(
      'sess-1',
      'desc',
      'http://localhost:4096',
      '/tmp',
    );

    expect(result).toEqual({ success: false });

    // Should NOT have called client at all
    if (mockClientInstance) {
      expect(mockClientInstance?.call.mock.calls.length).toBe(0);
    }
  });

  // -----------------------------------------------------------------------
  // spawnPane herdr not available
  // -----------------------------------------------------------------------

  test('spawnPane returns failure when herdr is not available', async () => {
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(1, '', 'not found');
      }
      return createSpawnResult();
    });

    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    const result = await herdr.spawnPane(
      'sess-1',
      'desc',
      'http://localhost:4096',
      '/tmp',
    );

    expect(result).toEqual({ success: false });
  });

  // -----------------------------------------------------------------------
  // spawnPane split returns no pane_id
  // -----------------------------------------------------------------------

  test('spawnPane returns failure when split response lacks pane_id', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(
      async (method: string, _params: Record<string, unknown>) => {
        if (method === 'pane.list') return { panes: [] };
        if (method === 'pane.split') {
          return {}; // no pane field
        }
        return {};
      },
    );

    const result = await herdr.spawnPane(
      'sess-1',
      'desc',
      'http://localhost:4096',
      '/tmp',
    );

    expect(result).toEqual({ success: false });
  });

  // -----------------------------------------------------------------------
  // spawnPane exception
  // -----------------------------------------------------------------------

  test('spawnPane returns failure when call throws', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(
      async (method: string, _params: Record<string, unknown>) => {
        // Let pane.list succeed, fail on the actual spawn
        if (method === 'pane.list') return { panes: [] };
        throw new Error('connection lost');
      },
    );

    const result = await herdr.spawnPane(
      'sess-1',
      'desc',
      'http://localhost:4096',
      '/tmp',
    );

    expect(result).toEqual({ success: false });
  });

  // -----------------------------------------------------------------------
  // closePane success
  // -----------------------------------------------------------------------

  test('closePane returns true on success', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(
      async (method: string, _params: Record<string, unknown>) => {
        if (method === 'pane.send_keys') return { type: 'ok' };
        if (method === 'pane.close') return { type: 'ok' };
        return {};
      },
    );

    const result = await herdr.closePane('w1:p2');
    expect(result).toBe(true);
  });

  test('closePane calls panes in correct order (send_keys then pane.close)', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    const callSequence: string[] = [];
    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(
      async (method: string, _params: Record<string, unknown>) => {
        callSequence.push(method);
        if (method === 'pane.send_keys') return { type: 'ok' };
        if (method === 'pane.close') return { type: 'ok' };
        return {};
      },
    );

    await herdr.closePane('w1:p2');

    expect(callSequence).toEqual(['pane.send_keys', 'pane.close']);
  });

  test('closePane calls send_keys with ctrl+c', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    let sendKeysParams: Record<string, unknown> | null = null;
    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'pane.send_keys') {
          sendKeysParams = params;
          return { type: 'ok' };
        }
        if (method === 'pane.close') return { type: 'ok' };
        return {};
      },
    );

    await herdr.closePane('w1:p2');
    expect(sendKeysParams).toEqual({
      pane_id: 'w1:p2',
      keys: ['ctrl+c'],
    });
  });

  // -----------------------------------------------------------------------
  // closePane already gone
  // -----------------------------------------------------------------------

  test('closePane returns true when pane is already closed (pane_not_found)', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    expect(mockClientInstance).not.toBeNull();
    // send_keys throws, pane.close throws pane_not_found
    mockClientInstance?.call.mockImplementation(
      async (method: string, _params: Record<string, unknown>) => {
        if (method === 'pane.send_keys') {
          throw new Error('herdr: pane_not_found — pane gone');
        }
        if (method === 'pane.close') {
          const err = Object.assign(
            new Error('herdr: pane_not_found — already gone'),
            { code: 'pane_not_found', message: 'already gone' },
          );
          throw err;
        }
        return {};
      },
    );

    const result = await herdr.closePane('w1:p2');
    expect(result).toBe(true);
  });

  // -----------------------------------------------------------------------
  // closePane empty paneId
  // -----------------------------------------------------------------------

  test('closePane returns false for empty paneId', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    const result = await herdr.closePane('');
    expect(result).toBe(false);

    // Should not have called client
    if (mockClientInstance) {
      expect(mockClientInstance?.call.mock.calls.length).toBe(0);
    }
  });

  // -----------------------------------------------------------------------
  // closePane non-not_found error
  // -----------------------------------------------------------------------

  test('closePane returns false on internal_error', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(
      async (method: string, _params: Record<string, unknown>) => {
        if (method === 'pane.send_keys') return { type: 'ok' };
        if (method === 'pane.close') {
          const err = Object.assign(
            new Error('herdr: internal_error — something broke'),
            { code: 'internal_error', message: 'something broke' },
          );
          throw err;
        }
        return {};
      },
    );

    const result = await herdr.closePane('w1:p2');
    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // closePane send_keys also tolerates errors
  // -----------------------------------------------------------------------

  test('closePane tolerates send_keys failure and still tries pane.close', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    const callSequence: string[] = [];
    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(
      async (method: string, _params: Record<string, unknown>) => {
        callSequence.push(method);
        if (method === 'pane.send_keys') {
          throw Object.assign(new Error('herdr: pane_not_found'), {
            code: 'pane_not_found',
            message: 'gone',
          });
        }
        if (method === 'pane.close') {
          return { type: 'ok' };
        }
        return {};
      },
    );

    const result = await herdr.closePane('w1:p2');
    expect(result).toBe(true);
    expect(callSequence).toEqual(['pane.send_keys', 'pane.close']);
  });

  // -----------------------------------------------------------------------
  // applyLayout — main-horizontal
  // -----------------------------------------------------------------------

  test('applyLayout main-horizontal queries layout and resizes main pane down', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    process.env.HERDR_PANE_ID = 'w4:p1';

    expect(mockClientInstance).not.toBeNull();
    mockClientInstance?.call.mockImplementation(
      async (method: string, _params: Record<string, unknown>) => {
        if (method === 'pane.layout') {
          return {
            layout: {
              area: { width: 166, height: 47 },
              panes: [
                {
                  pane_id: 'w4:p1',
                  rect: { x: 26, y: 1, width: 166, height: 20 },
                  focused: true,
                },
                {
                  pane_id: 'w4:p2',
                  rect: { x: 26, y: 21, width: 166, height: 27 },
                  focused: false,
                },
              ],
            },
          };
        }
        if (method === 'pane.resize') {
          return { type: 'pane_resize' };
        }
        return {};
      },
    );

    await expect(
      herdr.applyLayout('main-horizontal', 60),
    ).resolves.toBeUndefined();

    // Should have called pane.layout + pane.resize
    const layoutCalls = mockClientInstance?.call.mock.calls.filter(
      ([m]) => m === 'pane.layout',
    );
    const resizeCalls = mockClientInstance?.call.mock.calls.filter(
      ([m]) => m === 'pane.resize',
    );

    expect(layoutCalls).toHaveLength(1);
    expect(resizeCalls).toHaveLength(1);

    // 60% − 20/47 = ratio delta
    const resizeParams = resizeCalls?.[0]?.[1] as Record<string, unknown>;
    expect(resizeParams).toHaveProperty('pane_id', 'w4:p1');
    expect(resizeParams).toHaveProperty('direction', 'down');
    expect(resizeParams).toHaveProperty('amount', 0.6 - 20 / 47);
  });

  test('applyLayout main-horizontal skips resize when already at target', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    // 60% of 50 = 30, current height = 30 → no delta
    mockClientInstance?.call.mockImplementation(async (method: string) => {
      if (method === 'pane.layout') {
        return {
          layout: {
            area: { width: 100, height: 50 },
            panes: [
              {
                pane_id: 'w4:p1',
                rect: { x: 0, y: 0, width: 100, height: 30 },
                focused: true,
              },
              {
                pane_id: 'w4:p2',
                rect: { x: 0, y: 30, width: 100, height: 20 },
                focused: false,
              },
            ],
          },
        };
      }
      return {};
    });

    await herdr.applyLayout('main-horizontal', 60);

    const resizeCalls = mockClientInstance?.call.mock.calls.filter(
      ([m]) => m === 'pane.resize',
    );
    expect(resizeCalls).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // applyLayout — even-vertical / tiled
  // -----------------------------------------------------------------------

  test('applyLayout even-vertical resizes all panes to equal height', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    process.env.HERDR_PANE_ID = 'w4:p1';

    mockClientInstance?.call.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'pane.layout') {
          return {
            layout: {
              area: { width: 100, height: 48 },
              panes: [
                {
                  pane_id: 'w4:p1',
                  rect: { x: 0, y: 0, width: 100, height: 20 },
                  focused: true,
                },
                {
                  pane_id: 'w4:p2',
                  rect: { x: 0, y: 20, width: 100, height: 14 },
                  focused: false,
                },
                {
                  pane_id: 'w4:p3',
                  rect: { x: 0, y: 34, width: 100, height: 14 },
                  focused: false,
                },
              ],
            },
          };
        }
        // After each resize, return updated layout with the resized rects
        if (method === 'pane.resize') {
          const resizeParams = params as {
            pane_id: string;
            direction: string;
            amount: number;
          };
          // Simulate resized layout
          if (resizeParams.pane_id === 'w4:p1') {
            return {
              layout: {
                area: { width: 100, height: 48 },
                panes: [
                  {
                    pane_id: 'w4:p1',
                    rect: { x: 0, y: 0, width: 100, height: 16 },
                    focused: true,
                  },
                  {
                    pane_id: 'w4:p2',
                    rect: { x: 0, y: 16, width: 100, height: 18 },
                    focused: false,
                  },
                  {
                    pane_id: 'w4:p3',
                    rect: { x: 0, y: 34, width: 100, height: 14 },
                    focused: false,
                  },
                ],
              },
            };
          }
          if (resizeParams.pane_id === 'w4:p2') {
            return {
              layout: {
                area: { width: 100, height: 48 },
                panes: [
                  {
                    pane_id: 'w4:p1',
                    rect: { x: 0, y: 0, width: 100, height: 16 },
                    focused: true,
                  },
                  {
                    pane_id: 'w4:p2',
                    rect: { x: 0, y: 16, width: 100, height: 16 },
                    focused: false,
                  },
                  {
                    pane_id: 'w4:p3',
                    rect: { x: 0, y: 32, width: 100, height: 16 },
                    focused: false,
                  },
                ],
              },
            };
          }
          return {};
        }
        return {};
      },
    );

    await herdr.applyLayout('even-vertical', 60);

    const resizeCalls = mockClientInstance?.call.mock.calls.filter(
      ([m]) => m === 'pane.resize',
    );
    expect(resizeCalls).toHaveLength(2);
    expect(resizeCalls?.[0]?.[1]).toHaveProperty('pane_id', 'w4:p1');
    expect(resizeCalls?.[1]?.[1]).toHaveProperty('pane_id', 'w4:p2');
  });

  test('applyLayout tiled delegates to even-vertical logic', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    mockClientInstance?.call.mockImplementation(async (method: string) => {
      if (method === 'pane.layout') {
        return {
          layout: {
            area: { width: 100, height: 48 },
            panes: [
              {
                pane_id: 'w4:p1',
                rect: { x: 0, y: 0, width: 100, height: 24 },
                focused: true,
              },
              {
                pane_id: 'w4:p2',
                rect: { x: 0, y: 24, width: 100, height: 24 },
                focused: false,
              },
            ],
          },
        };
      }
      return {};
    });

    await expect(herdr.applyLayout('tiled', 50)).resolves.toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // applyLayout — width-axis layouts (main-vertical, even-horizontal)
  // -----------------------------------------------------------------------

  test('applyLayout main-vertical resizes main pane width', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    process.env.HERDR_PANE_ID = 'w4:p1';

    mockClientInstance?.call.mockImplementation(
      async (method: string, _params: Record<string, unknown>) => {
        if (method === 'pane.layout') {
          return {
            layout: {
              area: { width: 166, height: 47 },
              panes: [
                {
                  pane_id: 'w4:p1',
                  rect: { x: 26, y: 1, width: 66, height: 47 },
                  focused: true,
                },
                {
                  pane_id: 'w4:p2',
                  rect: { x: 92, y: 1, width: 100, height: 47 },
                  focused: false,
                },
              ],
            },
          };
        }
        if (method === 'pane.resize') {
          return { type: 'pane_resize' };
        }
        return {};
      },
    );

    await expect(
      herdr.applyLayout('main-vertical', 60),
    ).resolves.toBeUndefined();

    // targetRatio=0.6, currentRatio=66/166, delta=0.6-66/166
    const resizeCalls = mockClientInstance?.call.mock.calls.filter(
      ([m]) => m === 'pane.resize',
    );
    expect(resizeCalls).toHaveLength(1);
    const resizeParams = resizeCalls?.[0]?.[1] as Record<string, unknown>;
    expect(resizeParams).toHaveProperty('pane_id', 'w4:p1');
    expect(resizeParams).toHaveProperty('direction', 'right');
    expect(resizeParams).toHaveProperty('amount', 0.6 - 66 / 166);
  });

  test('applyLayout main-vertical skips resize when already at target', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    process.env.HERDR_PANE_ID = 'w4:p1';

    // 60% of 100 = 60, current main width = 60 → no delta
    mockClientInstance?.call.mockImplementation(async (method: string) => {
      if (method === 'pane.layout') {
        return {
          layout: {
            area: { width: 100, height: 48 },
            panes: [
              {
                pane_id: 'w4:p1',
                rect: { x: 0, y: 0, width: 60, height: 48 },
                focused: true,
              },
              {
                pane_id: 'w4:p2',
                rect: { x: 60, y: 0, width: 40, height: 48 },
                focused: false,
              },
            ],
          },
        };
      }
      return {};
    });

    await herdr.applyLayout('main-vertical', 60);

    const resizeCalls = mockClientInstance?.call.mock.calls.filter(
      ([m]) => m === 'pane.resize',
    );
    expect(resizeCalls).toHaveLength(0);
  });

  test('applyLayout even-horizontal resizes all panes to equal width', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    process.env.HERDR_PANE_ID = 'w4:p1';

    mockClientInstance?.call.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'pane.layout') {
          return {
            layout: {
              area: { width: 99, height: 47 },
              panes: [
                {
                  pane_id: 'w4:p1',
                  rect: { x: 0, y: 0, width: 40, height: 47 },
                  focused: true,
                },
                {
                  pane_id: 'w4:p2',
                  rect: { x: 40, y: 0, width: 30, height: 47 },
                  focused: false,
                },
                {
                  pane_id: 'w4:p3',
                  rect: { x: 70, y: 0, width: 29, height: 47 },
                  focused: false,
                },
              ],
            },
          };
        }
        if (method === 'pane.resize') {
          const resizeParams = params as {
            pane_id: string;
            direction: string;
            amount: number;
          };
          // Simulate resized layout after each call
          if (resizeParams.pane_id === 'w4:p1') {
            return {
              layout: {
                area: { width: 99, height: 47 },
                panes: [
                  {
                    pane_id: 'w4:p1',
                    rect: { x: 0, y: 0, width: 33, height: 47 },
                  },
                  {
                    pane_id: 'w4:p2',
                    rect: { x: 33, y: 0, width: 37, height: 47 },
                  },
                  {
                    pane_id: 'w4:p3',
                    rect: { x: 70, y: 0, width: 29, height: 47 },
                  },
                ],
              },
            };
          }
          if (resizeParams.pane_id === 'w4:p2') {
            return {
              layout: {
                area: { width: 99, height: 47 },
                panes: [
                  {
                    pane_id: 'w4:p1',
                    rect: { x: 0, y: 0, width: 33, height: 47 },
                  },
                  {
                    pane_id: 'w4:p2',
                    rect: { x: 33, y: 0, width: 33, height: 47 },
                  },
                  {
                    pane_id: 'w4:p3',
                    rect: { x: 66, y: 0, width: 33, height: 47 },
                  },
                ],
              },
            };
          }
          return {};
        }
        return {};
      },
    );

    await herdr.applyLayout('even-horizontal', 50);

    const resizeCalls = mockClientInstance?.call.mock.calls.filter(
      ([m]) => m === 'pane.resize',
    );
    expect(resizeCalls).toHaveLength(2);
    expect(resizeCalls?.[0]?.[1]).toHaveProperty('pane_id', 'w4:p1');
    expect(resizeCalls?.[1]?.[1]).toHaveProperty('pane_id', 'w4:p2');
  });

  // -----------------------------------------------------------------------
  // applyLayout — error handling
  // -----------------------------------------------------------------------

  test('applyLayout catches and logs errors without throwing', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    mockClientInstance?.call.mockImplementation(async (_method: string) => {
      throw new Error('layout query failed');
    });

    // Should not throw
    await expect(
      herdr.applyLayout('main-horizontal', 60),
    ).resolves.toBeUndefined();
  });

  test('applyLayout handles single pane gracefully', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    mockClientInstance?.call.mockImplementation(async (method: string) => {
      if (method === 'pane.layout') {
        return {
          layout: {
            area: { width: 166, height: 47 },
            panes: [
              {
                pane_id: 'w4:p1',
                rect: { x: 26, y: 1, width: 166, height: 47 },
                focused: true,
              },
            ],
          },
        };
      }
      return {};
    });

    await expect(
      herdr.applyLayout('even-vertical', 60),
    ).resolves.toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // applyLayout — debounce
  // -----------------------------------------------------------------------

  test('scheduleLayout debounces and calls applyLayoutNow once after settle', async () => {
    const { HerdrMultiplexer } = await importFreshHerdr();
    const herdr = new HerdrMultiplexer();

    process.env.HERDR_PANE_ID = 'w4:p1';

    mockClientInstance?.call.mockImplementation(async (method: string) => {
      if (method === 'pane.list') {
        return { panes: [] };
      }
      if (method === 'pane.split') {
        return { pane: { pane_id: 'w4:p2' } };
      }
      if (method === 'pane.send_text') {
        return { type: 'ok' };
      }
      if (method === 'pane.layout') {
        return {
          layout: {
            area: { width: 100, height: 48 },
            panes: [
              {
                pane_id: 'w4:p1',
                rect: { x: 0, y: 0, width: 100, height: 24 },
                focused: true,
              },
              {
                pane_id: 'w4:p2',
                rect: { x: 0, y: 24, width: 100, height: 24 },
                focused: false,
              },
            ],
          },
        };
      }
      if (method === 'pane.resize') {
        return {};
      }
      return {};
    });

    // Trigger scheduleLayout indirectly via spawnPane
    await herdr.spawnPane('sess-1', 'desc', 'http://localhost:4096', '/tmp');

    // Count calls before debounce fires
    const layoutCallsBefore = mockClientInstance?.call.mock.calls.filter(
      ([m]) => m === 'pane.layout',
    ).length;
    expect(layoutCallsBefore).toBe(0);

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 200));

    // After settle, applyLayoutNow should have been called
    const layoutCallsAfter = mockClientInstance?.call.mock.calls.filter(
      ([m]) => m === 'pane.layout',
    ).length;
    expect(layoutCallsAfter).toBe(1);
  });
});
