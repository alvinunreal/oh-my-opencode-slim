import { existsSync, readFileSync } from 'node:fs';
import {
  parseJsonConfigContent,
  publishJsonFile,
  withSerializedConfigWrites,
} from '../cli/config-io';
import { findPluginConfigPaths } from '../config/loader';

interface UnknownRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MARKETPLACE_AGENT_LISTS = [
  'agents',
  'agents_add',
  'agents_remove',
] as const;

function removeFromConfig(config: unknown, packageId: string): unknown {
  if (!isRecord(config) || !isRecord(config.presets)) return config;

  let changed = false;
  const presets = { ...config.presets };
  for (const [presetName, presetValue] of Object.entries(presets)) {
    if (!isRecord(presetValue) || !isRecord(presetValue.marketplace)) continue;
    let marketplace: UnknownRecord = presetValue.marketplace;
    for (const key of MARKETPLACE_AGENT_LISTS) {
      const agents = marketplace[key];
      if (!Array.isArray(agents)) continue;
      const filtered = agents.filter(
        (value) =>
          typeof value !== 'string' || value.trim().toLowerCase() !== packageId,
      );
      if (filtered.length === agents.length) continue;
      changed = true;
      marketplace = { ...marketplace, [key]: filtered };
    }
    if (marketplace !== presetValue.marketplace) {
      presets[presetName] = { ...presetValue, marketplace };
    }
  }
  return changed ? { ...config, presets } : config;
}

interface ConfigChange {
  path: string;
  original: string;
  updated: string;
}

/**
 * Remove user/project activations and commit the store change under both
 * config leases. The callback must be synchronous, signal once the store
 * mutation is durable (or the package is already absent), and must not
 * re-enter a config mutation for either path.
 */
export function withMarketplaceConfigReferencesRemoved(
  directory: string,
  packageId: string,
  commit: (markCommitted: () => void) => void,
): void {
  const paths = findPluginConfigPaths(directory);
  const normalizedId = packageId.trim().toLowerCase();
  const configPaths = [paths.userConfigPath, paths.projectConfigPath].filter(
    (value): value is string => value !== null,
  );
  withSerializedConfigWrites(configPaths, () => {
    const changes: ConfigChange[] = [];
    // Prepare both files before publishing either one (including parse errors).
    for (const path of new Set(configPaths)) {
      if (!existsSync(path)) continue;
      const original = readFileSync(path, 'utf8');
      if (!original.trim()) continue;
      let config: unknown;
      try {
        config = parseJsonConfigContent(original);
      } catch (error) {
        throw new Error(`Failed to parse config ${path}: ${error}`, {
          cause: error,
        });
      }
      const updated = removeFromConfig(config, normalizedId);
      if (updated !== config) {
        changes.push({
          path,
          original,
          updated: `${JSON.stringify(updated, null, 2)}\n`,
        });
      }
    }

    const attempted: ConfigChange[] = [];
    let committed = false;
    try {
      for (const change of changes) {
        // Include the failing publication: it may have renamed successfully
        // before reporting a directory sync or backup failure.
        attempted.push(change);
        publishJsonFile(change.path, change.updated);
      }
      commit(() => {
        committed = true;
      });
    } catch (error) {
      if (committed) {
        throw new Error(
          `Marketplace removal completed for ${normalizedId}, but finalization failed; config references remain removed`,
          { cause: error },
        );
      }
      const rollbackErrors: unknown[] = [];
      for (const change of attempted.reverse()) {
        try {
          publishJsonFile(change.path, change.original);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Marketplace config removal is in doubt: publish/commit and rollback failed',
        );
      }
      throw error;
    }
  });
}

/** Remove a package from every user and project preset activation list. */
export function removeMarketplaceConfigReferences(
  directory: string,
  packageId: string,
): void {
  withMarketplaceConfigReferencesRemoved(directory, packageId, () => {});
}
