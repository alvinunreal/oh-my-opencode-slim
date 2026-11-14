import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import tuiPlugin, { readConfigState, readTuiGates } from './tui';
import { readTuiGatesOnly } from './tui-gates';

interface TestEnvironment {
  root: string;
  projectDir: string;
  restore: () => void;
}

const ENV_KEYS = [
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'OPENCODE_LOG_DIR',
  'OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS',
  'OH_MY_OPENCODE_SLIM_DISABLE',
] as const;

function makeTestEnvironment(): TestEnvironment {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-gates-'));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const original = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const configDir = path.join(root, 'opencode-config');

  process.env.OPENCODE_CONFIG_DIR = configDir;
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
  process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
  process.env.OPENCODE_LOG_DIR = path.join(root, 'logs');
  delete process.env.OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS;
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  fs.mkdirSync(configDir, { recursive: true });

  return {
    root,
    projectDir,
    restore: () => {
      for (const key of ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function writeUserConfig(config: Record<string, unknown>): void {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  if (!configDir) throw new Error('OPENCODE_CONFIG_DIR not set');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'oh-my-opencode-slim.json'),
    JSON.stringify(config, null, 2),
  );
}

function writeProjectConfig(
  projectDir: string,
  config: Record<string, unknown>,
): void {
  const configDir = path.join(projectDir, '.opencode');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'oh-my-opencode-slim.json'),
    JSON.stringify(config, null, 2),
  );
}

type Dispose = () => void | Promise<void>;

function makeSidebarApi(projectDir: string): {
  api: Record<string, unknown>;
  disposers: Dispose[];
} {
  const disposers: Dispose[] = [];
  const api = {
    location: { directory: projectDir },
    renderer: { requestRender: () => {} },
    theme: { text: {}, background: {}, border: {} },
    ui: {
      router: { current: () => ({ type: 'home' }) },
      slot: () => () => {},
    },
  };
  apiDisposers.set(api, disposers);
  return { api, disposers };
}

const apiDisposers = new WeakMap<Record<string, unknown>, Dispose[]>();

async function runSidebar(api: Record<string, unknown>): Promise<void> {
  const dispose = await tuiPlugin.setup(api as never);
  if (dispose) apiDisposers.get(api)?.push(dispose);
}

function spyOnIntervals(): {
  delays: number[];
  callbacks: Map<number, () => void>;
  restore: () => void;
} {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timerHost = globalThis as unknown as {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
  const delays: number[] = [];
  const callbacks = new Map<number, () => void>();
  const setIntervalSpy = mock((callback: () => void, delay?: number) => {
    callbacks.set(delay ?? 0, callback);
    delays.push(delay ?? 0);
    return 0 as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalSpy = mock((_timer: unknown) => {});
  timerHost.setInterval = setIntervalSpy as unknown as typeof setInterval;
  timerHost.clearInterval = clearIntervalSpy as unknown as typeof clearInterval;
  return {
    delays,
    callbacks,
    restore: () => {
      timerHost.setInterval = originalSetInterval;
      timerHost.clearInterval = originalClearInterval;
    },
  };
}

describe('TUI feature gates', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = makeTestEnvironment();
  });

  afterEach(() => {
    env.restore();
    fs.rmSync(env.root, { recursive: true, force: true });
  });

  test('question timeout defaults off and follows the configured value', () => {
    // Mutation: omit timeout from the TUI gate projection.
    writeUserConfig({});
    expect(readTuiGates(env.projectDir).gates.questionTimeoutMs).toBe(0);
    writeUserConfig({ questionTimeoutMs: 60_000 });
    expect(readTuiGates(env.projectDir).gates.questionTimeoutMs).toBe(60_000);
  });

  test('a thrown config read leaves question timeout off', () => {
    // Mutation: enable question timeout in fail-open defaults.
    const read = readTuiGatesOnly(null as never);
    expect(read.readFailed).toBe(true);
    expect(read.gates.questionTimeoutMs).toBe(0);
  });

  test('entry and unchanged polling share one parsed config snapshot', async () => {
    writeUserConfig({ sidebar: false, disabled_commands: ['preset'] });
    const configPath = path.join(
      process.env.OPENCODE_CONFIG_DIR as string,
      'oh-my-opencode-slim.json',
    );
    const realRead = fs.readFileSync;
    let reads = 0;
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      if (String(args[0]) === configPath) reads += 1;
      return realRead(...(args as Parameters<typeof fs.readFileSync>));
    });
    const intervals = spyOnIntervals();
    const { api, disposers } = makeSidebarApi(env.projectDir);
    try {
      await runSidebar(api);
      const startupReads = reads;
      expect(startupReads).toBeGreaterThan(0);
      intervals.callbacks.get(5000)?.();
      intervals.callbacks.get(5000)?.();
      expect(reads).toBe(startupReads);
      writeUserConfig({ sidebar: false, preset: 'edited' });
      intervals.callbacks.get(5000)?.();
      expect(reads).toBeGreaterThan(startupReads);
      const afterEdit = reads;
      expect(readConfigState(env.projectDir, 'v2').presetName).toBe('edited');
      expect(reads).toBe(afterEdit);
    } finally {
      for (const dispose of disposers) await dispose();
      intervals.restore();
      readSpy.mockRestore();
    }
  });

  test('tui false implies sidebar off and the update switch is shared', () => {
    writeUserConfig({ tui: false, sidebar: true, autoUpdate: false });
    const off = readTuiGates(env.projectDir).gates;
    expect(off.tuiEnabled).toBe(false);
    expect(off.sidebarEnabled).toBe(false);
    expect(off.updateCheckerEnabled).toBe(false);

    writeUserConfig({
      tui: true,
      sidebar: true,
      disabled_hooks: ['auto-update-checker'],
    });
    const hookOff = readTuiGates(env.projectDir).gates;
    expect(hookOff.tuiEnabled).toBe(true);
    expect(hookOff.sidebarEnabled).toBe(true);
    expect(hookOff.updateCheckerEnabled).toBe(false);

    writeUserConfig({ autoUpdate: true });
    expect(readTuiGates(env.projectDir).gates.updateCheckerEnabled).toBe(true);
  });

  test('shared gates preserve invalid-config warnings and repair on edit', () => {
    writeUserConfig({ tui: false });
    expect(readTuiGates(env.projectDir).gates.tuiEnabled).toBe(false);
    const configPath = path.join(
      process.env.OPENCODE_CONFIG_DIR as string,
      'oh-my-opencode-slim.json',
    );
    fs.writeFileSync(configPath, '{ invalid');
    expect(readTuiGates(env.projectDir).gates.configInvalid).toBe(true);
    writeUserConfig({ tui: true, compactSidebar: false });
    const repaired = readTuiGates(env.projectDir);
    expect(repaired.gates.configInvalid).toBe(false);
    expect(repaired.gates.compactSidebar).toBe(false);
    expect(repaired.gates.tuiEnabled).toBe(true);
  });

  test('sidebarShowHiddenAgents defaults off and follows the config', () => {
    writeUserConfig({});
    expect(readTuiGates(env.projectDir).gates.showHiddenAgents).toBe(false);

    writeUserConfig({ sidebarShowHiddenAgents: true });
    expect(readTuiGates(env.projectDir).gates.showHiddenAgents).toBe(true);

    writeUserConfig({ sidebarShowHiddenAgents: false });
    expect(readTuiGates(env.projectDir).gates.showHiddenAgents).toBe(false);
  });

  test('render-path gate read includes pane-wiring admission from the same snapshot', () => {
    writeUserConfig({ multiplexer: { type: 'tmux' } });
    const full = readTuiGates(env.projectDir);
    expect(full.paneConfig?.multiplexer.type).toBe('tmux');
    expect(full.paneConfig?.invalid).toBe(false);

    // A thrown read keeps fail-open gates and never invents pane admission.
    const configPath = path.join(
      process.env.OPENCODE_CONFIG_DIR as string,
      'oh-my-opencode-slim.json',
    );
    fs.writeFileSync(configPath, '{ invalid');
    const broken = readTuiGates(env.projectDir);
    expect(broken.gates.configInvalid).toBe(true);
    // Broken config forces pane admission off rather than guessing a type.
    expect(broken.paneConfig?.invalid).toBe(true);
  });

  test('independently reachable internal setup honors tui false', async () => {
    writeUserConfig({ tui: false });

    const cleanup = await tuiPlugin.setup({
      location: { directory: env.projectDir },
    } as unknown as Parameters<typeof tuiPlugin.setup>[0]);

    expect(cleanup).toBeUndefined();
  });

  test('threads hostFlavor to feature gates during TUI gate probe', () => {
    writeUserConfig({ backgroundJobs: { mode: 'managed' } });

    // On v1 or unmarked host, probe succeeds with managed gates
    const v1 = readTuiGates(env.projectDir, 'v1');
    expect(v1.readFailed).toBe(false);
    expect(v1.gates.tuiEnabled).toBe(true);

    // On v2 host, explicit managed mode causes the config read to fail
    // and probeTuiGates catches it, returning failOpen gates with readFailed: true
    const v2 = readTuiGates(env.projectDir, 'v2');
    expect(v2.readFailed).toBe(true);
    expect(v2.gates.tuiEnabled).toBe(true);
  });

  test('v2 off disables session preset routing without disabling preset editing', () => {
    writeUserConfig({
      preset: 'kept',
      backgroundJobs: { mode: 'off' },
      presets: { kept: { orchestrator: { model: 'openai/gpt-5-mini' } } },
    });

    const off = readTuiGates(env.projectDir, 'v2').gates;
    expect(off.presetRouting).toBe(false);
    expect(off.tuiEnabled).toBe(true);
    expect(off.presetName).toBe('kept');

    writeUserConfig({ backgroundJobs: { mode: 'native' } });
    expect(readTuiGates(env.projectDir, 'v2').gates.presetRouting).toBe(true);
  });

  describe('sidebar polling intervals', () => {
    test('sidebar-on rendering keeps the fast 1s poll', async () => {
      writeUserConfig({});
      const intervals = spyOnIntervals();
      const { api, disposers } = makeSidebarApi(env.projectDir);
      try {
        await runSidebar(api);
        expect(intervals.delays).toContain(1000);
        expect(intervals.delays).toContain(100);
        expect(intervals.delays).not.toContain(5000);
      } finally {
        for (const dispose of disposers) await dispose();
        intervals.restore();
      }
    });

    test('sidebar-off config polling uses the slow 5s interval', async () => {
      writeUserConfig({});
      writeProjectConfig(env.projectDir, { sidebar: false });
      const intervals = spyOnIntervals();
      const { api, disposers } = makeSidebarApi(env.projectDir);
      try {
        await runSidebar(api);
        expect(intervals.delays).toContain(5000);
        expect(intervals.delays).not.toContain(1000);
        expect(intervals.delays).not.toContain(100);
      } finally {
        for (const dispose of disposers) await dispose();
        intervals.restore();
      }
    });

    test('the refresh test hook overrides either poll interval', async () => {
      process.env.OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS = '42';
      writeUserConfig({});
      const fastIntervals = spyOnIntervals();
      const fast = makeSidebarApi(env.projectDir);
      try {
        await runSidebar(fast.api);
        expect(fastIntervals.delays).toContain(42);
        expect(fastIntervals.delays).not.toContain(1000);
      } finally {
        for (const dispose of fast.disposers) await dispose();
        fastIntervals.restore();
      }

      writeProjectConfig(env.projectDir, { sidebar: false });
      const slowIntervals = spyOnIntervals();
      const slow = makeSidebarApi(env.projectDir);
      try {
        await runSidebar(slow.api);
        expect(slowIntervals.delays).toContain(42);
        expect(slowIntervals.delays).not.toContain(5000);
      } finally {
        for (const dispose of slow.disposers) await dispose();
        slowIntervals.restore();
      }
    });
  });
});
