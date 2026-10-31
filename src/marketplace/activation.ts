import { DEFAULT_AGENT_MCPS } from '../config/agent-mcps.js';
import { normalizeAgentName } from '../utils/agent-variant.js';
import { satisfiesPluginCompatibility } from './compatibility.js';
import {
  MarketplaceBusyError,
  MarketplaceCompatibilityError,
} from './errors.js';
import { normalizeMarketplacePackageId } from './ids.js';
import { hasImmediateMarketplaceLeases } from './lease.js';
import { ambiguousMcpNamespaces } from './mcp-namespaces.js';
import {
  type ActivatedMarketplacePackageManifest,
  ActivatedMarketplacePackageManifestSchema,
  type MarketplacePackageManifest,
} from './schemas.js';
import type { StoredMarketplacePackage } from './store.js';

export { ambiguousMcpNamespaces } from './mcp-namespaces.js';

export type MarketplaceDiagnosticCode =
  | 'invalid-selection'
  | 'duplicate-selection'
  | 'missing'
  | 'corrupt'
  | 'operational'
  | 'incompatible'
  | 'invalid-manifest'
  | 'manifest-id-mismatch'
  | 'collision'
  | 'missing-required-dependency'
  | 'ambiguous-mcp-namespace'
  | 'invalid-capability';

export interface MarketplaceActivationDiagnostic {
  readonly packageId: string;
  readonly code: MarketplaceDiagnosticCode;
  readonly message: string;
  readonly cause?: unknown;
}

export interface MarketplaceActivationAdmission {
  readonly packageId: string;
  readonly agentName: string;
  readonly version: string;
  readonly digest: string;
  readonly manifest: ActivatedMarketplacePackageManifest;
  readonly requiredSkills: readonly string[];
  readonly requiredMcps: readonly string[];
}

export interface MarketplaceActivationPlan {
  readonly agents: readonly MarketplaceActivationAdmission[];
  readonly diagnostics: readonly MarketplaceActivationDiagnostic[];
}

export interface MarketplaceSelectedPackageLoad {
  readonly packages: ReadonlyMap<string, StoredMarketplacePackage>;
  readonly errors: ReadonlyMap<string, Error>;
}

export interface MarketplaceActivationStore {
  loadSelected(ids: readonly string[]): MarketplaceSelectedPackageLoad;
}

export interface ResolveMarketplaceActivationOptions {
  /** Resolved preset marketplace.agents only; persistence directives are not inputs. */
  readonly selectedPackageIds: readonly string[];
  readonly store: MarketplaceActivationStore;
  readonly pluginVersion: string;
  readonly availableSkillNames: readonly string[];
  readonly availableMcpNames: readonly string[];
  readonly disabledSkillNames?: readonly string[];
  readonly disabledMcpNames?: readonly string[];
  /**
   * Complete pre-mutation runtime identity set: builtins, aliases, custom/ACP,
   * and host agent names. Entries are normalized with normalizeAgentName.
   * Marketplace manifest agentName is schema-constrained to lowercase names
   * without an @ prefix; collision comparison uses that same normalization
   * (trim and remove an optional @), then remains case-sensitive.
   * The caller/registry remains responsible for later alias-configuration
   * collision checks that are not expressible in this admission plan.
   */
  readonly reservedAgentNames: ReadonlySet<string>;
}

const READONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'ast_grep_search',
  'webfetch',
  'websearch',
]);

function diagnostic(
  packageId: string,
  code: MarketplaceDiagnosticCode,
  message: string,
  cause?: unknown,
): MarketplaceActivationDiagnostic {
  return {
    packageId,
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  };
}

function loadErrorCode(error: unknown): MarketplaceDiagnosticCode {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'integrity' || error.code === 'lockfile')
  ) {
    return error.code === 'integrity' &&
      error instanceof Error &&
      error.message.includes('is not installed')
      ? 'missing'
      : 'corrupt';
  }
  return 'operational';
}

function validateCapability(
  manifest: MarketplacePackageManifest,
): string | undefined {
  const extension = manifest.extends;
  if (
    !extension ||
    extension.builtin === 'designer' ||
    extension.builtin === 'fixer'
  ) {
    return undefined;
  }
  const invalid = manifest.tools.filter((tool) => !READONLY_TOOLS.has(tool));
  return invalid.length === 0
    ? undefined
    : `extends read-only builtin ${extension.builtin} and cannot request ${invalid.join(', ')}`;
}

/**
 * Resolve selected marketplace packages into a side-effect-free admission plan.
 * Any diagnostic rejects the whole set so downstream registries can consume
 * the plan atomically.
 */
export function resolveMarketplaceActivation(
  options: ResolveMarketplaceActivationOptions,
): MarketplaceActivationPlan {
  const diagnostics: MarketplaceActivationDiagnostic[] = [];
  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  for (const rawId of options.selectedPackageIds) {
    let id: string;
    try {
      id = normalizeMarketplacePackageId(rawId);
    } catch (cause) {
      diagnostics.push(
        diagnostic(
          rawId,
          'invalid-selection',
          `Invalid selected package ID: ${rawId}`,
          cause,
        ),
      );
      continue;
    }
    if (seen.has(id)) {
      diagnostics.push(
        diagnostic(
          id,
          'duplicate-selection',
          `Package ${id} is selected more than once`,
        ),
      );
      continue;
    }
    seen.add(id);
    normalizedIds.push(id);
  }

  let loaded: MarketplaceSelectedPackageLoad = {
    packages: new Map(),
    errors: new Map(),
  };
  let storeLoadFailed = false;
  if (normalizedIds.length > 0) {
    try {
      loaded = options.store.loadSelected([...normalizedIds].sort());
    } catch (cause) {
      if (
        cause instanceof MarketplaceBusyError &&
        hasImmediateMarketplaceLeases()
      )
        throw cause;
      storeLoadFailed = true;
      const message = cause instanceof Error ? cause.message : String(cause);
      diagnostics.push(
        diagnostic('(store)', loadErrorCode(cause), message, cause),
      );
    }
  }
  const skills = new Set(
    options.availableSkillNames.filter(
      (name) => !options.disabledSkillNames?.includes(name),
    ),
  );
  const mcps = new Set(
    options.availableMcpNames.filter(
      (name) => !options.disabledMcpNames?.includes(name),
    ),
  );
  const claimed = new Set<string>();
  const reservedNames = new Set(
    [...options.reservedAgentNames].map(normalizeAgentName),
  );
  const agents: MarketplaceActivationAdmission[] = [];

  for (const id of [...normalizedIds].sort()) {
    if (storeLoadFailed) continue;
    const loadError = loaded.errors.get(id);
    if (loadError) {
      diagnostics.push(
        diagnostic(id, loadErrorCode(loadError), loadError.message, loadError),
      );
      continue;
    }
    const stored = loaded.packages.get(id);
    if (!stored) {
      diagnostics.push(diagnostic(id, 'missing', `${id} is not installed`));
      continue;
    }

    const parsed = ActivatedMarketplacePackageManifestSchema.safeParse(
      stored.manifest,
    );
    if (!parsed.success) {
      diagnostics.push(
        diagnostic(id, 'invalid-manifest', parsed.error.message, parsed.error),
      );
      continue;
    }
    const manifest = parsed.data;
    if (manifest.id !== id) {
      diagnostics.push(
        diagnostic(
          id,
          'manifest-id-mismatch',
          `Manifest ID ${manifest.id} does not match selected package ${id}`,
        ),
      );
      continue;
    }
    if (
      !satisfiesPluginCompatibility(
        options.pluginVersion,
        manifest.compatibility.plugin,
      )
    ) {
      const error = new MarketplaceCompatibilityError(
        `Marketplace package ${id} requires plugin ${manifest.compatibility.plugin}; current version is ${options.pluginVersion}`,
      );
      diagnostics.push(diagnostic(id, 'incompatible', error.message, error));
      continue;
    }

    const capabilityError = validateCapability(manifest);
    if (capabilityError) {
      diagnostics.push(
        diagnostic(id, 'invalid-capability', `${id} ${capabilityError}`),
      );
      continue;
    }
    const inheritedMcps = manifest.extends
      ? (DEFAULT_AGENT_MCPS[manifest.extends.builtin] ?? [])
      : [];
    const requiredMcps = [...new Set([...inheritedMcps, ...manifest.mcps])];
    const inheritedMcpSet = new Set(inheritedMcps);
    const missingSkills = manifest.skills.filter((name) => !skills.has(name));
    const missingMcps = requiredMcps.filter((name) => !mcps.has(name));
    if (missingSkills.length || missingMcps.length) {
      diagnostics.push(
        diagnostic(
          id,
          'missing-required-dependency',
          `${id} requires unavailable ${[
            ...missingSkills.map((name) => `skill ${name}`),
            ...missingMcps.map((name) =>
              inheritedMcpSet.has(name)
                ? `MCP ${name} inherited by ${manifest.extends?.builtin}`
                : `MCP ${name}`,
            ),
          ].join(', ')}`,
        ),
      );
      continue;
    }
    const effectiveMcps = requiredMcps;
    const ambiguous = ambiguousMcpNamespaces(effectiveMcps, mcps);
    if (ambiguous.length) {
      diagnostics.push(
        diagnostic(
          id,
          'ambiguous-mcp-namespace',
          `${id} has ambiguous MCP action namespaces: ${ambiguous.join(', ')}`,
        ),
      );
      continue;
    }

    const name = normalizeAgentName(manifest.agentName);
    if (reservedNames.has(name) || claimed.has(name)) {
      diagnostics.push(
        diagnostic(
          id,
          'collision',
          `Runtime agent name '${name}' collides with an existing or selected agent`,
        ),
      );
      continue;
    }
    claimed.add(name);
    agents.push({
      packageId: id,
      agentName: name,
      version: manifest.version,
      digest: stored.digest,
      manifest,
      requiredSkills: manifest.skills,
      requiredMcps,
    });
  }

  diagnostics.sort(
    (left, right) =>
      compareText(left.packageId, right.packageId) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );
  return {
    agents: diagnostics.length === 0 ? agents : [],
    diagnostics,
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
