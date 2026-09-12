import { AGENT_ALIASES, ALL_AGENT_NAMES } from '../config/constants';
import type { RuntimeConfig } from '../config/runtime';
import type { MarketplaceActivation } from '../config/schema';
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
import { isMarketplacePackageRetired } from './retirements';
import type { MarketplaceAgentManifest } from './schemas';
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
  | 'invalid-alias'
  | 'invalid-capability'
  | 'retired';

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

export interface MarketplaceActivationPlan {
  agents: ActivatedMarketplaceAgent[];
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
  return { agents: [], diagnostics: [] };
}

export function marketplaceActivationFromRuntime(
  runtime: RuntimeConfig,
): MarketplaceActivation | undefined {
  const presetName = runtime.preset;
  if (!presetName) return undefined;
  return runtime.plugin?.presets?.[presetName]?.marketplace;
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
    if (name !== ownOverrideKey) reserved.add(name);
  }
  for (const [name, override] of Object.entries(runtime.agents())) {
    if (name !== ownOverrideKey && override.displayName) {
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

function missing(
  values: readonly string[],
  available: ReadonlySet<string>,
): string[] {
  return values.filter((value) => !available.has(value));
}

function claimName(
  packageId: string,
  name: string,
  reserved: ReadonlySet<string>,
  claimed: Set<string>,
): MarketplaceDiagnostic | undefined {
  if (!isSafeAgentAlias(name)) {
    return diagnostic(
      packageId,
      'invalid-alias',
      `${packageId} agentName '${name}' is not a valid agent alias`,
    );
  }
  if (reserved.has(name) || claimed.has(name)) {
    return diagnostic(
      packageId,
      'collision',
      `${packageId} runtime name '${name}' collides with an existing agent name`,
    );
  }
  return undefined;
}

const READONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'ast_grep_search',
  'webfetch',
  'websearch',
]);

function validateExtensionCapabilities(
  pkg: StoredMarketplacePackage,
  diagnostics: MarketplaceDiagnostic[],
): boolean {
  const extension = pkg.manifest.extends;
  if (!extension) return true;
  if (extension.builtin !== 'designer' && extension.builtin !== 'fixer') {
    const invalid = pkg.manifest.tools.filter(
      (tool) => !READONLY_TOOLS.has(tool),
    );
    if (invalid.length > 0) {
      diagnostics.push(
        diagnostic(
          pkg.manifest.id,
          'invalid-capability',
          `${pkg.manifest.id} extends read-only builtin ${extension.builtin} and cannot request ${invalid.join(', ')}`,
        ),
      );
      return false;
    }
  }
  return true;
}

export function resolveMarketplaceActivation(
  options: ResolveMarketplaceActivationOptions,
): MarketplaceActivationPlan {
  const activation = marketplaceActivationFromRuntime(options.runtime);
  const ids = [
    ...new Set((activation?.agents ?? []).map((id) => id.trim().toLowerCase())),
  ];
  if (ids.length === 0) return emptyMarketplaceActivationPlan();

  const diagnostics: MarketplaceDiagnostic[] = [];
  const store = options.store ?? new MarketplaceStore();
  const skills = new Set(
    (
      options.availableSkillNames ??
      discoverPreflightSkills(
        options.runtime,
        options.projectDirectory,
        options.extraSkillDirectories,
      )
    ).filter((name) => !options.runtime.disabledSkills.includes(name)),
  );
  const mcps = new Set(
    (
      options.availableMcpNames ??
      discoverPreflightMcps(options.runtime, options.projectDirectory)
    ).filter((name) => !options.runtime.disabledMcps.includes(name)),
  );
  const selected = new Map<string, StoredMarketplacePackage>();
  const errors = new Map<string, Error>();
  try {
    const loaded = store.loadSelected(ids);
    for (const [id, pkg] of loaded.packages) selected.set(id, pkg);
    for (const [id, error] of loaded.errors) errors.set(id, error);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        '(store)',
        marketplaceLoadFailureCode(error),
        error instanceof Error ? error.message : String(error),
      ),
    );
    return { agents: [], diagnostics };
  }

  const claimed = new Set<string>();
  const agents: ActivatedMarketplaceAgent[] = [];
  for (const packageId of [...ids].sort()) {
    let id: string;
    try {
      id = normalizeMarketplacePackageId(packageId);
    } catch {
      diagnostics.push(
        diagnostic(packageId, 'missing', `${packageId} is not installed`),
      );
      continue;
    }
    if (isMarketplacePackageRetired(id)) {
      diagnostics.push(
        diagnostic(id, 'retired', `${id} is retired and will not be activated`),
      );
      continue;
    }
    const error = errors.get(id);
    if (error) {
      diagnostics.push(
        diagnostic(id, marketplaceLoadFailureCode(error), error.message),
      );
      continue;
    }
    const pkg = selected.get(id);
    if (!pkg) {
      diagnostics.push(diagnostic(id, 'missing', `${id} is not installed`));
      continue;
    }
    try {
      validateMarketplaceCompatibility(pkg.manifest);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          id,
          'incompatible',
          error instanceof MarketplaceCompatibilityError
            ? error.message
            : String(error),
        ),
      );
      continue;
    }
    if (!validateExtensionCapabilities(pkg, diagnostics)) continue;
    const missingSkills = missing(pkg.manifest.skills, skills);
    const missingMcps = missing(pkg.manifest.mcps, mcps);
    if (missingSkills.length || missingMcps.length) {
      diagnostics.push(
        diagnostic(
          id,
          'missing-required-dependency',
          `${id} is disabled: missing ${[
            ...missingSkills.map((name) => `skill ${name}`),
            ...missingMcps.map((name) => `mcp ${name}`),
          ].join(', ')}`,
        ),
      );
      continue;
    }
    const name = pkg.manifest.agentName;
    const nameError = claimName(
      id,
      name,
      reservedRuntimeNames(options.runtime, name),
      claimed,
    );
    if (nameError) {
      diagnostics.push(nameError);
      continue;
    }
    claimed.add(name);
    agents.push({
      packageId: id,
      version: pkg.manifest.version,
      digest: pkg.digest,
      manifest: pkg.manifest,
      requiredSkills: pkg.manifest.skills,
      requiredMcps: pkg.manifest.mcps,
    });
  }
  return { agents, diagnostics };
}
