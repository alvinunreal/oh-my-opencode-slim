import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_ALIASES,
  ALL_AGENT_NAMES,
  DEFAULT_DISABLED_AGENTS,
  PROTECTED_AGENTS,
} from '../config/constants';
import {
  mutateJsonFile,
  removeTopLevelJsonProperty,
  writeJsonAtomic,
} from '../config/json-file';
import { parseJsonConfigText } from '../config/jsonc';
import {
  type ConfigLoadWarning,
  findPluginConfigPaths,
  getPluginConfigCandidates,
  isProjectConfigDisabled,
  loadRawPluginConfigFromPath,
} from '../config/loader';
import {
  mergeAgentOverrides,
  mergePresetMaps,
  normalizePreset,
  resolvePresetDefinition,
} from '../config/presets';
import {
  type AgentOverrideConfig,
  type PluginConfig,
  type Preset,
  type PresetDefinition,
  type PresetInput,
  PresetSchema,
} from '../config/schema';
import { readPluginConfigSnapshot } from '../config/snapshot';
import { validateNewPresetName } from '../preset-editor-domain';
import {
  deletePreset as deletePresetOnDisk,
  findPresetDependents,
  getPresetSelectionState,
  getPresetSource,
  readProjectConfig,
  switchPresetOnDisk,
  writePreset,
} from '../tools/preset-switch';
import type {
  AgentEntry,
  OverridePatch,
  PresetInfo,
  ResultMessage,
  RosterEntry,
  Snapshot,
} from './rpc';

/**
 * Desktop GUI config adapter. Discovery, runtime schema validation, preset
 * resolution and JSONC writes are delegated to the OMOS config and
 * preset-switch modules; this module only maps their results onto the GUI RPC
 * contract and applies the audited override/edit semantics.
 */

const SCHEMA_SEED =
  'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json';
const HOST_FLAVOR = 'v2';

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  orchestrator: 'Primary orchestrator',
  explorer: 'Codebase exploration',
  oracle: 'Read-only analysis',
  designer: 'UI and UX implementation',
  fixer: 'Focused code changes',
  observer: 'Visual analysis',
  council: 'Parallel specialist panel',
  councillor: 'Council synthesis',
};

export interface OmosBackendOptions {
  /** Context location directory; required. Never falls back to process.cwd(). */
  directory: string;
  env?: EnvLike;
  homedir?: () => string;
}

export interface SnapshotHostInfo {
  omosVersion?: string;
}

export interface OmosBackend {
  getSnapshot(
    input?: { directory?: string },
    host?: SnapshotHostInfo,
  ): Promise<Snapshot>;
  switchPreset(input: {
    name: string;
    directory?: string;
  }): Promise<ResultMessage>;
  clearPresetDefault(input?: { directory?: string }): Promise<ResultMessage>;
  createPreset(input: {
    name: string;
    copyFrom?: string;
    directory?: string;
  }): Promise<ResultMessage>;
  deletePreset(input: {
    name: string;
    directory?: string;
  }): Promise<ResultMessage>;
  setAgentOverride(input: {
    preset: string;
    agent: string;
    patch: OverridePatch;
    directory?: string;
  }): Promise<ResultMessage>;
  removeAgent(input: {
    preset: string;
    agent: string;
    directory?: string;
  }): Promise<ResultMessage>;
  setAgentDisabled(input: {
    agent: string;
    disabled: boolean;
    directory?: string;
  }): Promise<ResultMessage>;
}

type EnvLike = Record<string, string | undefined>;
type UnknownRecord = Record<string, unknown>;
type AgentMap = Record<string, AgentOverrideConfig>;
type PresetMap = Record<string, PresetInput>;

interface PresetState {
  userPath: string | null;
  userPresets: PresetMap;
  projectPresets: PresetMap;
  effectivePresets: PresetMap;
  projectPreset: string;
}

interface PresetInspection {
  raw: PresetInput | undefined;
  resolved: AgentMap;
  local: AgentMap;
  extendsList: string[];
  validationError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ok(message: string): ResultMessage {
  return { ok: true, message };
}

function fail(message: string): ResultMessage {
  return { ok: false, message };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: object, key: string): boolean {
  return Object.hasOwn(record, key);
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  if (!hasOwn(record, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor
    ? (descriptor.value as T)
    : undefined;
}

function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function canonicalAgentName(name: string): string {
  return hasOwn(AGENT_ALIASES, name) ? AGENT_ALIASES[name] : name;
}

function isPrototypeSensitiveName(name: string): boolean {
  return name === '__proto__' || name === 'constructor' || name === 'prototype';
}

/** Apply the backend's injected environment for one synchronous upstream read/write. */
function withEnvironment<T>(
  options: OmosBackendOptions,
  operation: () => T,
): T {
  const environment = options.env;
  const home = options.homedir;
  if (!environment && !home) return operation();
  const previous = new Map<string, string | undefined>();
  const apply = (key: string, value: string | undefined): void => {
    if (!previous.has(key)) previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  if (environment) {
    for (const [key, value] of Object.entries(environment)) apply(key, value);
  }
  if (home && environment?.HOME === undefined) apply('HOME', home());
  if (home && environment?.USERPROFILE === undefined)
    apply('USERPROFILE', home());
  try {
    return operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function interpolateEnvironmentVariables(value: string): string {
  return value.replace(
    /\{env:([^}]+)\}/g,
    (_, variableName: string) => process.env[variableName] ?? '',
  );
}

function envPresetName(): string {
  return process.env.OH_MY_OPENCODE_SLIM_PRESET?.trim() ?? '';
}

function presetMapOf(value: unknown): PresetMap {
  if (!isRecord(value)) return {};
  const presets: PresetMap = {};
  for (const [name, definition] of Object.entries(value)) {
    defineOwn(presets, name, definition as PresetInput);
  }
  return presets;
}

function mergePresetLayers(base: PresetMap, override: PresetMap): PresetMap {
  if (Object.keys(base).length === 0) return override;
  if (Object.keys(override).length === 0) return base;
  try {
    return (mergePresetMaps(base, override) ?? {}) as PresetMap;
  } catch {
    // A malformed declaration must never hide the editable layers; the
    // per-preset schema check reports it instead.
    const merged: PresetMap = {};
    for (const [name, definition] of Object.entries(base))
      defineOwn(merged, name, definition);
    for (const [name, definition] of Object.entries(override))
      defineOwn(merged, name, definition);
    return merged;
  }
}

function readRawJsonObject(configPath: string): UnknownRecord | null {
  try {
    return parseJsonConfigText(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Raw editable preset layers; each definition is checked against PresetSchema for the runtime view. */
function readPresetState(directory: string): PresetState {
  const { userConfigPath, projectConfigPaths } = findPluginConfigPaths(
    directory,
    HOST_FLAVOR,
  );
  const userData = userConfigPath ? readRawJsonObject(userConfigPath) : null;
  const userPresets = presetMapOf(userData?.presets);
  let projectPresets: PresetMap = {};
  let projectPreset = '';
  for (const configPath of projectConfigPaths) {
    const layer = readRawJsonObject(configPath);
    if (!layer) continue;
    projectPresets = mergePresetLayers(
      projectPresets,
      presetMapOf(layer.presets),
    );
    if (typeof layer.preset === 'string') {
      projectPreset = interpolateEnvironmentVariables(layer.preset).trim();
    }
  }
  return {
    userPath: userConfigPath,
    userPresets,
    projectPresets,
    effectivePresets: mergePresetLayers(userPresets, projectPresets),
    projectPreset,
  };
}

function declaredExtends(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (typeof value.extends === 'string' && value.extends.length > 0)
    return [value.extends];
  if (Array.isArray(value.extends)) {
    return value.extends.filter(
      (item): item is string => typeof item === 'string',
    );
  }
  return [];
}

interface SchemaIssue {
  path: PropertyKey[];
  message: string;
  errors?: unknown;
}

function deepestSchemaIssue(issue: SchemaIssue): SchemaIssue {
  const grouped = issue.errors;
  if (!Array.isArray(grouped)) return issue;
  const nested: SchemaIssue[] = [];
  for (const group of grouped) {
    if (!Array.isArray(group)) continue;
    for (const candidate of group) {
      if (
        isRecord(candidate) &&
        Array.isArray(candidate.path) &&
        typeof candidate.message === 'string'
      ) {
        nested.push(candidate as unknown as SchemaIssue);
      }
    }
  }
  const withField = nested.filter((candidate) => candidate.path.length > 0);
  const preferred =
    withField.find((candidate) =>
      candidate.path.some((part) => String(part) === 'extends'),
    ) ??
    withField[0] ??
    nested[0];
  return preferred ? deepestSchemaIssue(preferred) : issue;
}

function formatSchemaError(error: {
  issues: ReadonlyArray<SchemaIssue>;
}): string {
  const issue = error.issues[0];
  if (!issue) return 'Preset definition does not match the runtime schema.';
  const detail = deepestSchemaIssue(issue);
  const location =
    detail.path.length > 0 ? `${detail.path.map(String).join('.')}: ` : '';
  return `${location}${detail.message}`;
}

function safeNormalizePreset(value: PresetInput): PresetDefinition | undefined {
  try {
    return normalizePreset(value);
  } catch {
    return undefined;
  }
}

/**
 * Resolution-only copy of the preset map: `{env:...}` placeholders in
 * `extends` are expanded the way the runtime config loader expands them.
 * Writes still read the raw map, so placeholders survive edits.
 */
function expandedPresetDefinitions(presets: PresetMap): PresetMap {
  const expanded: PresetMap = {};
  for (const [name, definition] of Object.entries(presets)) {
    if (!isRecord(definition)) {
      defineOwn(expanded, name, definition);
      continue;
    }
    const extendsValue = definition.extends;
    const expandedExtends =
      typeof extendsValue === 'string'
        ? interpolateEnvironmentVariables(extendsValue)
        : Array.isArray(extendsValue)
          ? extendsValue.map((value) =>
              typeof value === 'string'
                ? interpolateEnvironmentVariables(value)
                : value,
            )
          : extendsValue;
    defineOwn(expanded, name, {
      ...definition,
      ...(expandedExtends !== undefined ? { extends: expandedExtends } : {}),
    });
  }
  return expanded;
}

function inspectPreset(name: string, state: PresetState): PresetInspection {
  const raw = ownValue(state.effectivePresets, name);
  const resolvedPresets = expandedPresetDefinitions(state.effectivePresets);
  const normalized = raw !== undefined ? safeNormalizePreset(raw) : undefined;
  const extendsList = declaredExtends(ownValue(resolvedPresets, name));
  if (raw === undefined) {
    return { raw, resolved: {}, local: {}, extendsList };
  }
  const parsed = PresetSchema.safeParse(raw);
  let validationError = parsed.success
    ? undefined
    : formatSchemaError(parsed.error);
  let resolved: AgentMap = mergeAgentOverrides({}, normalized?.agents ?? {});
  if (!validationError) {
    try {
      resolved = resolvePresetDefinition(name, resolvedPresets)
        .agents as AgentMap;
    } catch (error) {
      validationError = errorMessage(error);
    }
  }
  if (validationError)
    resolved = mergeAgentOverrides({}, normalized?.agents ?? {});
  const local = mergeAgentOverrides({}, normalized?.agents ?? {});
  return { raw, resolved, local, extendsList, validationError };
}

function toAgentEntry(
  name: string,
  raw: unknown,
  inherited: boolean,
): AgentEntry {
  const override = isRecord(raw) ? raw : {};
  let model: string | undefined;
  let embeddedVariant: string | undefined;
  let modelChain: string[] | undefined;

  if (typeof override.model === 'string') {
    model = override.model;
  } else if (Array.isArray(override.model) && override.model.length > 0) {
    const ids: string[] = [];
    for (const entry of override.model) {
      if (typeof entry === 'string') ids.push(entry);
      else if (isRecord(entry) && typeof entry.id === 'string')
        ids.push(entry.id);
    }
    const first = override.model[0];
    if (typeof first === 'string') model = first;
    else if (isRecord(first) && typeof first.id === 'string') model = first.id;
    if (
      isRecord(first) &&
      typeof first.variant === 'string' &&
      first.variant.length > 0
    ) {
      embeddedVariant = first.variant;
    }
    if (ids.length > 0) modelChain = ids;
  }

  const entry: AgentEntry = {
    name,
    inherited,
    primary: override.primary === true,
  };
  if (model) entry.model = model;
  const topLevelVariant =
    typeof override.variant === 'string' && override.variant.length > 0
      ? override.variant
      : undefined;
  // Runtime precedence: an explicit agent-level variant beats the first
  // model entry's embedded variant.
  const variant = topLevelVariant ?? embeddedVariant;
  if (variant) entry.variant = variant;
  if (modelChain) entry.modelChain = modelChain;
  if (typeof override.inheritModelFrom === 'string')
    entry.inheritModelFrom = override.inheritModelFrom;
  if (typeof override.temperature === 'number')
    entry.temperature = override.temperature;
  if (isRecord(override.options) && Object.keys(override.options).length > 0) {
    entry.optionsJson = JSON.stringify(override.options);
  }
  if (Array.isArray(override.skills)) {
    entry.skills = override.skills.filter(
      (skill): skill is string => typeof skill === 'string',
    );
  }
  if (Array.isArray(override.mcps)) {
    entry.mcps = override.mcps.filter(
      (mcp): mcp is string => typeof mcp === 'string',
    );
  }
  return entry;
}

function agentRank(name: string): number {
  const index = (ALL_AGENT_NAMES as readonly string[]).indexOf(name);
  return index === -1 ? ALL_AGENT_NAMES.length : index;
}

function agentEntriesForPreset(
  resolvedAgents: AgentMap,
  localAgents: AgentMap,
): AgentEntry[] {
  const localCanonical = new Set(Object.keys(localAgents));
  const agents: AgentEntry[] = [];
  for (const [name, override] of Object.entries(resolvedAgents)) {
    agents.push(toAgentEntry(name, override, !localCanonical.has(name)));
  }
  agents.sort(
    (a, b) =>
      agentRank(a.name) - agentRank(b.name) || a.name.localeCompare(b.name),
  );
  return agents;
}

function describePresetInfo(
  extendsList: string[],
  agents: AgentEntry[],
  validationError: string | undefined,
): string {
  const summary = agents
    .map((agent) => {
      const short = agent.model
        ? (agent.model.split('/').filter(Boolean).pop() ?? agent.model)
        : agent.inheritModelFrom
          ? `inherit:${agent.inheritModelFrom}`
          : 'default';
      return `${agent.name}: ${short}`;
    })
    .join(' · ');
  const inherited =
    extendsList.length > 0 ? `extends ${extendsList.join(', ')}` : '';
  if (validationError) {
    const base = inherited || summary || 'preset';
    return `${base} (invalid: ${validationError})`;
  }
  if (inherited && summary) return `${inherited} · ${summary}`;
  return inherited || summary || 'Empty preset';
}

function buildPresetInfos(state: PresetState): PresetInfo[] {
  const presets: PresetInfo[] = [];
  for (const name of Object.keys(state.effectivePresets)) {
    const inspection = inspectPreset(name, state);
    if (inspection.raw === undefined) continue;
    const agents = agentEntriesForPreset(inspection.resolved, inspection.local);
    presets.push({
      name,
      description: describePresetInfo(
        inspection.extendsList,
        agents,
        inspection.validationError,
      ),
      inUserConfig: hasOwn(state.userPresets, name),
      inProjectConfig: hasOwn(state.projectPresets, name),
      agents,
      editable: !hasOwn(state.projectPresets, name),
      extends: inspection.extendsList,
      ...(inspection.validationError
        ? { validationError: inspection.validationError }
        : {}),
    });
  }
  return presets;
}

function hasDeclaredModel(override: UnknownRecord): boolean {
  if (typeof override.model === 'string')
    return override.model.trim().length > 0;
  if (!Array.isArray(override.model) || override.model.length === 0)
    return false;
  return override.model.some((entry) => {
    if (typeof entry === 'string') return entry.trim().length > 0;
    return isRecord(entry) && typeof entry.id === 'string';
  });
}

function hasModelOrInheritance(override: UnknownRecord): boolean {
  if (hasDeclaredModel(override)) return true;
  return (
    override.inheritModelFrom === 'session' ||
    override.inheritModelFrom === 'orchestrator'
  );
}

function buildRoster(
  agents: Record<string, AgentOverrideConfig>,
): RosterEntry[] {
  const canonical = mergeAgentOverrides({}, agents) as AgentMap;
  const roster: RosterEntry[] = [];
  for (const name of ALL_AGENT_NAMES) {
    const override = ownValue(canonical, name) ?? {};
    const description =
      typeof override.description === 'string' && override.description.trim()
        ? override.description
        : (BUILTIN_DESCRIPTIONS[name] ?? '');
    roster.push({
      name,
      description,
      protected: PROTECTED_AGENTS.has(name),
      primary: name === 'orchestrator',
    });
  }
  const custom: RosterEntry[] = [];
  for (const [name, override] of Object.entries(canonical)) {
    if ((ALL_AGENT_NAMES as readonly string[]).includes(name)) continue;
    if (hasOwn(AGENT_ALIASES, name)) continue;
    if (
      !/^[a-z][a-z0-9_-]*$/i.test(name) ||
      name.toLowerCase().startsWith('councillor-')
    )
      continue;
    if (isPrototypeSensitiveName(name)) continue;
    if (!hasModelOrInheritance(override)) continue;
    custom.push({
      name,
      description:
        typeof override.description === 'string' ? override.description : '',
      protected: false,
      primary: override.primary === true,
    });
  }
  custom.sort((a, b) => a.name.localeCompare(b.name));
  return [...roster, ...custom];
}

function canonicalDisabledList(value: unknown): string[] {
  let source: unknown[];
  if (Array.isArray(value)) source = value;
  else if (typeof value === 'string' && value.trim()) source = [value];
  else source = DEFAULT_DISABLED_AGENTS;
  const result: string[] = [];
  for (const entry of source) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!name) continue;
    const canonical = canonicalAgentName(name);
    if (PROTECTED_AGENTS.has(canonical)) continue;
    if (!result.includes(canonical)) result.push(canonical);
  }
  return result;
}

function disabledAgentsFrom(config: {
  disabled_agents?: readonly string[];
}): string[] {
  return canonicalDisabledList(config.disabled_agents);
}

function presetSourceFor(
  state: PresetState,
  directory: string,
  name: string,
): 'project' | 'user' | 'none' {
  if (hasOwn(state.projectPresets, name)) return 'project';
  if (hasOwn(state.userPresets, name)) return 'user';
  return getPresetSource(directory, name, HOST_FLAVOR);
}

function assertKnownPreset(state: PresetState, preset: string): void {
  if (ownValue(state.effectivePresets, preset) === undefined) {
    throw new Error(`Unknown preset "${preset}".`);
  }
}

function assertEditablePreset(
  state: PresetState,
  directory: string,
  preset: string,
): void {
  const source = presetSourceFor(state, directory, preset);
  if (source === 'project') {
    throw new Error(
      `Preset "${preset}" is defined in project config and is read-only.`,
    );
  }
  if (source !== 'user') {
    throw new Error(`Preset "${preset}" is not defined in the user config.`);
  }
}

function assertValidPreset(
  state: PresetState,
  preset: string,
): PresetInspection {
  const inspection = inspectPreset(preset, state);
  if (inspection.validationError) {
    throw new Error(
      `Preset "${preset}" is invalid: ${inspection.validationError}. Fix its configuration before editing.`,
    );
  }
  return inspection;
}

function parentProvidesAgent(
  state: PresetState,
  preset: string,
  agentKey: string,
): boolean {
  const inspection = inspectPreset(preset, state);
  const resolvedPresets = expandedPresetDefinitions(state.effectivePresets);
  for (const parentName of inspection.extendsList) {
    try {
      const parent = resolvePresetDefinition(parentName, resolvedPresets);
      if (hasOwn(parent.agents, agentKey)) return true;
    } catch {
      // An unresolved parent cannot be claimed as the source.
    }
  }
  return false;
}

function ensurePresetMap(current: UnknownRecord): Record<string, PresetInput> {
  if (!hasOwn(current, 'presets') || current.presets === undefined) {
    current.presets = {};
    return current.presets as Record<string, PresetInput>;
  }
  if (!isRecord(current.presets)) {
    throw new Error(
      "Cannot edit presets: the user config's presets value is not an object.",
    );
  }
  return current.presets as Record<string, PresetInput>;
}

function currentPreset(current: UnknownRecord, preset: string): UnknownRecord {
  const presets = ensurePresetMap(current);
  const raw = ownValue(presets, preset);
  if (!isRecord(raw))
    throw new Error(`Preset "${preset}" is not defined in the user config.`);
  return raw;
}

/** The object that directly holds agent overrides: `.agents` for structured presets, the preset itself for legacy flat ones. */
function writableAgentContainer(preset: UnknownRecord): UnknownRecord {
  if (isRecord(preset.agents)) {
    const entries = Object.values(preset.agents);
    if (entries.every((entry) => isRecord(entry))) return preset.agents;
  }
  return preset;
}

function assertPresetSchema(preset: string, value: unknown): void {
  const parsed = PresetSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Refusing to save preset "${preset}": ${formatSchemaError(parsed.error)}.`,
    );
  }
}

/** Runtime-valid empty definitions use flat/inline syntax, never an empty `agents` wrapper. */
function normalizePresetShape(preset: UnknownRecord): void {
  if (isRecord(preset.agents) && Object.keys(preset.agents).length === 0) {
    delete preset.agents;
  }
}

function preferredUserConfigPath(directory: string): string | null {
  const existing = findPluginConfigPaths(directory, HOST_FLAVOR).userConfigPath;
  if (existing) return existing;
  return getPluginConfigCandidates(directory, HOST_FLAVOR).user[0] ?? null;
}

function usesInlineEmptyExtends(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.extends === 'string' &&
    (!isRecord(value.agents) || Object.keys(value.agents).length === 0)
  );
}

function writeInlinePreset(
  target: string,
  name: string,
  preset: PresetInput,
): void {
  mutateJsonFile(target, (current) => {
    const presets = ensurePresetMap(current);
    if (hasOwn(presets, name))
      throw new Error(`Preset "${name}" already exists.`);
    defineOwn(presets, name, preset);
    return current;
  });
}

function rootOverrideNote(directory: string, agentKey: string): string {
  try {
    const snapshot = readPluginConfigSnapshot(directory, {
      hostFlavor: HOST_FLAVOR,
      presetName: '',
      fresh: true,
    });
    const rootAgents = snapshot.config.agents ?? {};
    const rootOverride = ownValue(rootAgents, agentKey);
    if (!rootOverride || Object.keys(rootOverride).length === 0) return '';
    return ` Note: root agents.${agentKey} overrides this preset entry at runtime; edit root agents to change the effective configuration.`;
  } catch {
    return '';
  }
}

function validUserConfigOrError(userPath: string): string | undefined {
  const warnings: ConfigLoadWarning[] = [];
  const loaded = loadRawPluginConfigFromPath(userPath, {
    silent: true,
    onWarning: (warning) => warnings.push(warning),
  });
  if (loaded) return undefined;
  const detail = warnings[0]?.message ? ` ${warnings[0].message}` : '';
  return `The user config is invalid or unreadable.${detail}`;
}

function resolveDirectory(
  input: { directory?: string } | undefined,
  fallback: string,
): string {
  const explicit =
    typeof input?.directory === 'string' ? input.directory.trim() : '';
  if (explicit) return path.resolve(explicit);
  if (!fallback || typeof fallback !== 'string') {
    throw new Error(
      'No session directory is available for configuration discovery.',
    );
  }
  return path.resolve(fallback);
}

function applyModelPatch(entry: UnknownRecord, model: string): void {
  if (model === '') {
    delete entry.model;
    delete entry.variant;
    return;
  }
  const previous = entry.model;
  let preservedVariant: string | undefined =
    typeof entry.variant === 'string' && entry.variant.length > 0
      ? entry.variant
      : undefined;
  if (!preservedVariant && Array.isArray(previous) && previous.length > 0) {
    const first = previous[0];
    if (
      isRecord(first) &&
      typeof first.variant === 'string' &&
      first.variant.length > 0
    ) {
      preservedVariant = first.variant;
    }
  }
  entry.model = model;
  if (preservedVariant) entry.variant = preservedVariant;
  else delete entry.variant;
}

function applyVariantPatch(entry: UnknownRecord, variant: string): void {
  if (variant === '') {
    delete entry.variant;
    if (Array.isArray(entry.model) && entry.model.length > 0) {
      const first = entry.model[0];
      if (isRecord(first) && hasOwn(first, 'variant')) delete first.variant;
    }
    return;
  }
  // Runtime precedence is agent-level variant over model-entry variant.
  entry.variant = variant;
}

export function createOmosConfigBackend(
  options: OmosBackendOptions,
): OmosBackend {
  const defaultDirectory = options.directory;
  const directoryFor = (input: { directory?: string } | undefined): string =>
    resolveDirectory(input, defaultDirectory);
  const run = <T>(operation: () => T): T => withEnvironment(options, operation);

  return {
    async getSnapshot(input, host) {
      return run(() => {
        const directory = directoryFor(input);
        const rootSnapshot = readPluginConfigSnapshot(directory, {
          hostFlavor: HOST_FLAVOR,
          presetName: '',
          fresh: true,
        });
        const state = readPresetState(directory);
        const selection = getPresetSelectionState(directory, HOST_FLAVOR);
        const envPreset = envPresetName();
        const globalPreset = selection.global ?? '';
        const projectPreset = selection.project ?? state.projectPreset;
        const effectivePreset = envPreset || projectPreset || globalPreset;
        const configPath =
          rootSnapshot.paths.userConfigPath ??
          getPluginConfigCandidates(directory, HOST_FLAVOR).user[0] ??
          '';
        const snapshot: Snapshot = {
          found: Boolean(
            rootSnapshot.paths.userConfigPath ||
              rootSnapshot.paths.projectConfigPaths.length > 0,
          ),
          configPath,
          preset: effectivePreset,
          envOverride: Boolean(envPreset),
          presets: buildPresetInfos(state),
          disabledAgents: disabledAgentsFrom(rootSnapshot.config),
          globalPreset,
          projectPreset,
          envPreset,
          liveConfigRefresh: rootSnapshot.config.liveConfigRefresh !== false,
          warnings: rootSnapshot.warnings.map((warning) =>
            warning.path
              ? `${warning.path}: ${warning.message}`
              : warning.message,
          ),
          projectConfigPaths: [...rootSnapshot.paths.projectConfigPaths],
          roster: buildRoster(rootSnapshot.config.agents ?? {}),
        };
        if (host?.omosVersion) snapshot.omosVersion = host.omosVersion;
        return snapshot;
      });
    },

    async switchPreset(input) {
      try {
        return run(() => {
          const directory = directoryFor(input);
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          if (!name) return fail('Preset name is required.');
          const state = readPresetState(directory);
          const inspection = inspectPreset(name, state);
          if (inspection.raw === undefined) {
            const available = Object.keys(state.effectivePresets);
            const hint =
              available.length > 0
                ? ` Available presets: ${available.join(', ')}.`
                : '';
            return fail(`Unknown preset "${name}".${hint}`);
          }
          if (inspection.validationError) {
            return fail(
              `Preset "${name}" is invalid: ${inspection.validationError}. Fix it before selecting it as the global default.`,
            );
          }
          if (!state.userPath) {
            return fail(
              'No user config file was found. Create oh-my-opencode-slim.jsonc or .json before switching presets.',
            );
          }
          const invalid = validUserConfigOrError(state.userPath);
          if (invalid) {
            return fail(
              `Cannot set the global preset. ${invalid} Fix the file and try again.`,
            );
          }
          const runtime = readPluginConfigSnapshot(directory, {
            hostFlavor: HOST_FLAVOR,
            fresh: true,
          });
          if (
            !runtime.config.presets ||
            !hasOwn(runtime.config.presets, name)
          ) {
            const failure = runtime.warnings.find(
              (warning) => warning.presetName === name,
            );
            return fail(
              `Preset "${name}" is not valid in the merged runtime config${failure ? `: ${failure.message}` : ''}. Fix the config before selecting it as the global default.`,
            );
          }
          const result = switchPresetOnDisk(
            directory,
            name,
            {
              // The disk helpers read raw config; hand them the same
              // environment-expanded definitions the runtime resolves.
              presets: expandedPresetDefinitions(state.effectivePresets),
            } as PluginConfig,
            {
              hostFlavor: HOST_FLAVOR,
            },
          );
          return result.ok ? ok(result.message) : fail(result.message);
        });
      } catch (error) {
        return fail(`Could not save the global preset: ${errorMessage(error)}`);
      }
    },

    async clearPresetDefault(input) {
      try {
        return run(() => {
          const directory = directoryFor(input);
          const state = readPresetState(directory);
          if (!state.userPath) {
            return ok(
              'No user config file exists; the global preset is already unset.',
            );
          }
          removeTopLevelJsonProperty(state.userPath, 'preset');
          return ok('Global default preset cleared.');
        });
      } catch (error) {
        return fail(
          `Could not clear the global preset: ${errorMessage(error)}`,
        );
      }
    },

    async createPreset(input) {
      try {
        return run(() => {
          const directory = directoryFor(input);
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          const invalid = validateNewPresetName(name);
          if (invalid) return fail(invalid);
          const state = readPresetState(directory);
          if (ownValue(state.effectivePresets, name) !== undefined) {
            return fail(
              `Preset "${name}" already exists. Choose a different name.`,
            );
          }
          const copyFrom =
            typeof input.copyFrom === 'string' ? input.copyFrom.trim() : '';
          let clone: PresetInput = {};
          let copied = false;
          if (copyFrom) {
            const source = ownValue(state.effectivePresets, copyFrom);
            if (source !== undefined) {
              const parsed = PresetSchema.safeParse(source);
              if (!parsed.success) {
                return fail(
                  `Cannot copy preset "${copyFrom}": ${formatSchemaError(parsed.error)}. Fix it first.`,
                );
              }
              clone = structuredClone(source);
              copied = true;
            }
          }
          if (!state.userPath) {
            const target = preferredUserConfigPath(directory);
            if (!target)
              return fail('No user config location could be resolved.');
            writeJsonAtomic(target, { $schema: SCHEMA_SEED, presets: {} });
          }
          const target = findPluginConfigPaths(
            directory,
            HOST_FLAVOR,
          ).userConfigPath;
          if (!target)
            return fail('No user config location could be resolved.');
          if (usesInlineEmptyExtends(clone)) {
            // writePreset materializes `{ extends, agents: {} }`, which the
            // runtime schema rejects as ambiguous; keep the inline form.
            writeInlinePreset(target, name, clone);
          } else {
            const wrote = writePreset(
              directory,
              name,
              clone as Preset | PresetDefinition,
            );
            if (!wrote) {
              return fail(
                `Could not create preset "${name}". Check that the user config is writable and not concurrently edited.`,
              );
            }
          }
          if (copyFrom && !copied) {
            return ok(
              `Created empty preset "${name}" ("${copyFrom}" was not found).`,
            );
          }
          return ok(
            copyFrom && copied
              ? `Created preset "${name}" from "${copyFrom}".`
              : `Created empty preset "${name}".`,
          );
        });
      } catch (error) {
        return fail(`Could not create preset: ${errorMessage(error)}`);
      }
    },

    async deletePreset(input) {
      try {
        return run(() => {
          const directory = directoryFor(input);
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          if (!name) return fail('Preset name is required.');
          if (isPrototypeSensitiveName(name))
            return fail(`"${name}" cannot be used as a preset name.`);
          const state = readPresetState(directory);
          if (hasOwn(state.projectPresets, name)) {
            return fail(
              `Preset "${name}" is defined in project config and is read-only.`,
            );
          }
          if (!hasOwn(state.userPresets, name)) {
            return fail(
              `"${name}" is not in the user config (project presets are read-only).`,
            );
          }
          const dependents = findPresetDependents(
            name,
            expandedPresetDefinitions(state.effectivePresets),
          );
          if (dependents.length > 0) {
            return fail(
              `Cannot delete "${name}": it is the base preset for ${dependents.map((item) => `"${item}"`).join(', ')}.`,
            );
          }
          const selection = getPresetSelectionState(directory, HOST_FLAVOR);
          const globalSelected = selection.global === name;
          const envPreset = envPresetName();
          if (envPreset === name) {
            return fail(
              `Cannot delete "${name}": OH_MY_OPENCODE_SLIM_PRESET selects it and would be left dangling. Unset the environment variable first.`,
            );
          }
          const projectPreset = selection.project ?? state.projectPreset;
          if (projectPreset === name) {
            return fail(
              `Cannot delete "${name}": project config selects it as its default preset and would be left dangling. Update the project config first.`,
            );
          }
          if (!state.userPath)
            return fail('No user config location could be resolved.');
          const deleted = deletePresetOnDisk(directory, name, HOST_FLAVOR);
          if (!deleted) {
            return fail(
              `Could not delete "${name}". It may be selected or referenced by another config layer.`,
            );
          }
          if (globalSelected) {
            // An interpolated `{env:...}` preset value no longer compares
            // equal to the raw string, so clear any remaining global default.
            const after = getPresetSelectionState(directory, HOST_FLAVOR);
            if (after.global === name) {
              try {
                removeTopLevelJsonProperty(state.userPath, 'preset');
              } catch (error) {
                return fail(
                  `Deleted preset "${name}", but could not clear the global default that selected it: ${errorMessage(error)}`,
                );
              }
            }
          }
          return ok(`Deleted preset "${name}".`);
        });
      } catch (error) {
        return fail(`Could not delete preset: ${errorMessage(error)}`);
      }
    },

    async setAgentOverride(input) {
      try {
        return run(() => {
          const directory = directoryFor(input);
          const preset =
            typeof input.preset === 'string' ? input.preset.trim() : '';
          const agentInput =
            typeof input.agent === 'string' ? input.agent.trim() : '';
          if (!preset) return fail('Preset is required.');
          if (!agentInput) return fail('Agent is required.');
          if (isPrototypeSensitiveName(agentInput)) {
            return fail(`"${agentInput}" cannot be used as an agent name.`);
          }
          const patch = input.patch;
          if (!patch || typeof patch !== 'object')
            return fail('A patch is required.');
          if (patch.model !== undefined && typeof patch.model !== 'string') {
            return fail('Model must be a string.');
          }
          if (
            patch.variant !== undefined &&
            typeof patch.variant !== 'string'
          ) {
            return fail('Variant must be a string.');
          }
          let temperature: number | undefined;
          if (!patch.clearTemperature && patch.temperature !== undefined) {
            if (
              typeof patch.temperature !== 'number' ||
              !Number.isFinite(patch.temperature)
            ) {
              return fail('Temperature must be a number between 0 and 2.');
            }
            temperature = patch.temperature;
            if (temperature < 0 || temperature > 2) {
              return fail('Temperature must be a number between 0 and 2.');
            }
          }
          let options: UnknownRecord | undefined;
          let clearOptions = false;
          if (typeof patch.optionsJson === 'string') {
            const raw = patch.optionsJson.trim();
            if (raw === '' || raw === '{}') {
              clearOptions = true;
            } else {
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw);
              } catch {
                return fail('Options must be a valid JSON object.');
              }
              if (!isRecord(parsed))
                return fail('Options must be a valid JSON object.');
              if (Object.keys(parsed).length === 0) clearOptions = true;
              else options = parsed;
            }
          }

          const state = readPresetState(directory);
          assertKnownPreset(state, preset);
          assertEditablePreset(state, directory, preset);
          assertValidPreset(state, preset);
          const agentKey = canonicalAgentName(agentInput);
          if (!state.userPath)
            return fail('No user config location could be resolved.');
          mutateJsonFile(state.userPath, (current) => {
            const local = currentPreset(current, preset);
            const container = writableAgentContainer(local);
            const matching = Object.keys(container).filter(
              (key) => canonicalAgentName(key) === agentKey,
            );
            let entry: UnknownRecord;
            if (matching.length === 0) {
              entry = {};
              defineOwn(container, agentKey, entry);
            } else if (matching.length === 1 && matching[0] === agentKey) {
              const existing = ownValue(container, agentKey);
              if (!isRecord(existing)) {
                throw new Error(
                  `Agent "${agentKey}" in preset "${preset}" is not an object.`,
                );
              }
              entry = existing;
            } else {
              const subset: AgentMap = {};
              for (const key of matching) {
                const value = ownValue(container, key);
                if (!isRecord(value)) {
                  throw new Error(
                    `Agent "${key}" in preset "${preset}" is not an object.`,
                  );
                }
                defineOwn(subset, key, value);
              }
              entry =
                (mergeAgentOverrides({}, subset) as AgentMap)[agentKey] ?? {};
              for (const key of matching) delete container[key];
              defineOwn(container, agentKey, entry);
            }

            if (typeof patch.model === 'string')
              applyModelPatch(entry, patch.model);
            if (typeof patch.variant === 'string')
              applyVariantPatch(entry, patch.variant);
            if (patch.clearTemperature) {
              delete entry.temperature;
            } else if (temperature !== undefined) {
              entry.temperature = temperature;
            }
            if (clearOptions) {
              delete entry.options;
            } else if (options !== undefined) {
              entry.options = options;
            }
            assertPresetSchema(preset, local);
            return current;
          });
          return ok(
            `Saved ${agentKey} in "${preset}".${rootOverrideNote(directory, agentKey)}`,
          );
        });
      } catch (error) {
        return fail(`Could not save agent override: ${errorMessage(error)}`);
      }
    },

    async removeAgent(input) {
      try {
        return run(() => {
          const directory = directoryFor(input);
          const preset =
            typeof input.preset === 'string' ? input.preset.trim() : '';
          const agentInput =
            typeof input.agent === 'string' ? input.agent.trim() : '';
          if (!preset) return fail('Preset is required.');
          if (!agentInput) return fail('Agent is required.');
          if (isPrototypeSensitiveName(agentInput)) {
            return fail(`"${agentInput}" cannot be used as an agent name.`);
          }
          const agentKey = canonicalAgentName(agentInput);
          const state = readPresetState(directory);
          assertKnownPreset(state, preset);
          assertEditablePreset(state, directory, preset);
          assertValidPreset(state, preset);

          const local = ownValue(state.userPresets, preset);
          if (!isRecord(local)) {
            return fail(
              `Preset "${preset}" is not defined in the user config.`,
            );
          }
          const localContainer = writableAgentContainer(local);
          const matching = Object.keys(localContainer).filter(
            (key) => canonicalAgentName(key) === agentKey,
          );
          if (matching.length === 0) {
            const inspection = inspectPreset(preset, state);
            if (ownValue(inspection.resolved, agentKey) !== undefined) {
              const parents = inspection.extendsList;
              const source =
                parents.length > 0
                  ? `base preset ${parents.map((item) => `"${item}"`).join(', ')}`
                  : 'the base preset';
              return fail(
                `"${agentKey}" is inherited from ${source} and cannot be removed from "${preset}". Edit the base preset instead.`,
              );
            }
            return ok(`Agent "${agentKey}" is not set in "${preset}".`);
          }

          const inspection = inspectPreset(preset, state);
          const remainsInherited = parentProvidesAgent(state, preset, agentKey);
          const parents = inspection.extendsList;
          if (!state.userPath)
            return fail('No user config location could be resolved.');
          mutateJsonFile(state.userPath, (current) => {
            const localPreset = currentPreset(current, preset);
            const container = writableAgentContainer(localPreset);
            for (const key of Object.keys(container)) {
              if (canonicalAgentName(key) === agentKey) delete container[key];
            }
            normalizePresetShape(localPreset);
            assertPresetSchema(preset, localPreset);
            return current;
          });
          const note = rootOverrideNote(directory, agentKey);
          if (remainsInherited) {
            return ok(
              `Removed the local ${agentKey} override from "${preset}"; it still inherits from ${
                parents.length > 0
                  ? parents.map((item) => `"${item}"`).join(', ')
                  : 'its base'
              }.${note}`,
            );
          }
          return ok(`Removed ${agentKey} from "${preset}".${note}`);
        });
      } catch (error) {
        return fail(`Could not remove agent: ${errorMessage(error)}`);
      }
    },

    async setAgentDisabled(input) {
      try {
        return run(() => {
          const directory = directoryFor(input);
          const agentInput =
            typeof input.agent === 'string' ? input.agent.trim() : '';
          if (!agentInput) return fail('Agent is required.');
          if (typeof input.disabled !== 'boolean')
            return fail('Disabled must be a boolean.');
          const agentKey = canonicalAgentName(agentInput);
          if (PROTECTED_AGENTS.has(agentKey))
            return fail(`${agentKey} cannot be disabled.`);

          if (!isProjectConfigDisabled(HOST_FLAVOR)) {
            const projectConfig = readProjectConfig(directory, HOST_FLAVOR);
            if (projectConfig && Array.isArray(projectConfig.disabled_agents)) {
              const projectList = canonicalDisabledList(
                projectConfig.disabled_agents,
              );
              const projectState = projectList.includes(agentKey);
              if (projectState === input.disabled) {
                return ok(
                  `${agentKey} is already ${input.disabled ? 'disabled' : 'enabled'} by project config (.opencode), which takes precedence; no user change was written.`,
                );
              }
              return fail(
                `Cannot ${input.disabled ? 'disable' : 'enable'} "${agentKey}": project config (.opencode) sets disabled_agents, which takes precedence over the user config. Update the project config instead.`,
              );
            }
          }

          const state = readPresetState(directory);
          const target = state.userPath ?? preferredUserConfigPath(directory);
          if (!target)
            return fail('No user config location could be resolved.');
          if (!state.userPath)
            writeJsonAtomic(target, { $schema: SCHEMA_SEED });
          mutateJsonFile(target, (current) => {
            let list = canonicalDisabledList(current.disabled_agents);
            if (input.disabled) {
              if (!list.includes(agentKey)) list.push(agentKey);
            } else {
              list = list.filter((name) => name !== agentKey);
            }
            current.disabled_agents = list;
            return current;
          });
          return ok(`${agentKey} ${input.disabled ? 'disabled' : 'enabled'}.`);
        });
      } catch (error) {
        return fail(`Could not update disabled agents: ${errorMessage(error)}`);
      }
    },
  };
}
