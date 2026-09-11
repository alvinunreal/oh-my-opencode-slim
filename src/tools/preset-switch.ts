import * as fs from 'node:fs';
import { stripJsonComments } from '../cli/config-io';
import type { AgentOverrideConfig, PluginConfig, Preset } from '../config';
import { AGENT_ALIASES } from '../config/constants';
import { findPluginConfigPaths } from '../config/loader';

/**
 * Result of a preset switch attempt. `message` is user-facing and intended for
 * a TUI toast/dialog (it is never injected into the LLM context).
 */
export interface PresetSwitchResult {
  ok: boolean;
  presetName: string;
  message: string;
  /** Per-agent summary lines, e.g. "orchestrator → model: x, variant: y". */
  summary: string[];
}

/** A flattened, SDK-shaped agent override derived from a preset entry. */
export interface AgentUpdate {
  model?: string;
  temperature?: number;
  variant?: string;
  options?: Record<string, unknown>;
}

/**
 * Switch the active preset purely through on-disk state: persist the preset
 * name to the user config file. The sidebar snapshot is deliberately NOT
 * touched — the new preset applies on the next reload/restart, when
 * `loadPluginConfig` re-reads the config file and merges the preset into
 * `config.agents`. Refreshing the sidebar mid-session while the agent
 * registry is unchanged would show models that don't match the running
 * agents, which is confusing.
 *
 * This is the shared core used by the TUI `/preset` slash command. It
 * deliberately does NOT touch OpenCode's in-memory agent registry. It also
 * does not set the server-side runtime-preset singleton, because the TUI
 * runs in a separate process from the server and cannot reach that state.
 */
export function switchPresetOnDisk(
  directory: string,
  presetName: string,
  config: PluginConfig,
): PresetSwitchResult {
  const presets = config.presets ?? {};
  const preset = presets[presetName];

  if (!preset) {
    const available = Object.keys(presets);
    const hint =
      available.length > 0
        ? `Available presets: ${available.join(', ')}`
        : 'No presets configured. Define presets in oh-my-opencode-slim.jsonc.';
    return {
      ok: false,
      presetName,
      message: `Preset "${presetName}" not found. ${hint}`,
      summary: [],
    };
  }

  const agentUpdates = buildAgentUpdates(preset);
  const hasMarketplaceActivation =
    preset.marketplace?.agents !== undefined ||
    preset.marketplace?.profiles !== undefined;
  if (Object.keys(agentUpdates).length === 0 && !hasMarketplaceActivation) {
    return {
      ok: false,
      presetName,
      message: `Preset "${presetName}" is empty (no agent overrides defined).`,
      summary: [],
    };
  }

  persistPresetName(directory, presetName);

  return {
    ok: true,
    presetName,
    message: `Saved preset "${presetName}". Reload OpenCode (or start a new conversation) for it to take effect. The current session keeps its existing agent models to avoid truncating context, drifting prior turns, or destabilizing running subagents.`,
    summary: buildPresetSummary(agentUpdates),
  };
}

/**
 * Build the SDK-shaped agent overrides from a preset, resolving legacy alias
 * keys (e.g. "explore" → "explorer").
 */
export function buildAgentUpdates(preset: Preset): Record<string, AgentUpdate> {
  const agentUpdates: Record<string, AgentUpdate> = {};
  for (const [agentName, override] of Object.entries(preset.agents)) {
    const resolvedName = AGENT_ALIASES[agentName] ?? agentName;
    const agentConfig = mapOverrideToAgentConfig(override);
    if (Object.keys(agentConfig).length > 0) {
      agentUpdates[resolvedName] = agentConfig;
    }
  }
  return agentUpdates;
}

/**
 * Map an AgentOverrideConfig (from plugin config) to the subset of agent
 * config fields shown in the saved preset summary.
 */
export function mapOverrideToAgentConfig(
  override: AgentOverrideConfig,
): AgentUpdate {
  const agentConfig: AgentUpdate = {};

  if (typeof override.model === 'string') {
    agentConfig.model = override.model;
  } else if (Array.isArray(override.model) && override.model.length > 0) {
    // Array-form model (fallback chain): pick the first entry. Full chain
    // resolution happens at init time via the config() hook, so at runtime we
    // use the primary model from the array.
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

/** Build the per-agent summary lines for a switch result / picker tooltip. */
export function buildPresetSummary(
  agentUpdates: Record<string, AgentUpdate>,
): string[] {
  const summaryParts: string[] = [];
  for (const [name, cfg] of Object.entries(agentUpdates)) {
    const parts: string[] = [name];
    if (cfg.model) parts.push(`model: ${cfg.model}`);
    if (cfg.variant) parts.push(`variant: ${cfg.variant}`);
    if (cfg.temperature !== undefined) parts.push(`temp: ${cfg.temperature}`);
    if (cfg.options) parts.push('options: yes');
    summaryParts.push(parts.join(' → '));
  }
  return summaryParts;
}

/**
 * Persist the preset name to the user-level config file so it survives
 * restarts. Best-effort: a failure must not abort the switch, because the
 * persisted name is what makes the next reload pick up the new preset.
 *
 * Note: this rewrites the file as plain JSON (JSONC comments are not
 * preserved), matching the prior server-side behavior.
 */
function persistPresetName(directory: string, presetName: string): void {
  try {
    const { userConfigPath } = findPluginConfigPaths(directory);
    if (!userConfigPath) return;
    // Strip a UTF-8 BOM (RFC 8259 permits one); JSON.parse would otherwise
    // fail with "Unrecognized token" and the preset would not be persisted.
    const raw = fs.readFileSync(userConfigPath, 'utf-8').replace(/^\uFEFF/, '');
    const persisted = JSON.parse(stripJsonComments(raw)) as Record<
      string,
      unknown
    >;
    persisted.preset = presetName;
    fs.writeFileSync(userConfigPath, `${JSON.stringify(persisted, null, 2)}\n`);
  } catch {
    // Non-critical: the preset name is also returned in the switch result
    // so the caller can surface it to the user.
  }
}

/**
 * Read the user-level config file as a parsed object. Returns null if the
 * file is absent or unreadable.
 */
function readUserConfig(directory: string): Record<string, unknown> | null {
  try {
    const { userConfigPath } = findPluginConfigPaths(directory);
    if (!userConfigPath) return null;
    // Strip a UTF-8 BOM (RFC 8259 permits one); JSON.parse would otherwise
    // fail with "Unrecognized token" and the preset name would be lost.
    const raw = fs.readFileSync(userConfigPath, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Write the user-level config file (plain JSON; JSONC comments are not
 * preserved, matching the existing switchPreset behavior). Best-effort.
 */
function writeUserConfig(
  directory: string,
  config: Record<string, unknown>,
): boolean {
  try {
    const { userConfigPath } = findPluginConfigPaths(directory);
    if (!userConfigPath) return false;
    fs.writeFileSync(userConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist a preset (create or overwrite) into the user config's `presets`
 * object. Returns true on success.
 */
export function writePreset(
  directory: string,
  name: string,
  preset: Preset,
): boolean {
  const config = readUserConfig(directory) ?? {};
  const presets = (config.presets as Record<string, Preset> | undefined) ?? {};
  presets[name] = preset;
  config.presets = presets;
  return writeUserConfig(directory, config);
}

/**
 * Delete a preset from the user config. Returns true if removed, false if the
 * preset did not exist or the write failed.
 */
export function deletePreset(directory: string, name: string): boolean {
  const config = readUserConfig(directory);
  if (!config) return false;
  const presets = config.presets as Record<string, Preset> | undefined;
  if (!presets || !(name in presets)) return false;
  delete presets[name];
  // If the active preset was deleted, clear the `preset` field too.
  if (config.preset === name) {
    delete config.preset;
  }
  return writeUserConfig(directory, config);
}

/**
 * Set (or replace) an agent override within an in-memory preset. Returns a
 * new preset object; does not mutate the input.
 */
export function setAgentOverride(
  preset: Preset,
  agentName: string,
  override: AgentOverrideConfig,
): Preset {
  return { ...preset, agents: { ...preset.agents, [agentName]: override } };
}

/**
 * Remove an agent from an in-memory preset. Returns a new preset object; does
 * not mutate the input. If the agent was not present, the preset is unchanged.
 */
export function removeAgentFromPreset(
  preset: Preset,
  agentName: string,
): Preset {
  if (!(agentName in preset.agents)) return preset;
  const agents = { ...preset.agents };
  delete agents[agentName];
  return { ...preset, agents };
}
