import type { PluginInput } from '@opencode-ai/plugin';
import type {
  AgentOverrideConfig,
  ModelEntry,
  PluginConfig,
  Preset,
} from '../config';
import { createInternalAgentTextPart } from '../utils';

const COMMAND_NAME = 'preset';

/**
 * Creates a preset manager for the /preset slash command.
 *
 * Uses the OpenCode SDK's client.config.update() to change agent models
 * and temperatures without restarting. The server invalidates its agent
 * cache and re-reads config on the next prompt.
 *
 * Note: activePreset is tracked in-memory only and resets on plugin reload.
 * If the user manually edits config or another mechanism changes agents,
 * this tracker may become stale until the next /preset call.
 */
export function createPresetManager(ctx: PluginInput, config: PluginConfig) {
  let activePreset: string | null = config.preset ?? null;

  /**
   * Handle the /preset command from command.execute.before hook.
   *
   * - No arguments: list available presets
   * - With argument: switch to the named preset
   */
  async function handleCommandExecuteBefore(
    input: {
      command: string;
      sessionID: string;
      arguments: string;
    },
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    if (input.command !== COMMAND_NAME) {
      return;
    }

    // Clear the template so OpenCode doesn't send it to the LLM
    output.parts.length = 0;

    const arg = input.arguments.trim();
    const presets = config.presets ?? {};

    if (!arg) {
      // List available presets
      output.parts.push(createInternalAgentTextPart(formatPresetList(presets)));
      return;
    }

    // Guard against multi-word arguments
    if (/\s/.test(arg)) {
      const suggestion = arg.split(/\s+/)[0];
      output.parts.push(
        createInternalAgentTextPart(
          `Preset names cannot contain spaces. Did you mean: /preset ${suggestion}?`,
        ),
      );
      return;
    }

    // Switch to named preset
    await switchPreset(arg, presets, output);
  }

  /**
   * Register the /preset command in the OpenCode config.
   */
  function registerCommand(opencodeConfig: Record<string, unknown>): void {
    const configCommand = opencodeConfig.command as
      | Record<string, unknown>
      | undefined;
    if (!configCommand?.[COMMAND_NAME]) {
      if (!opencodeConfig.command) {
        opencodeConfig.command = {};
      }
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        template: 'List available presets and switch between them',
        description:
          'Switch agent presets at runtime (e.g., /preset cheap, /preset powerful)',
      };
    }
  }

  /**
   * Switch to the given preset name by calling client.config.update().
   */
  async function switchPreset(
    presetName: string,
    presets: Record<string, Preset>,
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    const preset = presets[presetName];
    if (!preset) {
      const available = Object.keys(presets);
      const hint =
        available.length > 0
          ? `Available presets: ${available.join(', ')}`
          : 'No presets configured. Define presets in oh-my-opencode-slim.jsonc.';
      output.parts.push(
        createInternalAgentTextPart(
          `Preset "${presetName}" not found. ${hint}`,
        ),
      );
      return;
    }

    // Build the agent config overrides from the preset.
    // Each preset value is { agentName: AgentOverrideConfig }.
    // We need to convert to SDK AgentConfig format:
    // { agent: { agentName: { model, temperature, ... } } }
    const agentUpdates: Record<
      string,
      {
        model?: string;
        temperature?: number;
        variant?: string;
        options?: Record<string, unknown>;
      }
    > = {};
    for (const [agentName, override] of Object.entries(preset)) {
      const agentConfig = mapOverrideToAgentConfig(override);
      if (Object.keys(agentConfig).length > 0) {
        agentUpdates[agentName] = agentConfig;
      }
    }

    if (Object.keys(agentUpdates).length === 0) {
      output.parts.push(
        createInternalAgentTextPart(
          `Preset "${presetName}" is empty (no agent overrides defined).`,
        ),
      );
      return;
    }

    try {
      await ctx.client.config.update({
        body: { agent: agentUpdates },
      });

      activePreset = presetName;

      const summary = Object.entries(agentUpdates)
        .map(([name, cfg]) => {
          const parts: string[] = [name];
          if (cfg.model) parts.push(`model: ${cfg.model}`);
          if (cfg.variant) parts.push(`variant: ${cfg.variant}`);
          if (cfg.temperature !== undefined)
            parts.push(`temp: ${cfg.temperature}`);
          if (cfg.options) parts.push('options: yes');
          return parts.join(' → ');
        })
        .join('\n');

      output.parts.push(
        createInternalAgentTextPart(
          `Switched to preset "${presetName}":\n${summary}`,
        ),
      );
    } catch (err) {
      output.parts.push(
        createInternalAgentTextPart(
          `Failed to switch preset "${presetName}": ${String(err)}`,
        ),
      );
    }
  }

  /**
   * Map an AgentOverrideConfig (from plugin config) to the subset of
   * SDK AgentConfig fields that client.config.update() can apply at runtime.
   *
   * Excluded fields and why:
   * - prompt, orchestratorPrompt: require restart (resolved at init by config() hook)
   * - skills, mcps: plugin-level concern, not part of SDK AgentConfig
   * - displayName: plugin-level concern, not part of SDK AgentConfig
   */
  function mapOverrideToAgentConfig(override: AgentOverrideConfig): {
    model?: string;
    temperature?: number;
    variant?: string;
    options?: Record<string, unknown>;
  } {
    const agentConfig: {
      model?: string;
      temperature?: number;
      variant?: string;
      options?: Record<string, unknown>;
    } = {};

    if (typeof override.model === 'string') {
      agentConfig.model = override.model;
    } else if (Array.isArray(override.model) && override.model.length > 0) {
      // Array-form model (fallback chain): pick the first entry.
      // The full chain resolution only happens at init time via config() hook,
      // so at runtime we use the primary model from the array.
      const first = override.model[0];
      agentConfig.model = typeof first === 'string' ? first : first.id;
      if (typeof first !== 'string' && first.variant) {
        agentConfig.variant = first.variant;
      }
    }

    if (typeof override.temperature === 'number') {
      agentConfig.temperature = override.temperature;
    }

    if (typeof override.variant === 'string') {
      agentConfig.variant = override.variant;
    }

    if (
      override.options &&
      typeof override.options === 'object' &&
      !Array.isArray(override.options)
    ) {
      agentConfig.options = override.options;
    }

    return agentConfig;
  }

  /**
   * Format the list of available presets with the active one highlighted.
   */
  function formatPresetList(presets: Record<string, Preset>): string {
    const names = Object.keys(presets);
    if (names.length === 0) {
      return 'No presets configured. Define presets in oh-my-opencode-slim.jsonc under the "presets" field.';
    }

    const lines = ['Available presets:'];
    for (const name of names) {
      const marker = name === activePreset ? ' ← active' : '';
      const preset = presets[name];
      const agentNames = Object.keys(preset);
      const models = agentNames
        .map((a) => {
          const cfg = preset[a];
          const modelStr =
            typeof cfg.model === 'string'
              ? cfg.model
              : Array.isArray(cfg.model) && cfg.model.length > 0
                ? resolveFirstModel(cfg.model)
                : undefined;
          return modelStr ? `    ${a} → ${modelStr}` : `    ${a}`;
        })
        .join('\n');
      lines.push(`  ${name}${marker}`);
      lines.push(models);
    }
    lines.push('\nUsage: /preset <name> to switch.');

    return lines.join('\n');
  }

  /**
   * Resolve the first model from an array-form model entry.
   */
  function resolveFirstModel(
    models: Array<string | ModelEntry>,
  ): string | undefined {
    if (models.length === 0) return undefined;
    const first = models[0];
    return typeof first === 'string' ? first : first.id;
  }

  return {
    handleCommandExecuteBefore,
    registerCommand,
  };
}

export type PresetManager = ReturnType<typeof createPresetManager>;
