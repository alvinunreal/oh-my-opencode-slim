import type { SpecialistRole } from '../config/agent-roles';
import { AGENT_ALIASES, ALL_AGENT_NAMES } from '../config/constants';
import type { RuntimeConfig } from '../config/runtime';
import type {
  AgentOverrideConfig,
  MarketplaceActivation,
} from '../config/schema';
import { isSafeAgentAlias, normalizeAgentName } from '../utils/agent-variant';
import { validateMarketplaceCompatibility } from './compatibility';
import {
  MarketplaceCompatibilityError,
  MarketplaceIntegrityError,
  MarketplaceLockfileError,
} from './errors';
import { normalizeMarketplacePackageId } from './ids';
import {
  discoverOnDiskSkillNames,
  discoverPreflightMcps,
  discoverPreflightSkills,
} from './preflight';
import type {
  MarketplaceAgentManifest,
  MarketplacePackageManifest,
  MarketplaceProfileManifest,
} from './schemas';
import { MarketplaceStore, type StoredMarketplacePackage } from './store';

export {
  discoverOnDiskSkillNames,
  discoverPreflightMcps,
  discoverPreflightSkills,
};

export type MarketplaceDiagnosticCode =
  | 'missing'
  | 'corrupt'
  | 'operational'
  | 'incompatible'
  | 'collision'
  | 'missing-required-dependency'
  | 'kind-mismatch'
  | 'target-mismatch'
  | 'target-disabled'
  | 'prompt-masked'
  | 'invalid-alias';

export interface MarketplaceDiagnostic {
  packageId: string;
  code: MarketplaceDiagnosticCode;
  message: string;
}

export interface ActivatedMarketplaceAgent {
  packageId: string;
  version: string;
  digest: string;
  manifest: MarketplaceAgentManifest;
  requiredSkills: readonly string[];
  requiredMcps: readonly string[];
}

export interface ActivatedMarketplaceProfile {
  packageId: string;
  version: string;
  digest: string;
  manifest: MarketplaceProfileManifest;
  requiredSkills: readonly string[];
  requiredMcps: readonly string[];
}

export interface MarketplaceActivationPlan {
  agents: ActivatedMarketplaceAgent[];
  profiles: Map<SpecialistRole, ActivatedMarketplaceProfile>;
  diagnostics: MarketplaceDiagnostic[];
}

export interface ResolveMarketplaceActivationOptions {
  runtime: RuntimeConfig;
  store?: MarketplaceStore;
  projectDirectory?: string;
  availableSkillNames?: readonly string[];
  availableMcpNames?: readonly string[];
  extraSkillDirectories?: readonly string[];
}

export function emptyMarketplaceActivationPlan(): MarketplaceActivationPlan {
  return { agents: [], profiles: new Map(), diagnostics: [] };
}

export function marketplaceActivationFromRuntime(
  runtime: RuntimeConfig,
): MarketplaceActivation | undefined {
  const presetName = runtime.preset;
  if (!presetName) return undefined;
  return runtime.plugin?.presets?.[presetName]?.marketplace;
}

export function composePackagePrompt(
  rolePrompt: string,
  instructions: string,
  mode: 'append' | 'replace',
): string {
  return mode === 'replace' ? instructions : `${rolePrompt}\n\n${instructions}`;
}

export function boundedPackageOverride(
  manifest: MarketplacePackageManifest,
): AgentOverrideConfig {
  const overrides = manifest.overrides;
  const result: AgentOverrideConfig = {};
  if (overrides.model) result.model = overrides.model;
  if (overrides.variant) result.variant = overrides.variant;
  if (overrides.temperature !== undefined) {
    result.temperature = overrides.temperature;
  }
  if (overrides.displayName) {
    const displayName = normalizeAgentName(overrides.displayName);
    const selfAlias =
      (manifest.kind === 'agent' && displayName === manifest.agentName) ||
      (manifest.kind === 'profile' && displayName === manifest.targetRole);
    if (displayName && !selfAlias) result.displayName = displayName;
  }
  if (overrides.description) result.description = overrides.description;
  return result;
}

export function reservedRuntimeNames(
  runtime: RuntimeConfig,
  ownOverrideKey?: string,
): Set<string> {
  const reserved = new Set<string>(ALL_AGENT_NAMES);
  for (const [alias, canonical] of Object.entries(AGENT_ALIASES)) {
    reserved.add(alias);
    reserved.add(canonical);
  }
  for (const name of Object.keys(runtime.acpAgents)) reserved.add(name);
  reserved.add('councillor');
  const councilPreset =
    runtime.council?.presets?.[runtime.council.default_preset ?? 'default'];
  if (councilPreset) {
    for (const seat of Object.keys(councilPreset)) {
      if (seat !== 'master') reserved.add(`councillor-${seat}`);
    }
  }
  for (const name of runtime.customAgentNames) {
    if (name === ownOverrideKey) continue;
    reserved.add(name);
  }
  for (const [name, override] of Object.entries(runtime.agents())) {
    if (name === ownOverrideKey) continue;
    if (override.displayName) {
      reserved.add(normalizeAgentName(override.displayName));
    }
  }
  return reserved;
}

function diagnostic(
  packageId: string,
  code: MarketplaceDiagnosticCode,
  message: string,
): MarketplaceDiagnostic {
  return { packageId, code, message };
}

function missingRequired(
  required: readonly string[],
  available: ReadonlySet<string>,
): string[] {
  return required.filter((name) => !available.has(name));
}

function marketplaceLoadFailureCode(error: unknown): MarketplaceDiagnosticCode {
  if (
    error instanceof MarketplaceIntegrityError &&
    error.message.includes('is not installed')
  ) {
    return 'missing';
  }
  if (
    error instanceof MarketplaceLockfileError ||
    error instanceof MarketplaceIntegrityError
  ) {
    return 'corrupt';
  }
  return 'operational';
}

function claimDisplayAlias(
  packageId: string,
  runtimeName: string,
  rawDisplayName: string | undefined,
  reserved: ReadonlySet<string>,
  claimedNames: Set<string>,
): MarketplaceDiagnostic | undefined {
  if (!rawDisplayName) return undefined;
  const displayName = normalizeAgentName(rawDisplayName);
  if (!displayName || displayName === runtimeName) return undefined;
  if (!isSafeAgentAlias(displayName)) {
    return diagnostic(
      packageId,
      'invalid-alias',
      `${packageId} display alias '${rawDisplayName}' is not a valid agent alias`,
    );
  }
  if (reserved.has(displayName) || claimedNames.has(displayName)) {
    return diagnostic(
      packageId,
      'collision',
      `${packageId} display alias '${displayName}' collides with an existing agent name`,
    );
  }
  claimedNames.add(displayName);
  return undefined;
}

export function resolveMarketplaceActivation(
  options: ResolveMarketplaceActivationOptions,
): MarketplaceActivationPlan {
  const activation = marketplaceActivationFromRuntime(options.runtime);
  if (!activation) return emptyMarketplaceActivationPlan();

  const agentIds = [...(activation.agents ?? [])].map((id) =>
    id.trim().toLowerCase(),
  );
  const profileEntries = Object.entries(activation.profiles ?? {})
    .filter((entry): entry is [SpecialistRole, string] => {
      return entry[1] !== null && entry[1].trim().length > 0;
    })
    .map(
      ([role, packageId]) => [role, packageId.trim().toLowerCase()] as const,
    );

  if (agentIds.length === 0 && profileEntries.length === 0) {
    return emptyMarketplaceActivationPlan();
  }

  const diagnostics: MarketplaceDiagnostic[] = [];
  const store = options.store ?? new MarketplaceStore();
  const disabledSkills = new Set(options.runtime.disabledSkills);
  const disabledMcps = new Set(options.runtime.disabledMcps);
  const skills = new Set(
    (
      options.availableSkillNames ??
      discoverPreflightSkills(
        options.runtime,
        options.projectDirectory,
        options.extraSkillDirectories,
      )
    ).filter((name) => !disabledSkills.has(name)),
  );
  const mcps = new Set(
    (
      options.availableMcpNames ??
      discoverPreflightMcps(options.runtime, options.projectDirectory)
    ).filter((name) => !disabledMcps.has(name)),
  );
  const claimedNames = new Set<string>();
  const agents: ActivatedMarketplaceAgent[] = [];
  const profiles = new Map<SpecialistRole, ActivatedMarketplaceProfile>();

  const selectedIds: string[] = [];
  for (const packageId of new Set([
    ...agentIds,
    ...profileEntries.map(([, packageId]) => packageId),
  ])) {
    try {
      selectedIds.push(normalizeMarketplacePackageId(packageId));
    } catch {
      diagnostics.push(
        diagnostic(packageId, 'missing', `${packageId} is not installed`),
      );
    }
  }

  let selectedPackages = new Map<string, StoredMarketplacePackage>();
  let selectedErrors = new Map<string, Error>();
  let selectedLoadFailed = false;
  try {
    const selected = store.loadSelected(selectedIds);
    selectedPackages = selected.packages;
    selectedErrors = selected.errors;
  } catch (error) {
    selectedLoadFailed = true;
    diagnostics.push(
      diagnostic(
        '(store)',
        marketplaceLoadFailureCode(error),
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  const load = (packageId: string): StoredMarketplacePackage | undefined => {
    if (selectedLoadFailed) return undefined;
    let normalized: string;
    try {
      normalized = normalizeMarketplacePackageId(packageId);
    } catch {
      return undefined;
    }
    const error = selectedErrors.get(normalized);
    if (error) {
      diagnostics.push(
        diagnostic(
          normalized,
          marketplaceLoadFailureCode(error),
          error.message,
        ),
      );
      return undefined;
    }
    const pkg = selectedPackages.get(normalized);
    if (!pkg) {
      diagnostics.push(
        diagnostic(normalized, 'missing', `${normalized} is not installed`),
      );
      return undefined;
    }
    try {
      validateMarketplaceCompatibility(pkg.manifest);
    } catch (compatError) {
      const message =
        compatError instanceof MarketplaceCompatibilityError
          ? compatError.message
          : compatError instanceof Error
            ? compatError.message
            : String(compatError);
      diagnostics.push(diagnostic(normalized, 'incompatible', message));
      return undefined;
    }
    return pkg;
  };

  const preflight = (
    pkg: StoredMarketplacePackage,
  ): { skills: string[]; mcps: string[] } | undefined => {
    const missingSkills = missingRequired(
      pkg.manifest.requirements.skills.required,
      skills,
    );
    const missingMcps = missingRequired(
      pkg.manifest.requirements.mcps.required,
      mcps,
    );
    if (missingSkills.length > 0 || missingMcps.length > 0) {
      diagnostics.push(
        diagnostic(
          pkg.manifest.id,
          'missing-required-dependency',
          `${pkg.manifest.id} is disabled: missing required ${[
            ...missingSkills.map((name) => `skill ${name}`),
            ...missingMcps.map((name) => `mcp ${name}`),
          ].join(', ')}`,
        ),
      );
      return undefined;
    }
    return {
      skills: pkg.manifest.requirements.skills.required,
      mcps: pkg.manifest.requirements.mcps.required,
    };
  };

  for (const packageId of [...agentIds].sort()) {
    const pkg = load(packageId);
    if (!pkg) continue;
    if (pkg.manifest.kind !== 'agent') {
      diagnostics.push(
        diagnostic(
          pkg.manifest.id,
          'kind-mismatch',
          `${pkg.manifest.id} is a ${pkg.manifest.kind} package and cannot be activated as an agent`,
        ),
      );
      continue;
    }
    const deps = preflight(pkg);
    if (!deps) continue;
    const runtimeName = pkg.manifest.agentName;
    const reserved = reservedRuntimeNames(options.runtime, runtimeName);
    if (reserved.has(runtimeName) || claimedNames.has(runtimeName)) {
      diagnostics.push(
        diagnostic(
          pkg.manifest.id,
          'collision',
          `${pkg.manifest.id} runtime name '${runtimeName}' collides with an existing agent, alias, or display name`,
        ),
      );
      continue;
    }
    const aliasError = claimDisplayAlias(
      pkg.manifest.id,
      runtimeName,
      pkg.manifest.overrides.displayName,
      reserved,
      claimedNames,
    );
    if (aliasError) {
      diagnostics.push(aliasError);
      continue;
    }
    claimedNames.add(runtimeName);
    agents.push({
      packageId: pkg.manifest.id,
      version: pkg.manifest.version,
      digest: pkg.digest,
      manifest: pkg.manifest,
      requiredSkills: deps.skills,
      requiredMcps: deps.mcps,
    });
  }

  for (const [role, packageId] of profileEntries.sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const pkg = load(packageId);
    if (!pkg) continue;
    if (pkg.manifest.kind !== 'profile') {
      diagnostics.push(
        diagnostic(
          pkg.manifest.id,
          'kind-mismatch',
          `${pkg.manifest.id} is a ${pkg.manifest.kind} package and cannot be activated as a profile`,
        ),
      );
      continue;
    }
    if (pkg.manifest.targetRole !== role) {
      diagnostics.push(
        diagnostic(
          pkg.manifest.id,
          'target-mismatch',
          `${pkg.manifest.id} targets ${pkg.manifest.targetRole}, not ${role}`,
        ),
      );
      continue;
    }
    if (options.runtime.disabledAgents.has(role)) {
      diagnostics.push(
        diagnostic(
          pkg.manifest.id,
          'target-disabled',
          `${pkg.manifest.id} is disabled because @${role} is disabled`,
        ),
      );
      continue;
    }
    const deps = preflight(pkg);
    if (!deps) continue;
    const reserved = reservedRuntimeNames(options.runtime, role);
    const aliasError = claimDisplayAlias(
      pkg.manifest.id,
      role,
      pkg.manifest.overrides.displayName,
      reserved,
      claimedNames,
    );
    if (aliasError) {
      diagnostics.push(aliasError);
      continue;
    }
    profiles.set(role, {
      packageId: pkg.manifest.id,
      version: pkg.manifest.version,
      digest: pkg.digest,
      manifest: pkg.manifest,
      requiredSkills: deps.skills,
      requiredMcps: deps.mcps,
    });
  }

  return { agents, profiles, diagnostics };
}
