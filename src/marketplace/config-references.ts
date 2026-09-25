import { mutateJsonFile, parseConfigFile } from '../cli/config-io';
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
    const { config, error } = parseConfigFile(configPath);
    if (error)
      throw new Error(`Failed to parse config ${configPath}: ${error}`);
    if (removeFromConfig(config, normalizedId) === config) continue;
    mutateJsonFile(configPath, (config) =>
      removeFromConfig(config, normalizedId),
    );
  }
}
