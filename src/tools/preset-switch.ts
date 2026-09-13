import * as fs from 'node:fs';
import type {
  AgentOverrideConfig,
  ModelEntry,
  PluginConfig,
  Preset,
  ResolvedPreset,
} from '../config';
import { AGENT_ALIASES } from '../config/constants';
import {
  findPluginConfigPaths,
  getResolvedPreset,
  mergePluginConfigs,
  PresetInheritanceError,
  parseConfigContent,
  resolvePresetInheritance,
} from '../config/loader';
import { PluginConfigSchema } from '../config/schema';

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

export interface PresetMutationResult {
  ok: boolean;
  message?: string;
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
  if (!Object.hasOwn(presets, presetName)) {
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

  let preset: ResolvedPreset | undefined;
  try {
    preset = getResolvedPreset(config, presetName);
  } catch (error) {
    if (error instanceof PresetInheritanceError) {
      return {
        ok: false,
        presetName,
        message: error.message,
        summary: [],
      };
    }
    throw error;
  }

  if (!preset) {
    return {
      ok: false,
      presetName,
      message: `Preset "${presetName}" has no resolved agent configuration.`,
      summary: [],
    };
  }

  const agentUpdates = buildAgentUpdates(preset);
  const hasAgentOverride = Object.values(preset).some(
    (override) => Object.keys(override).length > 0,
  );
  if (!hasAgentOverride) {
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
export function buildAgentUpdates(
  preset: Preset | ResolvedPreset,
): Record<string, AgentUpdate> {
  const agentUpdates: Record<string, AgentUpdate> = {};
  for (const [agentName, override] of getAgentEntries(preset)) {
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
 * A single-line description of a preset for the TUI picker, e.g.
 * "orchestrator → glm-5.2, oracle → glm-5.2".
 */
export function formatPresetOneLine(preset: Preset | ResolvedPreset): string {
  const lines: string[] = [];
  for (const [agentName, override] of getAgentEntries(preset)) {
    const modelStr =
      typeof override.model === 'string'
        ? override.model
        : Array.isArray(override.model) && override.model.length > 0
          ? resolveFirstModel(override.model)
          : undefined;
    lines.push(modelStr ? `${agentName} → ${modelStr}` : agentName);
  }
  return lines.join(', ');
}

/**
 * Format the full preset list with the active one highlighted. Used by
 * non-TUI surfaces (e.g. a future headless listing); the TUI uses the picker.
 */
export function formatPresetList(
  presets: Record<string, Preset | ResolvedPreset>,
  activePreset: string | null,
): string {
  const names = Object.keys(presets);
  if (names.length === 0) {
    return 'No presets configured. Define presets in oh-my-opencode-slim.jsonc under the "presets" field.';
  }

  const lines = ['Available presets:'];
  for (const name of names) {
    const marker = name === activePreset ? ' ← active' : '';
    const models = Object.entries(buildAgentUpdates(presets[name]))
      .map(([a, cfg]) => {
        return cfg.model ? `    ${a} → ${cfg.model}` : `    ${a}`;
      })
      .join('\n');
    lines.push(`  ${name}${marker}`);
    lines.push(models);
  }
  lines.push('\nUsage: /preset <name> to switch.');

  return lines.join('\n');
}

function resolveFirstModel(
  models: Array<string | ModelEntry>,
): string | undefined {
  if (models.length === 0) return undefined;
  const first = models[0];
  return typeof first === 'string' ? first : first.id;
}

function getAgentEntries(
  preset: Preset | ResolvedPreset,
): Array<[string, AgentOverrideConfig]> {
  return Object.entries(preset).flatMap(([name, value]) => {
    if (name === '$extends' || typeof value !== 'object' || value === null) {
      return [];
    }
    return [[name, value as AgentOverrideConfig]];
  });
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
    const persisted = parseConfigContent(raw, {
      interpolate: false,
    }) as Record<string, unknown>;
    persisted.preset = presetName;
    fs.writeFileSync(userConfigPath, `${JSON.stringify(persisted, null, 2)}\n`);
  } catch {
    // Non-critical: the preset name is also returned in the switch result
    // so the caller can surface it to the user.
  }
}

/**
 * Read the user-level config file while distinguishing absence from an
 * existing file that cannot safely be parsed or validated.
 */
type UserConfigReadResult =
  | { kind: 'absent' }
  | { kind: 'invalid'; message: string }
  | { kind: 'valid'; config: Record<string, unknown> };

function readUserConfig(directory: string): UserConfigReadResult {
  const { userConfigPath } = findPluginConfigPaths(directory);
  if (!userConfigPath) return { kind: 'absent' };

  try {
    // Strip a UTF-8 BOM (RFC 8259 permits one); JSON.parse would otherwise
    // fail with "Unrecognized token" and the preset name would be lost.
    const raw = fs.readFileSync(userConfigPath, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = parseConfigContent(raw, { interpolate: false });
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        kind: 'invalid',
        message: 'The existing user config is not an object.',
      };
    }
    const effective = parseConfigContent(raw);
    const result = PluginConfigSchema.safeParse(effective);
    if (!result.success) {
      return {
        kind: 'invalid',
        message: 'The existing user config does not match the plugin schema.',
      };
    }
    return { kind: 'valid', config: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      kind: 'invalid',
      message: `Could not parse or read the existing user config: ${String(error)}`,
    };
  }
}

/** Read one preset's exact raw definition from the user config layer. */
export function readRawUserPreset(
  directory: string,
  name: string,
): Preset | undefined {
  const userConfig = readUserConfig(directory);
  if (userConfig.kind !== 'valid') return undefined;

  const rawPresets = userConfig.config.presets;
  if (
    typeof rawPresets !== 'object' ||
    rawPresets === null ||
    Array.isArray(rawPresets) ||
    !Object.hasOwn(rawPresets, name)
  ) {
    return undefined;
  }

  const rawPreset = (rawPresets as Record<string, unknown>)[name];
  return typeof rawPreset === 'object' && rawPreset !== null
    ? (rawPreset as Preset)
    : undefined;
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
  return writePresetResult(directory, name, preset).ok;
}

/**
 * Persist a raw preset only after validating the candidate user/project graph.
 */
export function writePresetResult(
  directory: string,
  name: string,
  preset: Preset,
): PresetMutationResult {
  const userConfig = readUserConfig(directory);
  if (userConfig.kind === 'absent') {
    return { ok: false, message: 'User config file not found.' };
  }
  if (userConfig.kind === 'invalid') {
    return { ok: false, message: userConfig.message };
  }
  const config = userConfig.config;
  const rawPresets = config.presets;
  if (
    rawPresets !== undefined &&
    (typeof rawPresets !== 'object' ||
      rawPresets === null ||
      Array.isArray(rawPresets))
  ) {
    return { ok: false, message: 'The user presets value is not an object.' };
  }
  const presets = Object.create(null) as Record<string, Preset>;
  for (const [presetName, presetValue] of Object.entries(
    (rawPresets as Record<string, Preset> | undefined) ?? {},
  )) {
    Object.defineProperty(presets, presetName, {
      configurable: true,
      enumerable: true,
      value: presetValue,
      writable: true,
    });
  }
  Object.defineProperty(presets, name, {
    configurable: true,
    enumerable: true,
    value: preset,
    writable: true,
  });
  const candidate: Record<string, unknown> = { ...config, presets };
  const validationError = validateCandidateUserConfig(directory, candidate);
  if (validationError) return { ok: false, message: validationError };
  if (!writeUserConfig(directory, candidate)) {
    return { ok: false, message: 'Could not write the user config file.' };
  }
  return { ok: true };
}

/**
 * Delete a preset from the user config. Returns true if removed, false if the
 * preset did not exist or the write failed.
 */
export function deletePreset(directory: string, name: string): boolean {
  return deletePresetResult(directory, name).ok;
}

/** Delete a raw preset after validating the resulting merged graph. */
export function deletePresetResult(
  directory: string,
  name: string,
): PresetMutationResult {
  const userConfig = readUserConfig(directory);
  if (userConfig.kind === 'absent') {
    return { ok: false, message: 'User config file not found.' };
  }
  if (userConfig.kind === 'invalid') {
    return { ok: false, message: userConfig.message };
  }
  const config = userConfig.config;
  const rawPresets = config.presets;
  if (
    !rawPresets ||
    typeof rawPresets !== 'object' ||
    Array.isArray(rawPresets) ||
    !Object.hasOwn(rawPresets, name)
  ) {
    return { ok: false, message: `Preset "${name}" does not exist.` };
  }
  const presets = Object.create(null) as Record<string, Preset>;
  for (const [presetName, presetValue] of Object.entries(
    rawPresets as Record<string, Preset>,
  )) {
    if (presetName === name) continue;
    Object.defineProperty(presets, presetName, {
      configurable: true,
      enumerable: true,
      value: presetValue,
      writable: true,
    });
  }
  const candidate: Record<string, unknown> = { ...config, presets };
  // If the active preset was deleted, clear the `preset` field too.
  if ((config as Record<string, unknown>).preset === name) {
    delete candidate.preset;
  }
  const validationError = validateCandidateUserConfig(directory, candidate);
  if (validationError) return { ok: false, message: validationError };
  if (!writeUserConfig(directory, candidate)) {
    return { ok: false, message: 'Could not write the user config file.' };
  }
  return { ok: true };
}

function validateCandidateUserConfig(
  directory: string,
  candidate: Record<string, unknown>,
): string | undefined {
  let userValue: unknown;
  try {
    userValue = parseConfigContent(JSON.stringify(candidate));
  } catch (error) {
    return `Could not parse the candidate user config: ${String(error)}`;
  }
  const userResult = PluginConfigSchema.safeParse(userValue);
  if (!userResult.success) {
    return 'The candidate user config does not match the plugin schema.';
  }

  const { projectConfigPath } = findPluginConfigPaths(directory);
  let projectConfig: PluginConfig | undefined;
  if (projectConfigPath) {
    try {
      const raw = parseConfigContent(
        fs.readFileSync(projectConfigPath, 'utf8'),
      );
      const projectResult = PluginConfigSchema.safeParse(raw);
      if (!projectResult.success) {
        return 'The project config does not match the plugin schema.';
      }
      projectConfig = projectResult.data;
    } catch (error) {
      return `Could not validate the project config: ${String(error)}`;
    }
  }

  const merged = projectConfig
    ? mergePluginConfigs(userResult.data, projectConfig)
    : userResult.data;
  try {
    resolvePresetInheritance(merged.presets);
  } catch (error) {
    if (error instanceof PresetInheritanceError) return error.message;
    throw error;
  }
  return undefined;
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
  return { ...preset, [agentName]: override };
}

/**
 * Remove an agent from an in-memory preset. Returns a new preset object; does
 * not mutate the input. If the agent was not present, the preset is unchanged.
 */
export function removeAgentFromPreset(
  preset: Preset,
  agentName: string,
): Preset {
  if (!(agentName in preset)) return preset;
  const next = { ...preset };
  delete next[agentName];
  return next;
}
