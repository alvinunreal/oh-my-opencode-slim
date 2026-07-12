import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  CliCmuxClient,
  type CmuxClient,
  CmuxMultiplexer,
  type CommandRunner,
  resetCmuxStateForTests,
  SpawnCommandRunner,
} from '.';

function client(): CmuxClient {
  let next = 1;
  return {
    version: mock(async () => '0.64.17'),
    identify: mock(async () => ({
      workspaceId: 'workspace-root',
      paneId: 'pane-root',
      surfaceId: 'surface-root',
      socketPath: '/tmp/cmux.sock',
    })),
    createSurface: mock(async () => ({
      paneId: `pane-${next}`,
      surfaceId: `surface-${next++}`,
    })),
    respawnSurface: mock(async () => true),
    closeSurface: mock(async () => 'closed' as const),
    equalizeSplits: mock(async () => true),
  };
}

function mux(api: CmuxClient): CmuxMultiplexer {
  return new CmuxMultiplexer(api, {
    checkSessionReady: async () => true,
    delay: async () => {},
    opencodeBinary: '/opt/opencode',
    pathExists: () => true,
  });
}

describe('CmuxMultiplexer', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(resetCmuxStateForTests);
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('gates cmux versions', async () => {
    const api = client();
    api.version = mock(async () => '0.64.13');
    expect(await mux(api).isAvailable()).toBe(false);
    api.version = mock(async () => '0.64.14');
    expect(await mux(api).isAvailable()).toBe(true);
  });

  test('does not cache transient version failure but keeps hard old version', async () => {
    const api = client();
    api.version = mock(async () => null);
    const transient = mux(api);
    expect(await transient.isAvailable()).toBe(false);
    api.version = mock(async () => '0.64.17');
    expect(await transient.isAvailable()).toBe(true);

    const old = client();
    old.version = mock(async () => '0.64.13');
    expect(
      await mux(old).spawnPane('old', 'agent', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'hard' });
  });

  test('waits for attachable status before creating and respawning', async () => {
    const api = client();
    const events: string[] = [];
    api.createSurface = mock(async () => {
      events.push('create');
      return { paneId: 'pane-1', surfaceId: 'surface-1' };
    });
    api.respawnSurface = mock(async () => {
      events.push('respawn');
      return true;
    });
    let attempt = 0;
    const readiness = mock(async (url: URL, sessionId: string) => {
      events.push('status');
      expect(url.href).toBe('https://example.test/session/status');
      expect(sessionId).toBe('session-1');
      attempt += 1;
      if (attempt === 2) throw new Error('network');
      return attempt >= 4;
    });
    const instance = new CmuxMultiplexer(api, {
      checkSessionReady: readiness,
      delay: async () => {},
      opencodeBinary: '/opt/opencode',
      pathExists: () => true,
    });
    expect(
      await instance.spawnPane(
        'session-1',
        'agent',
        'https://example.test/base',
        '/repo',
      ),
    ).toEqual(expect.objectContaining({ success: true }));
    expect(events).toEqual([
      'status',
      'status',
      'status',
      'status',
      'create',
      'respawn',
    ]);
  });

  test('readiness timeout does not flash or create a pane', async () => {
    const api = client();
    const instance = new CmuxMultiplexer(api, {
      checkSessionReady: async () => false,
      delay: async () => {},
      opencodeBinary: '/opt/opencode',
      pathExists: () => true,
    });
    expect(
      await instance.spawnPane('s1', 'agent', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'unavailable' });
    expect(api.createSurface).not.toHaveBeenCalled();
    expect(api.respawnSurface).not.toHaveBeenCalled();
    expect(api.closeSurface).not.toHaveBeenCalled();
  });

  test('hanging readiness does not block an existing pane close', async () => {
    const api = client();
    const hanging = createDeferred<boolean>();
    const instance = new CmuxMultiplexer(api, {
      checkSessionReady: (_url, sessionId) =>
        sessionId === 'first' ? Promise.resolve(true) : hanging.promise,
      delay: async () => {},
      readinessAttemptTimeoutMs: 1,
      opencodeBinary: '/opt/opencode',
      pathExists: () => true,
    });
    const first = await instance.spawnPane(
      'first',
      'agent',
      'http://server',
      '/repo',
    );
    const waiting = instance.spawnPane(
      'hanging',
      'agent',
      'http://server',
      '/repo',
    );
    expect(await instance.closePane(first.paneId ?? '')).toBe(true);
    expect(api.closeSurface).toHaveBeenCalledWith(
      'workspace-root',
      'surface-1',
      '/tmp/cmux.sock',
    );
    expect(await waiting).toEqual({ success: false, error: 'unavailable' });
  });

  test('default readiness parses the target status from /session/status', async () => {
    const api = client();
    const requested: string[] = [];
    globalThis.fetch = mock(async (input) => {
      requested.push(String(input));
      return Response.json({ target: { type: 'busy' } });
    }) as typeof fetch;
    expect(
      await new CmuxMultiplexer(api, {
        opencodeBinary: '/opt/opencode',
        pathExists: () => true,
      }).spawnPane('target', 'agent', 'http://127.0.0.1:7777/base', '/repo'),
    ).toEqual(expect.objectContaining({ success: true }));
    expect(requested).toEqual(['http://127.0.0.1:7777/session/status']);
  });

  test('uses stable create IDs for right/down anchors and close', async () => {
    const api = client();
    const instance = mux(api);
    const first = await instance.spawnPane('s1', 'one', 'http://server', '/r');
    await instance.spawnPane('s2', 'two', 'http://server', '/r');
    expect(api.createSurface).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: 'workspace-root',
        targetSurfaceId: 'surface-root',
        direction: 'right',
        focus: false,
      },
      '/tmp/cmux.sock',
    );
    expect(api.createSurface).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        targetSurfaceId: 'surface-1',
        direction: 'down',
      }),
      '/tmp/cmux.sock',
    );
    await instance.closePane(first.paneId ?? '');
    expect(api.closeSurface).toHaveBeenCalledWith(
      'workspace-root',
      'surface-1',
      '/tmp/cmux.sock',
    );
    expect(api.equalizeSplits).toHaveBeenCalledTimes(3);
  });

  test('uses the identified socket for every operation after identify', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: mock(async (argv) => {
        calls.push(argv);
        if (argv.includes('--version'))
          return { exitCode: 0, stdout: 'cmux 0.64.17', stderr: '' };
        if (argv.includes('identify'))
          return {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              socket_path: '/tmp/socket-a',
              caller: {
                workspace_id: 'w',
                pane_id: 'p',
                surface_id: 'root',
              },
            }),
          };
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({ pane_id: 'p2', surface_id: 's2' }),
        };
      }),
    };
    const previous = process.env.CMUX_SOCKET_PATH;
    process.env.CMUX_SOCKET_PATH = '/tmp/socket-a';
    const instance = mux(new CliCmuxClient(runner, '/bin/cmux'));
    const pane = await instance.spawnPane('s', 'agent', 'http://server', '/r');
    process.env.CMUX_SOCKET_PATH = '/tmp/socket-b';
    await instance.closePane(pane.paneId ?? '');
    const close = calls.find((call) => call.includes('close-surface'));
    for (const operation of [
      'new-split',
      'respawn-pane',
      'rpc',
      'close-surface',
    ]) {
      const call = calls.find((candidate) => candidate.includes(operation));
      expect(call?.slice(1, 3)).toEqual(['--socket', '/tmp/socket-a']);
    }
    if (previous === undefined) delete process.env.CMUX_SOCKET_PATH;
    else process.env.CMUX_SOCKET_PATH = previous;
  });

  test('keeps separate multiplexer instances on their identified sockets', async () => {
    const first = client();
    const second = client();
    first.identify = mock(async () => ({
      workspaceId: 'w1',
      paneId: 'p1',
      surfaceId: 'root1',
      socketPath: '/tmp/a',
    }));
    second.identify = mock(async () => ({
      workspaceId: 'w2',
      paneId: 'p2',
      surfaceId: 'root2',
      socketPath: '/tmp/b',
    }));
    await mux(first).spawnPane('a', 'agent', 'http://server', '/repo');
    await mux(second).spawnPane('b', 'agent', 'http://server', '/repo');
    expect(first.createSurface).toHaveBeenCalledWith(
      expect.any(Object),
      '/tmp/a',
    );
    expect(second.createSurface).toHaveBeenCalledWith(
      expect.any(Object),
      '/tmp/b',
    );
    expect(first.respawnSurface).toHaveBeenCalledWith(
      'w1',
      expect.any(String),
      expect.any(String),
      '/tmp/a',
    );
    expect(second.respawnSurface).toHaveBeenCalledWith(
      'w2',
      expect.any(String),
      expect.any(String),
      '/tmp/b',
    );
  });

  test('serializes concurrent spawns', async () => {
    const api = client();
    const instance = mux(api);
    await Promise.all([
      instance.spawnPane('s1', 'one', 'http://server', '/repo'),
      instance.spawnPane('s2', 'two', 'http://server', '/repo'),
    ]);
    expect(api.createSurface).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ direction: 'down' }),
      '/tmp/cmux.sock',
    );
  });

  test('quotes attach command data safely', async () => {
    const api = client();
    await mux(api).spawnPane(
      "s'$(touch /tmp/no);",
      'one',
      'http://host/a b;$()',
      "/repo/a b/'quoted'",
    );
    expect(api.respawnSurface).toHaveBeenCalledWith(
      'workspace-root',
      'surface-1',
      "'/opt/opencode' attach 'http://host/a b;$()' --session 's'\\''$(touch /tmp/no);' --dir '/repo/a b/'\\''quoted'\\'''",
      '/tmp/cmux.sock',
    );
  });

  test('uses the injected host opencode executable instead of pane PATH', async () => {
    const api = client();
    const instance = new CmuxMultiplexer(api, {
      checkSessionReady: async () => true,
      delay: async () => {},
      opencodeBinary: '/Users/king/.opencode/bin/opencode',
      pathExists: () => true,
    });
    await instance.spawnPane('s1', 'agent', 'http://server', '/repo');
    expect(api.respawnSurface).toHaveBeenCalledWith(
      'workspace-root',
      'surface-1',
      "'/Users/king/.opencode/bin/opencode' attach 'http://server' --session 's1' --dir '/repo'",
      '/tmp/cmux.sock',
    );
  });

  test('quotes an injected host executable containing spaces', async () => {
    const api = client();
    const instance = new CmuxMultiplexer(api, {
      checkSessionReady: async () => true,
      delay: async () => {},
      opencodeBinary: '/Applications/Open Code/opencode',
      pathExists: () => true,
    });
    await instance.spawnPane('s1', 'agent', 'http://server', '/repo');
    const command = (api.respawnSurface as ReturnType<typeof mock>).mock
      .calls[0]?.[2];
    expect(command).toStartWith("'/Applications/Open Code/opencode' attach");
  });

  test('returns an orphan handle when respawn and cleanup both fail', async () => {
    const api = client();
    api.respawnSurface = mock(async () => false);
    api.closeSurface = mock(async () => 'failed' as const);
    const result = await mux(api).spawnPane(
      'orphan',
      'agent',
      'http://server',
      '/repo',
    );
    expect(result).toEqual({
      success: false,
      error: 'unavailable',
      orphanPaneId: expect.stringContaining('cmux:v1:'),
    });
    expect(await mux(api).closePane(result.orphanPaneId ?? '')).toBe(false);
  });

  test('does not create a surface without an existing absolute binary', async () => {
    const api = client();
    const instance = new CmuxMultiplexer(api, {
      checkSessionReady: async () => true,
      opencodeBinary: 'opencode',
      pathExists: () => false,
    });
    expect(
      await instance.spawnPane('s', 'agent', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'hard' });
    expect(api.createSurface).not.toHaveBeenCalled();
    expect(api.respawnSurface).not.toHaveBeenCalled();
  });
});

describe('CliCmuxClient', () => {
  test('bounds a hanging spawned command', async () => {
    const kill = mock(() => true);
    const runner = new SpawnCommandRunner(5, (() => ({
      exited: new Promise<number>(() => {}),
      stdout: async () => '',
      stderr: async () => '',
      kill,
    })) as any);
    const result = await runner.run(['/bin/cmux', '--version']);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('unavailable');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('uses the 0.64.14 UUID CLI contract', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: mock(async (argv) => {
        calls.push(argv);
        return {
          exitCode: 0,
          stderr: '',
          stdout: argv.includes('identify')
            ? JSON.stringify({
                socket_path: '/tmp/cmux.sock',
                caller: {
                  workspace_id: 'w',
                  pane_id: 'p',
                  surface_id: 's',
                },
              })
            : JSON.stringify({ pane_id: 'p2', surface_id: 's2' }),
        };
      }),
    };
    const cli = new CliCmuxClient(runner, '/bin/cmux');
    expect(await cli.identify()).toEqual({
      workspaceId: 'w',
      paneId: 'p',
      surfaceId: 's',
      socketPath: '/tmp/cmux.sock',
    });
    await cli.createSurface({
      workspaceId: 'w',
      targetSurfaceId: 's',
      direction: 'right',
      focus: false,
    });
    expect(calls[1]).toEqual([
      '/bin/cmux',
      '--json',
      '--id-format',
      'uuids',
      'new-split',
      'right',
      '--workspace',
      'w',
      '--surface',
      's',
      '--focus',
      'false',
    ]);
  });

  test('covers respawn close equalize and resets create error classification', async () => {
    const calls: string[][] = [];
    let splitAttempt = 0;
    const runner: CommandRunner = {
      run: mock(async (argv) => {
        calls.push(argv);
        if (argv.includes('new-split')) {
          splitAttempt += 1;
          return splitAttempt === 1
            ? { exitCode: 1, stdout: '', stderr: 'invalid_state' }
            : { exitCode: 1, stdout: '', stderr: 'bad configuration' };
        }
        if (argv.includes('close-surface')) {
          return { exitCode: 1, stdout: '', stderr: 'not_found' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };
    const cli = new CliCmuxClient(runner, '/bin/cmux');
    const input = {
      workspaceId: 'w',
      targetSurfaceId: 's',
      direction: 'right' as const,
      focus: false as const,
    };
    expect(await cli.createSurface(input)).toBeNull();
    expect(cli.getCreateError()).toBe('invalid_state');
    expect(await cli.createSurface(input)).toBeNull();
    expect(cli.getCreateError()).toBe('hard');
    expect(await cli.respawnSurface('w', 's', 'safe command')).toBe(true);
    expect(await cli.closeSurface('w', 's')).toBe('not_found');
    expect(
      await cli.equalizeSplits({ workspace_id: 'w', orientation: 'vertical' }),
    ).toBe(true);
    expect(calls.at(-2)).toEqual([
      '/bin/cmux',
      'close-surface',
      '--workspace',
      'w',
      '--surface',
      's',
    ]);
  });

  test('classifies runner throws as transient and recovers without stale errors', async () => {
    let calls = 0;
    const runner: CommandRunner = {
      run: mock(async (argv) => {
        calls += 1;
        if (calls <= 3) throw new Error('socket closed');
        if (argv.includes('--version')) {
          return { exitCode: 0, stdout: 'cmux 0.64.17', stderr: '' };
        }
        if (argv.includes('identify')) {
          return {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              socket_path: '/tmp/cmux.sock',
              caller: { workspace_id: 'w', pane_id: 'p', surface_id: 's' },
            }),
          };
        }
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({ pane_id: 'p2', surface_id: 's2' }),
        };
      }),
    };
    const cli = new CliCmuxClient(runner, '/bin/cmux');
    expect(await cli.version()).toBeNull();
    expect(cli.getVersionError()).toBe('unavailable');
    expect(await cli.identify()).toBeNull();
    expect(cli.getIdentifyError()).toBe('unavailable');
    expect(
      await cli.createSurface({
        workspaceId: 'w',
        targetSurfaceId: 's',
        direction: 'right',
        focus: false,
      }),
    ).toBeNull();
    expect(cli.getCreateError()).toBe('unavailable');
    expect(await cli.version()).toBe('0.64.17');
    expect(await cli.identify()).not.toBeNull();
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
