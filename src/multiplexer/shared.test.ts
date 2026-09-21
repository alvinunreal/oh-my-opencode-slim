import { afterEach, describe, expect, mock, test } from 'bun:test';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
};

const crossSpawnMock = mock(
  (_args: string[]): SpawnResult => ({
    exited: Promise.resolve(0),
    stdout: () => Promise.resolve(''),
    stderr: () => Promise.resolve(''),
  }),
);

mock.module('../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

let importCounter = 0;

async function importShared() {
  return import(`./shared?test=${importCounter++}`);
}

describe('gracefulClosePane', () => {
  afterEach(() => {
    crossSpawnMock.mockReset();
  });

  test('sends Ctrl+C, waits 250ms, then closes, returning true on exit 0', async () => {
    const calls: string[][] = [];

    crossSpawnMock.mockImplementation((args: string[]) => {
      calls.push(args);
      return {
        exited: Promise.resolve(0),
        stdout: () => Promise.resolve(''),
        stderr: () => Promise.resolve(''),
      };
    });

    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('tmux', '%1', {
      ctrlC: ['send-keys', '-t', '%1', 'C-c'],
      close: ['kill-pane', '-t', '%1'],
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('returns true when acceptExitCode1 and exit code is 1', async () => {
    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(1),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve(''),
    }));

    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('zellij', 'terminal_1', {
      ctrlC: ['action', 'write', '--pane-id', 'terminal_1', '\u0003'],
      close: ['action', 'close-pane', '--pane-id', 'terminal_1'],
      acceptExitCode1: true,
    });
    expect(ok).toBe(true);
  });

  test('returns false on exit 1 when acceptExitCode1 is false', async () => {
    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(1),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve(''),
    }));

    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('tmux', '%1', {
      ctrlC: ['send-keys', '-t', '%1', 'C-c'],
      close: ['kill-pane', '-t', '%1'],
    });
    expect(ok).toBe(false);
  });

  test('returns emptyPaneReturnsTrue when paneId is empty', async () => {
    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('zellij', '', {
      ctrlC: ['action', 'write', '--pane-id', '', '\u0003'],
      close: ['action', 'close-pane', '--pane-id', ''],
      emptyPaneReturnsTrue: true,
    });
    expect(ok).toBe(true);
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
  });

  test('returns false when binary is null', async () => {
    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane(null, '%1', {
      ctrlC: ['x'],
      close: ['y'],
    });
    expect(ok).toBe(false);
  });
});

describe('buildOpencodeAttachCommand', () => {
  test('quotes an absolute executable containing spaces and apostrophes', async () => {
    const { buildOpencodeAttachCommand } = await importShared();
    const cmd = buildOpencodeAttachCommand(
      'sess',
      'url',
      '/repo',
      "/Users/King's Tools/opencode",
    );
    expect(cmd).toStartWith("'/Users/King'\\''s Tools/opencode' attach");
  });

  test('resolves host executable with env, process, and bare fallbacks', async () => {
    const { resolveHostOpencodeBinary } = await importShared();
    expect(
      resolveHostOpencodeBinary({
        envOverride: '/Users/king/.opencode/bin/opencode',
        pathExists: () => true,
        execPath: '/opt/homebrew/bin/bun',
        argv0: '/opt/homebrew/bin/bun',
      }),
    ).toBe('/Users/king/.opencode/bin/opencode');
    expect(
      resolveHostOpencodeBinary({
        envOverride: '/missing/opencode',
        pathExists: (path) => path === '/Users/king/.opencode/bin/opencode',
        execPath: '/Users/king/.opencode/bin/opencode',
      }),
    ).toBe('/Users/king/.opencode/bin/opencode');
    expect(
      resolveHostOpencodeBinary({
        envOverride: 'relative/opencode',
        pathExists: () => true,
        execPath: '/opt/homebrew/bin/bun',
        argv0: 'bun',
      }),
    ).toBeNull();
  });

  test('defaults to the resolved absolute host executable (#514)', async () => {
    const { buildOpencodeAttachCommand } = await importShared();
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'omos-514-'));
    const bin = join(dir, 'opencode');
    writeFileSync(bin, '');
    const original = process.env.OPENCODE_BIN;
    process.env.OPENCODE_BIN = bin;
    try {
      const cmd = buildOpencodeAttachCommand('sess', 'url', '/repo');
      expect(cmd).toStartWith(`'${bin}' attach`);
    } finally {
      if (original === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizes Windows backslash paths to forward slashes', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      const cmd = buildOpencodeAttachCommand(
        'sess',
        'url',
        'C:\\Users\\foo\\repo',
      );
      expect(cmd).toContain('C:/Users/foo/repo');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
  });

  test('leaves non-Windows paths unchanged', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      const cmd = buildOpencodeAttachCommand('sess', 'url', '/home/user/repo');
      expect(cmd).toContain('/home/user/repo');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
  });
});

describe('buildShellLaunchArgs', () => {
  const cases: Array<{
    shell: string;
    expected: (cmd: string) => string[];
  }> = [
    {
      shell: '/opt/homebrew/bin/fish',
      expected: (cmd) => ['/opt/homebrew/bin/fish', '-c', cmd],
    },
    {
      shell: '/usr/bin/nu',
      expected: (cmd) => ['/usr/bin/nu', '-c', cmd],
    },
    {
      shell: '/bin/zsh',
      expected: (cmd) => ['/bin/zsh', '-l', '-c', expect.stringContaining(cmd)],
    },
    {
      shell: '/bin/bash',
      expected: (cmd) => [
        '/bin/bash',
        '-l',
        '-c',
        expect.stringContaining(cmd),
      ],
    },
    {
      shell: 'C:\\Windows\\System32\\cmd.exe',
      expected: (cmd) => ['C:\\Windows\\System32\\cmd.exe', '/c', cmd],
    },
    {
      shell: '/usr/bin/pwsh',
      expected: (cmd) => ['/usr/bin/pwsh', '-NoProfile', '-Command', cmd],
    },
    {
      shell: '/bin/dash',
      expected: (cmd) => ['/bin/dash', '-c', cmd],
    },
    {
      shell: '/usr/bin/elvish',
      expected: (cmd) => ['/usr/bin/elvish', '-c', cmd],
    },
  ];

  for (const { shell, expected } of cases) {
    test(`uses correct args for ${shell}`, async () => {
      const original = process.env.SHELL;
      process.env.SHELL = shell;
      try {
        const { buildShellLaunchArgs } = await importShared();
        const cmd = 'opencode attach url --session s';
        expect(buildShellLaunchArgs(cmd)).toEqual(expected(cmd));
      } finally {
        process.env.SHELL = original;
      }
    });
  }

  test('falls back to /bin/sh when SHELL is unset', async () => {
    const original = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const { buildShellLaunchArgs } = await importShared();
      const cmd = 'opencode attach url';
      expect(buildShellLaunchArgs(cmd)).toEqual(['/bin/sh', '-c', cmd]);
    } finally {
      process.env.SHELL = original;
    }
  });
});

describe('waitForSessionReady', () => {
  const url = 'http://127.0.0.1:7777/base';

  test('returns true immediately when the session is already ready', async () => {
    const { waitForSessionReady } = await importShared();
    const check = mock(async () => true);
    const delays: number[] = [];
    const ready = await waitForSessionReady(url, 'session-1', {
      checkSessionReady: check,
      delay: async (ms) => void delays.push(ms),
    });
    expect(ready).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  test('delayed readiness: polls until the session appears, then succeeds', async () => {
    const { waitForSessionReady } = await importShared();
    const seen: Array<{ url: string; sessionId: string }> = [];
    let attempt = 0;
    const check = mock(async (checkUrl: URL, sessionId: string) => {
      seen.push({ url: checkUrl.href, sessionId });
      attempt += 1;
      return attempt >= 3;
    });
    const delays: number[] = [];
    const ready = await waitForSessionReady(url, 'session-1', {
      checkSessionReady: check,
      delay: async (ms) => void delays.push(ms),
    });
    expect(ready).toBe(true);
    expect(check).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([
      { url: 'http://127.0.0.1:7777/session/status', sessionId: 'session-1' },
      { url: 'http://127.0.0.1:7777/session/status', sessionId: 'session-1' },
      { url: 'http://127.0.0.1:7777/session/status', sessionId: 'session-1' },
    ]);
    expect(delays).toEqual([50, 100]);
  });

  test('sends the child directory header to the readiness probe', async () => {
    const { waitForSessionReady } = await importShared();
    const seen: Array<{ search: string; headers?: Record<string, string> }> =
      [];
    const check = mock(
      async (
        checkUrl: URL,
        _sessionId: string,
        _signal: AbortSignal,
        headers?: Record<string, string>,
      ) => {
        seen.push({ search: checkUrl.search, headers });
        return true;
      },
    );
    const ready = await waitForSessionReady(url, 'session-1', {
      checkSessionReady: check,
      delay: async () => {},
      directory: '/home/user/project-b',
    });
    expect(ready).toBe(true);
    expect(seen).toEqual([
      {
        search: '',
        headers: { 'x-opencode-directory': '%2Fhome%2Fuser%2Fproject-b' },
      },
    ]);
  });

  test('sends empty headers when no directory is provided', async () => {
    const { waitForSessionReady } = await importShared();
    const seen: Array<{ search: string; headers?: Record<string, string> }> =
      [];
    const check = mock(
      async (
        checkUrl: URL,
        _sessionId: string,
        _signal: AbortSignal,
        headers?: Record<string, string>,
      ) => {
        seen.push({ search: checkUrl.search, headers });
        return true;
      },
    );
    const ready = await waitForSessionReady(url, 'session-1', {
      checkSessionReady: check,
      delay: async () => {},
    });
    expect(ready).toBe(true);
    expect(seen).toEqual([{ search: '', headers: {} }]);
  });

  test('encodes percent-bearing directories exactly once for the header', async () => {
    const { waitForSessionReady } = await importShared();
    const seen: Array<{ search: string; headers?: Record<string, string> }> =
      [];
    const check = mock(
      async (
        checkUrl: URL,
        _sessionId: string,
        _signal: AbortSignal,
        headers?: Record<string, string>,
      ) => {
        seen.push({ search: checkUrl.search, headers });
        return true;
      },
    );
    const ready = await waitForSessionReady(url, 'session-1', {
      checkSessionReady: check,
      delay: async () => {},
      directory: '/tmp/a%20b',
    });
    expect(ready).toBe(true);
    expect(seen).toEqual([
      {
        search: '',
        headers: { 'x-opencode-directory': '%2Ftmp%2Fa%2520b' },
      },
    ]);
  });

  test('default readiness sends the directory header on its fetch', async () => {
    const { defaultSessionReady } = await importShared();
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: unknown,
      init?: { headers?: Record<string, string> },
    ) => {
      seen.push({ url: String(input), headers: init?.headers });
      return Response.json({ 'session-1': { type: 'busy' } });
    }) as typeof fetch;
    try {
      const ready = await defaultSessionReady(
        new URL('http://127.0.0.1:7777/session/status'),
        'session-1',
        new AbortController().signal,
        { 'x-opencode-directory': '%2Frepo' },
      );
      expect(ready).toBe(true);
      expect(seen).toEqual([
        {
          url: 'http://127.0.0.1:7777/session/status',
          headers: { 'x-opencode-directory': '%2Frepo' },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('buildDirectoryHeaders encodes non-ASCII directories to pure ASCII', async () => {
    const { buildDirectoryHeaders } = await importShared();
    const headers: Record<string, string> = buildDirectoryHeaders('/home/josé');
    expect(headers).toEqual({
      'x-opencode-directory': '%2Fhome%2Fjos%C3%A9',
    });
    expect(
      Object.values(headers).every((value) => /^[\x20-\x7E]*$/.test(value)),
    ).toBe(true);
  });

  test('readiness timeout: returns false without ever succeeding', async () => {
    const { waitForSessionReady } = await importShared();
    const check = mock(async () => false);
    const delays: number[] = [];
    const ready = await waitForSessionReady(url, 'session-1', {
      checkSessionReady: check,
      delay: async (ms) => void delays.push(ms),
    });
    expect(ready).toBe(false);
    // 8 attempts = 7 backoff delays + one final attempt
    expect(check).toHaveBeenCalledTimes(8);
    expect(delays).toEqual([50, 100, 200, 400, 500, 500, 250]);
  });

  test('a throwing probe is treated as not-ready and keeps polling', async () => {
    const { waitForSessionReady } = await importShared();
    let attempt = 0;
    const check = mock(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('network');
      return true;
    });
    const ready = await waitForSessionReady(url, 'session-1', {
      checkSessionReady: check,
      delay: async () => {},
    });
    expect(ready).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  test('a hanging probe is aborted by the per-attempt timeout', async () => {
    const { waitForSessionReady } = await importShared();
    const check = mock(() => new Promise<boolean>(() => {}));
    const ready = await waitForSessionReady(url, 'session-1', {
      checkSessionReady: check,
      delay: async () => {},
      readinessAttemptTimeoutMs: 5,
    });
    expect(ready).toBe(false);
    expect(check).toHaveBeenCalledTimes(8);
  });

  test('absolute deadline bounds the total wait even with hanging probes', async () => {
    const { waitForSessionReady } = await importShared();
    let clock = 0;
    const now = () => clock;
    const check = mock(() => new Promise<boolean>(() => {}));
    const delays: number[] = [];
    const ready = await waitForSessionReady(url, 'session-1', {
      checkSessionReady: check,
      delay: async (ms) => {
        delays.push(ms);
        clock += ms;
      },
      readinessAttemptTimeoutMs: 5,
      readinessDeadlineMs: 500,
      now,
    });
    expect(ready).toBe(false);
    // The deadline, not the 8-attempt schedule, stopped the wait.
    expect(check.mock.calls.length).toBeLessThan(8);
    // Cumulative delay never exceeds the deadline.
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(500);
  });

  test('an abort signal ends the wait promptly with false', async () => {
    const { waitForSessionReady } = await importShared();
    const controller = new AbortController();
    const check = mock(() => new Promise<boolean>(() => {}));
    const readyPromise = waitForSessionReady(url, 'session-1', {
      checkSessionReady: check,
      delay: async () => {},
      readinessAttemptTimeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(readyPromise).resolves.toBe(false);
  });

  test('default probe parses the target status from /session/status', async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = mock(async (input) => {
      requested.push(String(input));
      return Response.json({
        target: { type: 'busy' },
        other: { type: 'idle' },
      });
    }) as typeof fetch;
    try {
      const { waitForSessionReady } = await importShared();
      expect(
        await waitForSessionReady('http://127.0.0.1:7777/base', 'target'),
      ).toBe(true);
      expect(requested).toEqual(['http://127.0.0.1:7777/session/status']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('default probe reports false when the session is absent', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      Response.json({ other: { type: 'idle' } }),
    ) as typeof fetch;
    try {
      const { waitForSessionReady } = await importShared();
      expect(
        await waitForSessionReady('http://127.0.0.1:7777/base', 'missing'),
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
