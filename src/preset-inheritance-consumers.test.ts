import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgents } from './agents';
import { runDoctorCheck } from './cli/doctor';
import { loadAgentPrompt, loadPluginConfig, type PluginConfig } from './config';
import { RuntimeConfig } from './config/runtime';
import { applyOrchestratorModelConfig } from './config/strip-orchestrator-model';
import {
  deletePreset,
  formatPresetOneLine,
  switchPresetOnDisk,
  writePreset,
} from './tools/preset-switch';

mock.module('@opentui/solid', () => ({
  createElement: () => ({}),
  insert: () => undefined,
  setProp: () => undefined,
}));
const { openPresetManager } = await import('./tui-preset');

let tempDir: string;
let userConfigDir: string;
let previousConfigDir: string | undefined;
let previousXdgConfigHome: string | undefined;
let previousPreset: string | undefined;
let previousParentPreset: string | undefined;
let previousRoutingMode: string | undefined;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function projectConfigPath(): string {
  return path.join(tempDir, '.opencode', 'oh-my-opencode-slim.json');
}

function userConfigPath(): string {
  return path.join(userConfigDir, 'oh-my-opencode-slim.json');
}

function readUserConfigText(): string {
  return fs.readFileSync(userConfigPath(), 'utf8');
}

function runtimeFor(config: PluginConfig): RuntimeConfig {
  RuntimeConfig.reset(tempDir);
  return RuntimeConfig.init(tempDir, config);
}

interface MockDialogSelectProps {
  onSelect?: (option: { value: string }) => void;
}

interface MockDialog {
  children: MockDialogSelectProps;
}

function savePresetThroughTui(presetName: string): void {
  let dialog: MockDialog | undefined;
  const api = {
    ui: {
      dialog: {
        replace: (factory: () => MockDialog) => {
          dialog = factory();
        },
        clear: () => undefined,
      },
      Dialog: (props: MockDialog) => props,
      DialogSelect: (props: MockDialogSelectProps) => props,
      toast: () => undefined,
    },
  } as unknown as Parameters<typeof openPresetManager>[0];

  openPresetManager(api, tempDir, {
    snapshot: {
      version: 1,
      updatedAt: 0,
      agentModels: {},
      agentVariants: {},
    },
  });
  const select = (value: string): void => {
    if (!dialog?.children.onSelect) {
      throw new Error(
        `TUI dialog did not expose a select callback for ${value}`,
      );
    }
    dialog.children.onSelect({ value });
  };
  select(presetName);
  select('edit');
  select('__omo_save__');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-preset-consumers-'));
  userConfigDir = path.join(tempDir, 'user-config');
  fs.mkdirSync(userConfigDir, { recursive: true });

  previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  previousPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  previousParentPreset = process.env.PARENT_PRESET;
  previousRoutingMode = process.env.ROUTING_MODE;
  process.env.OPENCODE_CONFIG_DIR = userConfigDir;
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  delete process.env.PARENT_PRESET;
  delete process.env.ROUTING_MODE;
});

afterEach(() => {
  RuntimeConfig.reset(tempDir);
  if (previousConfigDir === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  }
  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
  if (previousPreset === undefined) {
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  } else {
    process.env.OH_MY_OPENCODE_SLIM_PRESET = previousPreset;
  }
  if (previousParentPreset === undefined) {
    delete process.env.PARENT_PRESET;
  } else {
    process.env.PARENT_PRESET = previousParentPreset;
  }
  if (previousRoutingMode === undefined) {
    delete process.env.ROUTING_MODE;
  } else {
    process.env.ROUTING_MODE = previousRoutingMode;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('supported preset runtime consumers', () => {
  test('startup agent fallback uses the resolved active preset model', () => {
    writeJson(projectConfigPath(), {
      preset: 'child',
      presets: {
        base: { orchestrator: { model: 'base/model' } },
        child: { $extends: 'base' },
      },
      disabled_agents: [],
    });

    const config = loadPluginConfig(tempDir);
    const agents = createAgents(runtimeFor(config), {
      projectDirectory: tempDir,
    });

    expect(
      agents.find((agent) => agent.name === 'observer')?.config.model,
    ).toBe('base/model');
  });

  test('orchestrator stripping checks the resolved preset rather than raw metadata', () => {
    const agents = {
      orchestrator: { model: 'configured/model', variant: 'thinking' },
    };

    applyOrchestratorModelConfig({
      agents,
      enabled: true,
      resolvedPresets: {
        child: { orchestrator: { model: 'inherited/model' } },
      },
      configPreset: 'child',
      runtimePreset: null,
    });

    expect(agents.orchestrator).toEqual({
      model: 'configured/model',
      variant: 'thinking',
    });
  });

  test('disk switching selects a parent-only preset using effective agents', () => {
    writeJson(userConfigPath(), {
      preset: 'base',
      presets: {
        base: {
          orchestrator: { model: 'base/model' },
          explore: { model: 'base/explorer' },
        },
        child: { $extends: 'base' },
      },
    });
    const config: PluginConfig = {
      presets: {
        base: { orchestrator: { model: 'base/model' } },
        child: { $extends: 'base' },
      },
      resolvedPresets: {
        base: {
          orchestrator: { model: 'base/model' },
          explore: { model: 'base/explorer' },
        },
        child: {
          orchestrator: { model: 'base/model' },
          explore: { model: 'base/explorer' },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'child', config);

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual([
      'orchestrator → model: base/model',
      'explorer → model: base/explorer',
    ]);
    expect(result.summary.join('\n')).not.toContain('$extends');

    const reloaded = loadPluginConfig(tempDir);
    expect(reloaded.preset).toBe('child');
    expect(reloaded.agents?.orchestrator?.model).toBe('base/model');
    expect(reloaded.agents?.explore?.model).toBe('base/explorer');
  });

  test('disk switching persists a parent-only prompt preset', () => {
    writeJson(userConfigPath(), { preset: 'old' });
    const config: PluginConfig = {
      presets: {
        child: { $extends: 'base' },
      },
      resolvedPresets: {
        child: {
          oracle: { prompt: 'inherited prompt' },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'child', config);

    expect(result.ok).toBe(true);
    expect(readUserConfigText()).toContain('"preset": "child"');
  });

  test('disk switching rejects a preset with only empty agent overrides', () => {
    writeJson(userConfigPath(), { preset: 'old' });
    const before = readUserConfigText();
    const config: PluginConfig = {
      presets: { empty: { oracle: {} } },
      resolvedPresets: { empty: { oracle: {} } },
    };

    const result = switchPresetOnDisk(tempDir, 'empty', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('empty');
    expect(readUserConfigText()).toBe(before);
  });

  test('preset summaries exclude the inheritance metadata entry', () => {
    expect(
      formatPresetOneLine({
        $extends: 'base',
        oracle: { model: 'oracle/model' },
      }),
    ).toBe('oracle → oracle/model');
  });

  test('disk switching rejects an invalid graph before persisting the selection', () => {
    writeJson(userConfigPath(), { preset: 'old' });
    const before = readUserConfigText();
    const config: PluginConfig = {
      presets: {
        broken: {
          $extends: 'missing',
          oracle: { model: 'oracle/model' },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'broken', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('missing');
    expect(readUserConfigText()).toBe(before);
  });
});

describe('TUI preset persistence validation', () => {
  test('preserves an environment-backed raw parent through an unchanged TUI save', () => {
    process.env.PARENT_PRESET = 'base';
    writeJson(userConfigPath(), {
      preset: 'child',
      presets: {
        base: { oracle: { model: 'base/model' } },
        child: { $extends: '{env:PARENT_PRESET}' },
      },
    });

    const loaded = loadPluginConfig(tempDir);
    expect(loaded.presets?.child?.$extends).toBe('base');
    expect(loaded.resolvedPresets?.child?.oracle?.model).toBe('base/model');

    savePresetThroughTui('child');

    const persisted = JSON.parse(readUserConfigText()) as {
      presets: Record<string, Record<string, unknown>>;
    };
    expect(persisted.presets.child.$extends).toBe('{env:PARENT_PRESET}');
  });

  test('preserves the user parent when the project layer overrides the effective parent', () => {
    writeJson(userConfigPath(), {
      preset: 'child',
      presets: {
        baseA: { oracle: { model: 'user/baseA' } },
        child: { $extends: 'baseA' },
      },
    });
    writeJson(projectConfigPath(), {
      presets: {
        baseB: { oracle: { model: 'project/baseB' } },
        child: { $extends: 'baseB' },
      },
    });

    const loaded = loadPluginConfig(tempDir);
    expect(loaded.presets?.child?.$extends).toBe('baseB');
    expect(loaded.resolvedPresets?.child?.oracle?.model).toBe('project/baseB');

    savePresetThroughTui('child');

    const persisted = JSON.parse(readUserConfigText()) as {
      presets: Record<string, Record<string, unknown>>;
    };
    expect(persisted.presets.child.$extends).toBe('baseA');
  });

  test('preserves raw $extends when saving a valid preset', () => {
    writeJson(userConfigPath(), {
      presets: { base: { oracle: { model: 'base/model' } } },
    });

    expect(
      writePreset(tempDir, 'child', {
        $extends: 'base',
        explorer: { model: 'child/model' },
      }),
    ).toBe(true);

    const persisted = JSON.parse(readUserConfigText()) as {
      presets: Record<string, Record<string, unknown>>;
    };
    expect(persisted.presets.child).toEqual({
      $extends: 'base',
      explorer: { model: 'child/model' },
    });
  });

  test('validates a candidate against the current project preset layer', () => {
    writeJson(userConfigPath(), { presets: {} });
    writeJson(projectConfigPath(), {
      presets: { base: { oracle: { model: 'project/base' } } },
    });

    expect(writePreset(tempDir, 'child', { $extends: 'base' })).toBe(true);

    const persisted = JSON.parse(readUserConfigText()) as {
      presets: Record<string, Record<string, unknown>>;
    };
    expect(persisted.presets.child).toEqual({ $extends: 'base' });
  });

  test('rejects a mutation of malformed user config without changing its bytes', () => {
    const malformed = '{\n  "presets": ';
    fs.writeFileSync(userConfigPath(), malformed);

    expect(
      writePreset(tempDir, 'new', { oracle: { model: 'new/model' } }),
    ).toBe(false);
    expect(readUserConfigText()).toBe(malformed);
  });

  test('validates environment-interpolated parent names before persisting', () => {
    process.env.PARENT_PRESET = 'base';
    writeJson(userConfigPath(), {
      presets: { base: { oracle: { model: 'base/model' } } },
    });

    expect(
      writePreset(tempDir, 'child', {
        $extends: '{env:PARENT_PRESET}',
      }),
    ).toBe(true);

    const persisted = JSON.parse(readUserConfigText()) as {
      presets: Record<string, Record<string, unknown>>;
    };
    expect(persisted.presets.child).toEqual({
      $extends: '{env:PARENT_PRESET}',
    });
  });

  test('validates schema-constrained environment placeholders before persisting', () => {
    process.env.ROUTING_MODE = 'direct';
    writeJson(userConfigPath(), {
      image_routing: '{env:ROUTING_MODE}',
      presets: { base: { oracle: { model: 'base/model' } } },
    });

    expect(writePreset(tempDir, 'child', { $extends: 'base' })).toBe(true);

    const persisted = JSON.parse(readUserConfigText()) as {
      image_routing: string;
      presets: Record<string, Record<string, unknown>>;
    };
    expect(persisted.image_routing).toBe('{env:ROUTING_MODE}');
    expect(persisted.presets.child).toEqual({ $extends: 'base' });
  });

  test('rejects a save with a missing parent and leaves the file unchanged', () => {
    writeJson(userConfigPath(), {
      presets: { keep: { oracle: { model: 'keep/model' } } },
    });
    const before = readUserConfigText();

    expect(
      writePreset(tempDir, 'broken', {
        $extends: 'missing',
        oracle: { model: 'broken/model' },
      }),
    ).toBe(false);

    expect(readUserConfigText()).toBe(before);
  });

  test('rejects an overwrite that creates a cycle and leaves the file unchanged', () => {
    writeJson(userConfigPath(), {
      presets: {
        base: { $extends: 'child' },
        child: { oracle: { model: 'child/model' } },
      },
    });
    const before = readUserConfigText();

    expect(writePreset(tempDir, 'child', { $extends: 'base' })).toBe(false);

    expect(readUserConfigText()).toBe(before);
  });

  test('rejects deleting a referenced parent and leaves the file unchanged', () => {
    writeJson(userConfigPath(), {
      presets: {
        base: { oracle: { model: 'base/model' } },
        child: { $extends: 'base' },
      },
    });
    const before = readUserConfigText();

    expect(deletePreset(tempDir, 'base')).toBe(false);

    expect(readUserConfigText()).toBe(before);
  });
});

describe('doctor preset graph diagnostics', () => {
  test('reports a merged missing-parent graph failure', () => {
    writeJson(userConfigPath(), {
      presets: { child: { $extends: 'base' } },
    });
    writeJson(projectConfigPath(), {
      presets: { other: { oracle: { model: 'project/model' } } },
    });

    const result = runDoctorCheck(tempDir);

    expect(result.ok).toBe(false);
    expect(result.presetGraphCheck?.ok).toBe(false);
    expect(result.presetGraphCheck?.error?.kind).toBe(
      'PRESET_INHERITANCE_MISSING_PARENT',
    );
    expect(result.presetGraphCheck?.error?.message).toContain('base');
  });

  test('reports a merged cycle graph failure', () => {
    writeJson(userConfigPath(), {
      presets: { base: { $extends: 'child' } },
    });
    writeJson(projectConfigPath(), {
      presets: { child: { $extends: 'base' } },
    });

    const result = runDoctorCheck(tempDir);

    expect(result.ok).toBe(false);
    expect(result.presetGraphCheck?.error?.kind).toBe(
      'PRESET_INHERITANCE_CYCLE',
    );
    expect(result.presetGraphCheck?.error?.message).toContain(
      'base -> child -> base',
    );
  });
});

describe('preset prompt boundaries', () => {
  test('inherits inline prompt fields without searching parent prompt directories', () => {
    writeJson(projectConfigPath(), {
      preset: 'child',
      presets: {
        base: {
          oracle: { prompt: 'inline parent prompt' },
        },
        child: { $extends: 'base' },
      },
      disabled_agents: [],
    });
    const parentPromptDir = path.join(
      tempDir,
      '.opencode',
      'oh-my-opencode-slim',
      'base',
    );
    fs.mkdirSync(parentPromptDir, { recursive: true });
    fs.writeFileSync(path.join(parentPromptDir, 'oracle.md'), 'parent file');

    const config = loadPluginConfig(tempDir);
    const oracle = createAgents(runtimeFor(config), {
      projectDirectory: tempDir,
    }).find((agent) => agent.name === 'oracle');

    expect(oracle?.config.prompt).toBe('inline parent prompt');
    expect(
      loadAgentPrompt('oracle', {
        preset: 'child',
        projectDirectory: tempDir,
      }),
    ).toEqual({});
  });
});
