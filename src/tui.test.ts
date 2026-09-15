import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RGBA } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { readTmuxPane } from './multiplexer/tmux-pane-registry';
import {
  type ActiveTmuxPaneRegistration,
  applyRemoteAgentModels,
  compareAliasNumeric,
  createSerializedRefresh,
  createSidebarInteraction,
  fetchRemoteAgentModels,
  getActiveSidebarAgentNames,
  getContrastForeground,
  getSidebarActivityIndicator,
  getSidebarAgentNames,
  getSidebarAgentTargets,
  isRefreshCurrent,
  makeRouteNavigator,
  readCompactSidebar,
  readConfigInvalid,
  resolveHoverBackground,
  resolveSidebarSlotOrder,
  selectionGuard,
  shortSessionID,
  splitSidebarModelId,
  syncTmuxPaneRegistration,
  default as tuiPlugin,
} from './tui';
import {
  recordTuiAgentActivity,
  recordTuiAgentModels,
  recordTuiSessionParent,
  type TuiSnapshot,
} from './tui-state';

const ACTIVITY_FRAME_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

function createSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    version: 1,
    updatedAt: 0,
    agentModels: {},
    agentVariants: {},
    activeSessions: {},
    activityPids: {},
    sessionParents: {},
    sessionDetails: {},
    ...overrides,
  };
}

describe('tui sidebar agents', () => {
  test('scopes active agents to the visible conversation (#1147)', () => {
    const snapshot = createSnapshot({
      activeSessions: { 'c1-oracle': 'oracle', 'c2-fixer': 'fixer' },
      sessionParents: { 'c1-oracle': 'conv-1', 'c2-fixer': 'conv-2' },
    });

    expect(getActiveSidebarAgentNames(snapshot, 'conv-1')).toEqual(
      new Set(['oracle']),
    );
    expect(getActiveSidebarAgentNames(snapshot, 'conv-2')).toEqual(
      new Set(['fixer']),
    );
    // Home route: no visible conversation, keep the union.
    expect(getActiveSidebarAgentNames(snapshot)).toEqual(
      new Set(['oracle', 'fixer']),
    );
  });

  test('navigating into a child route keeps its own spinner visible', () => {
    const snapshot = createSnapshot({
      activeSessions: { 'child-a': 'oracle' },
      sessionParents: { 'child-a': 'root-a' },
    });

    // Route points at the child; it must resolve to its root before
    // filtering, otherwise its own spinner disappears (#1147).
    expect(getActiveSidebarAgentNames(snapshot, 'child-a')).toEqual(
      new Set(['oracle']),
    );
    expect(getActiveSidebarAgentNames(snapshot, 'root-a')).toEqual(
      new Set(['oracle']),
    );
  });

  test('hides disabled agents when models are persisted explicitly', () => {
    const agentNames = getSidebarAgentNames(
      createSnapshot({
        agentModels: {
          explorer: 'openai/gpt-5.6-luna',
          fixer: 'openai/gpt-5.6-luna',
        },
      }),
    );

    expect(agentNames).toEqual(['explorer', 'fixer']);
    expect(agentNames).not.toContain('observer');
    expect(agentNames).not.toContain('librarian');
  });

  test('fills empty snapshot models from the v1 host agent list (#1133)', async () => {
    const seen: unknown[] = [];
    const client = {
      app: {
        async agents(input?: unknown) {
          seen.push(input);
          return {
            data: [
              {
                name: 'explorer',
                model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
              },
              {
                name: 'fixer',
                model: { providerID: 'openai', modelID: 'gpt-5.6' },
              },
              { name: 'unrelated', model: { providerID: 'x', modelID: 'y' } },
              { name: 'oracle' },
            ],
          };
        },
      },
    };

    const remote = await fetchRemoteAgentModels(client, '/tmp/project');
    expect(seen).toEqual([{ directory: '/tmp/project' }]);
    expect(remote).toEqual({
      explorer: 'openai/gpt-5.6-luna',
      fixer: 'openai/gpt-5.6',
    });

    const merged = applyRemoteAgentModels(
      createSnapshot({ agentModels: { explorer: 'local/model' } }),
      remote,
    );
    expect(merged.agentModels).toEqual({
      explorer: 'local/model',
      fixer: 'openai/gpt-5.6',
    });
  });

  test('fills models from the v2 agent.list contract (#1133)', async () => {
    const seen: unknown[] = [];
    const client = {
      agent: {
        async list(input?: unknown) {
          seen.push(input);
          return {
            data: {
              data: [
                {
                  id: 'explorer',
                  model: { providerID: 'openai', id: 'gpt-5.6-luna' },
                },
                {
                  id: 'fixer',
                  model: { providerID: 'openai', id: 'gpt-5.6' },
                },
                { id: 'unrelated', model: { providerID: 'x', id: 'y' } },
                { id: 'oracle' },
              ],
            },
          };
        },
      },
    };

    const remote = await fetchRemoteAgentModels(client, '/srv/project');
    expect(seen).toEqual([{ location: { directory: '/srv/project' } }]);
    expect(remote).toEqual({
      explorer: 'openai/gpt-5.6-luna',
      fixer: 'openai/gpt-5.6',
    });
  });

  test('fills models from nested v2.agent.list (#1133)', async () => {
    const seen: unknown[] = [];
    const client = {
      v2: {
        agent: {
          async list(input?: unknown) {
            seen.push(input);
            return {
              data: {
                location: { directory: '/srv/project' },
                data: [
                  {
                    id: 'explorer',
                    model: { providerID: 'openai', id: 'gpt-5.6-luna' },
                  },
                ],
              },
            };
          },
        },
      },
    };

    const remote = await fetchRemoteAgentModels(client, '/srv/project');
    expect(seen).toEqual([{ location: { directory: '/srv/project' } }]);
    expect(remote).toEqual({ explorer: 'openai/gpt-5.6-luna' });
  });

  test('remote model fetch is a no-op without a host client', async () => {
    expect(await fetchRemoteAgentModels(undefined, '/tmp/project')).toEqual({});
    expect(applyRemoteAgentModels(createSnapshot({}), {}).agentModels).toEqual(
      {},
    );
  });

  test('serialized refresh skips overlap and drops a stale directory (#1133)', async () => {
    expect(isRefreshCurrent('/a', '/a')).toBe(true);
    expect(isRefreshCurrent('/a', '/b')).toBe(false);

    let running = 0;
    let started = 0;
    let finished = 0;
    const release: Array<() => void> = [];
    const schedule = createSerializedRefresh(async () => {
      started += 1;
      running += 1;
      await new Promise<void>((resolve) => {
        release.push(() => {
          running -= 1;
          finished += 1;
          resolve();
        });
      });
    });

    schedule();
    schedule();
    expect(started).toBe(1);
    expect(running).toBe(1);
    release[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(1);
    schedule();
    expect(started).toBe(2);
    release[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(2);
  });

  test('uses default-enabled fallback before models are persisted', () => {
    const agentNames = getSidebarAgentNames(createSnapshot({}));

    expect(agentNames).toContain('explorer');
    expect(agentNames).toContain('fixer');
    expect(agentNames).not.toContain('observer');
    expect(agentNames).not.toContain('council');
    expect(agentNames).not.toContain('councillor');
  });

  test('derives active agents from concurrent session activity', () => {
    const activeAgents = getActiveSidebarAgentNames(
      createSnapshot({
        activeSessions: {
          'fixer-a': 'fixer',
          'fixer-b': 'fixer',
          'oracle-a': 'oracle',
        },
      }),
    );

    expect([...activeAgents]).toEqual(['fixer', 'oracle']);
  });

  test('renders a stable blank column or deterministic braille frame', () => {
    expect(getSidebarActivityIndicator(false, 0)).toBe(' ');
    expect(getSidebarActivityIndicator(true, 0)).toBe('⠋');
    expect(getSidebarActivityIndicator(true, 100)).toBe('⠙');
    expect(getSidebarActivityIndicator(true, 1_000)).toBe('⠋');
  });

  test('keeps compact agent rows single-line with truncated right-aligned model IDs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-compact-row-'));
    const projectDir = path.join(root, 'project');
    const disposers: Array<() => void> = [];
    let slotPlugin: { slots: { sidebar_content: () => unknown } } | undefined;
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      fs.mkdirSync(projectDir, { recursive: true });
      recordTuiAgentModels(
        {
          agentModels: {
            explorer: 'fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo',
            oracle: 'openai/gpt-5.6-luna-fast',
          },
        },
        projectDir,
      );

      await tuiPlugin.tui(
        {
          state: { path: { directory: projectDir } },
          route: { current: { name: 'home' } },
          lifecycle: {
            onDispose: (callback: () => void) => {
              disposers.push(callback);
              return () => {};
            },
          },
          renderer: { requestRender: () => {} },
          slots: {
            register: (plugin: typeof slotPlugin) => {
              slotPlugin = plugin;
              return 'test-slot';
            },
          },
          theme: {
            current: {
              accent: '#22c55e',
              background: '#111111',
              borderActive: '#555555',
              text: '#ffffff',
              textMuted: '#aaaaaa',
            },
          },
        } as Parameters<typeof tuiPlugin.tui>[0],
        {},
        { version: 'test' } as Parameters<typeof tuiPlugin.tui>[2],
      );

      setup = await testRender(
        () => slotPlugin?.slots.sidebar_content() as never,
        { width: 36, height: 14 },
      );
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      const lines = frame.split('\n').map((l) => l.trimEnd());

      // Find the explorer and oracle lines
      const explorerLineIdx = lines.findIndex((l) => l.includes('explorer'));
      const oracleLineIdx = lines.findIndex((l) => l.includes('oracle'));

      expect(explorerLineIdx).toBeGreaterThan(-1);
      expect(oracleLineIdx).toBe(explorerLineIdx + 1); // Strictly adjacent consecutive rows (no multi-line wrapping)

      // Explorer row should have the agent label on left and truncated model on right
      const explorerLine = lines[explorerLineIdx];
      expect(explorerLine).toMatch(/explorer\s+account\.\.\.p5-turbo/);

      // Oracle row should be single-line with right-aligned model
      const oracleLine = lines[oracleLineIdx];
      expect(oracleLine).toMatch(/oracle\s+gpt-5\.6-luna-fast/);

      // No unwrapped model path fragments should appear on separate lines
      expect(frame).not.toMatch(/fireworks\/routers\//);
    } finally {
      setup?.renderer.destroy();
      for (const dispose of disposers) dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('live TUI activity rendering', () => {
  test('updates a mounted v1 sidebar when an agent becomes active', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-spinner-live-'));
    const projectDir = path.join(root, 'project');
    const originalDataHome = process.env.XDG_DATA_HOME;
    const disposers: Array<() => void> = [];
    let slotPlugin: { slots: { sidebar_content: () => unknown } } | undefined;
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.XDG_DATA_HOME = path.join(root, 'data');
      recordTuiAgentModels(
        { agentModels: { explorer: 'openai/gpt-5.6-luna-fast' } },
        projectDir,
      );

      await tuiPlugin.tui(
        {
          state: { path: { directory: projectDir } },
          route: { current: { name: 'home' } },
          lifecycle: {
            onDispose: (callback: () => void) => {
              disposers.push(callback);
              return () => {};
            },
          },
          renderer: { requestRender: () => {} },
          slots: {
            register: (plugin: typeof slotPlugin) => {
              slotPlugin = plugin;
              return 'activity-test-slot';
            },
          },
          theme: {
            current: {
              accent: '#22c55e',
              background: '#111111',
              borderActive: '#555555',
              text: '#ffffff',
              textMuted: '#aaaaaa',
            },
          },
        } as Parameters<typeof tuiPlugin.tui>[0],
        {},
        { version: 'test' } as Parameters<typeof tuiPlugin.tui>[2],
      );

      setup = await testRender(
        () => slotPlugin?.slots.sidebar_content() as never,
        { width: 52, height: 14 },
      );
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toMatch(ACTIVITY_FRAME_PATTERN);

      recordTuiAgentActivity(
        {
          sessionID: 'explorer-session',
          agentName: 'explorer',
          active: true,
        },
        projectDir,
      );
      await Bun.sleep(1_100);
      await setup.renderOnce();

      const firstFrame = setup
        .captureCharFrame()
        .match(ACTIVITY_FRAME_PATTERN)?.[0];
      expect(firstFrame).toBeDefined();

      await Bun.sleep(200);
      await setup.renderOnce();
      const nextFrame = setup
        .captureCharFrame()
        .match(ACTIVITY_FRAME_PATTERN)?.[0];
      expect(nextFrame).toBeDefined();
      expect(nextFrame).not.toBe(firstFrame);
    } finally {
      setup?.renderer.destroy();
      for (const dispose of disposers) dispose();
      fs.rmSync(root, { recursive: true, force: true });
      if (originalDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = originalDataHome;
      }
    }
  });
});

describe('splitSidebarModelId', () => {
  test('splits provider from model at the first slash', () => {
    expect(splitSidebarModelId('openai/gpt-5.6-fast')).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-fast',
    });
    expect(
      splitSidebarModelId(
        'fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo',
      ),
    ).toEqual({
      provider: 'fireworks-ai',
      model: 'accounts/fireworks/routers/kimi-k2p5-turbo',
    });
  });

  test('keeps slashless names as model only', () => {
    expect(splitSidebarModelId('pending')).toEqual({ model: 'pending' });
  });
});

describe('readConfigInvalid', () => {
  let originalEnv: typeof process.env;
  let configHome: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Isolate from real user config and env presets
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-env-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    fs.rmSync(configHome, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('detects invalid config from the current directory without persisted state', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const configDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ agents: { oracle: { temperature: 5 } } }),
      );

      expect(readConfigInvalid(projectDir)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns false for valid config', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const configDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ agents: { oracle: { model: 'valid/model' } } }),
      );

      expect(readConfigInvalid(projectDir)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns false for config with deprecated fallback keys (loads fine)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const configDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          fallback: {
            enabled: true,
            timeoutMs: 15000,
            runtimeOverride: true,
          },
          agents: { oracle: { model: 'valid/model' } },
        }),
      );

      // Deprecated fallback keys are stripped with a warning; the config
      // loads successfully so the sidebar must NOT show "Config invalid".
      expect(readConfigInvalid(projectDir)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns false for config with normalized disabled_* string', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const configDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          disabled_agents: 'explorer',
          agents: { oracle: { model: 'valid/model' } },
        }),
      );

      // The string key is normalized to an array with a 'normalized' warning
      // (not invalid-schema), so the config loads fine and the sidebar must
      // NOT show "Config invalid".
      expect(readConfigInvalid(projectDir)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('uses compact sidebar by default', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      expect(readCompactSidebar(projectDir)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('allows expanded sidebar config', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const configDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ compactSidebar: false }),
      );

      expect(readCompactSidebar(projectDir)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('tui plugin env disable', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('does not perform setup when plugin is disabled by env', async () => {
    process.env.OH_MY_OPENCODE_SLIM_DISABLE = '1';

    let disposeRegistered = false;
    let renderRequested = false;
    let registered = false;
    await tuiPlugin.tui(
      {
        lifecycle: {
          onDispose: () => {
            disposeRegistered = true;
          },
        },
        renderer: {
          requestRender: () => {
            renderRequested = true;
          },
        },
        slots: {
          register: () => {
            registered = true;
          },
        },
        theme: { current: {} },
      } as unknown as Parameters<typeof tuiPlugin.tui>[0],
      {},
      { version: 'test' } as Parameters<typeof tuiPlugin.tui>[2],
    );

    expect(registered).toBe(false);
    expect(disposeRegistered).toBe(false);
    expect(renderRequested).toBe(false);
  });
});

describe('tmux pane registration', () => {
  let originalEnv: typeof process.env;
  let stateDirectory: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tmux-tui-'));
    process.env.XDG_DATA_HOME = stateDirectory;
    process.env.TMUX_PANE = '%42';
  });

  afterEach(() => {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('records the local pane for the active attached session', () => {
    const registration: ActiveTmuxPaneRegistration = {
      ownerPid: 100,
      lastRecordedAt: 0,
    };

    syncTmuxPaneRegistration(
      { name: 'session', params: { sessionID: 'root-session-b' } },
      registration,
      1_000,
    );

    expect(readTmuxPane('root-session-b', 1_000)).toBe('%42');
  });

  test('moves registration when the local TUI selects another session', () => {
    const registration: ActiveTmuxPaneRegistration = {
      ownerPid: 100,
      lastRecordedAt: 0,
    };
    const route = { name: 'session', params: { sessionID: 'root-a' } };

    syncTmuxPaneRegistration(route, registration, 1_000);
    route.params.sessionID = 'root-b';
    syncTmuxPaneRegistration(route, registration, 2_000);

    expect(readTmuxPane('root-a', 2_000)).toBeUndefined();
    expect(readTmuxPane('root-b', 2_000)).toBe('%42');
  });

  test('accepts the v2 route shape ({ type, sessionID })', () => {
    const registration: ActiveTmuxPaneRegistration = {
      ownerPid: 100,
      lastRecordedAt: 0,
    };

    syncTmuxPaneRegistration(
      { type: 'session', sessionID: 'v2-session' },
      registration,
      1_000,
    );

    expect(readTmuxPane('v2-session', 1_000)).toBe('%42');
  });
});

describe('getContrastForeground', () => {
  const white = RGBA.fromInts(255, 255, 255);
  const black = RGBA.fromInts(0, 0, 0);
  const darkGray = RGBA.fromInts(30, 30, 30);
  const transparent = RGBA.fromInts(0, 0, 0, 0);

  test('returns theme text when fallback is triggered', () => {
    expect(getContrastForeground(undefined, 'theme-text', 'theme-bg')).toBe(
      'theme-text',
    );
  });

  test('returns black on a light background', () => {
    // White background -> black text
    const result = getContrastForeground(white, white, black) as RGBA;
    expect(result.toInts()).toEqual([0, 0, 0, 255]);
  });

  test('returns white on a dark background', () => {
    // Black background -> white text
    const result = getContrastForeground(black, white, black) as RGBA;
    expect(result.toInts()).toEqual([255, 255, 255, 255]);
  });

  test('respects themeBackground if it is dark and solid when accent is light', () => {
    const result = getContrastForeground(white, white, darkGray) as RGBA;
    expect(result.toInts()).toEqual([30, 30, 30, 255]);
  });

  test('never returns transparent themeBackground even if accent is light', () => {
    const result = getContrastForeground(white, white, transparent) as RGBA;
    expect(result.toInts()).toEqual([0, 0, 0, 255]);
  });

  test('respects themeText if it is light when accent is dark', () => {
    const result = getContrastForeground(black, white, black) as RGBA;
    expect(result.toInts()).toEqual([255, 255, 255, 255]);
  });

  test('parses hex string colors correctly', () => {
    const result = getContrastForeground('#ffffff', '#ffffff', '#1e1e1e');
    expect(result).toBe('#1e1e1e');
  });
});

describe('dual-contract plugin module', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createV2Context(directory: string) {
    const slotClaims: Array<{
      append?: string;
      render: (input: { sessionID: string }) => unknown;
    }> = [];
    let disposeCalls = 0;
    const ctx = {
      location: { directory },
      renderer: { requestRender: () => {} },
      theme: {
        text: { default: '#f0f0f0', subdued: '#8a8a8a' },
        background: { default: '#101010' },
        border: { default: '#3a3a3a' },
      },
      ui: {
        slot: (claim: (typeof slotClaims)[number]) => {
          slotClaims.push(claim);
          return () => {
            disposeCalls += 1;
          };
        },
        router: {
          current: () =>
            ({ type: 'home' }) as {
              type?: string;
              sessionID?: string;
            },
        },
      },
    };
    return {
      ctx,
      slotClaims,
      getDisposeCalls: () => disposeCalls,
    };
  }

  type V2Context = Parameters<typeof tuiPlugin.setup>[0];

  test('exposes the dual contract shape', () => {
    expect(typeof tuiPlugin.id).toBe('string');
    expect(tuiPlugin.id.length).toBeGreaterThan(0);
    expect(typeof tuiPlugin.tui).toBe('function');
    expect(typeof tuiPlugin.setup).toBe('function');
  });

  test('setup registers one sidebar.content slot and cleanup disposes it', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-v2-'));
    let cleanup: (() => void) | undefined;
    try {
      const { ctx, slotClaims, getDisposeCalls } = createV2Context(tempDir);
      cleanup = (await tuiPlugin.setup(
        ctx as unknown as V2Context,
      )) as () => void;

      expect(slotClaims).toHaveLength(1);
      expect(slotClaims[0]?.append).toBe('sidebar.content');
      expect(typeof slotClaims[0]?.render).toBe('function');
      expect(getDisposeCalls()).toBe(0);

      cleanup();
      expect(getDisposeCalls()).toBe(1);
    } finally {
      cleanup?.();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('setup returns early without registering a slot when disabled by env', async () => {
    process.env.OH_MY_OPENCODE_SLIM_DISABLE = '1';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-v2-'));
    try {
      const { ctx, slotClaims } = createV2Context(tempDir);
      const cleanup = await tuiPlugin.setup(ctx as unknown as V2Context);

      expect(slotClaims).toHaveLength(0);
      expect(cleanup).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('clickable sidebar sessions', () => {
  test('getSidebarAgentTargets groups active subagents by agent with alias/model/status', () => {
    const snapshot = createSnapshot({
      activeSessions: {
        'ora-1-ses': 'oracle',
        'ora-2-ses': 'oracle',
        'fix-ses': 'fixer',
        'root-ses': 'oracle',
      },
      sessionParents: {
        'ora-1-ses': 'conv-1',
        'ora-2-ses': 'conv-1',
        'fix-ses': 'conv-1',
        // root-ses has no parent: a root session running oracle directly
        // must not be offered as a subagent destination.
      },
      sessionDetails: {
        'ora-1-ses': {
          alias: 'ora-1',
          model: 'openai/gpt-5.6',
          status: 'busy',
        },
        'ora-2-ses': { alias: 'ora-2', status: 'retry' },
      },
    });

    const targets = getSidebarAgentTargets(snapshot, 'conv-1');
    expect(targets.map((t) => t.agentName).sort()).toEqual(['fixer', 'oracle']);
    const oracle = targets.find((t) => t.agentName === 'oracle');
    expect(oracle?.sessions.map((s) => s.sessionID)).toEqual([
      'ora-1-ses',
      'ora-2-ses',
    ]);
    expect(oracle?.sessions[0].alias).toBe('ora-1');
    expect(oracle?.sessions[0].model).toBe('openai/gpt-5.6');
    expect(oracle?.sessions[1].status).toBe('retry');

    // Other conversation: no targets even though sessions are active.
    expect(getSidebarAgentTargets(snapshot, 'conv-2')).toEqual([]);
    // Home route: no scoping possible, no navigation offered.
    expect(getSidebarAgentTargets(snapshot, undefined)).toEqual([]);
  });

  test('alias ordering is numeric (ora-2 before ora-10), unaliased last', () => {
    const snapshot = createSnapshot({
      activeSessions: {
        a: 'oracle',
        b: 'oracle',
        c: 'oracle',
      },
      sessionParents: { a: 'conv', b: 'conv', c: 'conv' },
      sessionDetails: {
        a: { alias: 'ora-10' },
        b: { alias: 'ora-2' },
        // c has no alias (board record dropped): sorts last by sessionID.
      },
    });
    const [group] = getSidebarAgentTargets(snapshot, 'conv');
    expect(group.sessions.map((s) => s.sessionID)).toEqual(['b', 'a', 'c']);
    expect(compareAliasNumeric('ora-2', 'ora-10')).toBeLessThan(0);
  });

  test('expansion state: toggle, independent agents, reset on scope change', () => {
    const interaction = createSidebarInteraction((id) => id);
    expect(interaction.expandedAgents().size).toBe(0);
    interaction.toggleAgent('oracle');
    interaction.toggleAgent('fixer');
    expect([...interaction.expandedAgents()].sort()).toEqual([
      'fixer',
      'oracle',
    ]);
    // Toggle off one leaves the other.
    interaction.toggleAgent('oracle');
    expect([...interaction.expandedAgents()]).toEqual(['fixer']);
    // Same conversation root: navigating parent→child must not reset.
    interaction.syncScope('/p', 'conv-1');
    expect([...interaction.expandedAgents()]).toEqual(['fixer']);
    interaction.syncScope('/p', 'conv-1');
    expect([...interaction.expandedAgents()]).toEqual(['fixer']);
    // Root change within the same project resets expansion.
    interaction.syncScope('/p', 'conv-2');
    expect(interaction.expandedAgents().size).toBe(0);
  });

  test('makeRouteNavigator wraps v1 (name,params) and v2 (route object) shapes', () => {
    const v1Calls: unknown[][] = [];
    const v1Owner = {
      navigate(...args: unknown[]) {
        v1Calls.push([this === v1Owner, ...args]);
      },
    };
    const v1 = makeRouteNavigator(v1Owner, 'navigate', false);
    v1?.('ses-1');
    expect(v1Calls).toEqual([[true, 'session', { sessionID: 'ses-1' }]]);

    const v2Calls: unknown[] = [];
    const v2Owner = {
      navigate(route: unknown) {
        v2Calls.push({ self: this === v2Owner, route });
      },
    };
    const v2 = makeRouteNavigator(v2Owner, 'navigate', true);
    v2?.('ses-2');
    expect(v2Calls).toEqual([
      { self: true, route: { type: 'session', sessionID: 'ses-2' } },
    ]);

    expect(makeRouteNavigator(undefined, 'navigate', false)).toBeUndefined();
    expect(makeRouteNavigator({}, 'navigate', false)).toBeUndefined();
    const throwingOwner = {
      navigate() {
        throw new Error('host');
      },
    };
    const throwing = makeRouteNavigator(throwingOwner, 'navigate', false);
    expect(() => throwing?.('ses-3')).not.toThrow();
  });

  test('resolveHoverBackground prefers theme.hover then backgroundElement', () => {
    expect(
      resolveHoverBackground({
        hover: '#333333',
        backgroundElement: '#222222',
        background: '#111111',
        text: '#ffffff',
      }),
    ).toBe('#333333');
    expect(
      resolveHoverBackground({
        backgroundElement: '#222222',
        background: '#111111',
        text: '#ffffff',
      }),
    ).toBe('#222222');
  });

  test('expansion state is local to each sidebar instance', () => {
    const first = createSidebarInteraction((id) => id);
    const second = createSidebarInteraction((id) => id);
    first.toggleAgent('oracle');
    expect([...first.expandedAgents()]).toEqual(['oracle']);
    expect(second.expandedAgents().size).toBe(0);
  });

  test('selectionGuard only blocks non-empty selected text', () => {
    let selected = '';
    const guard = selectionGuard({
      getSelection: () => ({
        getSelectedText: () => selected,
      }),
    });

    expect(guard()).toBe(false);
    selected = 'selected text';
    expect(guard()).toBe(true);
  });

  test('duplicate aliases in the same group get a short id suffix', () => {
    const snapshot = createSnapshot({
      activeSessions: {
        ses_aaaa1111bbbb2222: 'oracle',
        ses_cccc3333dddd4444: 'oracle',
      },
      sessionParents: {
        ses_aaaa1111bbbb2222: 'conv',
        ses_cccc3333dddd4444: 'conv',
      },
      sessionDetails: {
        ses_aaaa1111bbbb2222: { alias: 'ora-1' },
        ses_cccc3333dddd4444: { alias: 'ora-1' },
      },
    });
    const [group] = getSidebarAgentTargets(snapshot, 'conv');
    expect(group.sessions.map((s) => s.alias)).toEqual([
      'ora-1 bbbb2222',
      'ora-1 dddd4444',
    ]);
  });

  test('shortSessionID keeps ids readable for unaliased rows', () => {
    expect(shortSessionID('ses_1234567890abcdef')).toBe('90abcdef');
    expect(shortSessionID('short')).toBe('short');
  });

  test('mouse contract: onMouseUp via element/setProp fires on click, onClick does not', async () => {
    // @opentui 0.5.8: Renderable exposes setters for onMouseUp/Over/Out but
    // NOT for onClick — assigning onClick via setProp is a silent no-op.
    // Our sidebar helpers (element/setProp) must use the mouse setters, and
    // clicks must bubble from the text child to the parent box handler.
    const { createElement, insert, setProp } = await import('@opentui/solid');

    const events: string[] = [];
    const setup = await testRender(
      () => {
        const root = createElement('box');
        setProp(root, 'width', '100%');
        setProp(root, 'height', 3);
        setProp(root, 'onMouseUp', () => events.push('up'));
        setProp(root, 'onMouseOver', () => events.push('over'));
        setProp(root, 'onClick', () => events.push('click-should-not-fire'));
        const label = createElement('text');
        insert(label, 'clickme');
        insert(root, label);
        return root as never;
      },
      { width: 20, height: 6 },
    );

    try {
      await setup.renderOnce();
      const lines = setup.captureCharFrame().split('\n');
      const row = lines.findIndex((l) => l.includes('clickme'));
      expect(row).toBeGreaterThan(-1);
      const col = lines[row].indexOf('clickme');

      await setup.mockMouse.moveTo(col + 2, row);
      await setup.mockMouse.click(col + 2, row);

      expect(events).toContain('up');
      expect(events).toContain('over');
      expect(events).not.toContain('click-should-not-fire');
    } finally {
      setup.renderer.destroy();
    }
  });

  async function mountClickableSidebar(opts: {
    projectDir: string;
    sessionID: string;
    navigate?: (name: string, params?: Record<string, unknown>) => void;
  }) {
    const disposers: Array<() => void> = [];
    let slotPlugin: { slots: { sidebar_content: () => unknown } } | undefined;
    await tuiPlugin.tui(
      {
        state: { path: { directory: opts.projectDir } },
        route: {
          current: { name: 'session', params: { sessionID: opts.sessionID } },
          navigate: opts.navigate,
        },
        lifecycle: {
          onDispose: (callback: () => void) => {
            disposers.push(callback);
            return () => {};
          },
        },
        renderer: { requestRender: () => {} },
        slots: {
          register: (plugin: typeof slotPlugin) => {
            slotPlugin = plugin;
            return 'click-slot';
          },
        },
        theme: {
          current: {
            accent: '#22c55e',
            background: '#111111',
            backgroundElement: '#222222',
            borderActive: '#555555',
            success: '#00ff00',
            text: '#ffffff',
            textMuted: '#aaaaaa',
            warning: '#ffcc00',
          },
        },
      } as Parameters<typeof tuiPlugin.tui>[0],
      {},
      { version: 'test' } as Parameters<typeof tuiPlugin.tui>[2],
    );
    return { slotPlugin, disposers };
  }

  function withIsolatedDataHome(root: string): () => void {
    const originalDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(root, 'data');
    return () => {
      if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalDataHome;
    };
  }

  test('mounted sidebar: 1 session navigates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-click-'));
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const restoreDataHome = withIsolatedDataHome(root);
    const navigated: unknown[] = [];
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    let mounted: Awaited<ReturnType<typeof mountClickableSidebar>> | undefined;

    try {
      recordTuiAgentModels(
        { agentModels: { oracle: 'openai/gpt-5.6' } },
        projectDir,
      );
      recordTuiSessionParent('ora-only', 'conv-1', projectDir);
      recordTuiAgentActivity(
        {
          sessionID: 'ora-only',
          agentName: 'oracle',
          active: true,
          details: { alias: 'ora-1', status: 'busy' },
        },
        projectDir,
      );

      mounted = await mountClickableSidebar({
        projectDir,
        sessionID: 'conv-1',
        navigate: (...args) => {
          navigated.push(args);
        },
      });
      setup = await testRender(
        () => mounted?.slotPlugin?.slots.sidebar_content() as never,
        { width: 52, height: 16 },
      );
      await setup.renderOnce();

      const lines = setup.captureCharFrame().split('\n');
      const oracleRow = lines.findIndex((l) => l.includes('oracle'));
      expect(oracleRow).toBeGreaterThan(-1);
      const col = Math.max(lines[oracleRow].indexOf('oracle'), 0);
      await setup.mockMouse.click(col + 2, oracleRow);
      expect(navigated).toEqual([['session', { sessionID: 'ora-only' }]]);
    } finally {
      setup?.renderer.destroy();
      for (const dispose of mounted?.disposers ?? []) dispose();
      restoreDataHome();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('mounted sidebar: N sessions expand on first click, child click navigates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-click-n-'));
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const restoreDataHome = withIsolatedDataHome(root);
    const navigated: unknown[] = [];
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    let mounted: Awaited<ReturnType<typeof mountClickableSidebar>> | undefined;

    try {
      recordTuiAgentModels(
        { agentModels: { oracle: 'openai/gpt-5.6' } },
        projectDir,
      );
      recordTuiSessionParent('ora-a', 'conv-1', projectDir);
      recordTuiSessionParent('ora-b', 'conv-1', projectDir);
      recordTuiAgentActivity(
        {
          sessionID: 'ora-a',
          agentName: 'oracle',
          active: true,
          details: {
            alias: 'ora-1',
            model: 'openai/gpt-6-astra-xhigh',
            status: 'busy',
          },
        },
        projectDir,
      );
      recordTuiAgentActivity(
        {
          sessionID: 'ora-b',
          agentName: 'oracle',
          active: true,
          details: {
            alias: 'ora-2',
            model: 'anthropic/claude-opus-long-context',
            status: 'retry',
          },
        },
        projectDir,
      );

      mounted = await mountClickableSidebar({
        projectDir,
        sessionID: 'conv-1',
        navigate: (...args) => {
          navigated.push(args);
        },
      });
      setup = await testRender(
        () => mounted?.slotPlugin?.slots.sidebar_content() as never,
        { width: 80, height: 18 },
      );
      await setup.renderOnce();

      let lines = setup.captureCharFrame().split('\n');
      const oracleRow = lines.findIndex((l) => l.includes('oracle'));
      expect(oracleRow).toBeGreaterThan(-1);
      const col = Math.max(lines[oracleRow].indexOf('oracle'), 0);
      await setup.mockMouse.click(col + 2, oracleRow);
      expect(navigated).toEqual([]);

      await setup.renderOnce();
      lines = setup.captureCharFrame().split('\n');
      const childRow = lines.findIndex((l) => l.includes('ora-1'));
      expect(childRow).toBeGreaterThan(-1);
      const firstChildLine = lines[childRow];
      const secondChildRow = lines.findIndex(
        (line, index) => index > childRow && line.includes('ora-2'),
      );
      expect(secondChildRow).toBeGreaterThan(childRow);
      const secondChildLine = lines[secondChildRow];
      expect(firstChildLine.indexOf('active')).toBeGreaterThan(
        firstChildLine.indexOf('gpt-6-astra-xhigh'),
      );
      expect(firstChildLine).toMatch(/gpt-6-astra-xhigh\s+active/);
      expect(secondChildLine).toMatch(/claude-opus-long-context\s+retrying/);

      const beforeHover = setup
        .captureSpans()
        .lines.map((line) =>
          line.spans.map((span) => [
            span.bg.r,
            span.bg.g,
            span.bg.b,
            span.bg.a,
          ]),
        );
      const childCol = Math.max(lines[childRow].indexOf('ora-1'), 0);
      await setup.mockMouse.moveTo(childCol + 1, childRow);
      await setup.renderOnce();
      const afterHover = setup
        .captureSpans()
        .lines.map((line) =>
          line.spans.map((span) => [
            span.bg.r,
            span.bg.g,
            span.bg.b,
            span.bg.a,
          ]),
        );
      expect(afterHover[childRow]).not.toEqual(beforeHover[childRow]);
      expect(afterHover[secondChildRow]).toEqual(beforeHover[secondChildRow]);
      await setup.mockMouse.click(childCol + 1, childRow);
      expect(navigated).toEqual([['session', { sessionID: 'ora-a' }]]);
    } finally {
      setup?.renderer.destroy();
      for (const dispose of mounted?.disposers ?? []) dispose();
      restoreDataHome();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('mounted sidebar without navigate does not act', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-click-none-'));
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const restoreDataHome = withIsolatedDataHome(root);
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    let mounted: Awaited<ReturnType<typeof mountClickableSidebar>> | undefined;

    try {
      recordTuiAgentModels(
        { agentModels: { oracle: 'openai/gpt-5.6' } },
        projectDir,
      );
      recordTuiSessionParent('ora-only', 'conv-1', projectDir);
      recordTuiAgentActivity(
        {
          sessionID: 'ora-only',
          agentName: 'oracle',
          active: true,
          details: { alias: 'ora-1', status: 'busy' },
        },
        projectDir,
      );

      mounted = await mountClickableSidebar({
        projectDir,
        sessionID: 'conv-1',
      });
      setup = await testRender(
        () => mounted?.slotPlugin?.slots.sidebar_content() as never,
        { width: 52, height: 16 },
      );
      await setup.renderOnce();
      const lines = setup.captureCharFrame().split('\n');
      const oracleRow = lines.findIndex((l) => l.includes('oracle'));
      expect(oracleRow).toBeGreaterThan(-1);
      await setup.mockMouse.click(2, oracleRow);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain('ora-1');
    } finally {
      setup?.renderer.destroy();
      for (const dispose of mounted?.disposers ?? []) dispose();
      restoreDataHome();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveSidebarSlotOrder', () => {
  const NAME = 'oh-my-opencode-slim';

  test('index 0 lands at 110, right after the host context section', () => {
    expect(resolveSidebarSlotOrder([`file:///w/${NAME}`], NAME)).toBe(110);
  });

  test('later indexes map to later bands of 100', () => {
    expect(
      resolveSidebarSlotOrder(
        ['@cortexkit/opencode-magic-context@0.42.4', `file:///w/${NAME}`],
        NAME,
      ),
    ).toBe(210);
  });

  test('falls back to 900 when the list is missing or not an array', () => {
    expect(resolveSidebarSlotOrder(undefined, NAME)).toBe(900);
    expect(resolveSidebarSlotOrder(null, NAME)).toBe(900);
    expect(resolveSidebarSlotOrder('not-a-list', NAME)).toBe(900);
  });

  test('falls back to 900 when the spec is absent from the list', () => {
    expect(
      resolveSidebarSlotOrder(['@cortexkit/opencode-magic-context'], NAME),
    ).toBe(900);
  });

  test('matches npm specs with versions', () => {
    expect(
      resolveSidebarSlotOrder(['other-plugin', `${NAME}@2.2.20`], NAME),
    ).toBe(210);
  });

  test('matches [spec, options] tuple entries the installer generates', () => {
    expect(
      resolveSidebarSlotOrder(
        [
          ['@cortexkit/opencode-magic-context@0.42.4', {}],
          [`file:///home/raxxor/workspace/${NAME}`, { flag: true }],
        ],
        NAME,
      ),
    ).toBe(210);
  });

  test('does not match a scoped package sharing the basename', () => {
    expect(resolveSidebarSlotOrder([`@other/${NAME}`, 'unrelated'], NAME)).toBe(
      900,
    );
  });

  test('file:// specs with a trailing slash still match', () => {
    expect(resolveSidebarSlotOrder([`file:///w/${NAME}/`], NAME)).toBe(110);
  });

  test('plain absolute local paths match by basename', () => {
    expect(resolveSidebarSlotOrder([`/workspace/${NAME}`], NAME)).toBe(110);
  });

  test('non-string and malformed entries are skipped without shifting index', () => {
    expect(
      resolveSidebarSlotOrder(
        [{ not: 'a spec' }, 42, [''], `file:///w/${NAME}`],
        NAME,
      ),
    ).toBe(410);
  });

  test('v1 registration wires tuiConfig.plugin into the slot order', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-v1-'));
    try {
      const captured: { order?: number }[] = [];
      await tuiPlugin.tui(
        {
          state: { path: { directory: projectDir } },
          route: { current: { name: 'home' } },
          lifecycle: { onDispose: () => () => {} },
          renderer: { requestRender: () => {} },
          slots: {
            register: (plugin: { order?: number }) => {
              captured.push({ order: plugin.order });
              return 'test-slot';
            },
          },
          tuiConfig: {
            plugin: [
              '@cortexkit/opencode-magic-context@0.42.4',
              'file:///home/raxxor/workspace/oh-my-opencode-slim',
            ],
          },
          theme: { current: {} },
        } as unknown as Parameters<typeof tuiPlugin.tui>[0],
        {},
        { version: 'test' } as Parameters<typeof tuiPlugin.tui>[2],
      );

      expect(captured[0]?.order).toBe(210);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('v1 registration falls back to 900 without tuiConfig', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-v1-'));
    try {
      const captured: { order?: number }[] = [];
      await tuiPlugin.tui(
        {
          state: { path: { directory: projectDir } },
          route: { current: { name: 'home' } },
          lifecycle: { onDispose: () => () => {} },
          renderer: { requestRender: () => {} },
          slots: {
            register: (plugin: { order?: number }) => {
              captured.push({ order: plugin.order });
              return 'test-slot';
            },
          },
          theme: { current: {} },
        } as unknown as Parameters<typeof tuiPlugin.tui>[0],
        {},
        { version: 'test' } as Parameters<typeof tuiPlugin.tui>[2],
      );

      expect(captured[0]?.order).toBe(900);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
