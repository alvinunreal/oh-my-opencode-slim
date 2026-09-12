import { findPluginConfigPaths, loadPluginConfig } from '../config/loader';

export interface MarketplaceConfigReference {
  packageId: string;
  configPath: string;
  presetName: string;
  target: 'agent';
}

interface UnknownRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addReference(
  references: MarketplaceConfigReference[],
  value: unknown,
  configPath: string,
  presetName: string,
  target: 'agent',
): void {
  if (typeof value !== 'string' || value.trim().length === 0) return;
  references.push({
    packageId: value.trim().toLowerCase(),
    configPath,
    presetName,
    target,
  });
}

function readReferencesFromMergedConfig(
  config: unknown,
  configPath: string,
): MarketplaceConfigReference[] {
  if (!isRecord(config)) return [];
  const presetName = config.preset;
  if (typeof presetName !== 'string') return [];
  const presets = config.presets;
  if (!isRecord(presets)) return [];

  const references: MarketplaceConfigReference[] = [];
  const presetValue = presets[presetName];
  if (!isRecord(presetValue) || !isRecord(presetValue.marketplace)) return [];
  const marketplace = presetValue.marketplace;
  if (Array.isArray(marketplace.agents)) {
    for (const packageId of marketplace.agents) {
      addReference(references, packageId, configPath, presetName, 'agent');
    }
  }
  return references;
}

/** Read persisted references from both user and project plugin configs. */
export function readMarketplaceConfigReferences(
  directory: string,
): MarketplaceConfigReference[] {
  const paths = findPluginConfigPaths(directory);
  const configPath = paths.projectConfigPath ?? paths.userConfigPath;
  const config = loadPluginConfig(directory, { silent: true });
  return readReferencesFromMergedConfig(config, configPath ?? directory);
}
