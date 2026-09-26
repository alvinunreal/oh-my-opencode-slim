import { accessSync, constants, readFileSync } from 'node:fs';
import { mutateJsonFile, stripJsonComments } from '../cli/config-io';
import {
  findPluginConfigPaths,
  interpolateEnvironmentVariables,
  loadPluginConfig,
} from '../config/loader';
import {
  mergePresetMaps,
  normalizePreset,
  resolvePresetDefinition,
} from '../config/presets';
import type { PresetInput } from '../config/schema';
import { PresetAgentsSchema } from '../config/schema';
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
    return interpolateEnvironmentVariables(value);
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

function interpolateDirectiveValues(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{env:([^}]+)\}/g, (_match, name: string) => {
      if (process.env[name] === undefined) {
        throw new MarketplaceActivationError(
          `Cannot update marketplace activation: environment variable '${name}' is not set`,
        );
      }
      return interpolateEnvironmentVariables(`{env:${name}}`);
    });
  }
  if (Array.isArray(value)) return value.map(interpolateDirectiveValues);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        interpolateDirectiveValues(entry),
      ]),
    );
  }
  return value;
}

function normalizeDirectiveIds(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new MarketplaceActivationError(
      `Cannot update marketplace activation: marketplace.${field} must be an array of package IDs`,
    );
  }
  try {
    return (value as string[]).map(normalizeMarketplacePackageId);
  } catch (error) {
    throw new MarketplaceActivationError(
      `Cannot update marketplace activation: invalid marketplace.${field} package ID (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function withoutPackage(
  raw: readonly string[],
  resolved: readonly string[],
  id: string,
): string[] {
  return raw.filter((_, index) => resolved[index] !== id);
}

function assertDirectiveEnvironmentIsSet(value: unknown): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{env:([^}]+)\}/g)) {
      const name = match[1];
      if (name && process.env[name] === undefined) {
        throw new MarketplaceActivationError(
          `Cannot update marketplace activation: environment variable '${name}' is not set`,
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertDirectiveEnvironmentIsSet(entry);
  }
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
      const rawPresetName =
        process.env.OH_MY_OPENCODE_SLIM_PRESET ?? persisted.preset;
      if (typeof rawPresetName === 'string') {
        const rawPreset = asRecord(asRecord(persisted.presets)[rawPresetName]);
        const rawMarketplace = asRecord(rawPreset.marketplace);
        for (const key of ['agents', 'agents_add', 'agents_remove']) {
          assertDirectiveEnvironmentIsSet(rawMarketplace[key]);
        }
        const resolvedMarketplace = interpolateDirectiveValues(
          rawMarketplace,
        ) as ConfigRecord;
        for (const key of ['agents', 'agents_add', 'agents_remove']) {
          if (Object.hasOwn(rawMarketplace, key)) {
            normalizeDirectiveIds(resolvedMarketplace[key], key);
          }
        }
      }
      const effectiveConfig = loadPluginConfig(directory, { silent: true });
      const presetName = activePresetName(effectiveConfig);
      if (!effectiveConfig.presets?.[presetName]) {
        throw new MarketplaceActivationError(
          `Active preset '${presetName}' does not exist in the plugin config`,
        );
      }
      const presets = asRecord(persisted.presets);
      let currentPreset = { ...asRecord(presets[presetName]) };
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
      const presetAgents = PresetAgentsSchema.safeParse(currentPreset.agents);
      const localMarketplaceValue = currentPreset.marketplace;
      const isExplicitActivation =
        localMarketplaceValue !== null &&
        typeof localMarketplaceValue === 'object' &&
        !Array.isArray(localMarketplaceValue) &&
        ['agents', 'agents_add', 'agents_remove'].some((key) =>
          Object.hasOwn(asRecord(localMarketplaceValue), key),
        );
      const marketplaceAgentOverride =
        !presetAgents.success &&
        !isExplicitActivation &&
        localMarketplaceValue !== null &&
        typeof localMarketplaceValue === 'object' &&
        !Array.isArray(localMarketplaceValue);
      if (marketplaceAgentOverride) {
        const { marketplace, extends: parent, ...flatAgents } = currentPreset;
        currentPreset = {
          ...(parent === undefined ? {} : { extends: parent }),
          agents: { ...flatAgents, marketplace },
        };
      }
      const localMarketplace = marketplaceAgentOverride
        ? {}
        : asRecord(currentPreset.marketplace);
      const resolvedLocalMarketplace = interpolateDirectiveValues(
        localMarketplace,
      ) as ConfigRecord;
      const ownsAgents = Array.isArray(localMarketplace.agents);
      const rawReplacement = ownsAgents
        ? (localMarketplace.agents as string[])
        : [];
      const replacement = ownsAgents
        ? normalizeDirectiveIds(resolvedLocalMarketplace.agents, 'agents')
        : undefined;
      const rawAdditions = Array.isArray(localMarketplace.agents_add)
        ? (localMarketplace.agents_add as string[])
        : [];
      const additions = normalizeDirectiveIds(
        resolvedLocalMarketplace.agents_add,
        'agents_add',
      );
      const rawRemovals = Array.isArray(localMarketplace.agents_remove)
        ? (localMarketplace.agents_remove as string[])
        : [];
      const removals = normalizeDirectiveIds(
        resolvedLocalMarketplace.agents_remove,
        'agents_remove',
      );

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
        if (
          !active &&
          inherited &&
          Array.isArray(localMarketplace.agents_add) &&
          additions.length === 0
        ) {
          // An explicit empty array masks lower-layer additions. Drop only
          // that mask so the inherited package becomes active again.
          delete next.agents_add;
        }
        if (ownsAgents && !replacement?.includes(id)) {
          next.agents = [...rawReplacement, id];
        } else if (!ownsAgents && !inherited && !additions.includes(id)) {
          next.agents_add = [...rawAdditions, id];
        }
        if (removals.includes(id)) {
          next.agents_remove = withoutPackage(rawRemovals, removals, id);
        }
      } else {
        if (!active && !additions.includes(id)) throw NO_ACTIVATION_CHANGE;
        if (ownsAgents && replacement?.includes(id)) {
          next.agents = withoutPackage(rawReplacement, replacement, id);
        }
        if (additions.includes(id)) {
          const remaining = withoutPackage(rawAdditions, additions, id);
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
          next.agents_remove = [...rawRemovals, id];
        } else if (
          active &&
          !inherited &&
          !ownsAgents &&
          Array.isArray(localMarketplace.agents_remove) &&
          removals.length === 0
        ) {
          // An explicit empty array can mask a lower-layer removal. Removing
          // the mask restores that lower-layer state without a new directive.
          delete next.agents_remove;
        }
      }
      if (JSON.stringify(next) === JSON.stringify(localMarketplace)) {
        throw NO_ACTIVATION_CHANGE;
      }
      if (Object.keys(next).length > 0) {
        currentPreset.marketplace = next;
      } else {
        delete currentPreset.marketplace;
      }
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
