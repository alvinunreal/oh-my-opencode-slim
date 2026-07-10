import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getSidebarAgentNames,
  readCompactSidebar,
  readConfigInvalid,
  splitSidebarModelId,
  default as tuiPlugin,
} from './tui';
import type { TuiSnapshot } from './tui-state';

function createSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    version: 1,
    updatedAt: 0,
    agentModels: {},
    agentVariants: {},
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
