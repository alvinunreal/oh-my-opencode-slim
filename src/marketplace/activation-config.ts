import { accessSync, constants, readFileSync } from 'node:fs';
import { mutateJsonFile, stripJsonComments } from '../cli/config-io';
import { findPluginConfigPaths, loadPluginConfig } from '../config/loader';
import {
  mergePresetMaps,
  normalizePreset,
  resolvePresetDefinition,
} from '../config/presets';
import type { PresetInput } from '../config/schema';
import { MarketplaceActivationError } from './errors';
import { normalizeMarketplacePackageId } from './ids';
import type { MarketplaceStore } from './store';

type MarketplaceStoreReader = Pick<MarketplaceStore, 'show'>;
type ConfigRecord = Record<string, unknown>;

function asRecord(value: unknown): ConfigRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ConfigRecord)
    : {};
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

function normalizePackageIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(normalizeMarketplacePackageId))];
}

function interpolateEnvironment(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\{env:([^}]+)\}/g,
      (_match, name: string) => process.env[name] ?? '',
    );
  }
  if (Array.isArray(value)) return value.map(interpolateEnvironment);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        interpolateEnvironment(entry),
      ]),
    );
  }
  return value;
}

function readPluginConfig(filePath: string | null): ConfigRecord {
  if (!filePath) return {};
  try {
    const source = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return asRecord(
      interpolateEnvironment(JSON.parse(stripJsonComments(source))),
    );
  } catch {
    return {};
  }
}

const NO_ACTIVATION_CHANGE = Symbol('no-marketplace-activation-change');

function persistActivation(
  directory: string,
  id: string,
  enabled: boolean,
): void {
  const filePath = configWritePath(directory);
  try {
    mutateJsonFile(filePath, (current) => {
      const persisted = { ...current };
      // The effective config is read inside mutateJsonFile's cross-process
      // lease, so a preceding writer's changes are part of this mutation.
      const effectiveConfig = loadPluginConfig(directory, { silent: true });
      const presetName = activePresetName(effectiveConfig);
      if (!effectiveConfig.presets?.[presetName]) {
        throw new MarketplaceActivationError(
          `Active preset '${presetName}' does not exist in the plugin config`,
        );
      }
      const presets = asRecord(persisted.presets);
      const currentPreset = { ...asRecord(presets[presetName]) };
      const paths = findPluginConfigPaths(directory);
      const writesProjectConfig =
        paths.projectConfigPath === filePath &&
        paths.projectConfigPath !== paths.userConfigPath;
      const userConfig = readPluginConfig(paths.userConfigPath);
      const userPresets = asRecord(userConfig.presets) as Record<
        string,
        PresetInput
      >;
      const projectPresets = asRecord(
        interpolateEnvironment(persisted.presets),
      ) as Record<string, PresetInput>;
      const effectivePresets = writesProjectConfig
        ? (mergePresetMaps(userPresets, projectPresets) ?? {})
        : projectPresets;
      const effective = resolvePresetDefinition(presetName, effectivePresets);
      const active = normalizePackageIds(
        effective.marketplace?.agents ?? [],
      ).includes(id);
      const localMarketplace = asRecord(currentPreset.marketplace);
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

      // Remove this file's directives to determine whether the package comes
      // from an inherited/lower layer. This preserves future parent additions.
      const baselinePreset = { ...currentPreset };
      const baselineMarketplace = { ...localMarketplace };
      delete baselineMarketplace.agents_add;
      delete baselineMarketplace.agents_remove;
      if (Object.keys(baselineMarketplace).length > 0) {
        baselinePreset.marketplace = baselineMarketplace;
      } else {
        delete baselinePreset.marketplace;
      }
      const baselineDefinition = writesProjectConfig
        ? mergePresetMaps(userPresets, {
            [presetName]: baselinePreset as PresetInput,
          })?.[presetName]
        : (baselinePreset as PresetInput);
      const inheritedPresets = {
        ...effectivePresets,
        [presetName]: {
          ...asRecord(baselineDefinition),
          ...(effective.extends ? { extends: effective.extends } : {}),
        } as PresetInput,
      };
      const inherited =
        !ownsAgents &&
        normalizePackageIds(
          resolvePresetDefinition(presetName, inheritedPresets).marketplace
            ?.agents ?? [],
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
          const remaining = additions.filter((value) => value !== id);
          const lowerPreset = writesProjectConfig
            ? (userPresets[presetName] as PresetInput | undefined)
            : undefined;
          if (
            remaining.length === 0 &&
            lowerPreset &&
            normalizePreset(lowerPreset).marketplace?.agents_add?.length
          ) {
            delete next.agents_add;
          } else {
            next.agents_add = remaining;
          }
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
      currentPreset.marketplace = next;
      presets[presetName] = currentPreset;
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
  store: MarketplaceStoreReader,
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
