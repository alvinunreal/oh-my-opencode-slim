/**
 * Fresh-process cold-gate contract for the v2 TUI entry (`./tui` export →
 * `dist/tui2.js`).
 *
 * The entry is the module every TUI host discovers, so BOTH of its contracts
 * — the legacy v1 `plugin.tui(api, options, meta)` factory and the v2
 * `plugin.setup(ctx)` — must reach their decision from the disable env switch
 * and the light gate read (`../tui-gates`) BEFORE the dynamic
 * `import('./tui-impl')`. A disabled TUI may therefore never evaluate
 * `src/tui-impl.ts`, `src/tui.ts`, `@opentui/*`, or `solid-js`.
 *
 * These assertions run in a spawned child process because module loading is
 * the subject under test: the parent bun process has already imported the
 * render stack for other test files, so nothing here may import the entry —
 * the entry path is passed to the child as a string, and the child reports
 * `require.cache` back as JSON. Each scenario gets its own config/project
 * tree under /tmp/opencode (never inside the repository), and the child
 * installs a `Bun.plugin` loader hook for `./tui-impl` that records the
 * import the entry actually issues and substitutes a recorder implementation,
 * so the disabled assertions watch the real loader instead of a module mock
 * (Bun's module mocks are process-global and would poison other test files).
 *
 * The scenarios also pin the directory the gates are read from:
 * `api.state.path.directory` (the v1 host's launch scope), not `cwd`, and
 * the v1 config-search boundary — the legacy gate must stop at the first
 * `.git` directory, so a `tui: false` outside that boundary does not disable
 * the legacy contract the way it would a v2 one.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared, pre-approved scratch root; the repo tree stays untouched. */
const FIXTURE_ROOT = '/tmp/opencode';

const ENTRY_PATH = JSON.stringify(join(import.meta.dir, 'tui.ts'));

interface ProbeReport {
  /** Absolute path of every `tui-impl` module load the entry requested. */
  loads: string[];
  /** `tui` (legacy contract) / `setup` (v2 contract), in call order. */
  calls: string[];
  legacyApiForwarded: boolean;
  legacyOptionsForwarded: boolean;
  legacyMetaForwarded: boolean;
  setupCtxForwarded: boolean;
  setupCleanupIsFunction: boolean;
  /** Heavy modules still resident after the contracts ran. */
  heavy: string[];
}

/**
 * Child harness. Runs both contracts (gated by env), records the entry's
 * dynamic import of `./tui-impl`, and replaces that module with a recorder so
 * the render stack can never run here — the disabled cases are proven by the
 * absence of the load itself, not by a crash.
 */
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
          'export const tui = (api, options, meta) => { ' +
          'globalThis.__calls = globalThis.__calls ?? []; ' +
          'globalThis.__calls.push({ kind: "tui", api, options, meta }); ' +
          '}; ' +
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
const api = { state: { path: { directory } } };
const ctx = { location: { directory } };
const options = { probeMarker: 'legacy-options' };
const meta = { state: 'first', version: '9.9.9-probe' };

if (process.env.PROBE_LEGACY === '1') {
  await plugin.tui(api, options, meta);
}
let cleanup;
if (process.env.PROBE_SETUP === '1') {
  cleanup = await plugin.setup(ctx);
}

const calls = globalThis.__calls ?? [];
const legacyCall = calls.find((call) => call.kind === 'tui');
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
  legacyApiForwarded: legacyCall !== undefined && legacyCall.api === api,
  legacyOptionsForwarded:
    legacyCall !== undefined && legacyCall.options === options,
  legacyMetaForwarded: legacyCall !== undefined && legacyCall.meta === meta,
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
  /** Call both contracts, or only one of them. */
  contracts: 'legacy' | 'setup' | 'both';
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
  const root = mkdtempSync(join(FIXTURE_ROOT, 'omos-tui-entry-'));
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
        PROBE_LEGACY:
          scenario.contracts === 'legacy' || scenario.contracts === 'both'
            ? '1'
            : '0',
        PROBE_SETUP:
          scenario.contracts === 'setup' || scenario.contracts === 'both'
            ? '1'
            : '0',
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
  test('tui: false loads nothing on either contract', () => {
    const report = runProbe({
      userConfig: {},
      projectConfig: { tui: false },
      contracts: 'both',
    });
    expect(report.loads).toHaveLength(0);
    expect(report.calls).toEqual([]);
    expect(report.setupCleanupIsFunction).toBe(false);
    expect(report.heavy).toEqual([]);
  });

  test('the disable env switch loads nothing on either contract', () => {
    const report = runProbe({
      userConfig: {},
      contracts: 'both',
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

  test('enabled keeps delegating with the legacy options/meta and the v2 ctx', () => {
    const report = runProbe({
      userConfig: {},
      contracts: 'both',
      env: { OPENCODE_CONFIG_PROJECT_DISABLE: '1' },
    });
    expect(report.loads).toHaveLength(1);
    expect(report.calls).toEqual(['tui', 'setup']);
    expect(report.legacyApiForwarded).toBe(true);
    expect(report.legacyOptionsForwarded).toBe(true);
    expect(report.legacyMetaForwarded).toBe(true);
    expect(report.setupCtxForwarded).toBe(true);
    expect(report.setupCleanupIsFunction).toBe(true);
    // The recorder replaced the real implementation, so only the stub is
    // resident: the gate's job is that the disabled cases load nothing.
    expect(report.heavy.every((key) => key.endsWith('/tui-impl.ts'))).toBe(
      true,
    );
  });

  test('the legacy gate keeps the v1 .git config-search boundary', () => {
    // `tui: false` sits one directory above a project that owns its own
    // `.git`. The legacy contract must ignore it (v1 stops at the worktree
    // boundary); a v2-flavored gate read would instead stay disabled.
    const report = runProbe({
      userConfig: {},
      ancestorConfig: { tui: false },
      contracts: 'legacy',
    });
    expect(report.loads).toHaveLength(1);
    expect(report.calls).toEqual(['tui']);
    expect(report.legacyApiForwarded).toBe(true);
    expect(report.legacyOptionsForwarded).toBe(true);
    expect(report.legacyMetaForwarded).toBe(true);
  });
});
