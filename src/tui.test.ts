import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RGBA } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { readTmuxPane } from './multiplexer/tmux-pane-registry';
import {
  type ActiveTmuxPaneRegistration,
  getActiveSidebarAgentNames,
  getContrastForeground,
  getSidebarActivityIndicator,
  getSidebarAgentNames,
  readCompactSidebar,
  readConfigInvalid,
  splitSidebarModelId,
  syncTmuxPaneRegistration,
  default as tuiPlugin,
} from './tui';
import {
  recordTuiAgentActivity,
  recordTuiAgentModels,
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
    ...overrides,
  };
}

describe('tui sidebar agents', () => {
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
