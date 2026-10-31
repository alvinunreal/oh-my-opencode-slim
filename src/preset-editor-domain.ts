/**
 * Shared pure domain helpers for the preset editors.
 *
 * Two hosts implement the same three-level preset manager with different
 * control flows: the v1 TUI editor (`src/tui-preset.ts`, JSX dialogs) and the
 * v2 TUI editor (`src/v2/preset-manager.ts`, promise dialogs). Everything in
 * this module is host-agnostic and side-effect free so both editors share one
 * implementation of:
 *
 * - action-sentinel/user-choice wrapping (no user value can be shadowed by a
 *   manager action);
 * - new-preset name validation (pattern + reserved names) while pre-existing
 *   legacy/sentinel names stay usable;
 * - preset/override descriptions, inheritance resolution and cycle-safe base
 *   candidates;
 * - immutable agent add/remove/update;
 * - model-change variant clearing and the inherit-model transition;
 * - temperature and JSON options parsing;
 * - empty-override cleanup for persistable definitions.
 *
 * The modules deliberately keep their own control-flow adapters (callbacks vs.
 * promises) and only share these domain primitives.
 */
import type {
  AgentOverrideConfig,
  Preset,
  PresetDefinition,
  PresetInput,
} from './config';
import { normalizePreset, resolvePreset } from './config';
import { ALL_AGENT_NAMES } from './config/constants';

// --- action sentinels (embedded in select option values) ---

export const PRESET_ACTION = {
  NEW_PRESET: '__omo_new_preset__',
  ADD_AGENT: '__omo_add_agent__',
  REMOVE_AGENT: '__omo_remove_agent__',
  SAVE: '__omo_save__',
  SAVE_APPLY: '__omo_save_apply__',
  BACK: '__omo_back__',
  BASE_PRESET: '__omo_base_preset__',
  INHERIT_MODEL: '__omo_inherit_model__',
} as const;

/** Prefix for inherited-agent display rows (never an editable agent value). */
export const INHERITED_AGENT_PREFIX = '__omo_inherited__';

/**
 * Every string the managers themselves use as a select value. User-controlled
 * values that would exactly equal one of these (or start with the inherited
 * prefix) are wrapped via `wrapUserChoice`, so no user value can ever be
 * shadowed by a UI action.
 */
const ACTION_SENTINELS: ReadonlySet<string> = new Set<string>([
  ...Object.values(PRESET_ACTION),
  INHERITED_AGENT_PREFIX,
  '',
]);

/** A user-controlled select value wrapped to avoid action-sentinel collisions. */
interface WrappedUserChoice {
  user: string;
}

/** A select value produced by an editor's option lists. */
export type PresetChoice = string | WrappedUserChoice;

/** True when `value` is a wrapped user choice (not an action sentinel). */
function isWrappedUserChoice(value: unknown): value is WrappedUserChoice {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { user?: unknown }).user === 'string'
  );
}

/** Wrap a user value that could be mistaken for an action sentinel. */
export function wrapUserChoice(value: string): PresetChoice {
  return ACTION_SENTINELS.has(value) || value.startsWith(INHERITED_AGENT_PREFIX)
    ? { user: value }
    : value;
}

/** The raw user value behind a select choice. */
export function unwrapUserChoice(choice: PresetChoice): string {
  return isWrappedUserChoice(choice) ? choice.user : choice;
}

// --- new preset names ---

/** Allowed characters for newly created preset names. */
const PRESET_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Names that collide with JavaScript object internals. Existing config entries
 * with these names stay visible (and applicable) but can never be created,
 * edited, or deleted through the editors.
 */
const PROTOTYPE_SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** True for names that must never be used as plain object keys. */
export function isPrototypeSensitiveName(name: string): boolean {
  return PROTOTYPE_SENSITIVE_NAMES.has(name);
}

/** Reserved-name validation shared by both editors (pre-existing names are
 * not affected — only new creations). */
function reservedPresetNameError(name: string): string | undefined {
  if (name.startsWith('__omo_')) {
    return 'Preset names starting with "__omo_" are reserved for the preset manager UI. Choose a different name.';
  }
  if (isPrototypeSensitiveName(name)) {
    return `"${name}" is a reserved JavaScript property name and cannot be used as a preset name.`;
  }
  return undefined;
}

/**
 * Validate a user-typed name for a NEW preset. Returns an actionable error
 * message, or undefined when the name is acceptable. The returned name is not
 * trimmed here; callers trim first (see `validateNewPresetName` semantics in
 * the editors) — this helper expects the trimmed value.
 */
export function validateNewPresetName(name: string): string | undefined {
  if (!name) {
    return 'Preset names cannot be empty.';
  }
  if (!PRESET_NAME_PATTERN.test(name)) {
    return 'Preset names may only contain letters, digits, hyphens ("-"), and underscores ("_").';
  }
  return reservedPresetNameError(name);
}

// --- own-property-safe preset reads ---

/**
 * Own-property-only value read. Plain `record[name]` walks the prototype
 * chain, so pre-existing `__proto__`/`constructor` keys can resolve to
 * Object.prototype members. Editors use this for every user-controlled key.
 */
export function ownPresetValue<T>(
  record: Record<string, T>,
  name: string,
): T | undefined {
  if (!Object.hasOwn(record, name)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  if (!descriptor || !('value' in descriptor)) return undefined;
  return descriptor.value as T;
}

// --- descriptions ---

/** Format one override for list descriptions (shared by both editors). */
export function describeOverride(override: AgentOverrideConfig): string {
  const bits: string[] = [];
  if (typeof override.model === 'string') {
    bits.push(override.model);
  } else if (Array.isArray(override.model) && override.model.length > 0) {
    const first = override.model[0];
    bits.push(typeof first === 'string' ? first : first.id);
  }
  if (typeof override.inheritModelFrom === 'string') {
    bits.push(`inherit=${override.inheritModelFrom}`);
  }
  if (typeof override.variant === 'string') {
    bits.push(`variant=${override.variant}`);
  }
  if (typeof override.temperature === 'number') {
    bits.push(`temp=${override.temperature}`);
  }
  if (override.options && Object.keys(override.options).length > 0) {
    bits.push('options');
  }
  if (Array.isArray(override.skills) && override.skills.length > 0) {
    bits.push(`skills=[${override.skills.join(',')}]`);
  }
  if (Array.isArray(override.skills_add) && override.skills_add.length > 0) {
    bits.push(`skills_add=[${override.skills_add.join(',')}]`);
  }
  if (
    Array.isArray(override.skills_remove) &&
    override.skills_remove.length > 0
  ) {
    bits.push(`skills_remove=[${override.skills_remove.join(',')}]`);
  }
  if (typeof override.skills_include_local === 'boolean') {
    bits.push(`skills_include_local=${override.skills_include_local}`);
  }
  if (Array.isArray(override.mcps) && override.mcps.length > 0) {
    bits.push(`mcps=[${override.mcps.join(',')}]`);
  }
  if (typeof override.prompt === 'string') {
    bits.push('prompt');
  }
  if (typeof override.orchestratorPrompt === 'string') {
    bits.push('orchestratorPrompt');
  }
  if (override.permission !== undefined) {
    bits.push('permission');
  }
  if (typeof override.displayName === 'string') {
    bits.push(`name=${override.displayName}`);
  }
  return bits.length > 0 ? bits.join(', ') : '(unset)';
}

/** Normalize one raw preset declaration, tolerating malformed entries. */
function safeNormalizePreset(raw: PresetInput): PresetDefinition | undefined {
  try {
    return normalizePreset(raw);
  } catch {
    return undefined;
  }
}

/** Level-1 preset description: `extends: base (agents...)` or an agent list. */
export function describePreset(
  name: string,
  allPresets: Record<string, PresetInput>,
  resolvedPreset?: Preset,
): string {
  const raw = ownPresetValue(allPresets, name);
  const normalized = raw !== undefined ? safeNormalizePreset(raw) : undefined;
  try {
    const resolved = resolvedPreset ?? resolvePreset(name, allPresets);
    const parts = Object.entries(resolved).map(
      ([agent, override]) => `${agent}: ${describeOverride(override)}`,
    );
    if (normalized?.extends) {
      return `extends: ${normalized.extends}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
    }
    return parts.length > 0 ? parts.join(', ') : '(empty)';
  } catch {
    if (normalized?.extends) {
      return `extends: ${normalized.extends} (unresolved inheritance)`;
    }
    return '(empty)';
  }
}

// --- inheritance ---

export interface ResolvedInheritance {
  inheritedAgents: Preset;
  /** Human-readable resolution error, or null when the base resolved. */
  error: string | null;
}

/** Resolve a working copy's base preset with cycle detection, never throwing. */
export function resolveInheritedAgents(
  presetName: string,
  working: PresetDefinition,
  allPresets: Record<string, PresetInput>,
  wouldCreateCycle: (
    childName: string,
    targetParent: string,
    presets: Record<string, PresetInput>,
  ) => boolean,
): ResolvedInheritance {
  if (!working.extends) {
    return { inheritedAgents: {}, error: null };
  }
  if (wouldCreateCycle(presetName, working.extends, allPresets)) {
    return {
      inheritedAgents: {},
      error: `Cycle detected with "${working.extends}"`,
    };
  }
  try {
    return {
      inheritedAgents: resolvePreset(working.extends, allPresets),
      error: null,
    };
  } catch (err) {
    return {
      inheritedAgents: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Inherited-but-not-overridden agent names, in inherited order. */
export function inheritedAgentNames(
  working: PresetDefinition,
  inheritedAgents: Preset,
): string[] {
  return Object.keys(inheritedAgents).filter(
    (name) => !Object.hasOwn(working.agents, name),
  );
}

/** Description of the base-preset row (Level 2). */
export function describeBasePresetRow(
  working: PresetDefinition,
  inheritanceError: string | null,
): string {
  if (working.extends) {
    return inheritanceError
      ? `Error: ${inheritanceError}. Select to change or remove.`
      : `Inherits from "${working.extends}". Select to change or remove.`;
  }
  return 'Select to inherit configuration from another preset.';
}

/** Cycle-safe base candidates (excludes self and cycle-forming entries). */
export function basePresetCandidates(
  presetName: string,
  allPresets: Record<string, PresetInput>,
  wouldCreateCycle: (
    childName: string,
    targetParent: string,
    presets: Record<string, PresetInput>,
  ) => boolean,
): string[] {
  return Object.keys(allPresets).filter((candidate) => {
    if (candidate === presetName) return false;
    return !wouldCreateCycle(presetName, candidate, allPresets);
  });
}

/** Description of one base-preset candidate row. */
export function describeBasePresetCandidate(
  candidate: string,
  allPresets: Record<string, PresetInput>,
): string {
  try {
    const resolved = resolvePreset(candidate, allPresets);
    const count = Object.keys(resolved).length;
    return `${count} effective agent${count === 1 ? '' : 's'}: ${Object.keys(resolved).join(', ')}`;
  } catch {
    return 'Configured preset';
  }
}

// --- immutable agent collections ---

/** Add or replace an agent override. Returns a new preset object. */
export function withAgentOverride(
  agents: Preset,
  agentName: string,
  override: AgentOverrideConfig,
): Preset {
  const next: Preset = { ...agents };
  Object.defineProperty(next, agentName, {
    value: override,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return next;
}

/** Remove an agent override. Returns a new preset object. */
export function withoutAgentOverride(
  agents: Preset,
  agentName: string,
): Preset {
  if (!Object.hasOwn(agents, agentName)) return agents;
  const next = { ...agents };
  delete next[agentName];
  return next;
}

/** Known agents not yet present in the working copy. */
export function availableAgentNames(present: Iterable<string>): string[] {
  const taken = new Set(present);
  return ALL_AGENT_NAMES.filter((name) => !taken.has(name));
}

// --- level-3 primitives ---

/** Apply a picked model; a variant the new model does not expose is cleared. */
export function applyModelChoice(
  current: AgentOverrideConfig,
  model: string,
  variants: readonly string[],
): AgentOverrideConfig {
  const next: AgentOverrideConfig = { ...current, model };
  if (typeof next.variant !== 'string' || !variants.includes(next.variant)) {
    delete next.variant;
  }
  return next;
}

/** Drop the local model override (inherit from the base preset). */
export function applyInheritModelChoice(
  current: AgentOverrideConfig,
): AgentOverrideConfig {
  const next: AgentOverrideConfig = { ...current };
  delete next.model;
  delete next.variant;
  return next;
}

/** Apply a picked variant (undefined/empty clears it). */
export function applyVariantChoice(
  current: AgentOverrideConfig,
  variant: string | undefined,
): AgentOverrideConfig {
  const next: AgentOverrideConfig = { ...current };
  if (variant) {
    next.variant = variant;
  } else {
    delete next.variant;
  }
  return next;
}

export type ParsedTemperature =
  | { ok: true; temperature?: number }
  | { ok: false; message: string };

/**
 * Parse a temperature prompt value: blank clears the override; anything else
 * must be a number in [0, 2].
 */
export function parseTemperatureInput(raw: string): ParsedTemperature {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true };
  }
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 2) {
    return {
      ok: false,
      message: 'Temperature must be a number between 0 and 2.',
    };
  }
  return { ok: true, temperature: parsed };
}

export type ParsedOptions =
  | { ok: true; options?: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Parse an options prompt value: valid JSON plain object, `{}` clearing the
 * override. Arrays, null, and scalars are rejected with actionable text.
 */
export function parseOptionsInput(raw: string): ParsedOptions {
  const trimmed = raw.trim() || '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: 'Options must be valid JSON.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      message:
        'Options must be a JSON object, e.g. {"thinking":{"type":"enabled","budgetTokens":10000}}.',
    };
  }
  const options = parsed as Record<string, unknown>;
  return Object.keys(options).length > 0 ? { ok: true, options } : { ok: true };
}

/** Apply a parsed options value onto an override (undefined clears it). */
export function applyOptionsChoice(
  current: AgentOverrideConfig,
  options: Record<string, unknown> | undefined,
): AgentOverrideConfig {
  const next: AgentOverrideConfig = { ...current };
  if (options && Object.keys(options).length > 0) {
    next.options = options;
  } else {
    delete next.options;
  }
  return next;
}

/** Apply a parsed temperature onto an override (undefined clears it). */
export function applyTemperatureChoice(
  current: AgentOverrideConfig,
  temperature: number | undefined,
): AgentOverrideConfig {
  const next: AgentOverrideConfig = { ...current };
  if (typeof temperature === 'number') {
    next.temperature = temperature;
  } else {
    delete next.temperature;
  }
  return next;
}

// --- persistence ---

/**
 * Build the persistable definition: strips agents whose override is empty
 * (they add nothing) and preserves local `extends`/`marketplace` fields
 * without materializing inherited agents.
 */
export function buildPersistablePreset(
  working: PresetDefinition,
): Preset | PresetDefinition {
  const cleaned: Preset = {};
  for (const [agent, override] of Object.entries(working.agents)) {
    if (override && Object.keys(override).length > 0) {
      Object.defineProperty(cleaned, agent, {
        value: override,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  if (working.extends || working.marketplace !== undefined) {
    return {
      ...(working.extends ? { extends: working.extends } : {}),
      agents: cleaned,
      ...(working.marketplace !== undefined
        ? { marketplace: working.marketplace }
        : {}),
    };
  }
  return cleaned;
}
