import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  test('isAlreadyClosed: a failed close counts only when stderr proves the pane is gone', async () => {
    const closeWith = (stderr: string, exitCode = 1) =>
      crossSpawnMock.mockImplementation((args: string[]) => ({
        exited: Promise.resolve(args.includes('kill-pane') ? exitCode : 0),
        stdout: () => Promise.resolve(''),
        stderr: () => Promise.resolve(args.includes('kill-pane') ? stderr : ''),
      }));
    const options = {
      ctrlC: ['cli', 'send-text', '--pane-id', '5', '\u0003'],
      close: ['cli', 'kill-pane', '--pane-id', '5'],
      isAlreadyClosed: (stderr: string) => /no such pane \d+/.test(stderr),
    };
    const { gracefulClosePane } = await importShared();

    closeWith('Error: no such pane 5');
    expect(await gracefulClosePane('wezterm', '5', options)).toBe(true);

    closeWith('Error while decoding response pdu');
    expect(await gracefulClosePane('wezterm', '5', options)).toBe(false);

    closeWith('', 0);
    expect(await gracefulClosePane('wezterm', '5', options)).toBe(true);
  });

  test('isAlreadyClosed takes precedence over acceptExitCode1', async () => {
    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(1),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve('connection reset'),
    }));
    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('wezterm', '5', {
      ctrlC: ['ctrl-c'],
      close: ['kill'],
      acceptExitCode1: true,
      isAlreadyClosed: () => false,
    });
    expect(ok).toBe(false);
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
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      const cmd = buildOpencodeAttachCommand(
        'sess',
        'url',
        '/repo',
        "/Users/King's Tools/opencode",
      );
      expect(cmd).toStartWith("'/Users/King'\\''s Tools/opencode' attach");
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
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

describe('buildOpencodeAttachCommand on Windows pane shells', () => {
  const exe = 'C:\\Users\\foo\\opencode.exe';

  /** Stubs win32 plus a pane shell (unset = herdr default pwsh), returns a restore. */
  function stubWin32Shell(shell: string | undefined): () => void {
    const originalPlatform = process.platform;
    const originalShell = process.env.SHELL;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    if (shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = shell;
    return () => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
    };
  }

  test('pwsh panes get the call operator before the quoted executable', async () => {
    const restore = stubWin32Shell(
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    );
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      expect(
        buildOpencodeAttachCommand('sess', 'http://x', 'C:\\repo', exe),
      ).toBe(
        "& 'C:/Users/foo/opencode.exe' attach 'http://x' --session 'sess' --dir 'C:/repo'",
      );
    } finally {
      restore();
    }
  });

  test('pwsh quoting doubles apostrophes in the executable and arguments', async () => {
    const restore = stubWin32Shell(
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    );
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      expect(
        buildOpencodeAttachCommand(
          'sess',
          'http://x',
          "C:\\King's repo",
          "C:\\Users\\King's Tools\\opencode.exe",
        ),
      ).toBe(
        "& 'C:/Users/King''s Tools/opencode.exe' attach 'http://x' --session 'sess' --dir 'C:/King''s repo'",
      );
    } finally {
      restore();
    }
  });

  test('an explicit paneShell hint overrides $SHELL inference (herdr panes)', async () => {
    const restore = stubWin32Shell('C:\\Program Files\\Git\\bin\\bash.exe');
    try {
      const { buildViewCommand } = await importShared();
      // Git Bash parent ($SHELL) + herdr's own pwsh pane: the hint wins.
      expect(
        buildViewCommand('sess', 'http://x', 'C:\\repo', {
          executable: 'C:\\Users\\foo\\opencode.exe',
          paneShell: 'powershell',
        }),
      ).toStartWith("& 'C:/Users/foo/opencode.exe' attach");
      // Without the hint, $SHELL inference still picks the POSIX form.
      expect(
        buildViewCommand('sess', 'http://x', 'C:\\repo', {
          executable: 'C:\\Users\\foo\\opencode.exe',
        }),
      ).toStartWith("'C:/Users/foo/opencode.exe' attach");
    } finally {
      restore();
    }
  });

  test('Windows PowerShell panes use the call operator too', async () => {
    const restore = stubWin32Shell(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      expect(
        buildOpencodeAttachCommand('sess', 'http://x', 'C:\\repo', exe),
      ).toStartWith("& 'C:/Users/foo/opencode.exe' attach");
    } finally {
      restore();
    }
  });

  test('an unset $SHELL keeps the PowerShell form (herdr default pane shell)', async () => {
    const restore = stubWin32Shell(undefined);
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      expect(
        buildOpencodeAttachCommand('sess', 'http://x', 'C:\\repo', exe),
      ).toStartWith("& 'C:/Users/foo/opencode.exe' attach");
    } finally {
      restore();
    }
  });

  test('cmd panes get a double-quoted executable', async () => {
    const restore = stubWin32Shell('C:\\Windows\\System32\\cmd.exe');
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      expect(
        buildOpencodeAttachCommand('sess', 'http://x', 'C:\\repo', exe),
      ).toStartWith('"C:/Users/foo/opencode.exe" attach');
    } finally {
      restore();
    }
  });

  test('Git Bash panes keep the POSIX single-quoted form', async () => {
    const restore = stubWin32Shell('C:\\Program Files\\Git\\bin\\bash.exe');
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      expect(
        buildOpencodeAttachCommand('sess', 'http://x', 'C:\\repo', exe),
      ).toStartWith("'C:/Users/foo/opencode.exe' attach");
    } finally {
      restore();
    }
  });

  test('non-Windows platforms never emit the call operator', async () => {
    const originalPlatform = process.platform;
    const originalShell = process.env.SHELL;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      const { buildOpencodeAttachCommand } = await importShared();
      expect(
        buildOpencodeAttachCommand('sess', 'http://x', '/repo', '/opt/opencode'),
      ).toStartWith("'/opt/opencode' attach");
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
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

describe('findBinaryLogPrefix', () => {
  test('derives [<binaryName>] for callers without an override', async () => {
    const { findBinaryLogPrefix } = await importShared();

    // tmux/zellij/herdr/kitty pass no override, so their `findBinary` log
    // lines stay byte-identical.
    expect(findBinaryLogPrefix('tmux')).toBe('[tmux]');
    expect(findBinaryLogPrefix('zellij')).toBe('[zellij]');
    expect(findBinaryLogPrefix('herdr')).toBe('[herdr]');
    expect(findBinaryLogPrefix('kitten')).toBe('[kitten]');
    expect(findBinaryLogPrefix('kitty')).toBe('[kitty]');
  });

  test('honors the cmux adapter override for both probes', async () => {
    const { findBinaryLogPrefix } = await importShared();

    // The legacy `cmux` fallback must log under `[cmux-tui]`, never `[cmux]`.
    expect(findBinaryLogPrefix('cmux-tui', 'cmux-tui')).toBe('[cmux-tui]');
    expect(findBinaryLogPrefix('cmux', 'cmux-tui')).toBe('[cmux-tui]');
  });
});

describe('buildViewCommand', () => {
  test('defaults to the resolved absolute host executable (#514)', async () => {
    const { buildViewCommand } = await importShared();
    const dir = mkdtempSync(join(tmpdir(), 'omos-514-'));
    const bin = join(dir, 'opencode');
    writeFileSync(bin, '');
    const original = process.env.OPENCODE_BIN;
    process.env.OPENCODE_BIN = bin;
    try {
      const cmd = buildViewCommand('sess', 'http://x', '/repo');
      expect(cmd).toStartWith(`'${bin}' attach`);
    } finally {
      if (original === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to bare opencode when no binary resolves (#514)', async () => {
    const { buildViewCommand } = await importShared();
    const original = process.env.OPENCODE_BIN;
    delete process.env.OPENCODE_BIN;
    try {
      // bun's execPath/argv0 never match the opencode basename gate, so with
      // OPENCODE_BIN unset the resolver yields null and the bare name wins.
      expect(buildViewCommand('sess', 'http://x', '/repo')).toStartWith(
        'opencode attach',
      );
    } finally {
      if (original === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = original;
    }
  });

  test('v1 flavor is byte-identical to the legacy attach command', async () => {
    const { buildOpencodeAttachCommand, buildViewCommand } =
      await importShared();
    const legacy = buildOpencodeAttachCommand(
      'sess',
      'http://x',
      '/repo',
      'opencode',
    );
    expect(
      buildViewCommand('sess', 'http://x', '/repo', { executable: 'opencode' }),
    ).toBe(legacy);
  });

  test('v2-shared omits URL and secret (the viewer discovers the service)', async () => {
    const { buildViewCommand } = await importShared();
    expect(
      buildViewCommand('ses_abc', 'http://unused', '/repo', {
        executable: 'opencode',
        viewerFlavor: 'v2-shared',
      }),
    ).toBe("opencode --session 'ses_abc' '/repo'");
  });

  test('v2-remote carries server URL, session and directory — never the secret', async () => {
    const { buildViewCommand } = await importShared();
    expect(
      buildViewCommand('ses_abc', 'http://192.168.5.212:8192', '/repo', {
        executable: 'opencode',
        viewerFlavor: 'v2-remote',
      }),
    ).toBe(
      "opencode --server 'http://192.168.5.212:8192' --session 'ses_abc' '/repo'",
    );
  });

  test('v2-remote ignores a stray password option (no secret in command text)', async () => {
    const { buildViewCommand } = await importShared();
    const options = {
      executable: 'opencode' as const,
      viewerFlavor: 'v2-remote' as const,
      viewerPassword: 'pw-123',
    };
    const cmd = buildViewCommand('ses_abc', 'http://x', '/repo', options);
    expect(cmd).toBe(
      "opencode --server 'http://x' --session 'ses_abc' '/repo'",
    );
    expect(cmd).not.toContain('pw-123');
    expect(cmd).not.toContain('OPENCODE_PASSWORD');
  });

  test('viewer "mini" targets the mini interface for every flavor', async () => {
    const { buildViewCommand } = await importShared();
    expect(
      buildViewCommand('sess', 'http://x', '/repo', {
        executable: 'opencode',
        viewerFlavor: 'v1',
        viewerSurface: 'mini',
      }),
    ).toBe("opencode attach 'http://x' --session 'sess' --dir '/repo' --mini");
    expect(
      buildViewCommand('ses_abc', 'http://unused', '/repo', {
        executable: 'opencode',
        viewerFlavor: 'v2-shared',
        viewerSurface: 'mini',
      }),
    ).toBe("opencode mini --session 'ses_abc'");
    expect(
      buildViewCommand('ses_abc', 'http://192.168.5.212:8192', '/repo', {
        executable: 'opencode',
        viewerFlavor: 'v2-remote',
        viewerSurface: 'mini',
      }),
    ).toBe(
      "opencode mini --server 'http://192.168.5.212:8192' --session 'ses_abc'",
    );
  });

  test('v2 flavors quote directories, session ids and executables', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      const { buildViewCommand } = await importShared();
      expect(
        buildViewCommand("s'es s", 'http://x', "/tmp/a b's", {
          viewerFlavor: 'v2-shared',
          executable: "/opt/King's/opencode",
        }),
      ).toBe(
        "'/opt/King'\\''s/opencode' --session 's'\\''es s' '/tmp/a b'\\''s'",
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
  });

  test('v2-remote normalizes Windows backslash paths', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      const { buildViewCommand } = await importShared();
      const cmd = buildViewCommand('ses', 'http://x', 'C:\\Users\\foo\\repo', {
        viewerFlavor: 'v2-remote',
      });
      expect(cmd).toContain('C:/Users/foo/repo');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
  });

  test('normalizes Windows executable backslashes in both builders (Git Bash pane)', async () => {
    const original = process.platform;
    const originalShell = process.env.SHELL;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    process.env.SHELL = 'C:\\Program Files\\Git\\bin\\bash.exe';
    try {
      const { buildOpencodeAttachCommand, buildViewCommand } =
        await importShared();
      const exe = 'C:\\Users\\foo\\opencode.exe';
      expect(
        buildOpencodeAttachCommand(
          'sess',
          'http://x',
          'C:\\Users\\foo\\repo',
          exe,
        ),
      ).toStartWith("'C:/Users/foo/opencode.exe' attach");
      const cmd = buildViewCommand('ses', 'http://x', 'C:\\Users\\foo\\repo', {
        viewerFlavor: 'v2-remote',
        executable: exe,
      });
      expect(cmd).toStartWith("'C:/Users/foo/opencode.exe' --server");
      expect(cmd).toContain('C:/Users/foo/repo');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
    }
  });
});

describe('isPosixShell', () => {
  test('accepts POSIX-family shells by basename', async () => {
    const { isPosixShell } = await importShared();
    for (const shell of [
      '/bin/sh',
      '/bin/bash',
      '/usr/bin/zsh',
      '/usr/bin/dash',
      '/usr/bin/ksh',
      'bash',
    ]) {
      expect(isPosixShell(shell)).toBe(true);
    }
  });

  test('rejects non-POSIX and unknown shells (fail closed)', async () => {
    const { isPosixShell } = await importShared();
    for (const shell of [
      '/usr/bin/fish',
      '/usr/bin/nu',
      '/usr/bin/pwsh',
      '/usr/bin/powershell',
      'C:\\Windows\\System32\\cmd.exe',
      '/usr/bin/elvish',
      '/usr/bin/xonsh',
      '',
    ]) {
      expect(isPosixShell(shell)).toBe(false);
    }
  });
});

describe('withParentEnvPassword', () => {
  test('reads OPENCODE_PASSWORD first and falls back to OPENCODE_SERVER_PASSWORD', async () => {
    const { withParentEnvPassword } = await importShared();
    const script = withParentEnvPassword('opencode --server u');

    expect(script).toContain(`/proc/${process.pid}/environ`);
    expect(script).toContain('s/^OPENCODE_PASSWORD=//p');
    expect(script).toContain('s/^OPENCODE_SERVER_PASSWORD=//p');
    // Precedence: the primary probe runs before the fallback probe.
    const primary = script.indexOf('OPENCODE_PASSWORD=');
    const fallback = script.indexOf('OPENCODE_SERVER_PASSWORD=');
    expect(primary).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(primary);
    expect(script).toContain('export OPENCODE_PASSWORD');
    expect(script).toContain('unset _omo_pw');
    // The wrapper takes no secret argument, so no secret can be embedded,
    // and the original command is the last line.
    expect(script).not.toContain('pw-');
    expect(script.endsWith('\nopencode --server u')).toBe(true);
  });

  test('exports the primary value read from the parent environ', async () => {
    await expectExtractedPassword(
      'PATH=/usr/bin\0OPENCODE_PASSWORD=from-primary\0OPENCODE_SERVER_PASSWORD=from-fallback\0',
      'from-primary',
    );
  });

  test('falls back to OPENCODE_SERVER_PASSWORD when the primary is absent', async () => {
    await expectExtractedPassword(
      'PATH=/usr/bin\0OPENCODE_SERVER_PASSWORD=from-fallback\0',
      'from-fallback',
    );
  });

  test('runs the command with an empty value when neither is present', async () => {
    await expectExtractedPassword('PATH=/usr/bin\0', '');
  });

  test('v1 attach viewers get only OPENCODE_SERVER_PASSWORD', async () => {
    const { withParentEnvPassword } = await importShared();
    const script = withParentEnvPassword(
      'opencode attach u',
      'OPENCODE_SERVER_PASSWORD',
    );
    expect(script).toContain('export OPENCODE_SERVER_PASSWORD="$_omo_pw"');
    expect(script).not.toContain('export OPENCODE_PASSWORD');
    // A stray v2 OPENCODE_PASSWORD must not be consulted for a v1 viewer.
    expect(script).not.toContain('s/^OPENCODE_PASSWORD=//p');
    expect(script.endsWith('\nopencode attach u')).toBe(true);
  });

  test('v1 export ignores OPENCODE_PASSWORD in the parent environ', async () => {
    const { withParentEnvPassword } = await importShared();
    const dir = `/tmp/opencode/omo-shared-v1-test-${process.pid}`;
    mkdirSync(dir, { recursive: true });
    const environPath = `${dir}/environ`;
    writeFileSync(
      environPath,
      'OPENCODE_PASSWORD=v2-value\0OPENCODE_SERVER_PASSWORD=v1-value\0',
    );
    try {
      const script = withParentEnvPassword(
        'printf %s "$OPENCODE_SERVER_PASSWORD"',
        'OPENCODE_SERVER_PASSWORD',
      ).replaceAll(`/proc/${process.pid}/environ`, environPath);
      const proc = Bun.spawn(['/bin/sh', '-c', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      });
      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stdout).text()).toBe('v1-value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('runs the wrapped command in a POSIX shell', async () => {
    const { withParentEnvPassword } = await importShared();
    const script = withParentEnvPassword('printf ok');
    const proc = Bun.spawn(['/bin/sh', '-c', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe('ok');
  });
});

/**
 * Executes the generated wrapper against a fake `/proc/<pid>/environ` file
 * (only the path is substituted) and returns the value the wrapped command
 * observes as `OPENCODE_PASSWORD`.
 */
async function expectExtractedPassword(
  environContents: string,
  expected: string,
): Promise<void> {
  const { withParentEnvPassword } = await importShared();
  const dir = `/tmp/opencode/omo-shared-test-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  const environPath = `${dir}/environ`;
  writeFileSync(environPath, environContents);
  try {
    const script = withParentEnvPassword(
      'printf %s "$OPENCODE_PASSWORD"',
    ).replaceAll(`/proc/${process.pid}/environ`, environPath);
    // Clean env: a password exported in the test runner's own environment
    // must not satisfy the "neither is present" case.
    const proc = Bun.spawn(['/bin/sh', '-c', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('redactViewerSecretArgs', () => {
  test('masks viewer-secret env entries in spawn argv', async () => {
    const { redactViewerSecretArgs } = await importShared();
    expect(
      redactViewerSecretArgs([
        '-e',
        'OPENCODE_PASSWORD=hunter2',
        '--env',
        'OPENCODE_SERVER_PASSWORD=hunter3',
      ]),
    ).toEqual([
      '-e',
      'OPENCODE_PASSWORD=<redacted>',
      '--env',
      'OPENCODE_SERVER_PASSWORD=<redacted>',
    ]);
  });

  test('leaves unrelated entries and viewer commands untouched', async () => {
    const { redactViewerSecretArgs } = await importShared();
    expect(
      redactViewerSecretArgs([
        'env',
        'OPENCODE_DISABLE_TERMINAL_TITLE=1',
        'opencode --server http://127.0.0.1:1 --session ses_x /tmp/a b',
        'OPENCODE_PASSWORDX=keep',
      ]),
    ).toEqual([
      'env',
      'OPENCODE_DISABLE_TERMINAL_TITLE=1',
      'opencode --server http://127.0.0.1:1 --session ses_x /tmp/a b',
      'OPENCODE_PASSWORDX=keep',
    ]);
  });
});
