import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** OS scratch root; the repo tree stays untouched. */

const ENTRY_PATH = JSON.stringify(join(import.meta.dir, 'tui.ts'));

interface ProbeReport {
  /** Absolute path of every `tui-impl` module load the entry requested. */
  loads: string[];
  /** `tui` (legacy contract) / `setup` (v2 contract), in call order. */
  calls: string[];
  setupCtxForwarded: boolean;
  setupCleanupIsFunction: boolean;
  /** Heavy modules still resident after the contracts ran. */
  heavy: string[];
}

const PROBE_SCRIPT = `
const loads = [];
Bun.plugin({
  name: 'omos-tui-entry-probe',
  setup(build) {
    build.onLoad({ filter: /tui-impl\\.ts$/, namespace: 'file' }, (args) => {
      loads.push(args.path);
      return {
        loader: 'ts',
        contents:
          'export const runSetup = (ctx) => { ' +
          'globalThis.__calls = globalThis.__calls ?? []; ' +
          'globalThis.__calls.push({ kind: "setup", ctx }); ' +
          'return () => {}; };',
      };
    });
  },
});

const { default: plugin } = await import(${ENTRY_PATH});
const directory = process.env.PROBE_DIRECTORY;
const ctx = { location: { directory } };
const cleanup = await plugin.setup(ctx);
const calls = globalThis.__calls ?? [];
const setupCall = calls.find((call) => call.kind === 'setup');
const heavy = Object.keys(require.cache).filter(
  (key) =>
    key.endsWith('/tui-impl.ts') ||
    key.endsWith('/src/tui.ts') ||
    key.includes('@opentui/') ||
    key.includes('/solid-js/'),
);
const report = {
  loads,
  calls: calls.map((call) => call.kind),
  setupCtxForwarded: setupCall !== undefined && setupCall.ctx === ctx,
  setupCleanupIsFunction: typeof cleanup === 'function',
  heavy,
};
process.stdout.write('PROBE ' + JSON.stringify(report) + '\\n');
`;

interface Scenario {
  /** User-level config file content; an explicit `{}` stops the search. */
  userConfig: Record<string, unknown>;
  /** Project `.opencode/oh-my-opencode-slim.json` content, if any. */
  projectConfig?: Record<string, unknown>;
  /** Ancestor `.opencode` config outside the project's `.git` boundary. */
  ancestorConfig?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

function buildFixture(root: string, scenario: Scenario): string {
  const configHome = join(root, 'config');
  mkdirSync(configHome, { recursive: true });
  writeFileSync(
    join(configHome, 'oh-my-opencode-slim.json'),
    JSON.stringify(scenario.userConfig, null, 2),
  );
  // The project is where the contracts' directory points; `cwd` is a
  // different, config-less directory so the assertions watch the api/ctx
  // directory being used for the gate read, not the process cwd.
  const project = join(root, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(root, 'cwd'), { recursive: true });
  if (scenario.projectConfig) {
    mkdirSync(join(project, '.opencode'), { recursive: true });
    writeFileSync(
      join(project, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify(scenario.projectConfig, null, 2),
    );
  }
  if (scenario.ancestorConfig) {
    mkdirSync(join(root, '.opencode'), { recursive: true });
    writeFileSync(
      join(root, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify(scenario.ancestorConfig, null, 2),
    );
  }
  return project;
}

/**
 * Spawns the probe for one scenario and returns its report. The process is
 * synchronous (`spawnSync`) — no timer-based settling — and any child failure
 * surfaces its stderr instead of a bare exit code.
 */
function runProbe(scenario: Scenario): ProbeReport {
  const root = mkdtempSync(join(tmpdir(), 'omos-tui-entry-'));
  const project = buildFixture(root, scenario);
  const scriptPath = join(root, 'probe.ts');
  writeFileSync(scriptPath, PROBE_SCRIPT);
  try {
    const child = spawnSync(process.execPath, [scriptPath], {
      cwd: join(root, 'cwd'),
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, 'config-xdg'),
        OPENCODE_CONFIG_DIR: join(root, 'config'),
        OPENCODE_LOG_DIR: join(root, 'logs'),
        PROBE_DIRECTORY: project,
        ...scenario.env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(
      child.error,
      `probe failed to spawn: ${String(child.error)}`,
    ).toBeUndefined();
    expect(
      child.status,
      `probe exited ${child.status}\nstderr: ${child.stderr ?? ''}`,
    ).toBe(0);
    const line = (child.stdout ?? '')
      .split('\n')
      .filter((entry) => entry.trim().length > 0)
      .at(-1);
    expect(
      line,
      `probe printed no report\nstderr: ${child.stderr ?? ''}`,
    ).toMatch(/^PROBE /);
    return JSON.parse(line.slice('PROBE '.length)) as ProbeReport;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('v2 TUI entry cold gate', () => {
  test('tui: false loads nothing', () => {
    const report = runProbe({
      userConfig: {},
      projectConfig: { tui: false },
    });
    expect(report.loads).toHaveLength(0);
    expect(report.calls).toEqual([]);
    expect(report.setupCleanupIsFunction).toBe(false);
    expect(report.heavy).toEqual([]);
  });

  test('the disable env switch loads nothing', () => {
    const report = runProbe({
      userConfig: {},
      // Reserve the v2-only project discovery skip for this case: it keeps
      // the machine's project configs out of the (never reached) gate read.
      env: {
        OH_MY_OPENCODE_SLIM_DISABLE: '1',
        OPENCODE_CONFIG_PROJECT_DISABLE: '1',
      },
    });
    expect(report.loads).toHaveLength(0);
    expect(report.calls).toEqual([]);
    expect(report.setupCleanupIsFunction).toBe(false);
    expect(report.heavy).toEqual([]);
  });

  test('enabled forwards setup context and cleanup', () => {
    const report = runProbe({
      userConfig: {},
      env: { OPENCODE_CONFIG_PROJECT_DISABLE: '1' },
    });
    expect(report.loads).toHaveLength(1);
    expect(report.calls).toEqual(['setup']);
    expect(report.setupCtxForwarded).toBe(true);
    expect(report.setupCleanupIsFunction).toBe(true);
    // The recorder replaced the real implementation, so only the stub is
    // resident: the gate's job is that the disabled cases load nothing.
    expect(report.heavy.every((key) => key.endsWith('/tui-impl.ts'))).toBe(
      true,
    );
  });
});
