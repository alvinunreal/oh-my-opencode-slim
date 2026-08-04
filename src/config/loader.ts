import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripJsonComments } from '../cli/config-io';
import { getConfigSearchDirs } from '../cli/paths';
import { DEFAULT_DISABLED_AGENTS } from './constants';
import {
  type AgentOverrideConfig,
  BackgroundJobsConfigSchema,
  InterviewConfigSchema,
  LEGACY_FALLBACK_KEYS,
  type PluginConfig,
  PluginConfigSchema,
  type Preset,
  type ResolvedPreset,
  WebfetchConfigSchema,
} from './schema';

export type PresetInheritanceErrorCode =
  | 'PRESET_INHERITANCE_MISSING_PARENT'
  | 'PRESET_INHERITANCE_CYCLE';

/** A fatal semantic error in the merged preset inheritance graph. */
export class PresetInheritanceError extends Error {
  readonly code: PresetInheritanceErrorCode;

  constructor(code: PresetInheritanceErrorCode, message: string) {
    super(message);
    this.name = 'PresetInheritanceError';
    this.code = code;
  }
}

/**
 * Warning kinds produced during config loading.
 */
export type ConfigLoadWarningKind =
  | 'invalid-json'
  | 'invalid-schema'
  | 'read-error'
  | 'missing-preset'
  | 'deprecated-key'
  | 'normalized';

/**
 * A warning emitted while loading plugin configuration.
 */
export interface ConfigLoadWarning {
  path: string;
  kind: ConfigLoadWarningKind;
  message: string;
  formatted?: unknown;
}

/**
 * Options for loadPluginConfig.
 */
export interface LoadPluginConfigOptions {
  /**
   * Called with a warning whenever config loading produces a non-fatal issue.
   * The loader still falls back to defaults and continues normally.
   */
  onWarning?: (warning: ConfigLoadWarning) => void;

  /**
   * Suppress console warnings while still invoking onWarning.
   */
  silent?: boolean;
}

const PROMPTS_DIR_NAME = 'oh-my-opencode-slim';
const INTERVIEW_CONFIG_KEYS = [
  'maxQuestions',
  'outputFolder',
  'autoOpenBrowser',
  'port',
  'dashboard',
] as const;
const LEGACY_BACKGROUND_JOBS_KEYS = ['continueOnIdle'] as const;

// Config keys that must be arrays. A string value (e.g. "explorer") is
// normalized to a single-element array; any other non-array value is
// dropped. Normalization happens before schema validation so a typo in one
// key does not silently discard the user's entire config (issue #1027).
const DISABLED_CONFIG_KEYS = [
  'disabled_agents',
  'disabled_tools',
  'disabled_mcps',
  'disabled_skills',
] as const;

/**
 * Normalize disabled_* config keys in place so a non-array value does not
 * reject the whole config object during schema validation. A string value
 * (e.g. "explorer") becomes a single-element array so the user's disable
 * intent survives; any other non-array value (number, boolean, object, ...)
 * is dropped. Array and undefined values are left untouched. Each
 * normalization is reported through `warn` (if provided) with a plain
 * message; callers wrap it in their own warning channel (loader uses
 * onWarning + console.warn, doctor just reports the message).
 *
 * @param rawConfig - Parsed config to normalize (mutated in place)
 * @param warn - Optional callback invoked with each warning message
 */
export function normalizeDisabledArrayKeys(
  rawConfig: unknown,
  warn?: (message: string) => void,
): void {
  if (
    typeof rawConfig !== 'object' ||
    rawConfig === null ||
    Array.isArray(rawConfig)
  ) {
    return;
  }

  const configRecord = rawConfig as Record<string, unknown>;
  for (const key of DISABLED_CONFIG_KEYS) {
    const value = configRecord[key];
    if (value === undefined || Array.isArray(value)) {
      continue;
    }
    if (typeof value === 'string') {
      configRecord[key] = [value];
      warn?.(
        `Config key "${key}" should be an array; ` +
          `normalized to ["${value}"].`,
      );
    } else {
      delete configRecord[key];
      warn?.(`Config key "${key}" must be an array; ignoring invalid value.`);
    }
  }
}

function migrateLegacyBackgroundJobsConfig(rawConfig: unknown): unknown {
  if (
    typeof rawConfig !== 'object' ||
    rawConfig === null ||
    Array.isArray(rawConfig)
  ) {
    return rawConfig;
  }

  const configRecord = rawConfig as Record<string, unknown>;
  const backgroundJobs = configRecord.backgroundJobs;
  if (
    typeof backgroundJobs !== 'object' ||
    backgroundJobs === null ||
    Array.isArray(backgroundJobs) ||
    !Object.hasOwn(backgroundJobs, 'continueOnIdle')
  ) {
    return rawConfig;
  }

  const migratedBackgroundJobs = {
    ...(backgroundJobs as Record<string, unknown>),
  };
  const legacyContinueOnIdle = migratedBackgroundJobs.continueOnIdle;
  delete migratedBackgroundJobs.continueOnIdle;

  const wake = migratedBackgroundJobs.orchestratorWake;
  if (
    typeof legacyContinueOnIdle === 'boolean' &&
    (wake === undefined ||
      (typeof wake === 'object' && wake !== null && !Array.isArray(wake)))
  ) {
    const wakeConfig = (wake ?? {}) as Record<string, unknown>;
    if (!Object.hasOwn(wakeConfig, 'enabled')) {
      migratedBackgroundJobs.orchestratorWake = {
        ...wakeConfig,
        enabled: legacyContinueOnIdle,
      };
    }
  }

  return { ...configRecord, backgroundJobs: migratedBackgroundJobs };
}

function retainExplicitInterviewFields(
  parsedConfig: PluginConfig,
  rawConfig: unknown,
): PluginConfig {
  if (!parsedConfig.interview) {
    return parsedConfig;
  }

  const rawInterview =
    typeof rawConfig === 'object' &&
    rawConfig !== null &&
    !Array.isArray(rawConfig) &&
    typeof (rawConfig as Record<string, unknown>).interview === 'object' &&
    (rawConfig as Record<string, unknown>).interview !== null &&
    !Array.isArray((rawConfig as Record<string, unknown>).interview)
      ? ((rawConfig as Record<string, unknown>).interview as Record<
          string,
          unknown
        >)
      : undefined;

  if (!rawInterview) {
    return { ...parsedConfig, interview: undefined };
  }

  const interview: Record<string, unknown> = {};
  for (const key of INTERVIEW_CONFIG_KEYS) {
    if (Object.hasOwn(rawInterview, key)) {
      interview[key] = parsedConfig.interview[key];
    }
  }

  return {
    ...parsedConfig,
    interview: interview as PluginConfig['interview'],
  };
}

function retainExplicitBackgroundJobsFields(
  parsedConfig: PluginConfig,
  rawConfig: unknown,
): PluginConfig {
  if (!parsedConfig.backgroundJobs) {
    return parsedConfig;
  }

  const rawBackgroundJobs =
    typeof rawConfig === 'object' &&
    rawConfig !== null &&
    !Array.isArray(rawConfig) &&
    typeof (rawConfig as Record<string, unknown>).backgroundJobs === 'object' &&
    (rawConfig as Record<string, unknown>).backgroundJobs !== null &&
    !Array.isArray((rawConfig as Record<string, unknown>).backgroundJobs)
      ? ((rawConfig as Record<string, unknown>).backgroundJobs as Record<
          string,
          unknown
        >)
      : undefined;

  if (!rawBackgroundJobs) {
    return parsedConfig;
  }

  const backgroundJobs: Record<string, unknown> = {};
  const parsedBackgroundJobs = parsedConfig.backgroundJobs as unknown as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(rawBackgroundJobs)) {
    if (
      key !== 'orchestratorWake' &&
      Object.hasOwn(parsedBackgroundJobs, key)
    ) {
      backgroundJobs[key] = parsedBackgroundJobs[key];
    }
  }

  const rawWake =
    typeof rawBackgroundJobs.orchestratorWake === 'object' &&
    rawBackgroundJobs.orchestratorWake !== null &&
    !Array.isArray(rawBackgroundJobs.orchestratorWake)
      ? (rawBackgroundJobs.orchestratorWake as Record<string, unknown>)
      : undefined;
  const orchestratorWake: Record<string, unknown> = {};
  const parsedWake = parsedConfig.backgroundJobs
    .orchestratorWake as unknown as Record<string, unknown>;
  for (const key of Object.keys(rawWake ?? {})) {
    if (Object.hasOwn(parsedWake, key)) {
      orchestratorWake[key] = parsedWake[key];
    }
  }
  if (Object.keys(orchestratorWake).length > 0) {
    backgroundJobs.orchestratorWake = orchestratorWake;
  }

  return {
    ...parsedConfig,
    backgroundJobs: backgroundJobs as PluginConfig['backgroundJobs'],
  };
}

/**
 * Parse config text using the same JSONC and environment interpolation rules
 * as the normal loader. Callers that need to preserve raw values can disable
 * interpolation while still reusing the JSONC parser.
 */
export function parseConfigContent(
  content: string,
  options?: { interpolate?: boolean },
): unknown {
  const stripped = stripJsonComments(content);
  const source =
    options?.interpolate === false
      ? stripped
      : stripped.replace(
          /\{env:([^}]+)\}/g,
          (_, varName) => process.env[varName] ?? '',
        );
  return JSON.parse(source);
}

/**
 * Load and validate plugin configuration from a specific file path.
 * Supports both .json and .jsonc formats (JSON with comments).
 * Returns null if the file doesn't exist, is invalid, or cannot be read.
 * Logs warnings for validation errors and unexpected read errors.
 *
 * @param configPath - Absolute path to the config file
 * @param onWarning - Optional callback for warnings
 * @returns Validated config object, or null if loading failed
 */
function loadConfigFromPath(
  configPath: string,
  options?: LoadPluginConfigOptions,
): PluginConfig | null {
  try {
    // Strip a UTF-8 BOM (RFC 8259 permits one); JSON.parse would otherwise
    // fail with "Unrecognized token" and silently drop the whole config.
    const content = fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, '');
    // Use stripJsonComments to support JSONC format (comments and trailing commas)
    let rawConfig: unknown;
    try {
      rawConfig = parseConfigContent(content);
    } catch (error) {
      // Empty file or JSON parse error is treated as invalid-json
      const message = error instanceof Error ? error.message : String(error);
      options?.onWarning?.({
        path: configPath,
        kind: 'invalid-json',
        message,
      });
      if (!options?.silent) {
        console.warn(
          `[oh-my-opencode-slim] Invalid JSON in ${configPath}:`,
          message,
        );
      }
      return null;
    }
    // Warn about deprecated tmux key
    if (
      typeof rawConfig === 'object' &&
      rawConfig !== null &&
      'tmux' in (rawConfig as Record<string, unknown>)
    ) {
      const tmuxMsg =
        'Deprecated tmux config key found and ignored. Use multiplexer config instead.';
      options?.onWarning?.({
        path: configPath,
        kind: 'deprecated-key',
        message: tmuxMsg,
      });
      if (!options?.silent) {
        console.warn(`[oh-my-opencode-slim] ${tmuxMsg}`);
      }
    }

    // Warn about deprecated council.master key
    if (
      typeof rawConfig === 'object' &&
      rawConfig !== null &&
      typeof (rawConfig as Record<string, unknown>).council === 'object' &&
      (rawConfig as Record<string, unknown>).council !== null &&
      'master' in
        ((rawConfig as Record<string, unknown>).council as Record<
          string,
          unknown
        >)
    ) {
      const masterMsg =
        'Deprecated council.master config key found and ignored. Configure council agents via presets instead.';
      options?.onWarning?.({
        path: configPath,
        kind: 'deprecated-key',
        message: masterMsg,
      });
      if (!options?.silent) {
        console.warn(`[oh-my-opencode-slim] ${masterMsg}`);
      }
    }

    // Preserve the opt-out behavior of the removed continueOnIdle key for
    // one compatibility window by migrating it before schema validation.
    if (
      typeof rawConfig === 'object' &&
      rawConfig !== null &&
      typeof (rawConfig as Record<string, unknown>).backgroundJobs ===
        'object' &&
      (rawConfig as Record<string, unknown>).backgroundJobs !== null
    ) {
      const backgroundJobs = (rawConfig as Record<string, unknown>)
        .backgroundJobs as Record<string, unknown>;
      const present = LEGACY_BACKGROUND_JOBS_KEYS.filter(
        (key) => key in backgroundJobs,
      );
      if (present.length > 0) {
        const backgroundJobsMsg =
          'Deprecated backgroundJobs.continueOnIdle config key found. ' +
          'Boolean values are migrated to backgroundJobs.orchestratorWake.enabled ' +
          'unless that replacement is explicit in the same config file; other values are ignored. ' +
          'Use backgroundJobs.orchestratorWake.enabled instead.';
        options?.onWarning?.({
          path: configPath,
          kind: 'deprecated-key',
          message: backgroundJobsMsg,
        });
        if (!options?.silent) {
          console.warn(`[oh-my-opencode-slim] ${backgroundJobsMsg}`);
        }
      }
    }
    rawConfig = migrateLegacyBackgroundJobsConfig(rawConfig);

    // Warn about deprecated fallback.* keys. The schema strips these before
    // validation so the rest of the config still loads; without this warning
    // users would not know their stale keys are ignored.
    if (
      typeof rawConfig === 'object' &&
      rawConfig !== null &&
      typeof (rawConfig as Record<string, unknown>).fallback === 'object' &&
      (rawConfig as Record<string, unknown>).fallback !== null
    ) {
      const fallback = (rawConfig as Record<string, unknown>)
        .fallback as Record<string, unknown>;
      const present = LEGACY_FALLBACK_KEYS.filter((key) => key in fallback);
      if (present.length > 0) {
        const fallbackMsg = `Deprecated fallback config key${present.length === 1 ? '' : 's'} ${present.join(', ')} found and ignored. These fields were removed in 2.3.x; fallback behavior is controlled by fallback.enabled and fallback.maxRetries.`;
        options?.onWarning?.({
          path: configPath,
          kind: 'deprecated-key',
          message: fallbackMsg,
        });
        if (!options?.silent) {
          console.warn(`[oh-my-opencode-slim] ${fallbackMsg}`);
        }
      }
    }

    // Normalize disabled_* config keys before schema validation so a
    // non-array value does not reject the whole config object (which would
    // silently discard every other user setting). Reported with the
    // 'normalized' kind so TUI/doctor do not treat a fixed config as invalid.
    normalizeDisabledArrayKeys(rawConfig, (message) => {
      options?.onWarning?.({
        path: configPath,
        kind: 'normalized',
        message,
      });
      if (!options?.silent) {
        console.warn(`[oh-my-opencode-slim] ${message}`);
      }
    });

    const result = PluginConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      options?.onWarning?.({
        path: configPath,
        kind: 'invalid-schema',
        message: 'Config does not match schema',
        formatted: result.error.format(),
      });
      if (!options?.silent) {
        console.warn(`[oh-my-opencode-slim] Invalid config at ${configPath}:`);
        console.warn(result.error.format());
      }
      return null;
    }

    // Zod applies nested defaults while parsing each layer. Keep interview
    // defaults from masquerading as explicitly configured overrides; the
    // merged interview config is normalized after all layers are merged.
    let layerConfig = retainExplicitInterviewFields(result.data, rawConfig);
    layerConfig = retainExplicitBackgroundJobsFields(layerConfig, rawConfig);

    // Zod applies webfetch.enabled's default while parsing each layer. Keep
    // that default from masquerading as an explicitly configured override;
    // the merged webfetch config is normalized after all layers are merged.
    if (
      layerConfig.webfetch &&
      typeof rawConfig === 'object' &&
      rawConfig !== null &&
      'webfetch' in rawConfig &&
      typeof rawConfig.webfetch === 'object' &&
      rawConfig.webfetch !== null &&
      !Array.isArray(rawConfig.webfetch) &&
      !Object.hasOwn(rawConfig.webfetch, 'enabled')
    ) {
      const { enabled: _enabled, ...webfetch } = layerConfig.webfetch;
      return {
        ...layerConfig,
        webfetch: webfetch as PluginConfig['webfetch'],
      };
    }

    return layerConfig;
  } catch (error) {
    // File doesn't exist or isn't readable - this is expected and fine
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      options?.onWarning?.({
        path: configPath,
        kind: 'read-error',
        message: error.message,
      });
      if (!options?.silent) {
        console.warn(
          `[oh-my-opencode-slim] Error reading config from ${configPath}:`,
          error.message,
        );
      }
    }
    return null;
  }
}

/**
 * Find existing config file path, preferring .jsonc over .json.
 * Checks for .jsonc first, then falls back to .json.
 *
 * @param basePath - Base path without extension (e.g., /path/to/oh-my-opencode-slim)
 * @returns Path to existing config file, or null if neither exists
 */
function findConfigPath(basePath: string): string | null {
  const jsoncPath = `${basePath}.jsonc`;
  const jsonPath = `${basePath}.json`;

  // Prefer .jsonc over .json
  if (fs.existsSync(jsoncPath)) {
    return jsoncPath;
  }
  if (fs.existsSync(jsonPath)) {
    return jsonPath;
  }
  return null;
}

function findConfigPathInDirs(
  configDirs: string[],
  baseName: string,
): string | null {
  for (const configDir of configDirs) {
    const configPath = findConfigPath(path.join(configDir, baseName));
    if (configPath) {
      return configPath;
    }
  }

  return null;
}

/**
 * Validate that `image_routing: "auto"` has a live observer agent to route
 * images to. Emits a warning (via `onWarning`/`console.warn`) and returns
 * `false` if "auto" routing is configured but the observer agent is
 * disabled, since images would then have nowhere to go.
 *
 * @param config - Plugin configuration to validate
 * @param configPath - Path of the config file, used in the warning payload
 * @param options - Optional load options including the onWarning callback
 * @returns `true` if the routing configuration is valid, `false` otherwise
 */
function validateFinalImageRouting(
  config: PluginConfig,
  configPath: string,
  options?: LoadPluginConfigOptions,
): boolean {
  if (config.image_routing !== 'auto') return true;

  const disabledAgents = Array.isArray(config.disabled_agents)
    ? config.disabled_agents
    : DEFAULT_DISABLED_AGENTS;
  if (!disabledAgents.includes('observer')) return true;

  const message =
    'image_routing "auto" requires observer to be enabled. ' +
    'Remove "observer" from disabled_agents.';
  options?.onWarning?.({
    path: configPath,
    kind: 'invalid-schema',
    message,
  });
  if (!options?.silent) {
    console.warn(`[oh-my-opencode-slim] Invalid config: ${message}`);
  }
  return false;
}

/**
 * Find plugin config paths (user and project) for a given directory.
 * User config uses getConfigSearchDirs() for lookup.
 * Project config uses <directory>/.opencode/oh-my-opencode-slim.
 *
 * @param directory - Project directory to search for .opencode config
 * @returns Object with userConfigPath and projectConfigPath (null if not found)
 */
export function findPluginConfigPaths(directory: string): {
  userConfigPath: string | null;
  projectConfigPath: string | null;
} {
  const userConfigPath = findConfigPathInDirs(
    getConfigSearchDirs(),
    'oh-my-opencode-slim',
  );

  const projectConfigBasePath = path.join(
    directory,
    '.opencode',
    'oh-my-opencode-slim',
  );

  const projectConfigPath = findConfigPath(projectConfigBasePath);

  return { userConfigPath, projectConfigPath };
}

/**
 * Merge two plugin configs using the loader's merge rules.
 * Project/override takes precedence over base.
 */
export function mergePluginConfigs(
  base: PluginConfig,
  override: PluginConfig,
): PluginConfig {
  return {
    ...base,
    ...override,
    agents: deepMerge(base.agents, override.agents),
    presets: mergePresetMaps(base.presets, override.presets),
    multiplexer: deepMerge(base.multiplexer, override.multiplexer),
    interview: deepMerge(base.interview, override.interview),
    backgroundJobs: deepMerge(base.backgroundJobs, override.backgroundJobs),
    fallback: deepMerge(base.fallback, override.fallback),
    council: deepMerge(base.council, override.council),
    webfetch: deepMerge(
      base.webfetch as Record<string, unknown> | undefined,
      override.webfetch as Record<string, unknown> | undefined,
    ) as PluginConfig['webfetch'],
    acpAgents: deepMerge(base.acpAgents, override.acpAgents),
    companion: deepMerge(
      base.companion as Record<string, unknown> | undefined,
      override.companion as Record<string, unknown> | undefined,
    ) as PluginConfig['companion'],
  };
}

/**
 * Recursively merge two objects, with override values taking precedence.
 * For nested objects, merges recursively. For arrays and primitives, override replaces base.
 *
 * @param base - Base object to merge into
 * @param override - Override object whose values take precedence
 * @returns Merged object, or undefined if both inputs are undefined
 */
export function deepMerge<T extends Record<string, unknown>>(
  base?: T,
  override?: T,
): T | undefined {
  if (!base) return override;
  if (!override) return base;

  const result = { ...base } as T;
  for (const key of Object.keys(override) as (keyof T)[]) {
    const baseVal = base[key];
    const overrideVal = override[key];

    if (
      typeof baseVal === 'object' &&
      baseVal !== null &&
      typeof overrideVal === 'object' &&
      overrideVal !== null &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

function mergePresetMaps(
  base?: Record<string, Preset>,
  override?: Record<string, Preset>,
): Record<string, Preset> | undefined {
  if (!base) return override;
  if (!override) return base;

  const result = Object.create(null) as Record<string, Preset>;
  for (const name of Object.keys(base)) {
    Object.defineProperty(result, name, {
      configurable: true,
      enumerable: true,
      value: base[name],
      writable: true,
    });
  }
  for (const name of Object.keys(override)) {
    const value = Object.hasOwn(base, name)
      ? (deepMerge(base[name], override[name]) as Preset)
      : override[name];
    Object.defineProperty(result, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return result;
}

function stripPresetMetadata(preset: Preset): ResolvedPreset {
  const agents: ResolvedPreset = {};
  for (const [name, override] of Object.entries(preset)) {
    if (name !== '$extends') {
      agents[name] = override as AgentOverrideConfig;
    }
  }
  return agents;
}

/**
 * Resolve every preset in a fully merged raw preset graph.
 *
 * Parent declarations are intentionally read only after schema validation;
 * graph errors are semantic and therefore remain fatal to the caller.
 */
export function resolvePresetInheritance(
  presets?: Record<string, Preset>,
): Record<string, ResolvedPreset> {
  const rawPresets = presets ?? {};
  const resolved = new Map<string, ResolvedPreset>();

  const resolve = (name: string, pathFromRoot: string[]): ResolvedPreset => {
    if (resolved.has(name)) return resolved.get(name) as ResolvedPreset;

    const cycleStart = pathFromRoot.indexOf(name);
    if (cycleStart !== -1) {
      const cyclePath = [...pathFromRoot.slice(cycleStart), name];
      throw new PresetInheritanceError(
        'PRESET_INHERITANCE_CYCLE',
        `Preset inheritance cycle: ${cyclePath.join(' -> ')}`,
      );
    }

    if (!Object.hasOwn(rawPresets, name)) {
      const referencePath = [...pathFromRoot, name].join(' -> ');
      throw new PresetInheritanceError(
        'PRESET_INHERITANCE_MISSING_PARENT',
        `Preset "${pathFromRoot.at(-1)}" extends missing preset "${name}" (${referencePath})`,
      );
    }
    const preset = rawPresets[name];

    const parent = preset.$extends
      ? resolve(preset.$extends, [...pathFromRoot, name])
      : undefined;
    const ownAgents = stripPresetMetadata(preset);
    const effective = deepMerge(parent, ownAgents) ?? {};
    resolved.set(name, effective);
    return effective;
  };

  for (const name of Object.keys(rawPresets)) {
    resolve(name, []);
  }

  return Object.fromEntries(resolved);
}

/**
 * Return the metadata-free preset used by runtime consumers.
 *
 * Loaded configurations already carry the derived map. The fallback keeps
 * direct in-memory callers on the same raw/resolved boundary without making
 * them reimplement inheritance handling.
 */
export function getResolvedPreset(
  config: PluginConfig | undefined,
  name: string | null | undefined,
): ResolvedPreset | undefined {
  if (!name) return undefined;

  const resolved =
    config?.resolvedPresets ?? resolvePresetInheritance(config?.presets);
  return Object.hasOwn(resolved, name) ? resolved[name] : undefined;
}

/**
 * Load plugin configuration from user and project config files, merging them appropriately.
 *
 * Configuration is loaded from two locations:
 * 1. User config: $OPENCODE_CONFIG_DIR/oh-my-opencode-slim.jsonc or .json,
 *    or ~/.config/opencode/oh-my-opencode-slim.jsonc or .json (or $XDG_CONFIG_HOME)
 * 2. Project config: <directory>/.opencode/oh-my-opencode-slim.jsonc or .json
 *
 * JSONC format is preferred over JSON (allows comments and trailing commas).
 * Project config takes precedence over user config. Nested objects (agents, multiplexer) are
 * deep-merged, while top-level arrays are replaced entirely by project config.
 *
 * @param directory - Project directory to search for .opencode config
 * @param options - Optional load options including onWarning callback
 * @returns Merged plugin configuration (empty object if no configs found)
 */
export function loadPluginConfig(
  directory: string,
  options?: LoadPluginConfigOptions,
): PluginConfig {
  const { userConfigPath, projectConfigPath } =
    findPluginConfigPaths(directory);

  let config: PluginConfig = userConfigPath
    ? (loadConfigFromPath(userConfigPath, options) ?? {})
    : {};

  const projectConfig = projectConfigPath
    ? loadConfigFromPath(projectConfigPath, options)
    : null;
  if (projectConfig) {
    config = mergePluginConfigs(config, projectConfig);
  }

  if (config.webfetch) {
    config.webfetch = WebfetchConfigSchema.parse(config.webfetch);
  }
  if (config.interview) {
    config.interview = InterviewConfigSchema.parse(config.interview);
  }
  if (config.backgroundJobs) {
    config.backgroundJobs = BackgroundJobsConfigSchema.parse(
      config.backgroundJobs,
    );
  }

  // Override preset from environment variable if set
  const envPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  if (envPreset) {
    config.preset = envPreset;
  }

  // Resolve and validate the complete merged graph before selecting a preset.
  // Keep raw definitions for persistence-oriented consumers.
  if (config.presets) {
    Object.defineProperty(config, 'resolvedPresets', {
      configurable: true,
      enumerable: false,
      value: resolvePresetInheritance(config.presets),
      writable: true,
    });
  }

  // Resolve preset and merge with root agents
  if (config.preset) {
    const preset =
      config.resolvedPresets &&
      Object.hasOwn(config.resolvedPresets, config.preset)
        ? config.resolvedPresets[config.preset]
        : undefined;
    if (preset) {
      // Merge preset agents with root agents (root overrides)
      config.agents = deepMerge(preset, config.agents);
    } else {
      // Preset name specified but doesn't exist - warn user
      const presetSource =
        envPreset === config.preset ? 'environment variable' : 'config file';
      const availablePresets = config.presets
        ? Object.keys(config.presets).join(', ')
        : 'none';
      const message = `Preset "${config.preset}" not found (from ${presetSource}). Available presets: ${availablePresets}`;
      options?.onWarning?.({
        path: projectConfigPath ?? userConfigPath ?? '',
        kind: 'missing-preset',
        message,
      });
      if (!options?.silent) {
        console.warn(`[oh-my-opencode-slim] ${message}`);
      }
    }
  }

  // Normalize companion config defaults
  if (config.companion) {
    config.companion = {
      enabled: config.companion.enabled ?? false,
      binaryPath: config.companion.binaryPath,
      position: config.companion.position ?? 'bottom-right',
      size: config.companion.size ?? 'medium',
      gifPack: config.companion.gifPack ?? 'default',
      loopStyle: config.companion.loopStyle ?? 'classic',
      speed: config.companion.speed ?? 1,
      debug: config.companion.debug ?? false,
    };
  }

  validateFinalImageRouting(
    config,
    projectConfigPath ?? userConfigPath ?? '',
    options,
  );
  // Note: we intentionally do NOT override image_routing to 'direct' here.
  // The observer-disabled guard in processImageAttachments handles the
  // auto+observer-disabled case by returning true, which triggers the
  // debounced toast in index.ts. Overriding to 'direct' here would prevent
  // processImageAttachments from returning true and suppress the toast.

  return config;
}

/**
 * Load custom prompt for an agent from the prompts directory.
 * Checks for {agent}.md (replaces default) and {agent}_append.md (appends to default).
 * If preset is provided and safe for paths, it first checks {preset}/ subdirectory,
 * then falls back to the root prompts directory.
 *
 * @param agentName - Name of the agent (e.g., "orchestrator", "explorer")
 * @param optionsOrPreset - Optional preset name or options configuration
 * @returns Object with prompt and/or appendPrompt if files exist
 */
export function loadAgentPrompt(
  agentName: string,
  optionsOrPreset?: string | { preset?: string; projectDirectory?: string },
): {
  prompt?: string;
  appendPrompt?: string;
} {
  let preset: string | undefined;
  let projectDirectory: string | undefined;

  if (typeof optionsOrPreset === 'string') {
    preset = optionsOrPreset;
  } else if (optionsOrPreset && typeof optionsOrPreset === 'object') {
    preset = optionsOrPreset.preset;
    projectDirectory = optionsOrPreset.projectDirectory;
  }

  const presetDirName =
    preset && /^[a-zA-Z0-9_-]+$/.test(preset) ? preset : undefined;

  const searchDirs: string[] = [];

  // Lookup order preference:
  // 1. Project preset dir
  if (projectDirectory && presetDirName) {
    searchDirs.push(
      path.join(projectDirectory, '.opencode', PROMPTS_DIR_NAME, presetDirName),
    );
  }
  // 2. Project root dir
  if (projectDirectory) {
    searchDirs.push(path.join(projectDirectory, '.opencode', PROMPTS_DIR_NAME));
  }
  // 3. User preset dirs
  if (presetDirName) {
    for (const userDir of getConfigSearchDirs()) {
      searchDirs.push(path.join(userDir, PROMPTS_DIR_NAME, presetDirName));
    }
  }
  // 4. User root dirs
  for (const userDir of getConfigSearchDirs()) {
    searchDirs.push(path.join(userDir, PROMPTS_DIR_NAME));
  }

  const readFirstPrompt = (
    fileName: string,
    errorPrefix: string,
  ): string | undefined => {
    for (const dir of searchDirs) {
      const promptPath = path.join(dir, fileName);
      if (!fs.existsSync(promptPath)) {
        continue;
      }

      try {
        return fs.readFileSync(promptPath, 'utf-8');
      } catch (error) {
        console.warn(
          `[oh-my-opencode-slim] ${errorPrefix} ${promptPath}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return undefined;
  };

  const result: { prompt?: string; appendPrompt?: string } = {};

  // Check for replacement prompt
  result.prompt = readFirstPrompt(
    `${agentName}.md`,
    'Error reading prompt file',
  );

  // Check for append prompt
  result.appendPrompt = readFirstPrompt(
    `${agentName}_append.md`,
    'Error reading append prompt file',
  );

  return result;
}
