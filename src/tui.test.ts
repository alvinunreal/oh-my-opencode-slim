import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TuiSnapshot } from './tui-state';

type TestNode = {
  tag: string;
  props: Record<string, unknown>;
  children: Array<TestNode | string | number>;
};

mock.module('@opentui/solid', () => ({
  createElement: (tag: string): TestNode => ({ tag, props: {}, children: [] }),
  insert: (node: TestNode, child: TestNode | string | number) => {
    node.children.push(child);
  },
  setProp: (node: TestNode, key: string, value: unknown) => {
    node.props[key] = value;
  },
}));

const {
  getSidebarAgentNames,
  readConfigInvalid,
  splitSidebarModelId,
  default: tuiPlugin,
} = await import('./tui');

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
          explorer: 'openai/gpt-5.4-mini',
          fixer: 'openai/gpt-5.4-mini',
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
    expect(splitSidebarModelId('openai/gpt-5.5-fast')).toEqual({
      provider: 'openai',
      model: 'gpt-5.5-fast',
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
});

function nodeText(node: TestNode | string | number): string {
  if (typeof node !== 'object') return String(node);
  return `${node.props.content ?? ''}${node.children.map(nodeText).join('')}`;
}

function findNode(
  node: TestNode,
  predicate: (node: TestNode) => boolean,
): TestNode | undefined {
  if (predicate(node)) return node;

  for (const child of node.children) {
    if (typeof child !== 'object') continue;
    const match = findNode(child, predicate);
    if (match) return match;
  }
}

describe('tui agents dropdown', () => {
  let originalEnv: typeof process.env;
  let tempDir: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-dropdown-'));
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data');
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');

    const stateFile = path.join(
      process.env.XDG_DATA_HOME,
      'opencode/storage/oh-my-opencode-slim/tui-state.json',
    );
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        updatedAt: 0,
        agentModels: { explorer: 'openai/gpt-5.5' },
        agentVariants: {},
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('clicking agents header hides and shows mounted agent rows', async () => {
    let dispose = () => {};
    let sidebarContent: (() => TestNode) | undefined;

    await tuiPlugin.tui(
      {
        state: { path: { directory: tempDir } },
        lifecycle: { onDispose: (fn: () => void) => (dispose = fn) },
        renderer: {
          requestRender: () => {},
        },
        slots: {
          register: (registration: {
            slots: { sidebar_content: () => TestNode };
          }) => {
            sidebarContent = registration.slots.sidebar_content;
          },
        },
        theme: { current: {} },
      } as unknown as Parameters<typeof tuiPlugin.tui>[0],
      {},
      { version: 'test' } as Parameters<typeof tuiPlugin.tui>[2],
    );

    const sidebar = sidebarContent?.();
    if (!sidebar) throw new Error('sidebar content was not registered');

    const header = findNode(
      sidebar,
      (node) => node.tag === 'text' && nodeText(node) === '▼ Agents',
    );
    const toggle = findNode(
      sidebar,
      (node) => typeof node.props.onMouseDown === 'function',
    );
    const row = findNode(
      sidebar,
      (node) =>
        node.tag === 'box' &&
        node.props.visible !== undefined &&
        nodeText(node).includes('explorer'),
    );
    const onMouseDown = toggle?.props.onMouseDown;
    if (!header || typeof onMouseDown !== 'function' || !row) {
      throw new Error('agents dropdown nodes were not rendered');
    }

    expect(row.props.visible).toBe(true);

    onMouseDown();
    expect(header.props.content).toBe('▶ Agents');
    expect(row.props.visible).toBe(false);

    onMouseDown();
    expect(header.props.content).toBe('▼ Agents');
    expect(row.props.visible).toBe(true);

    dispose();
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
