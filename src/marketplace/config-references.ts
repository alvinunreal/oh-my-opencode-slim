import { mutateJsonFile } from '../cli/config-io';
import { findPluginConfigPaths } from '../config/loader';

interface UnknownRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function removeFromConfig(config: unknown, packageId: string): unknown {
  if (!isRecord(config) || !isRecord(config.presets)) return config;

  let changed = false;
  const presets = { ...config.presets };
  for (const [presetName, presetValue] of Object.entries(presets)) {
    if (!isRecord(presetValue) || !isRecord(presetValue.marketplace)) continue;
    const agents = presetValue.marketplace.agents;
    if (!Array.isArray(agents)) continue;
    const filtered = agents.filter(
      (value) =>
        typeof value !== 'string' || value.trim().toLowerCase() !== packageId,
    );
    if (filtered.length === agents.length) continue;
    changed = true;
    presets[presetName] = {
      ...presetValue,
      marketplace: {
        ...presetValue.marketplace,
        agents: filtered,
      },
    };
  }
  return changed ? { ...config, presets } : config;
}

/** Remove a package from every user and project preset activation list. */
export function removeMarketplaceConfigReferences(
  directory: string,
  packageId: string,
): void {
  const paths = findPluginConfigPaths(directory);
  const normalizedId = packageId.trim().toLowerCase();
  for (const configPath of new Set(
    [paths.userConfigPath, paths.projectConfigPath].filter(
      (value): value is string => value !== null,
    ),
  )) {
    mutateJsonFile(configPath, (config) =>
      removeFromConfig(config, normalizedId),
    );
  }
}
