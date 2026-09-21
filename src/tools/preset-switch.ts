import * as fs from 'node:fs';
import { stripJsonComments } from '../cli/config-io';
import type {
  AgentOverrideConfig,
  PluginConfig,
  Preset,
  PresetDefinition,
  PresetInput,
} from '../config';
import {
  deepMerge,
  normalizePreset,
  PresetResolutionError,
  resolvePreset,
} from '../config';
import { AGENT_ALIASES } from '../config/constants';
import { findPluginConfigPaths } from '../config/loader';

export type PresetMap = Record<string, PresetInput>;

function interpolateConfigEnvironment(raw: string): string {
  return raw.replace(
    /\{env:([^}]+)\}/g,
    (_, variableName) => process.env[variableName] ?? '',
  );
}

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

type PersistPresetResult = { ok: true } | { ok: false; message: string };

/** A flattened, SDK-shaped agent override derived from a preset entry. */
export interface AgentUpdate {
  model?: string;
  inheritModelFrom?: string;
  temperature?: number;
  variant?: string;
  options?: Record<string, unknown>;
  skills?: string[];
  skills_add?: string[];
  skills_remove?: string[];
  skills_include_local?: boolean;
  mcps?: string[];
  prompt?: string;
  orchestratorPrompt?: string;
  displayName?: string;
  description?: string;
  color?: string;
  permission?: unknown;
}

/**
 * Determine whether a preset defines at least one non-empty agent override.
 * Non-model fields (inheritModelFrom, skills, mcps, prompts, permissions, etc.)
 * make an override valid.
 */
export function hasPresetOverrides(preset: Preset): boolean {
  for (const override of Object.values(preset)) {
    if (override && typeof override === 'object' && !Array.isArray(override)) {
      if (Object.keys(override).length > 0) {
        return true;
      }
    }
  }
  return false;
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
  const configuredPresets = getAllConfiguredPresets(directory);
  const presets: PresetMap = {
    ...configuredPresets,
    ...((config.presets ?? {}) as PresetMap),
  };
  const rawPreset = presets[presetName];

  if (!rawPreset) {
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

  let effectivePreset: Preset;
  try {
    effectivePreset = resolvePreset(presetName, presets);
  } catch (error) {
    return {
      ok: false,
      presetName,
      message:
        error instanceof PresetResolutionError
          ? `Preset "${presetName}" cannot be applied: ${error.message}.`
          : `Preset "${presetName}" inheritance resolution failed: ${String(error)}.`,
      summary: [],
    };
  }

  if (!hasPresetOverrides(effectivePreset)) {
    return {
      ok: false,
      presetName,
      message: `Preset "${presetName}" is empty (no agent overrides defined).`,
      summary: [],
    };
  }

  const projectConfig = readProjectConfig(directory);
  const projectPreset =
    typeof projectConfig?.preset === 'string'
      ? projectConfig.preset.trim()
      : undefined;

  if (projectPreset && projectPreset !== presetName) {
    return {
      ok: false,
      presetName,
      message: `Cannot switch to preset "${presetName}": project config (.opencode) explicitly sets preset "${projectPreset}", which takes precedence on reload. Remove or update the preset in .opencode/oh-my-opencode-slim.jsonc first.`,
      summary: [],
    };
  }

  const envPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  if (envPreset && envPreset !== presetName) {
    return {
      ok: false,
      presetName,
      message: `Cannot switch to preset "${presetName}": OH_MY_OPENCODE_SLIM_PRESET is set to "${envPreset}", which takes precedence on reload. Unset the environment variable or set it to "${presetName}" first.`,
      summary: [],
    };
  }

  const agentUpdates = buildAgentUpdates(effectivePreset);
  const persistence = persistPresetName(directory, presetName);
  if (!persistence.ok) {
    return {
      ok: false,
      presetName,
      message: `Could not save preset "${presetName}": ${persistence.message}`,
      summary: [],
    };
  }

  return {
    ok: true,
    presetName,
    message: `Saved preset "${presetName}". Reload OpenCode for it to take effect. The current session keeps its existing agent models to avoid truncating context, drifting prior turns, or destabilizing running subagents.`,
    summary: buildPresetSummary(agentUpdates),
  };
}

/**
 * Build the SDK-shaped agent overrides from a preset, resolving legacy alias
 * keys (e.g. "explore" → "explorer").
 */
export function buildAgentUpdates(preset: Preset): Record<string, AgentUpdate> {
  const agentUpdates: Record<string, AgentUpdate> = {};
  for (const [agentName, override] of Object.entries(preset)) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      continue;
    }
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

  if (typeof override.inheritModelFrom === 'string') {
    agentConfig.inheritModelFrom = override.inheritModelFrom;
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

  if (Array.isArray(override.skills) && override.skills.length > 0) {
    agentConfig.skills = override.skills;
  }

  if (Array.isArray(override.skills_add) && override.skills_add.length > 0) {
    agentConfig.skills_add = override.skills_add;
  }

  if (
    Array.isArray(override.skills_remove) &&
    override.skills_remove.length > 0
  ) {
    agentConfig.skills_remove = override.skills_remove;
  }

  if (typeof override.skills_include_local === 'boolean') {
    agentConfig.skills_include_local = override.skills_include_local;
  }

  if (Array.isArray(override.mcps) && override.mcps.length > 0) {
    agentConfig.mcps = override.mcps;
  }

  if (typeof override.prompt === 'string') {
    agentConfig.prompt = override.prompt;
  }

  if (typeof override.orchestratorPrompt === 'string') {
    agentConfig.orchestratorPrompt = override.orchestratorPrompt;
  }

  if (typeof override.displayName === 'string') {
    agentConfig.displayName = override.displayName;
  }

  if (typeof override.description === 'string') {
    agentConfig.description = override.description;
  }

  if (typeof override.color === 'string') {
    agentConfig.color = override.color;
  }

  if (override.permission !== undefined) {
    agentConfig.permission = override.permission;
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
    if (cfg.inheritModelFrom) parts.push(`inherit: ${cfg.inheritModelFrom}`);
    if (cfg.variant) parts.push(`variant: ${cfg.variant}`);
    if (cfg.temperature !== undefined) parts.push(`temp: ${cfg.temperature}`);
    if (cfg.options) parts.push('options: yes');
    if (cfg.skills && cfg.skills.length > 0) {
      parts.push(`skills: ${cfg.skills.join(',')}`);
    }
    if (cfg.skills_add && cfg.skills_add.length > 0) {
      parts.push(`skills_add: ${cfg.skills_add.join(',')}`);
    }
    if (cfg.skills_remove && cfg.skills_remove.length > 0) {
      parts.push(`skills_remove: ${cfg.skills_remove.join(',')}`);
    }
    if (cfg.skills_include_local !== undefined) {
      parts.push(`skills_include_local: ${cfg.skills_include_local}`);
    }
    if (cfg.mcps && cfg.mcps.length > 0) {
      parts.push(`mcps: ${cfg.mcps.join(',')}`);
    }
    if (cfg.prompt) parts.push('prompt: yes');
    if (cfg.orchestratorPrompt) parts.push('orchestratorPrompt: yes');
    if (cfg.displayName) parts.push(`displayName: ${cfg.displayName}`);
    if (cfg.description) parts.push('description: yes');
    if (cfg.color) parts.push(`color: ${cfg.color}`);
    if (cfg.permission !== undefined) parts.push('permissions: yes');
    if (parts.length > 1) {
      summaryParts.push(parts.join(' → '));
    }
  }
  return summaryParts;
}

/**
 * Persist the preset name to the user-level config file so it survives
 * restarts. A failure is returned so callers do not report a switch that will
 * not survive the next reload.
 *
 * Note: this rewrites the file as plain JSON (JSONC comments are not
 * preserved), matching the prior server-side behavior.
 */
function persistPresetName(
  directory: string,
  presetName: string,
): PersistPresetResult {
  let userConfigPath: string | null;
  try {
    userConfigPath = findPluginConfigPaths(directory).userConfigPath;
  } catch (error) {
    return {
      ok: false,
      message: `Could not locate the user config file: ${describeError(error)}.`,
    };
  }

  if (!userConfigPath) {
    return {
      ok: false,
      message:
        'No user config file was found. Create oh-my-opencode-slim.jsonc or .json before switching presets.',
    };
  }

  let persisted: Record<string, unknown>;
  try {
    // Strip a UTF-8 BOM (RFC 8259 permits one); JSON.parse would otherwise
    // fail with "Unrecognized token" and the preset would not be persisted.
    const raw = fs.readFileSync(userConfigPath, 'utf-8').replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(stripJsonComments(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the config root must be a JSON object');
    }
    persisted = parsed as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      message: `Could not read or parse the user config file: ${describeError(error)}.`,
    };
  }

  try {
    persisted.preset = presetName;
    fs.writeFileSync(userConfigPath, `${JSON.stringify(persisted, null, 2)}\n`);
  } catch (error) {
    return {
      ok: false,
      message: `Could not write the user config file: ${describeError(error)}.`,
    };
  }

  return { ok: true };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the user-level config file as a parsed object. Returns null if the
 * file is absent or unreadable.
 */
export function readUserConfig(
  directory: string,
): Record<string, unknown> | null {
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
 * Read raw presets from the editable user config file.
 */
export function readUserPresets(
  directory: string,
): Record<string, PresetInput> {
  const config = readUserConfig(directory);
  if (
    !config ||
    typeof config.presets !== 'object' ||
    config.presets === null ||
    Array.isArray(config.presets)
  ) {
    return {};
  }
  return config.presets as Record<string, PresetInput>;
}

/**
 * Read the project-level config file as a parsed object. Returns null if absent.
 */
export function readProjectConfig(
  directory: string,
): Record<string, unknown> | null {
  try {
    const { projectConfigPath } = findPluginConfigPaths(directory);
    if (!projectConfigPath) return null;
    const raw = fs
      .readFileSync(projectConfigPath, 'utf-8')
      .replace(/^\uFEFF/, '');
    return JSON.parse(
      interpolateConfigEnvironment(stripJsonComments(raw)),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Retrieve all raw presets configured across user and project config files.
 */
export function getAllConfiguredPresets(
  directory: string,
): Record<string, PresetInput> {
  const userPresets = readUserPresets(directory);
  const projectConfig = readProjectConfig(directory);
  const projectPresets =
    projectConfig &&
    typeof projectConfig.presets === 'object' &&
    projectConfig.presets !== null &&
    !Array.isArray(projectConfig.presets)
      ? (projectConfig.presets as Record<string, PresetInput>)
      : {};
  return (deepMerge(userPresets, projectPresets) ?? {}) as Record<
    string,
    PresetInput
  >;
}

export type PresetSource = 'project' | 'user' | 'none';

/**
 * Determine the configuration source of a preset.
 * Returns 'project' if the preset is defined in project config (.opencode),
 * 'user' if defined in user config, or 'none' if not found.
 */
export function getPresetSource(directory: string, name: string): PresetSource {
  const projectConfig = readProjectConfig(directory);
  if (
    projectConfig &&
    typeof projectConfig.presets === 'object' &&
    projectConfig.presets !== null &&
    !Array.isArray(projectConfig.presets) &&
    Object.hasOwn(projectConfig.presets, name)
  ) {
    return 'project';
  }
  const userPresets = readUserPresets(directory);
  if (Object.hasOwn(userPresets, name)) {
    return 'user';
  }
  return 'none';
}

/**
 * Get the editable local definition of a preset (only local agents and local `extends`).
 * Does NOT materialize inherited effective agents.
 */
export function getEditablePreset(
  directory: string,
  name: string,
): PresetDefinition {
  const userPresets = readUserPresets(directory);
  const raw = userPresets[name];
  if (raw !== undefined) {
    return normalizePreset(raw);
  }
  const projectConfig = readProjectConfig(directory);
  const projectPresets =
    projectConfig &&
    typeof projectConfig.presets === 'object' &&
    projectConfig.presets !== null &&
    !Array.isArray(projectConfig.presets)
      ? (projectConfig.presets as Record<string, PresetInput>)
      : {};
  const projectRaw = projectPresets[name];
  if (projectRaw !== undefined) {
    return normalizePreset(projectRaw);
  }
  return { agents: {} };
}

/**
 * Find all preset names in `presets` that directly extend `baseName`.
 */
export function findPresetDependents(
  baseName: string,
  presets: Record<string, PresetInput>,
): string[] {
  const dependents: string[] = [];
  for (const [name, definition] of Object.entries(presets)) {
    if (name === baseName || !definition) continue;
    try {
      const normalized = normalizePreset(definition);
      if (normalized.extends === baseName) {
        dependents.push(name);
      }
    } catch {
      // Ignore malformed entries
    }
  }
  return dependents;
}

/**
 * Check if setting `targetParent` as the parent of `childName` would create a cycle.
 */
export function wouldCreatePresetCycle(
  childName: string,
  targetParent: string,
  presets: Record<string, PresetInput>,
): boolean {
  if (childName === targetParent) {
    return true;
  }

  const visited = new Set<string>();
  let current: string | undefined = targetParent;

  while (current) {
    if (current === childName) {
      return true;
    }
    if (visited.has(current)) {
      // Existing cycle in targetParent's ancestry
      return true;
    }
    visited.add(current);

    const definition = presets[current];
    if (!definition) {
      break;
    }
    try {
      const normalized = normalizePreset(definition);
      current = normalized.extends;
    } catch {
      break;
    }
  }

  return false;
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
 * object. Supports both flat agent maps and structured preset definitions with `extends`.
 * Preserves local `extends` and local agents only without materializing inherited agents.
 * Returns true on success.
 */
export function writePreset(
  directory: string,
  name: string,
  preset: Preset | PresetDefinition,
): boolean {
  const config = readUserConfig(directory) ?? {};
  const presets =
    (config.presets as Record<string, PresetInput> | undefined) ?? {};

  if (
    'extends' in preset &&
    typeof preset.extends === 'string' &&
    preset.extends
  ) {
    const agents =
      'agents' in preset && preset.agents && typeof preset.agents === 'object'
        ? (preset.agents as Preset)
        : {};
    const definition: PresetDefinition = {
      extends: preset.extends,
      agents,
    };
    presets[name] = definition;
  } else if (
    'agents' in preset &&
    typeof preset.agents === 'object' &&
    preset.agents !== null
  ) {
    // PresetDefinition without extends (or extends is undefined)
    presets[name] = preset.agents as Preset;
  } else {
    // Plain agent record
    presets[name] = preset as Preset;
  }

  config.presets = presets;
  return writeUserConfig(directory, config);
}

/**
 * Delete a preset from the user config. Returns true if removed.
 * Returns false if the preset did not exist, if the write failed,
 * or if other presets in the editable config depend on it.
 */
export function deletePreset(directory: string, name: string): boolean {
  const config = readUserConfig(directory);
  if (!config) return false;
  const presets = config.presets as Record<string, PresetInput> | undefined;
  if (!presets || !(name in presets)) return false;

  // Reject deleting a base preset that has dependents across all configured presets (user or project)
  const allPresets = getAllConfiguredPresets(directory);
  const dependents = findPresetDependents(name, allPresets);
  if (dependents.length > 0) {
    return false;
  }

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
