import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import {
  getActiveRuntimePreset,
  setActiveRuntimePreset,
} from '../config/runtime-preset';
import { readTuiSnapshot, recordTuiAgentModels } from '../tui-state';
import { createPresetManager } from './preset-manager';

function createMockContext() {
  const configUpdate = mock(async () => ({}));
  const instanceDispose = mock(async () => ({}));
  return {
    client: {
      config: {
        update: configUpdate,
      },
      instance: {
        dispose: instanceDispose,
      },
    },
    directory: tempDir,
  } as any;
}

function createOutput() {
  return { parts: [] as Array<{ type: string; text?: string }> };
}

function getOutputText(output: ReturnType<typeof createOutput>): string {
  return output.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
}

let previousXdgDataHome: string | undefined;
let previousXdgConfigHome: string | undefined;
let previousOpenCodeConfigDir: string | undefined;
let tempDir: string;

beforeEach(() => {
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  previousOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-preset-manager-'));
  process.env.XDG_DATA_HOME = tempDir;
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
  delete process.env.OPENCODE_CONFIG_DIR;
  setActiveRuntimePreset(null);
});

afterEach(() => {
  if (previousXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = previousXdgDataHome;
  }

  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }

  if (previousOpenCodeConfigDir === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = previousOpenCodeConfigDir;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  setActiveRuntimePreset(null);
});

describe('createPresetManager', () => {
  describe('handleCommandExecuteBefore', () => {
    test('ignores non-preset commands', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {};
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'unknown-command', sessionID: 's1', arguments: 'on' },
        output,
      );

      expect(output.parts).toHaveLength(0);
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test('lists available presets when no argument given', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
          },
          powerful: {
            orchestrator: { model: 'openai/gpt-5.6' },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: '' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('cheap');
      expect(text).toContain('powerful');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test('lists presets with active marker when preset is set', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        preset: 'cheap',
        presets: {
          cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
          powerful: { orchestrator: { model: 'openai/gpt-5.6' } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: '' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('← active');
    });

    test('shows no-presets message when none configured', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {};
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: '' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('No presets configured');
    });

    test('switches preset state without config.update or instance.dispose', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
            explorer: { model: 'openai/gpt-5.6-luna' },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheap' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('Saved preset "cheap"');
      expect(text).toContain('orchestrator');
      expect(text).toContain('anthropic/claude-3.5-haiku');
      expect(text).toContain('explorer');
      expect(text).toContain('Restart or reload OpenCode');
      expect(getActiveRuntimePreset()).toBe('cheap');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('updates the TUI snapshot after a successful preset switch', async () => {
      recordTuiAgentModels(
        {
          agentModels: {
            explorer: 'openai/gpt-5.6-luna',
            fixer: 'openai/gpt-5.6-luna',
          },
        },
        tempDir,
      );

      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
            explorer: { model: 'openai/gpt-5.6' },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheap' },
        output,
      );

      expect(readTuiSnapshot(tempDir).agentModels).toEqual({
        explorer: 'openai/gpt-5.6',
        fixer: 'openai/gpt-5.6-luna',
        orchestrator: 'anthropic/claude-3.5-haiku',
      });
    });

    test('persists preset changes from JSONC user config', async () => {
      const configDir = path.join(tempDir, 'opencode-config');
      fs.mkdirSync(configDir, { recursive: true });
      process.env.OPENCODE_CONFIG_DIR = configDir;

      const configPath = path.join(configDir, 'oh-my-opencode-slim.jsonc');
      fs.writeFileSync(
        configPath,
        `{
          // User-selected preset should be updated even in JSONC files.
          "preset": "old",
          "agents": {
            "orchestrator": { "model": "old-model" },
          },
        }`,
      );

      const ctx = { ...createMockContext(), directory: tempDir };
      const config: PluginConfig = {
        presets: {
          cheap: {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheap' },
        output,
      );

      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        preset?: string;
        agents?: Record<string, unknown>;
      };
      expect(persisted.preset).toBe('cheap');
      expect(persisted.agents).toEqual({
        orchestrator: { model: 'old-model' },
      });
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('shows temperature in preset summary without runtime config update', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          precise: {
            orchestrator: { model: 'openai/o3', temperature: 0.1 },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'precise' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('orchestrator');
      expect(text).toContain('model: openai/o3');
      expect(text).toContain('temp: 0.1');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('shows variant in preset summary without runtime config update', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          thinker: {
            oracle: {
              model: 'anthropic/claude-sonnet-4-6',
              variant: 'thinking',
            },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'thinker' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('oracle');
      expect(text).toContain('model: anthropic/claude-sonnet-4-6');
      expect(text).toContain('variant: thinking');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('shows error for unknown preset name', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'nonexistent' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('not found');
      expect(text).toContain('cheap');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('shows error when no presets configured but argument given', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {};
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheap' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('not found');
      expect(text).toContain('No presets configured');
    });

    test('unknown preset does not change active state or dispose instance', async () => {
      setActiveRuntimePreset('cheap');
      recordTuiAgentModels(
        {
          agentModels: {
            explorer: 'openai/gpt-5.6-luna',
          },
        },
        tempDir,
      );

      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'nonexistent' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('not found');
      expect(getActiveRuntimePreset()).toBe('cheap');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('shows empty preset message when preset has no valid overrides', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          empty: {
            orchestrator: {},
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'empty' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('empty');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test('shows options in preset summary without runtime config update', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          thinker: {
            oracle: {
              model: 'anthropic/claude-sonnet-4-6',
              options: {
                thinking: { type: 'enabled', budgetTokens: 10000 },
              },
            },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'thinker' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('oracle');
      expect(text).toContain('options: yes');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('trims whitespace from preset name argument', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: '  cheap  ' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('Saved preset "cheap"');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('shows suggestion for multi-word arguments', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheap powerful' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('cannot contain spaces');
      expect(text).toContain('/preset cheap');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test('catches tab-separated arguments', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheap\tpowerful' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('cannot contain spaces');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test('skips agents with empty overrides in mixed preset', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          mixed: {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
            explorer: {},
            oracle: { temperature: 0.3 },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'mixed' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('Saved preset "mixed"');
      expect(text).toContain('orchestrator');
      expect(text).toContain('oracle');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('resolves array-form model to first entry', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          fallback: {
            orchestrator: {
              model: ['anthropic/claude-3.5-haiku', 'openai/gpt-5.6'],
            },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'fallback' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('Saved preset "fallback"');
      expect(text).toContain('orchestrator');
      expect(text).toContain('anthropic/claude-3.5-haiku');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('resolves array-form model with object entries', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          thinker: {
            oracle: {
              model: [
                { id: 'anthropic/claude-sonnet-4-6', variant: 'thinking' },
                { id: 'openai/o3' },
              ],
            },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'thinker' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('Saved preset "thinker"');
      expect(text).toContain('oracle');
      expect(text).toContain('variant: thinking');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('shows variant and options in switch summary', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          thinker: {
            oracle: {
              model: 'anthropic/claude-sonnet-4-6',
              variant: 'thinking',
              options: { thinking: { type: 'enabled', budgetTokens: 10000 } },
            },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'thinker' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('variant: thinking');
      expect(text).toContain('options: yes');
    });

    test('tracks active preset after switch', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
          powerful: { orchestrator: { model: 'openai/gpt-5.6' } },
        },
      };
      const manager = createPresetManager(ctx, config);

      // Switch to cheap
      const output1 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheap' },
        output1,
      );
      expect(getOutputText(output1)).toContain('Saved preset');

      // List presets should now show cheap as active
      const output2 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: '' },
        output2,
      );
      expect(getOutputText(output2)).toContain('cheap ← active');

      // Switch to powerful
      const output3 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'powerful' },
        output3,
      );
      expect(getOutputText(output3)).toContain('Saved preset "powerful"');

      // List should now show powerful as active
      const output4 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: '' },
        output4,
      );
      expect(getOutputText(output4)).toContain('powerful ← active');

      // Cleanup module state
      setActiveRuntimePreset(null);
    });
  });

  describe('registerCommand', () => {
    test('registers preset command when not present', () => {
      const ctx = createMockContext();
      const config: PluginConfig = {};
      const manager = createPresetManager(ctx, config);
      const opencodeConfig: Record<string, unknown> = {};

      manager.registerCommand(opencodeConfig);

      const command = (opencodeConfig.command as Record<string, unknown>)
        .preset as { template: string; description: string };
      expect(command).toBeDefined();
      expect(command.template).toContain('presets');
      expect(command.description).toContain('/preset');
    });

    test('does not overwrite existing preset command', () => {
      const ctx = createMockContext();
      const config: PluginConfig = {};
      const manager = createPresetManager(ctx, config);
      const existing = { template: 'custom', description: 'custom' };
      const opencodeConfig: Record<string, unknown> = {
        command: { preset: existing },
      };

      manager.registerCommand(opencodeConfig);

      expect((opencodeConfig.command as Record<string, unknown>).preset).toBe(
        existing,
      );
    });
  });

  describe('preset switching stale state', () => {
    test('switching presets updates active preset without runtime config update', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: {
            oracle: { model: 'cheap-model', temperature: 0.3 },
          },
          powerful: {
            orchestrator: { model: 'powerful-model' },
          },
        },
        agents: {
          oracle: { model: 'baseline-model' },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output1 = createOutput();

      // Switch to cheap first
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheap' },
        output1,
      );
      expect(getOutputText(output1)).toContain('Saved preset "cheap"');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();

      const output2 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'powerful' },
        output2,
      );

      expect(getOutputText(output2)).toContain('Saved preset "powerful"');
      expect(getActiveRuntimePreset()).toBe('powerful');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('new preset with same agents still avoids runtime config update', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: {
            oracle: { model: 'a' },
          },
          cheaper: {
            oracle: { model: 'b' },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output1 = createOutput();

      // Switch to cheap first
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheap' },
        output1,
      );
      expect(getOutputText(output1)).toContain('Saved preset "cheap"');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();

      const output2 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheaper' },
        output2,
      );

      expect(getOutputText(output2)).toContain('Saved preset "cheaper"');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('preset state persists across successive switches without runtime update', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: {
            oracle: { model: 'a' },
          },
          expensive: {
            oracle: { model: 'b' },
          },
        },
      };
      const manager = createPresetManager(ctx, config);

      // Switch to cheap successfully
      const output1 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'cheap' },
        output1,
      );
      expect(getActiveRuntimePreset()).toBe('cheap');

      // Try to switch to expensive
      const output2 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: 'expensive' },
        output2,
      );

      expect(getActiveRuntimePreset()).toBe('expensive');
      expect(getOutputText(output2)).toContain('Saved preset "expensive"');
      expect(ctx.client.config.update).not.toHaveBeenCalled();
      expect(ctx.client.instance.dispose).not.toHaveBeenCalled();
    });

    test('activePreset syncs from runtime-preset state on factory creation', async () => {
      // Set runtime preset before creating manager
      setActiveRuntimePreset('cheap');

      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: {
            oracle: { model: 'a' },
          },
          powerful: {
            oracle: { model: 'b' },
          },
        },
      };

      // Create manager - should sync from module-level state
      const manager = createPresetManager(ctx, config);

      // List presets should show cheap as active
      const output = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: 'preset', sessionID: 's1', arguments: '' },
        output,
      );

      const text = getOutputText(output);
      expect(text).toContain('cheap ← active');
      expect(text).toContain('powerful');

      // Cleanup
      setActiveRuntimePreset(null);
    });
  });
});
