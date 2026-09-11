import { loadPluginConfig } from '../config/loader';
import type { MarketplaceActivation } from '../config/schema';
import type { MarketplaceDiagnostic } from './activation';
import { MarketplaceLockfileError } from './errors';
import type { MarketplaceService } from './service';
import type {
  MarketplaceStoreInspection,
  StoredMarketplacePackage,
} from './store';

export const MARKETPLACE_RELOAD_NOTICE =
  'Applies after OpenCode reload or a new session. The live agent registry is not hot-swapped.';

export type MarketplaceReloadRequired = boolean | 'unknown';
export type MarketplaceDiagnosticProvenance = 'disk' | 'live';

export interface MarketplaceLivePackage {
  packageId: string;
  version: string;
  digest: string;
  runtimeName: string;
  kind: 'agent' | 'profile';
}

export interface MarketplaceLiveSnapshot {
  packages: readonly MarketplaceLivePackage[];
  diagnostics?: readonly MarketplaceDiagnostic[];
}

export interface MarketplaceInstalledSummary {
  id: string;
  version?: string;
  kind?: 'agent' | 'profile';
  displayName?: string;
  role?: string;
  digest?: string;
  valid: boolean;
}

export interface MarketplaceStatusDiagnostic extends MarketplaceDiagnostic {
  provenance: MarketplaceDiagnosticProvenance;
}

export interface MarketplaceStatusReport {
  installed: MarketplaceInstalledSummary[];
  configured: {
    preset?: string;
    agents: string[];
    profiles: Record<string, string | null>;
  };
  live?: {
    packages: MarketplaceLivePackage[];
    diagnostics: MarketplaceStatusDiagnostic[];
  };
  diagnostics: MarketplaceStatusDiagnostic[];
  reloadRequired: MarketplaceReloadRequired;
  note: string;
}

export interface CollectMarketplaceStatusOptions {
  service: MarketplaceService;
  projectDir: string;
  live?: MarketplaceLiveSnapshot;
  desiredLive?: MarketplaceLiveSnapshot;
}

function packageRole(pkg: StoredMarketplacePackage): string {
  return pkg.manifest.kind === 'agent'
    ? pkg.manifest.baseRole
    : pkg.manifest.targetRole;
}

function summarize(pkg: StoredMarketplacePackage): MarketplaceInstalledSummary {
  return {
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    kind: pkg.manifest.kind,
    displayName: pkg.manifest.displayName,
    role: packageRole(pkg),
    digest: pkg.digest,
    valid: true,
  };
}

function configuredIds(
  activation: MarketplaceActivation | undefined,
): string[] {
  const agents = activation?.agents ?? [];
  const profiles = Object.values(activation?.profiles ?? {}).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return [...new Set([...agents, ...profiles])];
}

function identityKey(entry: {
  packageId: string;
  version: string;
  digest: string;
  runtimeName: string;
}): string {
  return `${entry.packageId}@${entry.version}#${entry.digest}->${entry.runtimeName}`;
}

function sameIdentitySet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function uniqueLabeled(
  diagnostics: readonly MarketplaceStatusDiagnostic[],
): MarketplaceStatusDiagnostic[] {
  const labeled: MarketplaceStatusDiagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const key = diagnosticClassKey(diagnostic, diagnostic.provenance);
    if (seen.has(key)) continue;
    seen.add(key);
    labeled.push(diagnostic);
  }
  return labeled;
}

function labelDisk(
  diagnostic: MarketplaceDiagnostic,
): MarketplaceStatusDiagnostic {
  return { ...diagnostic, provenance: 'disk' };
}

function labelLive(
  diagnostic: MarketplaceDiagnostic,
): MarketplaceStatusDiagnostic {
  return { ...diagnostic, provenance: 'live' };
}

function diagnosticClassKey(
  diagnostic: Pick<MarketplaceDiagnostic, 'packageId' | 'code'>,
  provenance: MarketplaceDiagnosticProvenance,
): string {
  return `${diagnostic.packageId}\0${diagnostic.code}\0${provenance}`;
}

function mergeDiagnostics(
  disk: readonly MarketplaceDiagnostic[],
  live: readonly MarketplaceDiagnostic[],
): MarketplaceStatusDiagnostic[] {
  const labeled: MarketplaceStatusDiagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of disk) {
    const key = diagnosticClassKey(diagnostic, 'disk');
    if (seen.has(key)) continue;
    seen.add(key);
    labeled.push(labelDisk(diagnostic));
  }
  for (const diagnostic of live) {
    const key = diagnosticClassKey(diagnostic, 'live');
    if (seen.has(key)) continue;
    seen.add(key);
    labeled.push(labelLive(diagnostic));
  }
  return labeled;
}

function inspectionDiagnostics(
  inspection: MarketplaceStoreInspection,
  pendingIds: readonly string[],
  installedIds: ReadonlySet<string>,
): MarketplaceDiagnostic[] {
  const diagnostics: MarketplaceDiagnostic[] = [];
  if (inspection.operationalError) {
    diagnostics.push({
      packageId: '(store)',
      code: 'operational',
      message: inspection.operationalError,
    });
  }
  if (inspection.lockfileError) {
    diagnostics.push({
      packageId: '(store)',
      code: 'corrupt',
      message: inspection.lockfileError,
    });
  }
  for (const id of pendingIds) {
    if (installedIds.has(id)) continue;
    const verification = inspection.verifications.find(
      (entry) => entry.id === id,
    );
    if (verification && !verification.valid) {
      diagnostics.push({
        packageId: id,
        code: 'corrupt',
        message: verification.message,
      });
      continue;
    }
    diagnostics.push({
      packageId: id,
      code: 'missing',
      message: `${id} is configured but not installed`,
    });
  }
  for (const verification of inspection.verifications) {
    if (verification.valid) continue;
    if (pendingIds.includes(verification.id)) continue;
    diagnostics.push({
      packageId: verification.id,
      code: 'corrupt',
      message: verification.message,
    });
  }
  return diagnostics;
}

export function collectMarketplaceStatus(
  options: CollectMarketplaceStatusOptions,
): MarketplaceStatusReport {
  let inspection: MarketplaceStoreInspection;
  try {
    inspection = options.service.store.inspectAll();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    inspection = {
      packages: [],
      verifications: [],
      ...(error instanceof MarketplaceLockfileError
        ? { lockfileError: message }
        : { operationalError: message }),
    };
  }
  const installedIds = new Set(
    inspection.packages.map((pkg) => pkg.manifest.id),
  );
  const config = loadPluginConfig(options.projectDir, { silent: true });
  const preset =
    typeof config.preset === 'string' && config.preset.length > 0
      ? config.preset
      : undefined;
  const activation = preset ? config.presets?.[preset]?.marketplace : undefined;
  const pendingIds = configuredIds(activation);
  const desiredDiagnostics = options.desiredLive?.diagnostics ?? [];
  const disk = [
    ...inspectionDiagnostics(inspection, pendingIds, installedIds),
    ...desiredDiagnostics,
  ];
  const liveDiagnostics = options.live?.diagnostics ?? [];
  const installed: MarketplaceInstalledSummary[] = [
    ...inspection.packages.map(summarize),
    ...inspection.verifications
      .filter((entry) => !entry.valid)
      .map((entry) => ({
        id: entry.id,
        version: entry.version,
        digest: entry.expectedDigest,
        valid: false,
      })),
  ];
  const livePackages = options.live ? [...options.live.packages] : undefined;
  const operational =
    Boolean(inspection.operationalError) ||
    desiredDiagnostics.some((entry) => entry.code === 'operational');
  const reloadRequired: MarketplaceReloadRequired =
    operational || !options.live || !options.desiredLive
      ? 'unknown'
      : !sameIdentitySet(
          options.desiredLive.packages.map(identityKey),
          options.live.packages.map(identityKey),
        );
  return {
    installed,
    configured: {
      ...(preset ? { preset } : {}),
      agents: [...(activation?.agents ?? [])],
      profiles: { ...(activation?.profiles ?? {}) },
    },
    ...(livePackages
      ? {
          live: {
            packages: livePackages,
            diagnostics: uniqueLabeled(liveDiagnostics.map(labelLive)),
          },
        }
      : {}),
    diagnostics: mergeDiagnostics(disk, liveDiagnostics),
    reloadRequired,
    note: reloadRequired === false ? '' : MARKETPLACE_RELOAD_NOTICE,
  };
}

export function formatMarketplaceStatus(
  report: MarketplaceStatusReport,
): string {
  const lines = [
    `preset: ${report.configured.preset ?? '(none)'}`,
    `reload_required: ${report.reloadRequired}`,
  ];
  if (report.note) lines.push(`note: ${report.note}`);
  lines.push('', 'installed:');
  if (report.installed.length === 0) {
    lines.push('  (none)');
  } else {
    for (const pkg of report.installed) {
      const version = pkg.version ? `@${pkg.version}` : '';
      const kind = pkg.kind ? ` ${pkg.kind}` : '';
      const role = pkg.role ? ` ${pkg.role}` : '';
      const name = pkg.displayName ? ` ${pkg.displayName}` : '';
      const valid = pkg.valid ? '' : ' corrupt';
      lines.push(`  ${pkg.id}${version}${kind}${role}${name}${valid}`);
    }
  }
  lines.push('', 'configured_agents:');
  if (report.configured.agents.length === 0) {
    lines.push('  (none)');
  } else {
    for (const id of report.configured.agents) lines.push(`  ${id}`);
  }
  lines.push('', 'configured_profiles:');
  const profileEntries = Object.entries(report.configured.profiles);
  if (profileEntries.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [role, packageId] of profileEntries) {
      lines.push(`  ${role}: ${packageId ?? '(cleared)'}`);
    }
  }
  if (report.live) {
    lines.push('', 'live_packages:');
    if (report.live.packages.length === 0) {
      lines.push('  (none)');
    } else {
      for (const entry of report.live.packages) {
        lines.push(
          `  ${entry.packageId}@${entry.version} ${entry.kind} ${entry.runtimeName}`,
        );
      }
    }
  }
  lines.push('', 'diagnostics:');
  if (report.diagnostics.length === 0) {
    lines.push('  (none)');
  } else {
    for (const diagnostic of report.diagnostics) {
      lines.push(
        `  ${diagnostic.provenance} ${diagnostic.packageId} ${diagnostic.code}: ${diagnostic.message}`,
      );
    }
  }
  return lines.join('\n');
}

export function mutationReloadNotice(
  message: string,
  reloadRequired: MarketplaceReloadRequired,
): string {
  const lines = [message, `reload_required: ${reloadRequired}`];
  if (reloadRequired !== false) lines.push(MARKETPLACE_RELOAD_NOTICE);
  return lines.join('\n');
}

export function reloadRequiredAfterMutation(
  options: CollectMarketplaceStatusOptions,
): MarketplaceReloadRequired {
  return collectMarketplaceStatus(options).reloadRequired;
}
