import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MultiplexerLayout } from '../../config/schema';
import type { CmuxEnvironment, CommandResult, CommandRunner } from './index';

type CmuxModule = typeof import('./index');

const logMock = mock(() => {});

mock.module('../../utils/logger', () => ({
  log: logMock,
}));

let importCounter = 0;

async function importCmux(): Promise<CmuxModule> {
  return import(`./index?test=${importCounter++}`);
}

const { CliCmuxClient, CmuxMultiplexer, SpawnCommandRunner } =
  await importCmux();

const BASE_ENV: CmuxEnvironment = {
  CMUX_TUI_SOCKET: '/tmp/cmux-tui.sock',
  CMUX_TUI_TERMINAL_ID: 'term_anchor',
};

const SOCKET_ARGS = ['--socket', '/tmp/cmux-tui.sock', '--json'];

const ATTACH_COMMAND =
  "'/opt/opencode' attach 'http://127.0.0.1:7777' " +
  "--session 'child-1' --dir '/repo'";

const SHELL_ARGS = [
  '/bin/bash',
  '-l',
  '-c',
  `shopt -s expand_aliases\n[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true\n${ATTACH_COMMAND}`,
];

function json(value: unknown): CommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
}

function defaultResponse(argv: string[]): CommandResult {
  if (argv.includes('ping')) return json({ alive: true });
  if (argv.includes('terminal')) {
    return json({ id: 'term_anchor', tab_id: 'tab_anchor', tab_ids: [] });
  }
  if (argv.includes('tab')) {
    return json({ id: 'tab_anchor', pane_id: 'pane_anchor' });
  }
  if (argv.includes('split')) return json({ value: { pane_id: 'pane_new' } });
  return json({ value: {} });
}

function recorder(
  handler: (argv: string[]) => CommandResult = defaultResponse,
) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run: mock(async (argv: string[]) => {
      calls.push(argv);
      return handler(argv);
    }),
  };
  return { runner, calls };
}

function mux(
  options: {
    runner?: CommandRunner;
    env?: CmuxEnvironment;
    layout?: MultiplexerLayout;
    sessionName?: string;
  } = {},
): CmuxMultiplexer {
  return new CmuxMultiplexer(options.layout ?? 'main-vertical', 60, {
    client: new CliCmuxClient(options.runner ?? recorder().runner, '/bin/cmux'),
    env: options.env ?? BASE_ENV,
    sessionName: options.sessionName,
    opencodeBinary: '/opt/opencode',
  });
}

function loggedText(): string {
  return logMock.mock.calls
    .map((call: unknown[]) => JSON.stringify(call))
    .join('\n');
}

describe('CmuxMultiplexer', () => {
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    process.env.SHELL = '/bin/bash';
    logMock.mockClear();
  });

  afterEach(() => {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  });

  test('sends the exact two-hop, split, rename, run and close argv contract', async () => {
    const { runner, calls } = recorder();
    const instance = mux({ runner });

    expect(
      await instance.spawnPane(
        'child-1',
        'child-1',
        'http://127.0.0.1:7777',
        '/repo',
      ),
    ).toEqual({ success: true, paneId: 'pane_new' });

    expect(calls).toEqual([
      ['/bin/cmux', ...SOCKET_ARGS, 'session', 'current', 'ping'],
      ['/bin/cmux', ...SOCKET_ARGS, 'terminal', 'term_anchor', 'show'],
      ['/bin/cmux', ...SOCKET_ARGS, 'tab', 'tab_anchor', 'show'],
      ['/bin/cmux', ...SOCKET_ARGS, 'pane', 'pane_anchor', 'split', '--right'],
      [
        '/bin/cmux',
        ...SOCKET_ARGS,
        'pane',
        'pane_new',
        'rename',
        '--name',
        'child-1',
      ],
      [
        '/bin/cmux',
        ...SOCKET_ARGS,
        'pane',
        'pane_new',
        'run',
        '--on-exit',
        'keep',
        '--',
        ...SHELL_ARGS,
      ],
    ]);

    expect(await instance.closePane('pane_new')).toBe(true);
    expect(calls[6]).toEqual([
      '/bin/cmux',
      ...SOCKET_ARGS,
      'pane',
      'pane_new',
      'close',
    ]);

    // Availability is a protocol read, never `--version`.
    expect(calls.some((argv) => argv.includes('--version'))).toBe(false);
  });

  test('falls back to the first tab_ids entry when tab_id is absent', async () => {
    const { runner, calls } = recorder((argv) =>
      argv.includes('terminal')
        ? json({ id: 'term_anchor', tab_ids: ['tab_from_list', 'tab_other'] })
        : defaultResponse(argv),
    );
    const instance = mux({ runner });

    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual(expect.objectContaining({ success: true }));
    expect(calls[2]).toEqual([
      '/bin/cmux',
      ...SOCKET_ARGS,
      'tab',
      'tab_from_list',
      'show',
    ]);
  });

  const layoutCases: Array<[MultiplexerLayout, string]> = [
    ['main-vertical', '--right'],
    ['main-horizontal', '--down'],
    ['even-horizontal', '--right'],
    ['even-vertical', '--down'],
    ['tiled', '--right'],
  ];

  for (const [layout, flag] of layoutCases) {
    test(`maps ${layout} to split ${flag}`, async () => {
      const { runner, calls } = recorder();
      await mux({ runner, layout }).spawnPane(
        'child',
        'child',
        'http://server',
        '/repo',
      );
      const split = calls.find((argv) => argv.includes('split'));
      expect(split?.at(-1)).toBe(flag);
    });
  }

  test('applyLayout updates the direction of the next spawn', async () => {
    const { runner, calls } = recorder();
    const instance = mux({ runner, layout: 'main-vertical' });

    await instance.applyLayout('even-vertical', 60);
    await instance.spawnPane('child', 'child', 'http://server', '/repo');

    const split = calls.find((argv) => argv.includes('split'));
    expect(split?.at(-1)).toBe('--down');
  });

  test('prefers CMUX_TUI_SOCKET over the legacy CMUX_MUX_SOCKET', async () => {
    const { runner, calls } = recorder();
    const instance = mux({
      runner,
      env: {
        CMUX_TUI_SOCKET: '/tmp/tui.sock',
        CMUX_MUX_SOCKET: '/tmp/legacy.sock',
        CMUX_TUI_TERMINAL_ID: 'term_anchor',
      },
    });

    await instance.spawnPane('child', 'child', 'http://server', '/repo');
    expect(calls[0]?.slice(0, 4)).toEqual([
      '/bin/cmux',
      '--socket',
      '/tmp/tui.sock',
      '--json',
    ]);
  });

  test('uses the legacy socket when the TUI socket is absent', async () => {
    const { runner, calls } = recorder();
    const instance = mux({
      runner,
      env: {
        CMUX_MUX_SOCKET: '/tmp/legacy.sock',
        CMUX_TUI_TERMINAL_ID: 'term_anchor',
      },
    });

    await instance.spawnPane('child', 'child', 'http://server', '/repo');
    expect(calls[0]?.slice(0, 4)).toEqual([
      '/bin/cmux',
      '--socket',
      '/tmp/legacy.sock',
      '--json',
    ]);
  });

  test('uses --session addressing when only a session name exists', async () => {
    const { runner, calls } = recorder();
    const instance = mux({
      runner,
      env: {
        CMUX_TUI_SESSION: 'probe',
        CMUX_TUI_TERMINAL_ID: 'term_anchor',
      },
    });

    await instance.spawnPane('child', 'child', 'http://server', '/repo');
    expect(calls[0]?.slice(0, 4)).toEqual([
      '/bin/cmux',
      '--session',
      'probe',
      '--json',
    ]);
  });

  test('returns not_found without commands when no socket is detected', async () => {
    const { runner, calls } = recorder();
    const instance = mux({
      runner,
      env: { CMUX_TUI_TERMINAL_ID: 'term_anchor' },
    });

    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'not_found' });
    expect(calls).toEqual([]);
  });

  test('returns not_found without commands when the terminal anchor is missing', async () => {
    const { runner, calls } = recorder();
    const instance = mux({
      runner,
      env: { CMUX_TUI_SOCKET: '/tmp/cmux-tui.sock' },
    });

    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'not_found' });
    expect(calls).toEqual([]);
  });

  test('rejects an old-generation command surface with a distinguishable diagnostic', async () => {
    const { runner, calls } = recorder(() => ({
      exitCode: 2,
      stdout: '',
      stderr: 'cmux: unknown resource scope "session".',
    }));
    const instance = mux({ runner });

    expect(await instance.isAvailable()).toBe(false);
    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'unavailable' });

    // Only the protocol self-check ran; no mutation reached the old binary.
    expect(calls.length).toBe(2);
    expect(calls.every((argv) => argv.includes('ping'))).toBe(true);
    expect(loggedText()).toContain('old-generation');
  });

  test('distinguishes a failed read self-check from an old-generation binary', async () => {
    const { runner } = recorder(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'cannot connect to session socket /run/x.sock: No such file',
    }));
    const instance = mux({ runner });

    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'unavailable' });
    expect(loggedText()).toContain('read-selfcheck-failed');
    expect(loggedText()).not.toContain('old-generation');
  });

  test('classifies selector.not_found from split as not_found and stops before run', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('split')) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: JSON.stringify({
            code: 'selector.not_found',
            details: { scope: 'pane', selector: 'pane_anchor' },
            message: 'no pane matches "pane_anchor"',
            retryable: false,
          }),
        };
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'not_found' });
    expect(calls.some((argv) => argv.includes('run'))).toBe(false);
    expect(calls.some((argv) => argv.includes('close'))).toBe(false);
  });

  test('treats a close selector.not_found as already closed', async () => {
    const { runner } = recorder(() => ({
      exitCode: 1,
      stdout: '',
      stderr: JSON.stringify({
        code: 'selector.not_found',
        details: { scope: 'pane', selector: 'pane_gone' },
        message: 'no pane matches "pane_gone"',
        retryable: false,
      }),
    }));
    const instance = mux({ runner });

    expect(await instance.closePane('pane_gone')).toBe(true);
  });

  test('returns false when close fails for another reason', async () => {
    const { runner } = recorder(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'operation.failed',
    }));
    const instance = mux({ runner });

    expect(await instance.closePane('pane_x')).toBe(false);
  });

  test('runs no command for close without a control-plane target', async () => {
    const { runner, calls } = recorder();
    const instance = mux({ runner, env: {} });

    expect(await instance.closePane('pane_x')).toBe(false);
    expect(await instance.closePane('')).toBe(false);
    expect(calls).toEqual([]);
  });

  test('closes the created pane when the attach run fails', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('run')) {
        return { exitCode: 1, stdout: '', stderr: 'operation.failed' };
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'hard' });
    expect(calls.at(-1)).toEqual([
      '/bin/cmux',
      ...SOCKET_ARGS,
      'pane',
      'pane_new',
      'close',
    ]);
  });

  test('detects a cmux session from either socket or a session name', () => {
    expect(
      mux({ env: { CMUX_TUI_SOCKET: '/tmp/a.sock' } }).isInsideSession(),
    ).toBe(true);
    expect(
      mux({ env: { CMUX_MUX_SOCKET: '/tmp/a.sock' } }).isInsideSession(),
    ).toBe(true);
    expect(mux({ env: {}, sessionName: 'probe' }).isInsideSession()).toBe(true);
    expect(mux({ env: {} }).isInsideSession()).toBe(false);
  });

  test('listPanesWithTitles maps cmux pane names', async () => {
    const { runner } = recorder(() =>
      json([
        { id: 'pane_1', name: 'user-shell' },
        { id: 'pane_2', name: 'omosc:123:ses_abc' },
      ]),
    );
    const instance = mux({ runner });

    expect(await instance.listPanesWithTitles()).toEqual([
      { paneId: 'pane_1', title: 'user-shell' },
      { paneId: 'pane_2', title: 'omosc:123:ses_abc' },
    ]);
  });

  test('sweep closes only the dead-owner terminal pane (FR-8)', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('list')) {
        return json([
          { id: 'pane_1', name: 'user-shell' },
          { id: 'pane_2', name: 'omosc:999:ses_gone' },
          { id: 'pane_3', name: 'omosc:4242:ses_gone' },
          { id: 'pane_4', name: 'omosc:999:ses_alive' },
        ]);
      }
      return json({ value: {} });
    });
    const instance = mux({ runner });
    const { sweepLeftoverPanes } = await import('../client/sweep');

    const stats = await sweepLeftoverPanes({
      adapter: instance,
      isProcessAlive: (pid) => pid !== 999,
      isSessionTerminal: async (child) => child === 'ses_gone',
    });

    expect(stats.closed).toBe(1);
    const close = calls.find((argv) => argv.includes('close'));
    expect(close).toEqual([
      '/bin/cmux',
      ...SOCKET_ARGS,
      'pane',
      'pane_2',
      'close',
    ]);
  });
});

describe('CliCmuxClient', () => {
  const target = { socketPath: '/tmp/cmux.sock' };

  test('requires a live protocol read for the self-check', async () => {
    const { runner } = recorder(() => json({ alive: true }));
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.selfCheck(target)).toEqual({ ok: true, value: true });
  });

  test('reports old-generation binaries distinctly', async () => {
    const { runner } = recorder(() => ({
      exitCode: 2,
      stdout: '',
      stderr: 'cmux: unknown resource scope "session".',
    }));
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.selfCheck(target)).toEqual({
      ok: false,
      error: 'unavailable',
      reason: 'old-generation',
    });
  });

  test('reports a failed protocol read as read-selfcheck-failed', async () => {
    const { runner } = recorder(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'connection refused',
    }));
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.selfCheck(target)).toEqual({
      ok: false,
      error: 'unavailable',
      reason: 'read-selfcheck-failed',
    });
  });

  test('rejects a ping payload that is not alive', async () => {
    const { runner } = recorder(() => json({ alive: false }));
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.selfCheck(target)).toEqual({
      ok: false,
      error: 'unavailable',
      reason: 'read-selfcheck-failed',
    });
  });

  test('resolves the two-hop anchor', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('terminal')) {
        return json({ id: 'term_1', tab_id: 'tab_1', tab_ids: ['tab_1'] });
      }
      if (argv.includes('tab')) {
        return json({ id: 'tab_1', pane_id: 'pane_1' });
      }
      return json({});
    });
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.resolveAnchor(target, 'term_1')).toEqual({
      ok: true,
      value: { tabId: 'tab_1', paneId: 'pane_1' },
    });
    expect(calls[0]).toEqual([
      '/bin/cmux',
      '--socket',
      '/tmp/cmux.sock',
      '--json',
      'terminal',
      'term_1',
      'show',
    ]);
    expect(calls[1]).toEqual([
      '/bin/cmux',
      '--socket',
      '/tmp/cmux.sock',
      '--json',
      'tab',
      'tab_1',
      'show',
    ]);
  });

  test('classifies an unparseable anchor response as hard', async () => {
    const { runner } = recorder((argv) =>
      argv.includes('terminal') ? json({ id: 'term_1' }) : json({}),
    );
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.resolveAnchor(target, 'term_1')).toEqual({
      ok: false,
      error: 'hard',
      reason: 'invalid-response',
    });
  });

  test('parses the created pane id from the split envelope', async () => {
    const { runner } = recorder(() => json({ value: { pane_id: 'pane_9' } }));
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.split(target, 'pane_anchor', 'down')).toEqual({
      ok: true,
      value: 'pane_9',
    });
  });

  test('renames a pane with the FR-8 metadata name', async () => {
    const { runner, calls } = recorder(() => json({ value: {} }));
    const client = new CliCmuxClient(runner, '/bin/cmux');
    const encoded = 'omosc:4242:ses_f41e46f05ffeoEESP7f24NJ9d6';

    expect(await client.rename(target, 'pane_9', encoded)).toEqual({
      ok: true,
      value: true,
    });
    expect(calls[0]).toEqual([
      '/bin/cmux',
      '--socket',
      '/tmp/cmux.sock',
      '--json',
      'pane',
      'pane_9',
      'rename',
      '--name',
      encoded,
    ]);
  });

  test('lists pane ids and names from pane list', async () => {
    const { runner } = recorder(() =>
      json([
        { id: 'pane_1', name: null },
        { id: 'pane_2', name: 'omosc:123:ses_abc' },
      ]),
    );
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.listPanes(target)).toEqual({
      ok: true,
      value: [
        { paneId: 'pane_1', name: '' },
        { paneId: 'pane_2', name: 'omosc:123:ses_abc' },
      ],
    });
  });

  test('bounds a hanging spawned command', async () => {
    const kill = mock(() => true);
    const runner = new SpawnCommandRunner(5, (() => ({
      exited: new Promise<number>(() => {}),
      stdout: async () => '',
      stderr: async () => '',
      kill,
    })) as never);

    const result = await runner.run(['/bin/cmux', '--version']);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('unavailable');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });
});
