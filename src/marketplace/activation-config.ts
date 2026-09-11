import { mutateJsonFile } from '../cli/config-io';
import {
  type SpecialistRole,
  SUPPORTED_SPECIALIST_ROLES,
} from '../config/agent-roles';
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

function cloneActivation(
  activation: MarketplaceActivation | undefined,
): MarketplaceActivation {
  return {
    ...(activation?.agents ? { agents: [...activation.agents] } : {}),
    ...(activation?.profiles ? { profiles: { ...activation.profiles } } : {}),
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
  const parentProfiles = parent?.profiles ?? {};
  const desiredProfiles = desired.profiles ?? {};
  const profiles: NonNullable<MarketplaceActivation['profiles']> = {
    ...parentProfiles,
  };
  let profilesChanged = false;
  for (const key of new Set([
    ...Object.keys(parentProfiles),
    ...Object.keys(desiredProfiles),
  ])) {
    const role = key as SpecialistRole;
    const next = Object.hasOwn(desiredProfiles, key)
      ? desiredProfiles[role]
      : undefined;
    const previous = parentProfiles[role];
    if (next !== previous) {
      profiles[role] = next ?? null;
      profilesChanged = true;
    }
  }
  if (profilesChanged) overlay.profiles = profiles;
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
  const pkg = store.show(id);
  if (pkg.manifest.kind !== 'agent') {
    throw new MarketplaceActivationError(
      `${id} is a ${pkg.manifest.kind} package; use profile to activate it`,
    );
  }
  const config = loadPluginConfig(directory, { silent: true });
  const presetName = activePresetName(config);
  persistActivation(directory, presetName, (activation) => {
    const agents = [...(activation.agents ?? [])];
    if (!agents.includes(id)) agents.push(id);
    const profiles = { ...(activation.profiles ?? {}) };
    for (const [role, value] of Object.entries(profiles)) {
      if (value === id) {
        throw new MarketplaceActivationError(
          `${id} is already selected as the ${role} profile`,
        );
      }
    }
    return { agents, profiles };
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
    profiles: Object.fromEntries(
      Object.entries(activation.profiles ?? {}).map(([role, value]) => [
        role,
        value === id ? null : value,
      ]),
    ),
  }));
}

export function setMarketplaceProfile(
  directory: string,
  role: string,
  packageId: string | null,
  store = new MarketplaceStore(),
): void {
  const parsedRole = SUPPORTED_SPECIALIST_ROLES.find((name) => name === role);
  if (!parsedRole) {
    throw new MarketplaceActivationError(
      `Unsupported profile target '${role}'`,
    );
  }
  const config = loadPluginConfig(directory, { silent: true });
  const presetName = activePresetName(config);
  if (packageId === null) {
    persistActivation(directory, presetName, (activation) => ({
      agents: [...(activation.agents ?? [])],
      profiles: { ...(activation.profiles ?? {}), [parsedRole]: null },
    }));
    return;
  }
  const id = normalizeMarketplacePackageId(packageId);
  assertMarketplacePackageNotRetired(id);
  const pkg = store.show(id);
  if (pkg.manifest.kind !== 'profile') {
    throw new MarketplaceActivationError(
      `${id} is a ${pkg.manifest.kind} package; use enable to activate it`,
    );
  }
  if (pkg.manifest.targetRole !== parsedRole) {
    throw new MarketplaceActivationError(
      `${id} targets ${pkg.manifest.targetRole}, not ${parsedRole}`,
    );
  }
  persistActivation(directory, presetName, (activation) => {
    const agents = [...(activation.agents ?? [])];
    if (agents.includes(id)) {
      throw new MarketplaceActivationError(
        `${id} is already enabled as a marketplace agent`,
      );
    }
    return {
      agents,
      profiles: { ...(activation.profiles ?? {}), [parsedRole]: id },
    };
  });
}

export type { SpecialistRole };
