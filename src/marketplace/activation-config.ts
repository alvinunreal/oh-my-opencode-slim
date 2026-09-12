import { accessSync, constants } from 'node:fs';
import { mutateJsonFile } from '../cli/config-io';
import {
  findPluginConfigPaths,
  loadPluginConfig,
  loadPluginConfigFile,
  mergePreset,
} from '../config/loader';
import type {
  MarketplaceActivation,
  PluginConfig,
  Preset,
} from '../config/schema';
import { MarketplaceActivationError } from './errors';
import { normalizeMarketplacePackageId } from './ids';
import { assertMarketplacePackageNotRetired } from './retirements';
import { MarketplaceStore } from './store';

function writeConfigFile(
  filePath: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  mutateJsonFile(filePath, (current) => {
    const persisted =
      current && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};
    return mutate(persisted);
  });
}

function configWritePath(directory: string): string {
  const paths = findPluginConfigPaths(directory);
  const filePath = paths.projectConfigPath ?? paths.userConfigPath;
  if (!filePath) {
    throw new MarketplaceActivationError(
      'No plugin config file found to persist marketplace activation',
    );
  }
  return filePath;
}

function activePresetName(config: PluginConfig): string {
  if (typeof config.preset === 'string' && config.preset.length > 0) {
    return config.preset;
  }
  throw new MarketplaceActivationError(
    'Select an active preset before enabling marketplace packages',
  );
}

export function preflightMarketplaceAgentActivation(
  directory: string,
  packageId: string,
): void {
  const id = normalizeMarketplacePackageId(packageId);
  assertMarketplacePackageNotRetired(id);
  const config = loadPluginConfig(directory, { silent: true });
  const presetName = activePresetName(config);
  if (!config.presets?.[presetName]) {
    throw new MarketplaceActivationError(
      `Active preset '${presetName}' does not exist in the plugin config`,
    );
  }
  const filePath = configWritePath(directory);
  try {
    accessSync(filePath, constants.W_OK);
  } catch (error) {
    throw new MarketplaceActivationError(
      `Cannot write plugin config for marketplace activation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function cloneActivation(
  activation: MarketplaceActivation | undefined,
): MarketplaceActivation {
  return {
    ...(activation?.agents ? { agents: [...activation.agents] } : {}),
  };
}

function samePackageIds(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const a = [...(left ?? [])].map((id) => id.trim().toLowerCase()).sort();
  const b = [...(right ?? [])].map((id) => id.trim().toLowerCase()).sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function activationOverlay(
  parent: MarketplaceActivation | undefined,
  desired: MarketplaceActivation,
): MarketplaceActivation {
  const overlay: MarketplaceActivation = {};
  if (parent === undefined || !samePackageIds(parent.agents, desired.agents)) {
    overlay.agents = [...(desired.agents ?? [])];
  }
  return overlay;
}

function persistActivation(
  directory: string,
  presetName: string,
  mutate: (activation: MarketplaceActivation) => MarketplaceActivation,
): void {
  const paths = findPluginConfigPaths(directory);
  const filePath = configWritePath(directory);
  const parentConfig =
    filePath === paths.projectConfigPath && paths.userConfigPath
      ? (loadPluginConfigFile(paths.userConfigPath, { silent: true }) ?? {})
      : {};
  writeConfigFile(filePath, (persisted) => {
    const presets = {
      ...((persisted.presets as Record<string, unknown> | undefined) ?? {}),
    };
    const current = {
      ...((presets[presetName] as Record<string, unknown> | undefined) ?? {}),
    };
    const parentPreset = parentConfig.presets?.[presetName];
    const effective = mergePreset(parentPreset, current as Preset);
    const desired = mutate(cloneActivation(effective?.marketplace));
    const overlay = activationOverlay(parentPreset?.marketplace, desired);
    current.agents = current.agents ?? {};
    if (Object.keys(overlay).length === 0) {
      delete current.marketplace;
    } else {
      current.marketplace = overlay;
    }
    presets[presetName] = current;
    persisted.presets = presets;
    if (persisted.preset === undefined) persisted.preset = presetName;
    return persisted;
  });
}

export function enableMarketplaceAgent(
  directory: string,
  packageId: string,
  store = new MarketplaceStore(),
): void {
  const id = normalizeMarketplacePackageId(packageId);
  assertMarketplacePackageNotRetired(id);
  preflightMarketplaceAgentActivation(directory, id);
  store.show(id);
  const config = loadPluginConfig(directory, { silent: true });
  const presetName = activePresetName(config);
  persistActivation(directory, presetName, (activation) => {
    const agents = [...(activation.agents ?? [])];
    if (!agents.includes(id)) agents.push(id);
    return { agents };
  });
}

export function disableMarketplacePackage(
  directory: string,
  packageId: string,
): void {
  const id = normalizeMarketplacePackageId(packageId);
  const config = loadPluginConfig(directory, { silent: true });
  const presetName = activePresetName(config);
  persistActivation(directory, presetName, (activation) => ({
    agents: (activation.agents ?? []).filter((value) => value !== id),
  }));
}
