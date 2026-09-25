import { accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { mutateJsonFile } from '../cli/config-io';
import { findPluginConfigPaths, loadPluginConfig } from '../config/loader';
import { normalizePreset, resolvePresetDefinition } from '../config/presets';
import { MarketplaceActivationError } from './errors';
import { normalizeMarketplacePackageId } from './ids';
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
  id: string,
  enabled: boolean,
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
      const current = { ...asRecord(presets[presetName]) };
      const effectivePresets = effectiveConfig.presets ?? {};
      const effective = resolvePresetDefinition(presetName, effectivePresets);
      const active = normalizePackageIds(
        effective.marketplace?.agents ?? [],
      ).includes(id);
      const localMarketplace = asRecord(current.marketplace);
      const ownsAgents = Array.isArray(localMarketplace.agents);
      const replacement = ownsAgents
        ? normalizePackageIds(localMarketplace.agents as string[])
        : undefined;
      const additions = Array.isArray(localMarketplace.agents_add)
        ? normalizePackageIds(localMarketplace.agents_add as string[])
        : [];
      const removals = Array.isArray(localMarketplace.agents_remove)
        ? normalizePackageIds(localMarketplace.agents_remove as string[])
        : [];

      // A local replacement is authoritative. Without one, only persist the
      // delta: a parent (or a lower same-named config layer) remains live.
      const paths = findPluginConfigPaths(directory);
      const userPreset =
        paths.projectConfigPath && paths.userConfigPath
          ? loadPluginConfig(dirname(paths.userConfigPath), { silent: true })
              .presets?.[presetName]
          : undefined;
      const userAgents = userPreset
        ? (normalizePreset(userPreset).marketplace?.agents ?? [])
        : [];
      const parentName = effective.extends;
      const parentAgents = parentName
        ? (resolvePresetDefinition(parentName, effectivePresets).marketplace
            ?.agents ?? [])
        : [];
      const inherited =
        !ownsAgents &&
        normalizePackageIds(
          userPreset && normalizePreset(userPreset).marketplace
            ? userAgents
            : parentAgents,
        ).includes(id);

      const next = { ...localMarketplace };
      if (enabled) {
        if (active && !removals.includes(id)) throw NO_ACTIVATION_CHANGE;
        if (ownsAgents && !replacement?.includes(id)) {
          next.agents = [...(replacement ?? []), id];
        } else if (!ownsAgents && !inherited && !additions.includes(id)) {
          next.agents_add = [...additions, id];
        }
        if (removals.includes(id)) {
          next.agents_remove = removals.filter((value) => value !== id);
        }
      } else {
        if (!active && !additions.includes(id)) throw NO_ACTIVATION_CHANGE;
        if (ownsAgents && replacement?.includes(id)) {
          next.agents = replacement.filter((value) => value !== id);
        }
        if (additions.includes(id)) {
          next.agents_add = additions.filter((value) => value !== id);
        }
        if (
          (inherited || (ownsAgents && active && !replacement?.includes(id))) &&
          !removals.includes(id)
        ) {
          next.agents_remove = [...removals, id];
        }
      }
      if (JSON.stringify(next) === JSON.stringify(localMarketplace)) {
        throw NO_ACTIVATION_CHANGE;
      }
      current.marketplace = next;
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
  persistActivation(directory, id, true);
}

export function disableMarketplacePackage(
  directory: string,
  packageId: string,
): void {
  const id = normalizeMarketplacePackageId(packageId);
  persistActivation(directory, id, false);
}
