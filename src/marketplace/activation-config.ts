import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mutateJsonFile } from '../config/json-file';
import {
  findPluginConfigPaths,
  interpolateEnvironmentVariables,
  isProjectConfigDisabled,
  loadPluginConfig,
  loadPluginConfigFromPath,
} from '../config/loader';
import { getConfigSearchDirs } from '../config/paths';
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
export type MarketplaceActivationScope = 'project' | 'user';

function asRecord(value: unknown): ConfigRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ConfigRecord)
    : {};
}

function configWritePath(
  directory: string,
  scope: MarketplaceActivationScope,
): string {
  if (scope === 'project' && isProjectConfigDisabled()) {
    throw new MarketplaceActivationError(
      'Cannot update project activation: OPENCODE_DISABLE_PROJECT_CONFIG disables project configuration. Unset it or use user scope.',
    );
  }
  const paths = findPluginConfigPaths(directory);
  if (scope === 'project') {
    return (
      paths.projectConfigPath ??
      join(directory, '.opencode', 'oh-my-opencode-slim.jsonc')
    );
  }
  return (
    paths.userConfigPath ??
    join(getConfigSearchDirs()[0] ?? '', 'oh-my-opencode-slim.jsonc')
  );
}

function activePresetName(
  config: { preset?: unknown },
  presetOverride?: string,
): string {
  const presetName =
    presetOverride || process.env.OH_MY_OPENCODE_SLIM_PRESET || config.preset;
  if (typeof presetName === 'string' && presetName.length > 0) {
    return presetName;
  }
  throw new MarketplaceActivationError(
    'Select an active preset before enabling marketplace packages',
  );
}

function loadScopeConfig(
  directory: string,
  scope: MarketplaceActivationScope,
  filePath: string,
  hostFlavor?: string,
): ConfigRecord {
  if (scope === 'project') {
    return asRecord(loadPluginConfig(directory, { silent: true, hostFlavor }));
  }
  return readPluginConfig(filePath);
}

export function preflightMarketplaceAgentActivation(
  directory: string,
  scope: MarketplaceActivationScope = 'project',
  presetOverride?: string,
  hostFlavor?: string,
): void {
  const filePath = configWritePath(directory, scope);
  const config = loadScopeConfig(directory, scope, filePath, hostFlavor);
  const presetName = activePresetName(config, presetOverride);
  if (!asRecord(config.presets)[presetName]) {
    throw new MarketplaceActivationError(
      `Active preset '${presetName}' does not exist in the plugin config`,
    );
  }
  if (existsSync(filePath)) {
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
  return asRecord(
    loadPluginConfigFromPath(filePath, { silent: true }) ?? undefined,
  );
}

const NO_ACTIVATION_CHANGE = Symbol('no-marketplace-activation-change');

function persistActivation(
  directory: string,
  id: string,
  enabled: boolean,
  scope: MarketplaceActivationScope,
  presetOverride: string | undefined,
  store?: MarketplaceStoreReader,
  hostFlavor?: string,
): void {
  const filePath = configWritePath(directory, scope);
  try {
    mutateJsonFile(filePath, (current) => {
      const persisted = { ...current };
      if (enabled) {
        if (!store) {
          throw new Error('Marketplace store is required to enable a package');
        }
        // mutateJsonFile holds the config lease here. Keep lock ordering
        // config → store so removal and activation cannot cross-check stale
        // package state.
        store.show(id);
      }
      // The effective config is read inside mutateJsonFile's cross-process
      // lease, so a preceding writer's changes are part of this mutation.
      const rawPresetName =
        presetOverride ||
        process.env.OH_MY_OPENCODE_SLIM_PRESET ||
        persisted.preset;
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
      const effectiveConfig = loadScopeConfig(
        directory,
        scope,
        filePath,
        hostFlavor,
      );
      const presetName = activePresetName(effectiveConfig, presetOverride);
      if (!asRecord(effectiveConfig.presets)[presetName]) {
        throw new MarketplaceActivationError(
          `Active preset '${presetName}' does not exist in the plugin config`,
        );
      }
      const presets = asRecord(persisted.presets);
      let currentPreset = { ...asRecord(presets[presetName]) };
      const paths = findPluginConfigPaths(directory, hostFlavor);
      const writesProjectConfig = scope === 'project';
      const userConfig =
        scope === 'project' ? readPluginConfig(paths.userConfigPath) : {};
      let basePresets = asRecord(userConfig.presets) as Record<
        string,
        PresetInput
      >;
      if (writesProjectConfig) {
        for (const configPath of paths.projectConfigPaths) {
          if (configPath === filePath) continue;
          const ancestorPresets = asRecord(
            readPluginConfig(configPath).presets,
          ) as Record<string, PresetInput>;
          basePresets = mergePresetMaps(basePresets, ancestorPresets) ?? {};
        }
      }
      const projectPresets = asRecord(
        interpolateEnvironment(persisted.presets),
      ) as Record<string, PresetInput>;
      const effectivePresets = writesProjectConfig
        ? (mergePresetMaps(basePresets, projectPresets) ?? {})
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

      // Remove this file's activation directives to determine whether the
      // package remains active from a parent/lower scope. This is evaluated
      // against the selected scope's actual lower layers.
      const baselinePreset = { ...currentPreset };
      const baselineMarketplace = { ...localMarketplace };
      delete baselineMarketplace.agents;
      delete baselineMarketplace.agents_add;
      delete baselineMarketplace.agents_remove;
      if (Object.keys(baselineMarketplace).length > 0) {
        baselinePreset.marketplace = baselineMarketplace;
      } else {
        delete baselinePreset.marketplace;
      }
      const baselineDefinition = writesProjectConfig
        ? mergePresetMaps(basePresets, {
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
      const inherited = normalizePackageIds(
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
            ? (basePresets[presetName] as PresetInput | undefined)
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
        if (inherited && !removals.includes(id)) {
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
  scope: MarketplaceActivationScope = 'project',
  presetOverride?: string,
  hostFlavor?: string,
): void {
  const id = normalizeMarketplacePackageId(packageId);
  preflightMarketplaceAgentActivation(
    directory,
    scope,
    presetOverride,
    hostFlavor,
  );
  persistActivation(
    directory,
    id,
    true,
    scope,
    presetOverride,
    store,
    hostFlavor,
  );
}

export function disableMarketplacePackage(
  directory: string,
  packageId: string,
  scope: MarketplaceActivationScope = 'project',
  presetOverride?: string,
  hostFlavor?: string,
): void {
  const id = normalizeMarketplacePackageId(packageId);
  persistActivation(
    directory,
    id,
    false,
    scope,
    presetOverride,
    undefined,
    hostFlavor,
  );
}
