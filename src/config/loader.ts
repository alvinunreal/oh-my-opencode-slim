import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripJsonComments } from '../cli/config-io';
import { getConfigSearchDirs } from '../cli/paths';
import { DEFAULT_DISABLED_AGENTS } from './constants';
import type { ResolvedPresetMap } from './presets';
import {
  deepMerge,
  mergeAgentOverrides,
  mergePresetMaps,
  normalizePreset,
  PresetResolutionError,
  resolvePresetDefinition,
} from './presets';
import {
  type BackgroundJobsConfig,
  BackgroundJobsConfigSchema,
  DISABLED_COMMANDS_VALUES,
  DISABLED_HOOKS_VALUES,
  InterviewConfigSchema,
  LEGACY_FALLBACK_KEYS,
  type MarketplaceActivation,
  MultiplexerConfigSchema,
  PluginConfigSchema,
  type RawPluginConfig,
  type ResolvedPluginConfig,
  sanitizeBackgroundJobsConfig,
  sanitizeMultiplexerConfig,
  WebfetchConfigSchema,
} from './schema';

export {
  deepMerge,
  mergeAgentOverrides,
  mergePresetMaps,
  normalizePreset,
  PresetResolutionError,
  resolvePreset,
  resolvePresets,
} from './presets';

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

  /**
   * Host flavor marker ('v2' on OpenCode v2 hosts; absent on v1). Selects
   * flavor-derived defaults for background-job keys that no config layer
   * set explicitly: on v2 the native background notifier already delivers
   * a run's first terminal publication, so board injection and periodic
   * wake evaluation default off there. Explicit config always wins.
   * Unmarked hosts also use v1's worktree-bounded discovery.
   */
  hostFlavor?: string;
}

const PROMPTS_DIR_NAME = 'oh-my-opencode-slim';
const INTERVIEW_CONFIG_KEYS = [
  'maxQuestions',
  'outputFolder',
  'autoOpenBrowser',
  'port',
  'dashboard',
  'printState',
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
  'disabled_hooks',
  'disabled_commands',
] as const;

// Enum-backed disabled_* keys: unknown entries are stripped from the array
// (with a warning) instead of rejecting the whole config layer through the
// schema's editor-completion enum. Single source: the schema value lists.
const DISABLED_CONFIG_VALUE_SETS: Partial<
  Record<(typeof DISABLED_CONFIG_KEYS)[number], readonly string[]>
> = {
  disabled_hooks: DISABLED_HOOKS_VALUES,
  disabled_commands: DISABLED_COMMANDS_VALUES,
};

/** Apply the environment placeholder syntax shared by config consumers. */
export function interpolateEnvironmentVariables(value: string): string {
  return value.replace(
    /\{env:([^}]+)\}/g,
    (_match, varName: string) => process.env[varName] ?? '',
  );
}

/**
 * Normalize disabled_* config keys in place so a non-array value does not
 * reject the whole config object during schema validation. A string value
 * (e.g. "explorer") becomes a single-element array so the user's disable
 * intent survives; any other non-array value (number, boolean, object, ...)
 * is dropped. Array values of enum-backed keys (disabled_hooks,
 * disabled_commands), including strings after shape normalization, are
 * filtered to their valid values, stripping unknown entries instead of
 * failing schema validation; a value consisting only of unknown entries is
 * treated as unset so a lower config layer's list still applies. Undefined
 * values are left
 * untouched. Each normalization is reported through `warn` (if provided)
 * with a plain message; callers wrap it in their own warning channel
 * (loader uses onWarning + console.warn, doctor just reports the message).
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
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'string') {
      configRecord[key] = [value];
      warn?.(
        `Config key "${key}" should be an array; ` +
          `normalized to ["${value}"].`,
      );
    } else if (!Array.isArray(value)) {
      delete configRecord[key];
      warn?.(`Config key "${key}" must be an array; ignoring invalid value.`);
      continue;
    }

    const validValues = DISABLED_CONFIG_VALUE_SETS[key];
    if (!validValues) {
      continue;
    }
    const normalizedValues = configRecord[key] as unknown[];
    const stripped: unknown[] = [];
    const kept: unknown[] = [];
    for (const entry of normalizedValues) {
      if (validValues.includes(entry as string)) {
        kept.push(entry);
      } else {
        stripped.push(entry);
      }
    }
    if (stripped.length === 0) {
      continue;
    }
    if (kept.length === 0) {
      // Every entry was unknown: emit no opt-out signal, so a lower config
      // layer's valid list survives the layer merge.
      delete configRecord[key];
      warn?.(
        `Config key "${key}" contains only unknown values ` +
          `(${JSON.stringify(stripped)}); ignoring the key entirely so a ` +
          `lower config layer still applies. ` +
          `Valid values: ${validValues.join(', ')}.`,
      );
      continue;
    }
    configRecord[key] = kept;
    warn?.(
      `Config key "${key}" contains unknown values ` +
        `(${JSON.stringify(stripped)}); ignoring them. ` +
        `Valid values: ${validValues.join(', ')}.`,
    );
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
  parsedConfig: RawPluginConfig,
  rawConfig: unknown,
): RawPluginConfig {
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
    interview: interview as RawPluginConfig['interview'],
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retainExplicitBackgroundJobsFields(
  parsedConfig: RawPluginConfig,
  rawConfig: unknown,
): RawPluginConfig {
  if (!parsedConfig.backgroundJobs) {
    return parsedConfig;
  }

  const rawBackgroundJobs =
    isPlainRecord(rawConfig) && isPlainRecord(rawConfig.backgroundJobs)
      ? rawConfig.backgroundJobs
      : undefined;
  if (!rawBackgroundJobs) {
    return parsedConfig;
  }

  // Keys the sanitizer dropped were invalid in this layer (#1291). Retaining
  // their parsed defaults would resurrect them as explicit values, letting a
  // broken upper layer override valid lower-layer settings during merge.
  // The sanitizer's once-per-process diagnostic already fired inside
  // safeParse, so this second pass stays silent.
  const sanitizedBackgroundJobs = sanitizeBackgroundJobsConfig(
    rawBackgroundJobs,
  ) as Record<string, unknown>;

  return {
    ...parsedConfig,
    backgroundJobs: retainSanitizedValues(
      parsedConfig.backgroundJobs as unknown as Record<string, unknown>,
      sanitizedBackgroundJobs,
    ) as RawPluginConfig['backgroundJobs'],
  };
}

/**
 * Zod applies multiplexer defaults while parsing each layer. Keep those
 * defaults from masquerading as explicitly configured overrides; the merged
 * multiplexer config is normalized after all layers are merged.
 */
function retainExplicitMultiplexerFields(
  parsedConfig: RawPluginConfig,
  rawConfig: unknown,
): RawPluginConfig {
  if (!parsedConfig.multiplexer || !isPlainRecord(rawConfig)) {
    return parsedConfig;
  }

  // The sanitizer's once-per-process diagnostic already fired in safeParse.
  return {
    ...parsedConfig,
    multiplexer: retainSanitizedValues(
      parsedConfig.multiplexer as unknown as Record<string, unknown>,
      sanitizeMultiplexerConfig(rawConfig.multiplexer) as Record<
        string,
        unknown
      >,
    ) as RawPluginConfig['multiplexer'],
  };
}

/** Keep parsed leaf values only where the sanitized raw layer kept the key, recursing into plain objects. */
function retainSanitizedValues(
  parsed: Record<string, unknown>,
  sanitized: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(sanitized)) {
    if (!Object.hasOwn(parsed, key)) {
      continue;
    }
    const parsedValue = parsed[key];
    const sanitizedValue = sanitized[key];
    if (isPlainRecord(parsedValue) && isPlainRecord(sanitizedValue)) {
      const nested = retainSanitizedValues(parsedValue, sanitizedValue);
      if (Object.keys(nested).length > 0) {
        out[key] = nested;
      }
      continue;
    }
    out[key] = parsedValue;
  }
  return out;
}

/** Normalize preset syntax before layered config objects are merged. */
function normalizePresetDeclarations(config: RawPluginConfig): RawPluginConfig {
  if (!config.presets) {
    return config;
  }

  return {
    ...config,
    presets: Object.fromEntries(
      Object.entries(config.presets).map(([name, preset]) => [
        name,
        normalizePreset(preset),
      ]),
    ),
  };
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
export function loadPluginConfigFromPath(
  configPath: string,
  options?: LoadPluginConfigOptions,
): RawPluginConfig | null {
  const config = loadRawPluginConfigFromPath(configPath, options);
  return config ? normalizePresetDeclarations(config) : null;
}

/** Validate a layer without changing its editable preset declaration syntax. */
export function loadRawPluginConfigFromPath(
  configPath: string,
  options?: LoadPluginConfigOptions,
): RawPluginConfig | null {
  try {
    // Strip a UTF-8 BOM (RFC 8259 permits one); JSON.parse would otherwise
    // fail with "Unrecognized token" and silently drop the whole config.
    const content = fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, '');
    // Use stripJsonComments to support JSONC format (comments and trailing commas)
    let rawConfig: unknown;
    try {
      const stripped = stripJsonComments(content);
      const interpolated = interpolateEnvironmentVariables(stripped);
      rawConfig = JSON.parse(interpolated);
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
        const fallbackMsg = `Deprecated fallback config key${present.length === 1 ? '' : 's'} ${present.join(', ')} found and ignored. These keys are no longer supported by foreground fallback and have no effect.`;
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
    layerConfig = retainExplicitMultiplexerFields(layerConfig, rawConfig);

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
      layerConfig = {
        ...layerConfig,
        webfetch: webfetch as RawPluginConfig['webfetch'],
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
  config: RawPluginConfig,
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

/** Use the host's case-insensitive boolean flag semantics. */
export function isProjectConfigDisabled(): boolean {
  return ['true', '1'].includes(
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase() ?? '',
  );
}

/** Project .opencode directories in host-specific, farthest-to-nearest order. */
export function getProjectConfigDirectories(
  directory: string,
  hostFlavor?: string,
): string[] {
  if (isProjectConfigDisabled()) {
    return [];
  }
  const directories: string[] = [];
  let current = path.resolve(directory);
  for (;;) {
    directories.push(path.join(current, '.opencode'));
    if (hostFlavor !== 'v2') {
      try {
        fs.lstatSync(path.join(current, '.git'));
        break;
      } catch {
        // As in marketplace preflight, a Git directory or worktree file
        // marks the inclusive v1 project boundary.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories.reverse();
}

function getProjectConfigBases(
  directory: string,
  hostFlavor?: string,
): string[] {
  return getProjectConfigDirectories(directory, hostFlavor).map(
    (configDirectory) => path.join(configDirectory, 'oh-my-opencode-slim'),
  );
}

/**
 * Find plugin config paths (user and project) for a given directory.
 * User config uses getConfigSearchDirs() for lookup.
 * Project configs follow the host's discovery boundary: the Git worktree
 * on v1 (the default), or the filesystem root on v2. The project's walk is
 * omitted when OPENCODE_DISABLE_PROJECT_CONFIG is true or 1.
 *
 * @param directory - Project directory to search for .opencode config
 * @returns All project layers in merge order, plus the current directory's
 * projectConfigPath for callers that edit local configuration. The singular
 * path must not redirect writes to an inherited ancestor file.
 */
export function findPluginConfigPaths(
  directory: string,
  hostFlavor?: string,
): {
  userConfigPath: string | null;
  projectConfigPath: string | null;
  projectConfigPaths: string[];
} {
  const userConfigPath = findConfigPathInDirs(
    getConfigSearchDirs(),
    'oh-my-opencode-slim',
  );

  const projectConfigBases = getProjectConfigBases(directory, hostFlavor);
  const projectConfigPaths = projectConfigBases
    .map(findConfigPath)
    .filter((configPath): configPath is string => configPath !== null);
  const projectConfigPath = projectConfigBases.length
    ? findConfigPath(
        path.resolve(directory, '.opencode', 'oh-my-opencode-slim'),
      )
    : null;

  return { userConfigPath, projectConfigPath, projectConfigPaths };
}

/**
 * All plugin config candidate paths for a directory, independent of
 * existence: `.jsonc` then `.json` for every user config search location and
 * for each eligible ancestor's `.opencode`, farthest to nearest.
 * The loader prefers `.jsonc` over `.json`, and
 * the v2 watcher must observe creation/deletion/rename and that precedence
 * change, so it consumes this candidate set instead of existing files only.
 */
export function getPluginConfigCandidates(
  directory: string,
  hostFlavor?: string,
): {
  user: string[];
  project: string[];
} {
  const user: string[] = [];
  for (const configDir of getConfigSearchDirs()) {
    const basePath = path.join(configDir, 'oh-my-opencode-slim');
    user.push(`${basePath}.jsonc`, `${basePath}.json`);
  }
  return {
    user,
    project: getProjectConfigBases(directory, hostFlavor).flatMap(
      (basePath) => [`${basePath}.jsonc`, `${basePath}.json`],
    ),
  };
}

/**
 * Merge two plugin configs using the loader's merge rules.
 * Project/override takes precedence over base.
 */
export function mergePluginConfigs(
  base: RawPluginConfig,
  override: RawPluginConfig,
): RawPluginConfig {
  return {
    ...base,
    ...override,
    agents:
      base.agents || override.agents
        ? mergeAgentOverrides(base.agents ?? {}, override.agents ?? {})
        : undefined,
    presets: mergePresetMaps(base.presets, override.presets),
    multiplexer: deepMerge(base.multiplexer, override.multiplexer),
    interview: deepMerge(base.interview, override.interview),
    backgroundJobs: deepMerge(base.backgroundJobs, override.backgroundJobs),
    fallback: deepMerge(base.fallback, override.fallback),
    council: deepMerge(base.council, override.council),
    webfetch: deepMerge(
      base.webfetch as Record<string, unknown> | undefined,
      override.webfetch as Record<string, unknown> | undefined,
    ) as RawPluginConfig['webfetch'],
    acpAgents: deepMerge(base.acpAgents, override.acpAgents),
    companion: deepMerge(
      base.companion as Record<string, unknown> | undefined,
      override.companion as Record<string, unknown> | undefined,
    ) as RawPluginConfig['companion'],
  };
}

/**
 * Load plugin configuration from user and project config files, merging them appropriately.
 *
 * Configuration is loaded in precedence order:
 * 1. User config: $OPENCODE_CONFIG_DIR/oh-my-opencode-slim.jsonc or .json,
 *    or ~/.config/opencode/oh-my-opencode-slim.jsonc or .json (or $XDG_CONFIG_HOME)
 * 2. Ancestor project configs: .opencode/oh-my-opencode-slim.jsonc or .json,
 *    from the host's discovery boundary down to directory, inclusive
 *
 * JSONC format is preferred over JSON (allows comments and trailing commas).
 * Closer project configs take precedence over ancestors and user config.
 * Nested objects (agents, multiplexer) are
 * deep-merged, while top-level arrays are replaced entirely by project config.
 *
 * @param directory - Project directory to search for .opencode config
 * @param options - Optional load options including onWarning callback
 * @returns Merged plugin configuration (empty object if no configs found)
 */
export function loadPluginConfig(
  directory: string,
  options?: LoadPluginConfigOptions,
): ResolvedPluginConfig {
  const { userConfigPath, projectConfigPaths } = findPluginConfigPaths(
    directory,
    options?.hostFlavor,
  );

  let config: RawPluginConfig = userConfigPath
    ? (loadPluginConfigFromPath(userConfigPath, options) ?? {})
    : {};

  const presetPaths = new Map<string, string>();
  const presetInheritancePaths = new Map<string, string>();
  let selectedPresetPath = '';
  let imageRoutingPath = '';
  const recordConfigSources = (
    layer: RawPluginConfig,
    configPath: string,
  ): void => {
    if (layer.preset !== undefined) selectedPresetPath = configPath;
    if (layer.image_routing !== undefined) imageRoutingPath = configPath;
    for (const [name, definition] of Object.entries(layer.presets ?? {})) {
      presetPaths.set(name, configPath);
      if (normalizePreset(definition).extends !== undefined) {
        presetInheritancePaths.set(name, configPath);
      }
    }
  };
  if (userConfigPath) recordConfigSources(config, userConfigPath);

  for (const configPath of projectConfigPaths) {
    const projectConfig = loadPluginConfigFromPath(configPath, options);
    if (projectConfig) {
      config = mergePluginConfigs(config, projectConfig);
      recordConfigSources(projectConfig, configPath);
    }
  }

  // v2-derived defaults (pre-parse, on the merged explicit-only config so a
  // key any layer configured explicitly is never overridden): the v2 native
  // background notifier delivers each run's FIRST terminal publication to
  // the parent, so the two channels that duplicate it — the passive job
  // board injected per request and the periodic idle evaluation — default
  // off on v2 hosts. Event-driven wakes (stopped-job recovery, rev>1
  // terminal publications, child-input asks) are unaffected and keep their
  // own config keys.
  if (options?.hostFlavor === 'v2') {
    const backgroundJobs = (config.backgroundJobs ??
      {}) as BackgroundJobsConfig & Record<string, unknown>;
    if (!Object.hasOwn(backgroundJobs, 'boardInjection')) {
      backgroundJobs.boardInjection = false;
    }
    const orchestratorWake = (backgroundJobs.orchestratorWake ??
      {}) as BackgroundJobsConfig['orchestratorWake'] & Record<string, unknown>;
    if (!Object.hasOwn(orchestratorWake, 'periodicWakeEnabled')) {
      orchestratorWake.periodicWakeEnabled = false;
    }
    backgroundJobs.orchestratorWake = orchestratorWake;
    config.backgroundJobs = backgroundJobs;
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
  if (config.multiplexer) {
    // Per-layer parsing kept only explicitly configured multiplexer keys
    // (see retainExplicitMultiplexerFields), so defaults apply once here,
    // after all layers are merged.
    config.multiplexer = MultiplexerConfigSchema.parse(config.multiplexer);
  }

  // Override preset from environment variable if set
  const envPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  if (envPreset) {
    config.preset = envPreset;
  }

  // Resolve presets independently. An invalid, unused preset must not prevent
  // valid presets from being selected. A failed chain is omitted completely,
  // so the selected preset can never receive a partially resolved ancestor.
  let resolvedPresets: ResolvedPresetMap | undefined;
  let resolvedMarketplacePresets:
    | Record<string, MarketplaceActivation>
    | undefined;
  const presetInheritanceFailures = new Set<string>();
  if (config.presets) {
    resolvedPresets = {};
    resolvedMarketplacePresets = {};
    for (const name of Object.keys(config.presets)) {
      try {
        const definition = resolvePresetDefinition(name, config.presets);
        resolvedPresets[name] = definition.agents;
        if (definition.marketplace) {
          resolvedMarketplacePresets[name] = definition.marketplace;
        }
      } catch (error) {
        presetInheritanceFailures.add(name);
        const message =
          error instanceof PresetResolutionError
            ? error.message
            : `Unable to resolve preset inheritance: ${String(error)}`;
        const brokenParent =
          error instanceof PresetResolutionError
            ? error.chain.at(-2)
            : undefined;
        options?.onWarning?.({
          path:
            (brokenParent
              ? presetInheritancePaths.get(brokenParent)
              : undefined) ??
            presetPaths.get(name) ??
            '',
          kind: 'invalid-schema',
          message,
        });
        if (!options?.silent) {
          console.warn(`[oh-my-opencode-slim] ${message}`);
        }
      }
    }
  }

  const { presets: _rawPresets, ...configWithoutPresets } = config;
  const runtimeConfig: ResolvedPluginConfig = resolvedPresets
    ? {
        ...configWithoutPresets,
        presets: resolvedPresets,
        ...(resolvedMarketplacePresets
          ? { marketplacePresets: resolvedMarketplacePresets }
          : {}),
      }
    : configWithoutPresets;

  // Resolve preset and merge with root agents
  if (runtimeConfig.preset) {
    const preset = resolvedPresets?.[runtimeConfig.preset];
    if (preset) {
      // Merge preset agents with root agents (root overrides)
      runtimeConfig.agents = mergeAgentOverrides(
        preset,
        runtimeConfig.agents ?? {},
      );
    } else if (presetInheritanceFailures.has(runtimeConfig.preset)) {
      // The inheritance warning above already identifies the exact broken
      // chain. In particular, never apply only the ancestor portion here.
    } else {
      // Preset name specified but doesn't exist - warn user
      const presetSource =
        envPreset === runtimeConfig.preset
          ? 'environment variable'
          : 'config file';
      const availablePresets = runtimeConfig.presets
        ? Object.keys(runtimeConfig.presets).join(', ')
        : 'none';
      const message = `Preset "${runtimeConfig.preset}" not found (from ${presetSource}). Available presets: ${availablePresets}`;
      options?.onWarning?.({
        path: envPreset ? '' : selectedPresetPath,
        kind: 'missing-preset',
        message,
      });
      if (!options?.silent) {
        console.warn(`[oh-my-opencode-slim] ${message}`);
      }
    }
  }

  // Canonicalize root declarations even when no preset is selected. This
  // keeps alias and canonical keys from competing in the runtime surface and
  // preserves canonical values field-by-field across user/project layers.
  if (runtimeConfig.agents) {
    runtimeConfig.agents = mergeAgentOverrides({}, runtimeConfig.agents);
  }

  // Note: per-agent skill directives (skills_add/skills_remove) are left
  // raw in the returned config. They are folded into the effective skills
  // list by RuntimeConfig.agents(), the single resolution point, so runtime
  // /preset switching re-resolves them from the raw preset layers instead
  // of operating on an already-baked skills array.

  // Normalize companion config defaults
  if (runtimeConfig.companion) {
    runtimeConfig.companion = {
      enabled: runtimeConfig.companion.enabled ?? false,
      binaryPath: runtimeConfig.companion.binaryPath,
      position: runtimeConfig.companion.position ?? 'bottom-right',
      size: runtimeConfig.companion.size ?? 'medium',
      gifPack: runtimeConfig.companion.gifPack ?? 'default',
      loopStyle: runtimeConfig.companion.loopStyle ?? 'classic',
      speed: runtimeConfig.companion.speed ?? 1,
      debug: runtimeConfig.companion.debug ?? false,
    };
  }

  validateFinalImageRouting(runtimeConfig, imageRoutingPath, options);
  // Note: we intentionally do NOT override image_routing to 'direct' here.
  // The observer-disabled guard in processImageAttachments handles the
  // auto+observer-disabled case by returning true, which triggers the
  // debounced toast in index.ts. Overriding to 'direct' here would prevent
  // processImageAttachments from returning true and suppress the toast.

  return runtimeConfig;
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
  optionsOrPreset?:
    | string
    | { preset?: string; projectDirectory?: string; hostFlavor?: string },
): {
  prompt?: string;
  appendPrompt?: string;
} {
  let preset: string | undefined;
  let projectDirectory: string | undefined;
  let hostFlavor: string | undefined;

  if (typeof optionsOrPreset === 'string') {
    preset = optionsOrPreset;
  } else if (optionsOrPreset && typeof optionsOrPreset === 'object') {
    preset = optionsOrPreset.preset;
    projectDirectory = optionsOrPreset.projectDirectory;
    hostFlavor = optionsOrPreset.hostFlavor;
  }

  const presetDirName =
    preset && /^[a-zA-Z0-9_-]+$/.test(preset) ? preset : undefined;

  const searchDirs: string[] = [];

  // Nearest project location wins, with preset-specific files preferred
  // within each location. Use the same ancestor walk as configuration.
  if (projectDirectory) {
    for (const configDirectory of getProjectConfigDirectories(
      projectDirectory,
      hostFlavor,
    ).reverse()) {
      const promptsDirectory = path.join(configDirectory, PROMPTS_DIR_NAME);
      if (presetDirName) {
        searchDirs.push(path.join(promptsDirectory, presetDirName));
      }
      searchDirs.push(promptsDirectory);
    }
  }
  // User preset dirs
  if (presetDirName) {
    for (const userDir of getConfigSearchDirs()) {
      searchDirs.push(path.join(userDir, PROMPTS_DIR_NAME, presetDirName));
    }
  }
  // User root dirs
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
