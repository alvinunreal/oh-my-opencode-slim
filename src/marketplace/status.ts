import type { MarketplaceLivePackage } from '../agents/registry.js';
import { loadPluginConfig } from '../config/loader.js';
import type { ResolvedPluginConfig } from '../config/schema.js';
import type { MarketplaceStore, MarketplaceStoreInspection } from './store.js';

export interface MarketplaceRuntimeStatus {
  readonly desiredPackageIds: readonly string[];
  readonly verifications: readonly {
    readonly id: string;
    readonly version?: string;
    readonly valid: boolean;
    readonly expectedDigest?: string;
    readonly actualDigest?: string;
    readonly message: string;
  }[];
  readonly liveAvailable: boolean;
  readonly livePackages: readonly MarketplaceLivePackage[] | null;
  readonly reloadRequired: boolean | null;
  readonly lockfileError?: string;
  readonly operationalError?: string;
  readonly diagnostics: readonly string[];
}

export interface MarketplaceReloadRequest extends MarketplaceRuntimeStatus {
  readonly accepted: false;
  readonly reloadRequired: boolean | null;
  readonly message: string;
}

function textOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function readDesiredMarketplacePackageIds(
  directory: string,
  presetOverride?: string,
  hostFlavor?: string,
): readonly string[] {
  const config = loadPluginConfig(directory, { silent: true, hostFlavor });
  return resolveDesiredMarketplacePackageIds(config, presetOverride);
}

export function resolveDesiredMarketplacePackageIds(
  config: ResolvedPluginConfig,
  presetOverride?: string,
): readonly string[] {
  // loadPluginConfig applies a truthy environment override; runtime overrides
  // have priority but an empty one falls through exactly like startup.
  const presetName = presetOverride || config.preset;
  if (!presetName) return [];
  return [...(config.marketplacePresets?.[presetName]?.agents ?? [])].sort(
    textOrder,
  );
}

/** Read desired config and package verification without changing marketplace state. */
export function readMarketplaceRuntimeStatus(input: {
  readonly directory: string;
  readonly hostFlavor?: string;
  readonly store: Pick<MarketplaceStore, 'inspectAll'>;
  /** Reuse the service's single lease-consistent inspection when provided. */
  readonly inspection?: MarketplaceStoreInspection;
  /** Active in-memory preset override; omitted in standalone CLI contexts. */
  readonly presetOverride?: string;
  /** Selection computed from the same normalized config used for projection. */
  readonly desiredPackageIds?: readonly string[];
  readonly livePackages?: readonly MarketplaceLivePackage[];
  readonly desiredPackages?: readonly MarketplaceLivePackage[];
  readonly desiredConfigError?: string;
}): MarketplaceRuntimeStatus {
  const desiredPackageIds =
    input.desiredPackageIds ??
    readDesiredMarketplacePackageIds(
      input.directory,
      input.presetOverride,
      input.hostFlavor,
    );
  const inspection = input.inspection ?? input.store.inspectAll();
  const wanted = new Set(desiredPackageIds);
  const observedVerifications = new Map(
    inspection.verifications
      .filter(({ id }) => wanted.has(id))
      .map((verification) => [verification.id, verification]),
  );
  const verifications = desiredPackageIds.map(
    (id) =>
      observedVerifications.get(id) ?? {
        id,
        valid: false,
        message: inspection.lockfileError ?? `${id} is not installed`,
      },
  );
  const liveAvailable = input.livePackages !== undefined;
  const livePackages = input.livePackages
    ? [...input.livePackages].sort((left, right) =>
        textOrder(left.id, right.id),
      )
    : null;
  const diskPackages = new Map(
    inspection.packages
      .filter(({ manifest }) => wanted.has(manifest.id))
      .map((stored) => [stored.manifest.id, stored]),
  );
  const verificationById = new Map(
    verifications.map((item) => [item.id, item]),
  );
  const liveById = new Map((livePackages ?? []).map((item) => [item.id, item]));
  const desiredById = new Map(
    (input.desiredPackages ?? []).map((item) => [item.id, item]),
  );
  const diagnostics = [
    ...(inspection.lockfileError ? [inspection.lockfileError] : []),
    ...(inspection.operationalError ? [inspection.operationalError] : []),
    ...(input.desiredConfigError ? [input.desiredConfigError] : []),
  ];
  const packageDiagnostics: string[] = [];
  for (const id of desiredPackageIds) {
    const current = diskPackages.get(id);
    const verification = verificationById.get(id);
    const desired = desiredById.get(id);
    if (!current) {
      packageDiagnostics.push(
        `${id}: ${verification?.message ?? 'package is not installed'}`,
      );
    } else if (!verification?.valid) {
      packageDiagnostics.push(
        `${id}: ${verification?.message ?? 'package verification is unavailable'}`,
      );
    } else if (input.desiredPackages !== undefined && !desired) {
      packageDiagnostics.push(
        `${id}: package is not admitted to the desired marketplace registry`,
      );
    }
  }
  diagnostics.push(...packageDiagnostics);
  const packageStateIncomplete = packageDiagnostics.length > 0;
  const reloadRequired: boolean | null =
    !liveAvailable ||
    inspection.lockfileError ||
    inspection.operationalError ||
    input.desiredConfigError !== undefined ||
    input.desiredPackages === undefined ||
    packageStateIncomplete
      ? null
      : desiredPackageIds.length !== (livePackages?.length ?? 0) ||
        desiredPackageIds.some((id) => {
          const live = liveById.get(id);
          const current = diskPackages.get(id);
          const desired = desiredById.get(id);
          return (
            !live ||
            !current ||
            !desired ||
            live.version !== current.manifest.version ||
            live.digest !== current.digest ||
            live.configFingerprint !== desired.configFingerprint
          );
        });

  return {
    desiredPackageIds,
    verifications,
    liveAvailable,
    livePackages,
    reloadRequired,
    diagnostics,
    ...(inspection.lockfileError
      ? { lockfileError: inspection.lockfileError }
      : {}),
    ...(inspection.operationalError
      ? { operationalError: inspection.operationalError }
      : {}),
  };
}

/** Report the host action required; this deliberately never attempts a reload. */
export function requestMarketplaceReload(input: {
  readonly directory: string;
  readonly store: Pick<MarketplaceStore, 'inspectAll'>;
  readonly inspection?: MarketplaceStoreInspection;
  readonly presetOverride?: string;
  readonly desiredPackageIds?: readonly string[];
  readonly livePackages?: readonly MarketplaceLivePackage[];
  readonly desiredPackages?: readonly MarketplaceLivePackage[];
  readonly desiredConfigError?: string;
}): MarketplaceReloadRequest {
  const status = readMarketplaceRuntimeStatus(input);
  const packageDiagnostics = status.diagnostics.filter((diagnostic) =>
    status.desiredPackageIds.some((id) => diagnostic.startsWith(`${id}:`)),
  );
  const hasOtherDiagnostics = status.diagnostics.some(
    (diagnostic) => !packageDiagnostics.includes(diagnostic),
  );
  return {
    ...status,
    accepted: false,
    message:
      packageDiagnostics.length > 0 && !hasOtherDiagnostics
        ? `Selected marketplace packages are blocked; repair them before evaluating whether a host reload is required. Resolve the reported package diagnostics and check again; no reload was performed. ${status.diagnostics.join('; ')}`
        : status.diagnostics.length > 0
          ? `Marketplace status is incomplete, so whether a host reload is required is unknown. Resolve the reported marketplace/config diagnostics and check again; no reload was performed. ${status.diagnostics.join('; ')}`
          : status.liveAvailable
            ? status.reloadRequired
              ? 'A host reload is required to apply the desired marketplace state. Restart or reload OpenCode from the host; no reload was performed.'
              : status.reloadRequired === false
                ? 'The live marketplace snapshot already matches the desired state. No reload was performed.'
                : 'Whether a host reload is required is unknown. Restart or reload OpenCode from the host to apply the desired state; no reload was performed.'
            : 'The live marketplace snapshot is unavailable in this standalone context. Restart or reload OpenCode from the host to apply the desired state; no reload was performed.',
  };
}
