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

const {
  CliCmuxClient,
  CmuxMultiplexer,
  SpawnCommandRunner,
  commandCarriesArgv,
  extractArgvMarker,
} = await importCmux();

const CHILD_ID = 'ses_f41e46f05ffeoEESP7f24NJ9GdEx6';
const CHILD_TOKEN = 'GdEx6';
const DESCRIPTION = `omosc:4242:${CHILD_ID}`;
const MARKER = `# ${DESCRIPTION}\n`;
const ATTACH_COMMAND =
  "'/opt/opencode' attach 'http://127.0.0.1:7777' " +
  `--session '${CHILD_ID}' --dir '/repo'`;
const BASH_PREAMBLE =
  'shopt -s expand_aliases\n' +
  '[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true\n';
const SHELL_ARGS = [
  '/bin/bash',
  '-l',
  '-c',
  `${BASH_PREAMBLE}${MARKER}${ATTACH_COMMAND}`,
];

const BASE_ENV: CmuxEnvironment = {
  CMUX_TUI_SOCKET: '/tmp/cmux-tui.sock',
  CMUX_TUI_TERMINAL_ID: 'term_anchor',
};

const SOCKET_ARGS = ['--socket', '/tmp/cmux-tui.sock', '--json'];

/** Full argv for one cmux invocation (binary + control plane + args). */
function cmux(args: string[]): string[] {
  return ['/bin/cmux', ...SOCKET_ARGS, ...args];
}

function json(value: unknown): CommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
}

function defaultResponse(argv: string[]): CommandResult {
  if (argv.includes('ping')) return json({ alive: true });
  if (argv.includes('process')) return json({ argv: [] });
  if (argv.includes('list') && argv.includes('terminal')) return json([]);
  if (argv.includes('list') && argv.includes('tab')) return json([]);
  if (argv.includes('terminal')) {
    return json({ id: 'term_anchor', tab_id: 'tab_anchor', tab_ids: [] });
  }
  if (argv.includes('tab') && argv.includes('show')) {
    return json({
      id: 'tab_anchor',
      pane_id: 'pane_anchor',
      focused: true,
      name: 'my-tab',
    });
  }
  if (argv.includes('run')) {
    return json({ value: { tab_id: 'tab_child', terminal_id: 'term_child' } });
  }
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

/** The `--name` value of the last `pane run` call recorded so far. */
function lastName(calls: string[][]): string {
  const run = calls.filter((argv) => argv.includes('run')).at(-1) ?? [];
  const index = run.indexOf('--name');
  return index === -1 ? '' : (run[index + 1] ?? '');
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

  test('spawns a named sibling tab in the parent pane and restores the active tab', async () => {
    const { runner, calls } = recorder();
    const instance = mux({ runner });

    expect(
      await instance.spawnPane(
        CHILD_ID,
        DESCRIPTION,
        'http://127.0.0.1:7777',
        '/repo',
        { subagentType: 'oracle' },
      ),
    ).toEqual({ success: true, paneId: 'term_child' });

    expect(calls).toEqual([
      cmux(['session', 'current', 'ping']),
      cmux(['terminal', 'term_anchor', 'show']),
      cmux(['tab', 'tab_anchor', 'show']),
      cmux([
        'pane',
        'pane_anchor',
        'run',
        '--on-exit',
        'keep',
        '--name',
        `my-tab/oracle:${CHILD_TOKEN}`,
        '--',
        ...SHELL_ARGS,
      ]),
      cmux(['tab', 'tab_anchor', 'focus']),
    ]);

    // 1.2: `--name` precedes the argv separator and keeps its `:` verbatim.
    const run = calls[3] ?? [];
    const nameIndex = run.indexOf('--name');
    expect(nameIndex).toBeGreaterThan(-1);
    expect(run[nameIndex + 1]).toBe(`my-tab/oracle:${CHILD_TOKEN}`);
    expect(nameIndex).toBeLessThan(run.indexOf('--'));

    // 3.6: the display name never carries FR-8 sweep metadata.
    expect(run[nameIndex + 1]).not.toContain('omosc:');

    // 4.6: no `terminal.project`; 1.1: no split/move/rename anywhere.
    expect(
      calls.some((argv) =>
        argv.some((arg) => /^(split|move|rename|project)$/.test(arg)),
      ),
    ).toBe(false);

    expect(await instance.closePane('term_child')).toBe(true);
    expect(calls[5]).toEqual(cmux(['terminal', 'term_child', 'close']));
  });

  test('keeps the child view when the focus restore fails (diagnostic only)', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('focus')) {
        return { exitCode: 1, stdout: '', stderr: 'operation.failed' };
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    expect(
      await instance.spawnPane(
        CHILD_ID,
        DESCRIPTION,
        'http://127.0.0.1:7777',
        '/repo',
        { subagentType: 'oracle' },
      ),
    ).toEqual({ success: true, paneId: 'term_child' });
    expect(calls.at(-1)).toEqual(cmux(['tab', 'tab_anchor', 'focus']));

    const failures = logMock.mock.calls.filter((call) =>
      JSON.stringify(call).includes('focus restore failed'),
    );
    expect(failures).toHaveLength(1);
  });

  test('neutralizes line breaks in the argv marker description', async () => {
    const { runner, calls } = recorder();
    const instance = mux({ runner });
    const description = `omosc:4242:${CHILD_ID}\necho pwned`;

    expect(
      await instance.spawnPane(
        CHILD_ID,
        description,
        'http://127.0.0.1:7777',
        '/repo',
      ),
    ).toEqual(expect.objectContaining({ success: true }));

    const run = calls.find((argv) => argv.includes('run')) ?? [];
    const script = run.at(-1) ?? '';
    // The injected text stays inside the single comment line.
    expect(script).not.toContain('\necho pwned');
    const markerLines = script
      .split('\n')
      .filter((line) => line.startsWith('# '));
    expect(markerLines).toHaveLength(1);
    expect(markerLines[0]).toContain('echo pwned');
  });

  test('restores the pre-spawn active sibling tab when the parent tab was not focused', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('tab') && argv.includes('show')) {
        return json({
          id: 'tab_anchor',
          pane_id: 'pane_anchor',
          focused: false,
          name: 'my-tab',
        });
      }
      if (argv.includes('tab') && argv.includes('list')) {
        return json([
          {
            id: 'tab_anchor',
            pane_id: 'pane_anchor',
            index: 0,
            focused: false,
            name: 'my-tab',
          },
          {
            id: 'tab_sibling',
            pane_id: 'pane_anchor',
            index: 1,
            focused: true,
            name: 'logs',
          },
          {
            id: 'tab_other_pane',
            pane_id: 'pane_other',
            index: 0,
            focused: false,
            name: 'x',
          },
        ]);
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    expect(
      await instance.spawnPane(
        CHILD_ID,
        DESCRIPTION,
        'http://127.0.0.1:7777',
        '/repo',
        { subagentType: 'oracle' },
      ),
    ).toEqual({ success: true, paneId: 'term_child' });

    expect(calls.map((argv) => argv.slice(4))).toEqual([
      ['session', 'current', 'ping'],
      ['terminal', 'term_anchor', 'show'],
      ['tab', 'tab_anchor', 'show'],
      ['tab', 'list'],
      [
        'pane',
        'pane_anchor',
        'run',
        '--on-exit',
        'keep',
        '--name',
        `my-tab/oracle:${CHILD_TOKEN}`,
        '--',
        ...SHELL_ARGS,
      ],
      ['tab', 'tab_sibling', 'focus'],
    ]);
  });

  test('falls back to the parent tab when no focused sibling can be read', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('tab') && argv.includes('show')) {
        return json({
          id: 'tab_anchor',
          pane_id: 'pane_anchor',
          focused: false,
          name: 'my-tab',
        });
      }
      if (argv.includes('tab') && argv.includes('list')) {
        return json([
          {
            id: 'tab_anchor',
            pane_id: 'pane_anchor',
            index: 0,
            focused: false,
            name: 'my-tab',
          },
        ]);
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    expect(
      await instance.spawnPane(CHILD_ID, DESCRIPTION, 'http://server', '/repo'),
    ).toEqual(expect.objectContaining({ success: true }));
    expect(calls.at(-1)).toEqual(cmux(['tab', 'tab_anchor', 'focus']));
  });

  test('keeps a degraded name and restores the parent tab when the tab list probe fails', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('tab') && argv.includes('show')) {
        return json({ id: 'tab_anchor', pane_id: 'pane_anchor' });
      }
      if (argv.includes('tab') && argv.includes('list')) {
        return { exitCode: 1, stdout: '', stderr: 'operation.failed' };
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    expect(
      await instance.spawnPane(CHILD_ID, DESCRIPTION, 'http://server', '/repo'),
    ).toEqual({ success: true, paneId: 'term_child' });

    expect(lastName(calls)).toBe(`Agent${process.pid}/subagent:${CHILD_TOKEN}`);
    // The active tab is undeterminable: the spec mandates the parent-tab
    // fallback rather than skipping the restore.
    expect(calls.at(-1)).toEqual(cmux(['tab', 'tab_anchor', 'focus']));
    expect(loggedText()).toContain('restoring the parent tab');
  });

  test('omits the argv marker when the shell has no # comments (cmd)', async () => {
    process.env.SHELL = 'C:\\Windows\\System32\\cmd.exe';
    const { runner, calls } = recorder();
    const instance = mux({ runner });

    expect(
      await instance.spawnPane(
        CHILD_ID,
        DESCRIPTION,
        'http://127.0.0.1:7777',
        '/repo',
        { subagentType: 'oracle' },
      ),
    ).toEqual({ success: true, paneId: 'term_child' });

    const run = calls.find((argv) => argv.includes('run')) ?? [];
    const script = run.at(-1) ?? '';
    expect(script).toBe(ATTACH_COMMAND);
    expect(script).not.toContain('# omosc:');
    // The display name contract is unaffected by the shell branch.
    expect(lastName(calls)).toBe(`my-tab/oracle:${CHILD_TOKEN}`);
  });

  test('falls back to the first tab_ids entry when tab_id is absent', async () => {
    const { runner, calls } = recorder((argv) =>
      argv.includes('terminal') && !argv.includes('list')
        ? json({ id: 'term_anchor', tab_ids: ['tab_from_list', 'tab_other'] })
        : defaultResponse(argv),
    );
    const instance = mux({ runner });

    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual(expect.objectContaining({ success: true }));
    expect(calls[2]).toEqual(cmux(['tab', 'tab_from_list', 'show']));
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

  test('classifies old-generation failures on the new command surface', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('ping')) return json({ alive: true });
      return {
        exitCode: 2,
        stdout: '',
        stderr: 'cmux: usage.invalid: unknown option "--name"',
      };
    });
    const instance = mux({ runner });

    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'unavailable' });
    expect(calls.some((argv) => argv.includes('run'))).toBe(false);
    expect(calls.some((argv) => argv.includes('focus'))).toBe(false);
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

  test('fails closed without a run when the anchor terminal has no tab', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('ping')) return json({ alive: true });
      if (argv.includes('terminal')) {
        return json({ id: 'term_anchor', tab_ids: [] });
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'hard' });
    expect(calls.some((argv) => argv.includes('run'))).toBe(false);
    expect(calls.some((argv) => argv.includes('focus'))).toBe(false);
  });

  test('fails closed without a run when the anchor tab has no pane', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('ping')) return json({ alive: true });
      if (argv.includes('tab') && argv.includes('show')) {
        return json({ id: 'tab_anchor' });
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    expect(
      await instance.spawnPane('child', 'child', 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'hard' });
    expect(calls.some((argv) => argv.includes('run'))).toBe(false);
    expect(calls.some((argv) => argv.includes('focus'))).toBe(false);
  });

  test('returns not_found when the anchor terminal is gone', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('ping')) return json({ alive: true });
      if (argv.includes('terminal')) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: JSON.stringify({
            code: 'selector.not_found',
            message: 'no terminal matches "term_anchor"',
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
    expect(calls.some((argv) => argv.includes('focus'))).toBe(false);
  });

  test('best-effort closes only the marked terminal when the run fails', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('run')) {
        return { exitCode: 1, stdout: '', stderr: 'operation.failed' };
      }
      if (argv.includes('process') && argv.includes('term_leak')) {
        return json({ argv: ['/bin/bash', '-l', '-c', `${MARKER}attach`] });
      }
      if (argv.includes('process') && argv.includes('term_user')) {
        return json({ argv: ['/bin/bash'] });
      }
      if (argv.includes('list') && argv.includes('terminal')) {
        return json([{ id: 'term_leak' }, { id: 'term_user' }]);
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    expect(
      await instance.spawnPane(CHILD_ID, DESCRIPTION, 'http://server', '/repo'),
    ).toEqual({ success: false, error: 'hard' });

    const closes = calls.filter((argv) => argv.includes('close'));
    expect(closes).toEqual([cmux(['terminal', 'term_leak', 'close'])]);
    expect(calls.some((argv) => argv.includes('focus'))).toBe(false);
  });

  test('classifies a run selector.not_found as not_found and stops', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('run')) {
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
    expect(calls.some((argv) => argv.includes('focus'))).toBe(false);
    // A gone parent pane proves nothing was created: no marker scan runs.
    expect(calls.some((argv) => argv.includes('list'))).toBe(false);
  });

  test('never derives display names from tab positions', async () => {
    let index = 0;
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('tab') && argv.includes('show')) {
        return json({
          id: 'tab_anchor',
          pane_id: 'pane_anchor',
          index,
          focused: false,
          name: 'my-tab',
        });
      }
      if (argv.includes('tab') && argv.includes('list')) {
        return json([
          {
            id: 'tab_anchor',
            pane_id: 'pane_anchor',
            index,
            focused: true,
            name: 'my-tab',
          },
        ]);
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    const sessionA = 'ses_aaaaaaaaaaaaaaaaaaaaaa11abc';
    const sessionB = 'ses_bbbbbbbbbbbbbbbbbbbbbb22xyz';
    const spawn = (sessionId: string) =>
      instance.spawnPane(sessionId, DESCRIPTION, 'http://server', '/repo', {
        subagentType: 'oracle',
      });

    await spawn(sessionA);
    const first = lastName(calls);
    index = 4; // a user closed tabs: positions shifted
    await spawn(sessionA);
    const repeated = lastName(calls);
    await spawn(sessionB);
    const other = lastName(calls);

    expect(first).toBe(`my-tab/oracle:11abc`);
    expect(repeated).toBe(first);
    expect(other).toBe(`my-tab/oracle:22xyz`);
    expect(other).not.toBe(first);
  });

  const layouts: MultiplexerLayout[] = [
    'main-vertical',
    'main-horizontal',
    'even-horizontal',
    'even-vertical',
    'tiled',
  ];

  for (const layout of layouts) {
    test(`applyLayout(${layout}) issues no command`, async () => {
      const { runner, calls } = recorder();
      const instance = mux({ runner, layout });

      await instance.applyLayout(layout, 60);
      expect(calls).toEqual([]);
    });
  }

  test('spawns identically under different layout values', async () => {
    const first = recorder();
    await mux({ runner: first.runner, layout: 'main-horizontal' }).spawnPane(
      CHILD_ID,
      DESCRIPTION,
      'http://server',
      '/repo',
      { subagentType: 'oracle' },
    );
    const second = recorder();
    await mux({ runner: second.runner, layout: 'tiled' }).spawnPane(
      CHILD_ID,
      DESCRIPTION,
      'http://server',
      '/repo',
      { subagentType: 'oracle' },
    );
    expect(first.calls).toEqual(second.calls);
  });

  test('treats a close selector.not_found as already closed', async () => {
    const { runner } = recorder(() => ({
      exitCode: 1,
      stdout: '',
      stderr: JSON.stringify({
        code: 'selector.not_found',
        details: { scope: 'terminal', selector: 'term_gone' },
        message: 'no terminal matches "term_gone"',
        retryable: false,
      }),
    }));
    const instance = mux({ runner });

    expect(await instance.closePane('term_gone')).toBe(true);
  });

  test('returns false when close fails for another reason', async () => {
    const { runner } = recorder(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'operation.failed',
    }));
    const instance = mux({ runner });

    expect(await instance.closePane('term_x')).toBe(false);
  });

  test('runs no command for close without a control-plane target', async () => {
    const { runner, calls } = recorder();
    const instance = mux({ runner, env: {} });

    expect(await instance.closePane('term_x')).toBe(false);
    expect(await instance.closePane('')).toBe(false);
    expect(calls).toEqual([]);
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

  test('discovers sweep candidates from terminal argv markers only', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('list') && argv.includes('terminal')) {
        return json([
          { id: 'term_marked' },
          { id: 'term_user' },
          { id: 'term_malformed' },
        ]);
      }
      if (argv.includes('process') && argv.includes('term_marked')) {
        return json({
          argv: ['/bin/bash', '-l', '-c', `${MARKER}attach`],
        });
      }
      if (argv.includes('process') && argv.includes('term_user')) {
        // The token exists but not as the plugin's comment marker.
        return json({ argv: ['/bin/bash', '-c', `echo ${DESCRIPTION}`] });
      }
      if (argv.includes('process') && argv.includes('term_malformed')) {
        return json({
          argv: ['/bin/bash', '-l', '-c', '# omosc:not-a-pid:ses_x\nattach'],
        });
      }
      return json({});
    });
    const instance = mux({ runner });

    expect(await instance.listPanesWithTitles()).toEqual({
      panes: [{ paneId: 'term_marked', title: DESCRIPTION }],
      incomplete: false,
    });
    // `tab list` is never a scan source: it cannot see closed-view terminals.
    expect(
      calls.every((argv) => !(argv.includes('tab') && argv.includes('list'))),
    ).toBe(true);
    expect(calls.every((argv) => !argv.includes('project'))).toBe(true);
  });

  test('rejects the candidate scan when terminal list fails', async () => {
    const { runner } = recorder((argv) => {
      if (argv.includes('list') && argv.includes('terminal')) {
        return { exitCode: 1, stdout: '', stderr: 'connection refused' };
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    // A failed scan must stay distinguishable from a clean empty pass so the
    // wiring can re-arm the owed sweep.
    await expect(instance.listPanesWithTitles()).rejects.toThrow(
      /terminal list failed/,
    );
  });

  test('reports an incomplete scan when a process show fails transiently', async () => {
    const { runner } = recorder((argv) => {
      if (argv.includes('list') && argv.includes('terminal')) {
        return json([{ id: 'term_marked' }, { id: 'term_flaky' }]);
      }
      if (argv.includes('process') && argv.includes('term_flaky')) {
        return { exitCode: 1, stdout: '', stderr: 'connection refused' };
      }
      if (argv.includes('process') && argv.includes('term_marked')) {
        return json({ argv: ['/bin/bash', '-l', '-c', `${MARKER}attach`] });
      }
      return json({});
    });
    const instance = mux({ runner });

    // `unavailable` means the scan could not determine whether `term_flaky`
    // is a leftover: the pass stays retryable, but the candidate found before
    // it is preserved instead of being discarded by an abort.
    await expect(instance.listPanesWithTitles()).resolves.toEqual({
      panes: [{ paneId: 'term_marked', title: DESCRIPTION }],
      incomplete: true,
    });
    const messages = logMock.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    expect(
      messages.some(
        (message) =>
          message.startsWith('[cmux-tui]') &&
          message.includes('terminal skipped'),
      ),
    ).toBe(true);
  });

  test('reports an incomplete scan when a process show fails hard', async () => {
    const { runner } = recorder((argv) => {
      if (argv.includes('list') && argv.includes('terminal')) {
        return json([{ id: 'term_marked' }, { id: 'term_flaky' }]);
      }
      if (argv.includes('process') && argv.includes('term_flaky')) {
        return { exitCode: 1, stdout: '', stderr: 'operation.failed' };
      }
      if (argv.includes('process') && argv.includes('term_marked')) {
        return json({ argv: ['/bin/bash', '-l', '-c', `${MARKER}attach`] });
      }
      return json({});
    });
    const instance = mux({ runner });

    await expect(instance.listPanesWithTitles()).resolves.toEqual({
      panes: [{ paneId: 'term_marked', title: DESCRIPTION }],
      incomplete: true,
    });
  });

  test('skips a not_found terminal but keeps the other candidates', async () => {
    const { runner } = recorder((argv) => {
      if (argv.includes('list') && argv.includes('terminal')) {
        return json([{ id: 'term_gone' }, { id: 'term_marked' }]);
      }
      if (argv.includes('process') && argv.includes('term_gone')) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: JSON.stringify({
            code: 'selector.not_found',
            message: 'no terminal matches "term_gone"',
          }),
        };
      }
      if (argv.includes('process') && argv.includes('term_marked')) {
        return json({ argv: ['/bin/bash', '-l', '-c', `${MARKER}attach`] });
      }
      return json({});
    });
    const instance = mux({ runner });

    // `not_found` is a definitive answer, not a failed scan: skipping the
    // stale terminal completes the pass. A blanket throw here would make
    // every sweep fail once one stale terminal exists.
    await expect(instance.listPanesWithTitles()).resolves.toEqual({
      panes: [{ paneId: 'term_marked', title: DESCRIPTION }],
      incomplete: false,
    });
    const messages = logMock.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    expect(
      messages.some(
        (message) =>
          message.startsWith('[cmux-tui]') &&
          message.includes('terminal already gone'),
      ),
    ).toBe(true);
  });

  test('sweep closes only the dead-owner terminal discovered via argv markers', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('list') && argv.includes('terminal')) {
        return json([
          { id: 'term_1' },
          { id: 'term_2' },
          { id: 'term_3' },
          { id: 'term_4' },
        ]);
      }
      if (argv.includes('process')) {
        if (argv.includes('term_1')) return json({ argv: ['/bin/bash'] });
        if (argv.includes('term_2')) {
          return json({
            argv: ['/bin/bash', '-l', '-c', '# omosc:999:ses_gone\nx'],
          });
        }
        if (argv.includes('term_3')) {
          return json({
            argv: ['/bin/bash', '-l', '-c', '# omosc:4242:ses_gone\nx'],
          });
        }
        if (argv.includes('term_4')) {
          return json({
            argv: ['/bin/bash', '-l', '-c', '# omosc:999:ses_alive\nx'],
          });
        }
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
    expect(stats.scanFailed).toBe(false);
    expect(stats.scanIncomplete).toBe(false);
    const close = calls.find((argv) => argv.includes('close'));
    expect(close).toEqual(cmux(['terminal', 'term_2', 'close']));
    expect(calls.every((argv) => !argv.includes('project'))).toBe(true);
  });

  test('emits only [cmux-tui] log prefixes on the adapter path', async () => {
    const { runner } = recorder((argv) => {
      if (argv.includes('close')) {
        return { exitCode: 1, stdout: '', stderr: 'selector.not_found' };
      }
      return defaultResponse(argv);
    });
    const instance = mux({ runner });

    await instance.spawnPane(CHILD_ID, DESCRIPTION, 'http://server', '/repo');
    expect(await instance.closePane('term_gone')).toBe(true);

    const messages = logMock.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message) => message.startsWith('[cmux-tui]'))).toBe(
      true,
    );
    expect(messages.some((message) => message.startsWith('[cmux]'))).toBe(
      false,
    );
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

  test('resolves the two-hop anchor with the parent tab name and active flag', async () => {
    const { runner, calls } = recorder((argv) => {
      if (argv.includes('terminal')) {
        return json({ id: 'term_1', tab_id: 'tab_1', tab_ids: ['tab_1'] });
      }
      if (argv.includes('tab')) {
        return json({
          id: 'tab_1',
          pane_id: 'pane_1',
          focused: true,
          name: 'my-tab',
        });
      }
      return json({});
    });
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.resolveAnchor(target, 'term_1')).toEqual({
      ok: true,
      value: {
        tabId: 'tab_1',
        paneId: 'pane_1',
        tabName: 'my-tab',
        tabFocused: true,
      },
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

  test('runs the attach argv under the display name before the separator', async () => {
    const { runner, calls } = recorder(() =>
      json({ value: { tab_id: 'tab_9', terminal_id: 'term_9' } }),
    );
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(
      await client.runInPane(
        target,
        'pane_1',
        ['/bin/bash', '-l', '-c', 'attach'],
        'my-tab/oracle:GdEx6',
      ),
    ).toEqual({ ok: true, value: { tabId: 'tab_9', terminalId: 'term_9' } });
    expect(calls[0]).toEqual([
      '/bin/cmux',
      '--socket',
      '/tmp/cmux.sock',
      '--json',
      'pane',
      'pane_1',
      'run',
      '--on-exit',
      'keep',
      '--name',
      'my-tab/oracle:GdEx6',
      '--',
      '/bin/bash',
      '-l',
      '-c',
      'attach',
    ]);
  });

  test('rejects a run response missing tab_id or terminal_id', async () => {
    for (const payload of [
      { tab_id: 'tab_9' },
      { terminal_id: 'term_9' },
      {},
    ]) {
      const { runner } = recorder(() => json({ value: payload }));
      const client = new CliCmuxClient(runner, '/bin/cmux');

      expect(await client.runInPane(target, 'pane_1', ['x'], 'name')).toEqual({
        ok: false,
        error: 'hard',
        reason: 'invalid-response',
      });
    }
  });

  test('classifies old-generation failures for every new command', async () => {
    const oldGeneration = () => ({
      exitCode: 2,
      stdout: '',
      stderr: 'cmux: unknown command "pane"',
    });

    const run = new CliCmuxClient(recorder(oldGeneration).runner, '/bin/cmux');
    expect(await run.runInPane(target, 'pane_1', ['x'], 'name')).toEqual({
      ok: false,
      error: 'unavailable',
      reason: 'old-generation',
    });

    const focus = new CliCmuxClient(
      recorder(oldGeneration).runner,
      '/bin/cmux',
    );
    expect(await focus.focusTab(target, 'tab_1')).toEqual({
      ok: false,
      error: 'unavailable',
      reason: 'old-generation',
    });

    const close = new CliCmuxClient(
      recorder(oldGeneration).runner,
      '/bin/cmux',
    );
    expect(await close.closeTerminal(target, 'term_1')).toBe('failed');

    const show = new CliCmuxClient(recorder(oldGeneration).runner, '/bin/cmux');
    expect(await show.processShow(target, 'term_1')).toEqual({
      ok: false,
      error: 'unavailable',
      reason: 'old-generation',
    });
  });

  test('focuses a tab with the exact argv', async () => {
    const { runner, calls } = recorder(() => json({ value: {} }));
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.focusTab(target, 'tab_1')).toEqual({
      ok: true,
      value: true,
    });
    expect(calls[0]).toEqual([
      '/bin/cmux',
      '--socket',
      '/tmp/cmux.sock',
      '--json',
      'tab',
      'tab_1',
      'focus',
    ]);
  });

  test('closes a terminal with the exact argv', async () => {
    const { runner, calls } = recorder(() => json({ value: {} }));
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.closeTerminal(target, 'term_1')).toBe('closed');
    expect(calls[0]).toEqual([
      '/bin/cmux',
      '--socket',
      '/tmp/cmux.sock',
      '--json',
      'terminal',
      'term_1',
      'close',
    ]);
  });

  test('treats a terminal close selector.not_found as already closed', async () => {
    const { runner } = recorder(() => ({
      exitCode: 1,
      stdout: '',
      stderr: JSON.stringify({
        code: 'selector.not_found',
        details: { scope: 'terminal', selector: 'term_gone' },
        message: 'no terminal matches "term_gone"',
        retryable: false,
      }),
    }));
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.closeTerminal(target, 'term_gone')).toBe('not_found');
  });

  test('reports a terminal close failure for other errors', async () => {
    const { runner } = recorder(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'operation.failed',
    }));
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.closeTerminal(target, 'term_1')).toBe('failed');
  });

  test('reads the verbatim argv from process show', async () => {
    const { runner, calls } = recorder(() =>
      json({ argv: ['/bin/bash', '-l', '-c', `${MARKER}attach`], pid: 42 }),
    );
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.processShow(target, 'term_1')).toEqual({
      ok: true,
      value: { argv: ['/bin/bash', '-l', '-c', `${MARKER}attach`] },
    });
    expect(calls[0]).toEqual([
      '/bin/cmux',
      '--socket',
      '/tmp/cmux.sock',
      '--json',
      'terminal',
      'term_1',
      'process',
      'show',
    ]);
  });

  test('rejects a process show response without argv', async () => {
    const { runner } = recorder(() => json({ pid: 42 }));
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.processShow(target, 'term_1')).toEqual({
      ok: false,
      error: 'hard',
      reason: 'invalid-response',
    });
  });

  test('lists tabs with pane and focus fields', async () => {
    const { runner } = recorder(() =>
      json([
        { id: 'tab_1', pane_id: 'pane_1', focused: true, name: 'my-tab' },
        { id: 'tab_2', pane_id: 'pane_1', focused: false, name: null },
        { id: 'tab_3', focused: false },
      ]),
    );
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.listTabs(target)).toEqual({
      ok: true,
      value: [
        { tabId: 'tab_1', paneId: 'pane_1', focused: true },
        { tabId: 'tab_2', paneId: 'pane_1', focused: false },
      ],
    });
  });

  test('lists terminal ids for sweep discovery', async () => {
    const { runner } = recorder(() =>
      json([
        { id: 'term_1', running: true, tab_ids: [] },
        { id: 'term_2', running: false, tab_ids: ['tab_2'] },
        { running: true },
      ]),
    );
    const client = new CliCmuxClient(runner, '/bin/cmux');

    expect(await client.listTerminals(target)).toEqual({
      ok: true,
      value: [{ terminalId: 'term_1' }, { terminalId: 'term_2' }],
    });
  });

  test('redacts stderr on argv-carrying command failures', async () => {
    const { runner } = recorder((argv) => {
      if (argv.includes('ping')) return json({ alive: true });
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'failed to spawn /bin/bash -c "secret attach payload"',
      };
    });
    const client = new CliCmuxClient(runner, '/bin/cmux');

    await client.runInPane(target, 'pane_1', ['secret'], 'name');
    expect(loggedText()).toContain('[redacted: may contain attach command]');
    expect(loggedText()).not.toContain('secret attach payload');
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

describe('cmux binary resolution', () => {
  test('prefers an explicit binary over PATH probing', async () => {
    const probes: string[] = [];
    const { runner, calls } = recorder();
    const instance = new CmuxMultiplexer('main-vertical', 60, {
      client: new CliCmuxClient(runner, '/opt/cmux-tui', async (name) => {
        probes.push(name);
        return null;
      }),
      env: BASE_ENV,
    });

    expect(await instance.isAvailable()).toBe(true);
    expect(probes).toEqual([]);
    expect(calls[0]?.[0]).toBe('/opt/cmux-tui');
  });

  test('probes cmux-tui before the legacy cmux name', async () => {
    const probes: string[] = [];
    const { runner, calls } = recorder();
    const client = new CliCmuxClient(runner, undefined, async (name) => {
      probes.push(name);
      return name === 'cmux-tui' ? '/usr/bin/cmux-tui' : '/usr/bin/cmux';
    });
    const instance = new CmuxMultiplexer('main-vertical', 60, {
      client,
      env: BASE_ENV,
    });

    expect(await instance.isAvailable()).toBe(true);
    expect(probes).toEqual(['cmux-tui']);
    expect(calls[0]?.[0]).toBe('/usr/bin/cmux-tui');
  });

  test('falls back to the legacy cmux name when cmux-tui is absent', async () => {
    const probes: string[] = [];
    const { runner, calls } = recorder();
    const client = new CliCmuxClient(runner, undefined, async (name) => {
      probes.push(name);
      return name === 'cmux' ? '/usr/bin/cmux' : null;
    });
    const instance = new CmuxMultiplexer('main-vertical', 60, {
      client,
      env: BASE_ENV,
    });

    expect(await instance.isAvailable()).toBe(true);
    expect(probes).toEqual(['cmux-tui', 'cmux']);
    expect(calls[0]?.[0]).toBe('/usr/bin/cmux');
  });

  test('resolves the binary once across commands', async () => {
    const probes: string[] = [];
    const { runner } = recorder();
    const client = new CliCmuxClient(runner, undefined, async (name) => {
      probes.push(name);
      return name === 'cmux-tui' ? '/usr/bin/cmux-tui' : null;
    });
    const instance = new CmuxMultiplexer('main-vertical', 60, {
      client,
      env: BASE_ENV,
    });

    await instance.isAvailable();
    await instance.isAvailable();
    expect(probes).toEqual(['cmux-tui']);
  });

  test('passes the cmux-tui log prefix to both probes', async () => {
    const probes: Array<{ name: string; logPrefix?: string }> = [];
    const { runner } = recorder();
    const client = new CliCmuxClient(
      runner,
      undefined,
      async (name, logPrefix) => {
        probes.push({ name, logPrefix });
        return name === 'cmux' ? '/usr/bin/cmux' : null;
      },
    );
    const instance = new CmuxMultiplexer('main-vertical', 60, {
      client,
      env: BASE_ENV,
    });

    expect(await instance.isAvailable()).toBe(true);
    // The legacy `cmux` fallback must not emit a `[cmux]` log prefix.
    expect(probes).toEqual([
      { name: 'cmux-tui', logPrefix: 'cmux-tui' },
      { name: 'cmux', logPrefix: 'cmux-tui' },
    ]);
  });
});

describe('argv marker helpers', () => {
  test('extracts the omosc token only from the comment marker line', () => {
    expect(
      extractArgvMarker(['/bin/bash', '-l', '-c', `${MARKER}attach`]),
    ).toBe(DESCRIPTION);
    expect(extractArgvMarker(['/bin/bash', '-c', 'attach'])).toBeNull();
    expect(
      extractArgvMarker(['/bin/bash', '-c', `echo ${DESCRIPTION}`]),
    ).toBeNull();
    expect(
      extractArgvMarker(['/bin/bash', '-c', '# omosc:not-a-pid:ses_x\nx']),
    ).toBeNull();
  });

  test('flags every command that carries an argv payload', () => {
    expect(
      commandCarriesArgv([
        'pane',
        'pane_1',
        'run',
        '--on-exit',
        'keep',
        '--name',
        'n',
        '--',
        '/bin/bash',
      ]),
    ).toBe(true);
    // A hypothetical non-`run` surface carrying argv is covered too.
    expect(commandCarriesArgv(['pane', 'pane_1', 'spawn', '--', 'x'])).toBe(
      true,
    );
    expect(commandCarriesArgv(['tab', 'tab_1', 'show'])).toBe(false);
  });
});
