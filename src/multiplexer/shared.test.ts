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
