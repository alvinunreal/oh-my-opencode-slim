import { accessSync, constants } from 'node:fs';
import { mutateJsonFile } from '../cli/config-io';
import { findPluginConfigPaths, loadPluginConfig } from '../config/loader';
import { resolvePresetDefinition } from '../config/presets';
import { MarketplaceActivationError } from './errors';
import { normalizeMarketplacePackageId } from './ids';
import { MarketplaceStore } from './store';

type MarketplaceActivation = { agents?: string[] };

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

function activePresetName(config: { preset?: string }): string {
  if (typeof config.preset === 'string' && config.preset.length > 0) {
    return config.preset;
  }
  throw new MarketplaceActivationError(
    'Select an active preset before enabling marketplace packages',
  );
}

export function preflightMarketplaceAgentActivation(directory: string): void {
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
    ...(activation?.agents
      ? { agents: normalizePackageIds(activation.agents) }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePackageIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(normalizeMarketplacePackageId))];
}

const NO_ACTIVATION_CHANGE = Symbol('no-marketplace-activation-change');

function persistActivation(
  directory: string,
  mutate: (activation: MarketplaceActivation) => MarketplaceActivation,
): void {
  const filePath = configWritePath(directory);
  try {
    writeConfigFile(filePath, (persisted) => {
      // Read all config layers while the mutation lease is held. A preceding
      // writer's activation is therefore part of this writer's baseline.
      const effectiveConfig = loadPluginConfig(directory, { silent: true });
      const presetName = activePresetName(effectiveConfig);
      const presets = asRecord(persisted.presets) as Record<
        string,
        Record<string, unknown>
      >;
      const current = { ...(presets[presetName] ?? {}) };
      const effectivePresets = effectiveConfig.presets ?? {};
      const effective = resolvePresetDefinition(
        presetName,
        effectivePresets,
      ).marketplace;
      const desired = mutate(cloneActivation(effective));
      const currentIds = normalizePackageIds(effective?.agents ?? []).sort();
      const desiredIds = normalizePackageIds(desired.agents ?? []).sort();
      if (
        currentIds.length === desiredIds.length &&
        currentIds.every((id, index) => id === desiredIds[index])
      ) {
        throw NO_ACTIVATION_CHANGE;
      }

      const localMarketplace = asRecord(current.marketplace);
      current.marketplace = {
        ...localMarketplace,
        agents: normalizePackageIds(desired.agents ?? []),
      };
      presets[presetName] = current;
      persisted.presets = presets;
      return persisted;
    });
  } catch (error) {
    if (error !== NO_ACTIVATION_CHANGE) throw error;
  }
}

export function enableMarketplaceAgent(
  directory: string,
  packageId: string,
  store = new MarketplaceStore(),
): void {
  const id = normalizeMarketplacePackageId(packageId);
  preflightMarketplaceAgentActivation(directory);
  store.show(id);
  persistActivation(directory, (activation) => {
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
  persistActivation(directory, (activation) => ({
    agents: (activation.agents ?? []).filter((value) => value !== id),
  }));
}
