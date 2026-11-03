import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse, printParseErrorCode } from 'jsonc-parser';
import {
  prepareJsonConfigWrite,
  publishPreparedJsonConfig,
  restorePreparedJsonConfig,
  withSerializedConfigWrites,
} from '../config/json-file';
import {
  findPluginConfigPaths,
  getPluginConfigCandidates,
} from '../config/loader';
import { getConfigSearchDirs } from '../config/paths';
import { MarketplaceActivationError } from './errors';
import { normalizeMarketplacePackageId } from './ids';

type RecordValue = Record<string, unknown>;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';
}

function pathExists(configPath: string): boolean {
  try {
    statSync(configPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function canCreateConfigLock(configPath: string): boolean {
  let parent = dirname(configPath);
  while (true) {
    let parentStat: ReturnType<typeof statSync>;
    try {
      parentStat = statSync(parent);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        const ancestor = dirname(parent);
        if (ancestor === parent) throw error;
        parent = ancestor;
        continue;
      }
      if (errorCode(error) === 'ENOTDIR') return false;
      throw error;
    }
    if (!parentStat.isDirectory()) return false;
    try {
      accessSync(parent, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if (['EACCES', 'EPERM', 'EROFS'].includes(errorCode(error) ?? '')) {
        return false;
      }
      throw error;
    }
  }
}

function shouldLockProjectConfig(configPath: string): boolean {
  // Lock existing files regardless of their parent permissions. For missing
  // files, lock only if a writer could create the config while uninstall waits.
  return pathExists(configPath) || canCreateConfigLock(configPath);
}

function findExistingUserConfigPath(): string | null {
  for (const configDir of getConfigSearchDirs()) {
    for (const extension of ['.jsonc', '.json']) {
      const configPath = join(configDir, `oh-my-opencode-slim${extension}`);
      if (pathExists(configPath)) return resolve(configPath);
    }
  }
  return null;
}

const MARKETPLACE_AGENT_LISTS = [
  'agents',
  'agents_add',
  'agents_remove',
] as const;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfig(configPath: string, source: string): unknown {
  const errors: Parameters<typeof parse>[1] = [];
  const config = parse(source.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
  });
  if (errors.length || !isRecord(config)) {
    const detail = errors.length
      ? printParseErrorCode(errors[0].error)
      : 'expected a JSON object';
    throw new Error(`Failed to parse config ${configPath}: ${detail}`);
  }
  return config;
}

function resolvedId(value: string, field: string): string {
  const resolved = value.replace(/\{env:([^}]+)\}/g, (_match, name: string) => {
    if (process.env[name] === undefined) {
      throw new MarketplaceActivationError(
        `Cannot uninstall marketplace package: environment variable '${name}' referenced by marketplace.${field} is not set`,
      );
    }
    return process.env[name];
  });
  try {
    return normalizeMarketplacePackageId(resolved);
  } catch (error) {
    throw new MarketplaceActivationError(
      `Cannot uninstall marketplace package: invalid marketplace.${field} package ID (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function removeReferences(config: unknown, packageId: string): unknown {
  if (!isRecord(config) || !isRecord(config.presets)) return config;
  let presetsChanged = false;
  const presets = { ...config.presets };

  for (const [presetName, presetValue] of Object.entries(presets)) {
    if (!isRecord(presetValue)) continue;
    if (
      Object.hasOwn(presetValue, 'marketplace') &&
      !isRecord(presetValue.marketplace)
    ) {
      throw new MarketplaceActivationError(
        `Cannot uninstall marketplace package: preset '${presetName}' marketplace directives must be an object`,
      );
    }
    if (!isRecord(presetValue.marketplace)) continue;
    let marketplaceChanged = false;
    const marketplace = { ...presetValue.marketplace };
    for (const key of MARKETPLACE_AGENT_LISTS) {
      if (Object.hasOwn(marketplace, key) && !Array.isArray(marketplace[key])) {
        throw new MarketplaceActivationError(
          `Cannot uninstall marketplace package: marketplace.${key} must be an array of package IDs`,
        );
      }
      const entries = marketplace[key];
      if (!Array.isArray(entries)) continue;
      if (entries.some((entry) => typeof entry !== 'string')) {
        throw new MarketplaceActivationError(
          `Cannot uninstall marketplace package: marketplace.${key} must contain only package IDs`,
        );
      }
      const filtered = entries.filter(
        (entry) => resolvedId(entry as string, key) !== packageId,
      );
      if (filtered.length === entries.length) continue;
      marketplace[key] = filtered;
      marketplaceChanged = true;
    }
    if (marketplaceChanged) {
      presets[presetName] = { ...presetValue, marketplace };
      presetsChanged = true;
    }
  }

  return presetsChanged ? { ...config, presets } : config;
}

/**
 * Coordinate config-reference cleanup with a durable store mutation.
 * The operation must synchronously signal its commit point and must not
 * re-enter config mutation for any of the leased files.
 */
export function withMarketplaceConfigReferencesRemoved(
  projectDir: string,
  id: string,
  operation: (onCommitted: () => void) => void,
  hostFlavor?: string,
): void {
  const initialUserConfigPath = findExistingUserConfigPath();
  const candidateConfigPaths = [
    ...getPluginConfigCandidates(projectDir, hostFlavor).project,
    ...(initialUserConfigPath ? [initialUserConfigPath] : []),
  ];
  const orderedPaths = [
    ...new Set(
      candidateConfigPaths
        .filter(
          (configPath) =>
            configPath === initialUserConfigPath ||
            shouldLockProjectConfig(configPath),
        )
        .map((configPath) => resolve(configPath)),
    ),
  ].sort();
  const targetId = normalizeMarketplacePackageId(id);

  let committed = false;
  try {
    withSerializedConfigWrites(orderedPaths, () => {
      // Rediscover while holding the selected user config and all feasible
      // project config leases. A project config may have been created while
      // uninstall waited.
      const current = findPluginConfigPaths(projectDir, hostFlavor);
      const currentUserConfigPath = findExistingUserConfigPath();
      if (currentUserConfigPath !== initialUserConfigPath) {
        throw new MarketplaceActivationError(
          'Marketplace user config resolution changed during uninstall; retry the operation',
        );
      }
      const configPaths = [currentUserConfigPath, ...current.projectConfigPaths]
        .filter((configPath): configPath is string => configPath !== null)
        .map((configPath) => resolve(configPath));
      if (
        configPaths.some((configPath) => !orderedPaths.includes(configPath))
      ) {
        throw new MarketplaceActivationError(
          'Marketplace project config resolution changed during uninstall; retry the operation',
        );
      }
      const prepared = [];
      for (const configPath of [...new Set(configPaths)].sort()) {
        if (!pathExists(configPath)) continue;
        const original = readFileSync(configPath, 'utf8');
        const config = parseConfig(configPath, original);
        const updated = removeReferences(config, targetId);
        prepared.push(
          prepareJsonConfigWrite(
            configPath,
            original,
            updated as Parameters<typeof prepareJsonConfigWrite>[2],
          ),
        );
      }

      const attempted: typeof prepared = [];
      try {
        for (const write of prepared) {
          if (!write.changed) continue;
          attempted.push(write);
          publishPreparedJsonConfig(write);
        }
        operation(() => {
          committed = true;
        });
      } catch (error) {
        if (committed) throw error;

        const rollbackErrors: Error[] = [];
        for (const write of attempted.reverse()) {
          try {
            restorePreparedJsonConfig(write);
          } catch (rollbackError) {
            rollbackErrors.push(
              new Error(`Failed to restore config ${write.configPath}`, {
                cause: rollbackError,
              }),
            );
          }
        }
        if (rollbackErrors.length) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            `Marketplace config removal for ${targetId} is in doubt; rollback failed`,
          );
        }
        throw error;
      }
    });
  } catch (error) {
    if (committed) {
      throw new Error(
        `Marketplace removal for ${targetId} completed, but finalization failed; config references remain removed`,
        { cause: error },
      );
    }
    throw error;
  }
}
