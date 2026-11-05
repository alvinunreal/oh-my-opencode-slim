#!/usr/bin/env bun
/**
 * Cold-loading verification for oh-my-opencode-slim.
 *
 * Drives the built dist artifact (dist/server/index.js, falling back to
 * dist/index.js) through isolated single-feature configurations, one
 * throwaway process each: import -> default.server(ctx) -> tool/agent
 * rosters -> dispose(). Timing samples run without NODE_V8_COVERAGE
 * (coverage perturbs timing); the byte/module count comes from a separate
 * coverage child whose files are read only after that child exited.
 *
 * Nothing is authorized to run: the probe overrides global fetch so any
 * network attempt throws and is counted, no tool is executed, and the
 * companion points at a binary that does not exist. Config files are
 * written under the temp root only; the package root is only read.
 *
 * Usage: bun run verify:optional-loading [built-package-root] [--report-only]
 *
 * The positional argument defaults to the repository root; the build must
 * already exist (this script never builds or installs). `--report-only`
 * records numbers without enforcing assertions, for baselines that predate
 * cold-loading.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const TEMP_BASE = '/tmp/opencode';
// Children must be Node: NODE_V8_COVERAGE is Node's switch and bun does not
// produce the same coverage files.
const NODE_BIN = 'node';
const TIMING_SAMPLES = 3;
const PROBE_TIMEOUT_MS = 120_000;

const ALL_HOOKS = [
  'phase-reminder',
  'foreground-fallback',
  'deepwork-goal',
  'chat-headers',
  'cache-monitor',
  'json-error-recovery',
  'tool-loop-guard',
  'search-path-guard',
  'absolute-path-rescue',
  'apply-patch',
  'council-inject',
  'auto-update-checker',
] as const;

const BASE_DISABLED_TOOLS = [
  'ast_grep_search',
  'ast_grep_replace',
  'acp_run',
  'marketplace_inspect',
  'marketplace_manage',
  'interview_submit_state',
] as const;

const BASE_DISABLED_COMMANDS = [
  'interview',
  'implement',
  'preset',
  'deepwork',
  'reflect',
] as const;

/** Controls whose optional implementation must be its own cold-gated chunk;
 * thin host-read controls (native) and in-file guards (hooks, council seats)
 * may legitimately share minimal's chunks. */
const STRICT_CONTROLS: readonly string[] = [
  'managed',
  'ast',
  'update',
  'fallback',
  'acp',
  'companion',
];

type CaseConfig = Record<string, unknown>;

const without = (values: readonly string[], drop: string[]) =>
  values.filter((value) => !drop.includes(value));

const baseConfig: CaseConfig = {
  tui: false,
  sidebar: false,
  autoUpdate: false,
  liveConfigRefresh: false,
  interview: { enabled: false },
  marketplace: { enabled: false },
  companion: { enabled: false },
  webfetch: { enabled: false },
  multiplexer: { type: 'none' },
  disabled_mcps: ['context7', 'gh_grep'],
  disabled_commands: BASE_DISABLED_COMMANDS,
  disabled_hooks: ALL_HOOKS,
  disabled_tools: BASE_DISABLED_TOOLS,
  backgroundJobs: { mode: 'off' },
};

interface Case {
  readonly name: string;
  readonly config: CaseConfig;
  readonly note: string;
}

const CASES: readonly Case[] = [
  {
    name: 'minimal',
    config: baseConfig,
    note: 'every optional subsystem off',
  },
  {
    name: 'native',
    config: { ...baseConfig, backgroundJobs: { mode: 'native' } },
    note: 'host task delegation only',
  },
  {
    name: 'managed',
    config: {
      ...baseConfig,
      backgroundJobs: {
        mode: 'managed',
        wallClockTimeoutMs: 0,
        orchestratorWake: { enabled: false },
      },
    },
    note: 'managed lifecycle, wake disabled, watchdog off',
  },
  {
    name: 'ast',
    config: {
      ...baseConfig,
      disabled_tools: without(BASE_DISABLED_TOOLS, [
        'ast_grep_search',
        'ast_grep_replace',
      ]),
    },
    note: 'ast-grep tools enabled',
  },
  {
    name: 'update',
    config: {
      ...baseConfig,
      autoUpdate: true,
      disabled_hooks: without(ALL_HOOKS, ['auto-update-checker']),
    },
    note: 'updater armed, session.created never delivered',
  },
  {
    name: 'fallback',
    config: {
      ...baseConfig,
      disabled_hooks: without(ALL_HOOKS, ['foreground-fallback']),
    },
    note: 'foreground fallback manager constructed',
  },
  {
    name: 'acp',
    config: {
      ...baseConfig,
      acpAgents: { probe: { command: 'never-executed-acp-command' } },
      disabled_tools: without(BASE_DISABLED_TOOLS, ['acp_run']),
    },
    note: 'one declared ACP command, never run',
  },
  {
    name: 'hooks',
    config: {
      ...baseConfig,
      disabled_hooks: ['foreground-fallback', 'auto-update-checker'],
    },
    note: 'every guard hook registered',
  },
  {
    name: 'council',
    config: {
      ...baseConfig,
      council: {
        presets: {
          probe: {
            alpha: { model: 'openai/gpt-5.3-codex' },
            beta: { model: 'google/gemini-3-pro' },
          },
        },
        default_preset: 'probe',
      },
    },
    note: 'two-seat council preset',
  },
  {
    name: 'companion',
    config: {
      ...baseConfig,
      companion: {
        enabled: true,
        binaryPath: path.join(TEMP_BASE, 'never-installed-companion-binary'),
      },
    },
    note: 'companion enabled, binary missing, no spawn',
  },
  {
    name: 'interview',
    config: {
      ...baseConfig,
      interview: { enabled: true, autoOpenBrowser: false },
      disabled_commands: without(BASE_DISABLED_COMMANDS, ['interview']),
      disabled_tools: without(BASE_DISABLED_TOOLS, ['interview_submit_state']),
    },
    note: 'interview subsystem, browser off',
  },
  {
    name: 'webfetch',
    config: { ...baseConfig, webfetch: { enabled: true } },
    note: 'enhanced webfetch and its JSDOM startup probe',
  },
];

interface TimingSample {
  readonly importMs: number;
  readonly initMs: number;
  readonly settleTurns: number;
  readonly disposeMs: number;
  readonly totalMs: number;
  readonly cpuUserMs: number;
  readonly rssDeltaMB: number;
  readonly heapUsedDeltaMB: number;
  readonly codeAndMetadataMB: number;
  readonly jsdomLoaded: boolean;
  readonly fetchCalls: number;
  readonly tools: readonly string[];
  readonly agents: readonly string[];
}

interface CoverageSummary {
  readonly packageModules: number;
  readonly packageBytes: number;
  readonly dependencyModules: number;
  readonly dependencyBytes: number;
  readonly loadedPackageFiles: readonly string[];
}

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface MedianRange {
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

interface CaseResult {
  readonly case: string;
  readonly note: string;
  readonly tools: readonly string[];
  readonly agents: readonly string[];
  readonly fetchCalls: number;
  readonly coverage: CoverageSummary | null;
  readonly timing: {
    readonly samples: number;
    readonly importMs: MedianRange;
    readonly initMs: MedianRange;
    readonly totalMs: MedianRange;
    readonly disposeMs: MedianRange;
    readonly cpuUserMs: MedianRange;
    readonly rssDeltaMB: MedianRange;
    readonly heapUsedDeltaMB: MedianRange;
    readonly codeAndMetadataMB: MedianRange;
    readonly jsdomLoaded: boolean;
    readonly settleTurns: number;
  };
  readonly checks: CheckResult[];
}

interface Report {
  readonly command: string;
  readonly mode: 'verify' | 'report-only';
  readonly status: string;
  readonly packageRoot: string;
  readonly entry: string;
  readonly entryKind: 'server' | 'root';
  readonly node: string;
  readonly cases: readonly CaseResult[];
  readonly checks: readonly CheckResult[];
  readonly ok: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function summarize(values: readonly number[]): MedianRange {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianValue =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return {
    median: +medianValue.toFixed(2),
    min: +Math.min(...values).toFixed(2),
    max: +Math.max(...values).toFixed(2),
  };
}

function parseArgs(argv: readonly string[]): {
  packageRoot: string;
  reportOnly: boolean;
} {
  const positional: string[] = [];
  let reportOnly = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--report-only') {
      reportOnly = true;
    } else if (arg.startsWith('--')) {
      fail(`Unknown argument: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    fail('usage: bun run verify:optional-loading [built-package-root]');
  }
  return {
    packageRoot: path.resolve(positional[0] ?? process.cwd()),
    reportOnly,
  };
}

function resolveEntry(packageRoot: string): {
  entry: string;
  entryKind: 'server' | 'root';
} {
  const serverEntry = path.join(packageRoot, 'dist', 'server', 'index.js');
  if (existsSync(serverEntry))
    return { entry: serverEntry, entryKind: 'server' };
  const rootEntry = path.join(packageRoot, 'dist', 'index.js');
  if (existsSync(rootEntry)) return { entry: rootEntry, entryKind: 'root' };
  fail(
    `No built artifact in ${packageRoot}: expected dist/server/index.js or dist/index.js. Run "bun run build" first; this script never builds.`,
  );
}

class CaseWorkspace {
  readonly root: string;
  readonly configDir: string;
  readonly directory: string;
  readonly logsDir: string;
  readonly coverageDir: string;

  constructor(tempRoot: string, caseName: string, config: CaseConfig) {
    this.root = path.join(tempRoot, caseName);
    this.configDir = path.join(this.root, 'config');
    this.directory = path.join(this.root, 'work');
    this.logsDir = path.join(this.root, 'logs');
    this.coverageDir = path.join(this.root, 'coverage');
    for (const dir of [this.configDir, this.directory, this.logsDir]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      path.join(this.configDir, 'oh-my-opencode-slim.json'),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }

  // Drop every host/plugin variable so the run cannot inherit a disable
  // switch, a runtime preset, project config discovery, or log locations.
  env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        !key.startsWith('OPENCODE_') &&
        !key.startsWith('OH_MY_OPENCODE_SLIM_') &&
        key !== 'NODE_V8_COVERAGE' &&
        key !== 'NODE_OPTIONS'
      ) {
        env[key] = value;
      }
    }
    return {
      ...env,
      HOME: this.root,
      OPENCODE_CONFIG_DIR: this.configDir,
      OPENCODE_LOG_DIR: this.logsDir,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      XDG_CONFIG_HOME: this.configDir,
      XDG_CACHE_HOME: path.join(this.root, 'cache'),
      XDG_DATA_HOME: path.join(this.root, 'data'),
      XDG_STATE_HOME: path.join(this.root, 'state'),
      OMOS_PROBE_DIRECTORY: this.directory,
      ...extra,
    };
  }

  logs(): string {
    let combined = '';
    for (const name of readdirSync(this.logsDir)) {
      if (name.endsWith('.log')) {
        combined += readFileSync(path.join(this.logsDir, name), 'utf8');
      }
    }
    return combined;
  }
}

function runProbeOnce(
  probePath: string,
  entry: string,
  workspace: CaseWorkspace,
  coverage: boolean,
): Promise<{ report: TimingSample; logs: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      NODE_BIN,
      [
        '--no-warnings',
        '--expose-gc',
        probePath,
        entry,
        workspace.root.split(path.sep).pop() ?? '',
      ],
      {
        cwd: workspace.directory,
        env: workspace.env(
          coverage ? { NODE_V8_COVERAGE: workspace.coverageDir } : {},
        ),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)));
    const kill = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(kill);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(kill);
      if (code !== 0) {
        reject(
          new Error(
            `probe exited with ${code}\n${stdout}\n${stderr.slice(-2000)}`,
          ),
        );
        return;
      }
      const lines = stdout.split('\n').filter((line) => line.trim());
      try {
        resolve({
          report: JSON.parse(lines[lines.length - 1]) as TimingSample,
          logs: workspace.logs(),
        });
      } catch {
        reject(
          new Error(
            `probe produced no JSON report\n${stdout}\n${stderr.slice(-2000)}`,
          ),
        );
      }
    });
  });
}

function readCoverage(
  workspace: CaseWorkspace,
  packageRoot: string,
): CoverageSummary {
  const packageUrls = new Set<string>();
  const dependencyUrls = new Set<string>();
  const distPrefix = path.join(packageRoot, 'dist');
  for (const name of readdirSync(workspace.coverageDir)) {
    if (!name.endsWith('.json')) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(
        readFileSync(path.join(workspace.coverageDir, name), 'utf8'),
      ) as Record<string, unknown>;
    } catch {
      continue;
    }
    const result = data.result;
    if (!Array.isArray(result)) continue;
    for (const script of result) {
      const url = (script as Record<string, unknown>).url;
      if (typeof url !== 'string' || !url.startsWith('file:')) continue;
      const file = fileURLToPath(url);
      if (file.startsWith(`${distPrefix}/`)) {
        packageUrls.add(file);
      } else if (file.includes(`${path.sep}node_modules${path.sep}`)) {
        dependencyUrls.add(file);
      }
    }
  }
  const bytes = (files: Iterable<string>) =>
    [...files].reduce((sum, file) => sum + statSync(file).size, 0);
  const packageFiles = [...packageUrls].sort();
  return {
    packageModules: packageFiles.length,
    packageBytes: bytes(packageUrls),
    dependencyModules: dependencyUrls.size,
    dependencyBytes: bytes(dependencyUrls),
    loadedPackageFiles: packageFiles.map((file) =>
      path.relative(packageRoot, file),
    ),
  };
}

function expectTools(
  checks: CheckResult[],
  name: string,
  present: readonly string[],
  absent: readonly string[],
  registration: readonly string[],
): void {
  const detail = `tools=[${registration.join(', ')}]`;
  for (const tool of present) {
    checks.push({
      name: `${name} registers ${tool}`,
      ok: registration.includes(tool),
      detail,
    });
  }
  for (const tool of absent) {
    checks.push({
      name: `${name} excludes ${tool}`,
      ok: !registration.includes(tool),
      detail,
    });
  }
}

function caseChecks(
  result: CaseResult,
  checks: CheckResult[],
  logs: string,
): void {
  const registration = [...result.tools];
  switch (result.case) {
    case 'minimal':
      expectTools(checks, 'minimal', [], ['webfetch'], registration);
      checks.push({
        name: 'minimal leaves JSDOM unloaded',
        ok: !result.timing.jsdomLoaded,
        detail: `jsdomLoaded=${result.timing.jsdomLoaded}`,
      });
      break;
    case 'native':
      expectTools(
        checks,
        'native',
        ['task_status', 'task_cancel'],
        ['task_reply', 'task_revive', 'task_message', 'wait_for_user'],
        registration,
      );
      break;
    case 'managed':
      expectTools(
        checks,
        'managed',
        [
          'task_status',
          'task_cancel',
          'task_reply',
          'task_revive',
          'task_message',
          'wait_for_user',
        ],
        [],
        registration,
      );
      break;
    case 'ast':
      expectTools(
        checks,
        'ast',
        ['ast_grep_search', 'ast_grep_replace'],
        [],
        registration,
      );
      break;
    case 'acp':
      expectTools(checks, 'acp', ['acp_run'], [], registration);
      checks.push({
        name: 'acp declares the fake agent',
        ok: result.agents.includes('probe'),
        detail: `agents=[${result.agents.join(', ')}]`,
      });
      break;
    case 'council':
      checks.push({
        name: 'council seats are declared',
        ok:
          result.agents.includes('councillor') &&
          result.agents.includes('councillor-alpha') &&
          result.agents.includes('councillor-beta'),
        detail: `agents=[${result.agents.join(', ')}]`,
      });
      break;
    case 'companion':
      // Log evidence only: the configured binary is missing, so the enabled
      // manager's own log line proves the probe reached Companion startup.
      checks.push({
        name: 'companion starts without spawning',
        ok:
          logs.includes('[companion]') && !logs.includes('[companion] spawned'),
        detail: logs.includes('[companion] spawned')
          ? 'spawn marker found in the plugin log'
          : logs.includes('[companion]')
            ? 'Companion startup log present, no spawn marker'
            : 'no Companion log line; enabled path was not exercised',
      });
      break;
    case 'webfetch':
      expectTools(checks, 'webfetch', ['webfetch'], [], registration);
      checks.push({
        name: 'webfetch startup probe loads JSDOM',
        ok: result.timing.jsdomLoaded,
        detail: `jsdomLoaded=${result.timing.jsdomLoaded}, settleTurns=${result.timing.settleTurns}`,
      });
      break;
  }
}

function compareBytes(cases: readonly CaseResult[]): CheckResult[] {
  const checks: CheckResult[] = [];
  const minimal = cases.find((entry) => entry.case === 'minimal');
  if (!minimal?.coverage) return checks;
  const minimalCoverage = minimal.coverage;
  const minimalFiles = minimalCoverage.loadedPackageFiles.join('\n');

  const strict = cases.filter(
    (result) =>
      STRICT_CONTROLS.includes(result.case) && result.coverage !== null,
  );
  if (strict.length > 0) {
    const smallest = Math.min(
      ...strict.map((result) => result.coverage?.packageBytes ?? Infinity),
    );
    checks.push({
      name: `minimal strictly loads fewer package bytes than the smallest cold-gated control (${STRICT_CONTROLS.join('/')})`,
      ok: minimalCoverage.packageBytes < smallest,
      detail: `minimal=${minimalCoverage.packageBytes} smallest=${smallest} (${strict
        .map((result) => `${result.case}=${result.coverage?.packageBytes}`)
        .join(', ')})`,
    });
  }

  for (const result of cases) {
    if (result === minimal || !result.coverage) continue;
    const coverage = result.coverage;
    checks.push({
      name: `minimal <= ${result.case} package bytes`,
      ok: coverage.packageBytes >= minimalCoverage.packageBytes,
      detail: `minimal=${minimalCoverage.packageBytes} ${result.case}=${coverage.packageBytes} (modules ${minimalCoverage.packageModules}/${coverage.packageModules})`,
    });
    if (coverage.loadedPackageFiles.join('\n') === minimalFiles) {
      checks.push({
        name: `${result.case} shares minimal's chunks`,
        ok: coverage.packageBytes === minimalCoverage.packageBytes,
        detail: `identical file set; bytes must be identical (minimal=${minimalCoverage.packageBytes}, ${result.case}=${coverage.packageBytes})`,
      });
      continue;
    }
    checks.push({
      name: `${result.case} adds a cold-gated chunk beyond minimal`,
      ok: coverage.packageBytes > minimalCoverage.packageBytes,
      detail: `added modules=${coverage.loadedPackageFiles
        .filter((file) => !minimalCoverage.loadedPackageFiles.includes(file))
        .join(', ')}`,
    });
  }
  return checks;
}

function formatMs(value: MedianRange): string {
  return `${value.median.toFixed(0)}ms (${value.min.toFixed(0)}-${value.max.toFixed(0)})`;
}

async function main(): Promise<void> {
  const { packageRoot, reportOnly } = parseArgs(process.argv);
  const { entry, entryKind } = resolveEntry(packageRoot);
  const probePath = path.join(SCRIPT_DIR, 'optional-loading-probe.mjs');
  if (!existsSync(probePath)) fail(`Missing probe script: ${probePath}`);
  const nodeVersion = spawnSync(NODE_BIN, ['--version'], { encoding: 'utf8' });
  if (nodeVersion.status !== 0 || !nodeVersion.stdout.trim()) {
    fail(`Could not run ${NODE_BIN} --version (is Node installed?)`);
  }

  const tempRoot = mkdtempSync(path.join(TEMP_BASE, 'omos-optional-loading-'));
  if (!tempRoot.startsWith(TEMP_BASE)) {
    fail(`Refusing to clean a temp root outside ${TEMP_BASE}: ${tempRoot}`);
  }

  const results: CaseResult[] = [];
  try {
    for (const testCase of CASES) {
      const workspace = new CaseWorkspace(
        tempRoot,
        testCase.name,
        testCase.config,
      );
      const samples: TimingSample[] = [];
      let logs = '';
      for (let index = 0; index < TIMING_SAMPLES; index += 1) {
        const run = await runProbeOnce(probePath, entry, workspace, false);
        samples.push(run.report);
        logs = run.logs;
      }
      let coverage: CoverageSummary | null = null;
      let coverageSample: TimingSample | undefined;
      try {
        const coverageRun = await runProbeOnce(
          probePath,
          entry,
          workspace,
          true,
        );
        coverageSample = coverageRun.report;
        logs = coverageRun.logs;
        coverage = readCoverage(workspace, packageRoot);
      } catch (error) {
        console.warn(
          `[verify:optional-loading] ${testCase.name}: coverage collection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // Every run of this case — timing samples and the coverage run — must
      // agree on the registration surface; timing stays supporting evidence.
      const reports = coverageSample ? [...samples, coverageSample] : samples;
      const rosters = new Set(
        reports.map(
          (sample) => `${sample.tools.join(',')}|${sample.agents.join(',')}`,
        ),
      );
      const fetchCalls = Math.max(
        ...reports.map((sample) => sample.fetchCalls),
      );
      const checks: CheckResult[] = [
        {
          name: `${testCase.name} coverage measured`,
          ok:
            coverage !== null &&
            coverage.packageModules > 0 &&
            coverage.packageBytes > 0,
          detail:
            coverage === null
              ? 'NODE_V8_COVERAGE collection failed; bytes cannot be compared'
              : `packageModules=${coverage.packageModules} packageBytes=${coverage.packageBytes} dependencyModules=${coverage.dependencyModules}`,
        },
        {
          name: `${testCase.name} performs no network fetch`,
          ok: fetchCalls === 0,
          detail: `fetchCalls=${fetchCalls} (probe overrides global fetch to throw)`,
        },
        {
          name: `${testCase.name} tool/agent rosters identical across runs`,
          ok: rosters.size === 1,
          detail: `${rosters.size} distinct roster(s) across ${reports.length} runs: tools=[${samples[0].tools.join(
            ', ',
          )}] agents=[${samples[0].agents.join(', ')}]`,
        },
      ];
      const first = samples[0];
      const result: CaseResult = {
        case: testCase.name,
        note: testCase.note,
        tools: first.tools,
        agents: first.agents,
        fetchCalls,
        coverage,
        timing: {
          samples: samples.length,
          importMs: summarize(samples.map((sample) => sample.importMs)),
          initMs: summarize(samples.map((sample) => sample.initMs)),
          totalMs: summarize(samples.map((sample) => sample.totalMs)),
          disposeMs: summarize(samples.map((sample) => sample.disposeMs)),
          cpuUserMs: summarize(samples.map((sample) => sample.cpuUserMs)),
          rssDeltaMB: summarize(samples.map((sample) => sample.rssDeltaMB)),
          heapUsedDeltaMB: summarize(
            samples.map((sample) => sample.heapUsedDeltaMB),
          ),
          codeAndMetadataMB: summarize(
            samples.map((sample) => sample.codeAndMetadataMB),
          ),
          jsdomLoaded: samples.every((sample) => sample.jsdomLoaded),
          settleTurns: Math.max(...samples.map((sample) => sample.settleTurns)),
        },
        checks,
      };
      caseChecks(result, checks, logs);
      results.push(result);
      console.info(
        `[verify:optional-loading] ${testCase.name.padEnd(10)} ` +
          `tools=${first.tools.length} fetch=${fetchCalls} ` +
          `package=${coverage?.packageModules ?? '?'}/` +
          `${coverage?.packageBytes ?? '?'} B ` +
          `deps=${coverage?.dependencyModules ?? '?'}/` +
          `${coverage?.dependencyBytes ?? '?'} B ` +
          `init=${formatMs(result.timing.initMs)} ` +
          `total=${formatMs(result.timing.totalMs)} ` +
          `dispose=${formatMs(result.timing.disposeMs)}`,
      );
    }
  } finally {
    // Only ever remove the directory this run created.
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const allChecks = [
    ...results.flatMap((result) => result.checks),
    ...compareBytes(results),
  ];
  const failed = allChecks.filter((check) => !check.ok);
  const ok = failed.length === 0;
  const report: Report = {
    command: `bun run verify:optional-loading${
      packageRoot === REPO_ROOT ? '' : ` ${packageRoot}`
    }${reportOnly ? ' --report-only' : ''}`,
    mode: reportOnly ? 'report-only' : 'verify',
    status: ok
      ? reportOnly
        ? 'report-only: all recorded checks pass'
        : 'verified'
      : reportOnly
        ? `report-only: ${failed.length} check(s) not enforced (baseline capture)`
        : 'failed',
    packageRoot,
    entry,
    entryKind,
    node: nodeVersion.stdout.trim(),
    cases: results,
    checks: allChecks,
    ok,
  };
  console.info(JSON.stringify(report, null, 2));
  for (const check of failed) {
    console.warn(
      `[verify:optional-loading] NOT-OK ${check.name}: ${check.detail}`,
    );
  }
  if (!reportOnly && !ok) {
    process.exitCode = 1;
  }
}

await main();
