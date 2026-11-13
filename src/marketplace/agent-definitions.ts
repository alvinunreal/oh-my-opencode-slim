import type { AgentConfig } from '@opencode-ai/sdk/v2';
import type { AgentDefinition } from '../agents/orchestrator.js';
import { createReadOnlyAgentPermission } from '../agents/permissions.js';
import {
  createRoleAgent,
  ROLE_DEFINITIONS,
} from '../agents/role-definitions.js';
import { DEFAULT_AGENT_MCPS } from '../config/agent-mcps.js';
import type { SpecialistRole } from '../config/agent-roles.js';
import type {
  MarketplaceActivationAdmission,
  MarketplaceActivationPlan,
} from './activation.js';
import { MARKETPLACE_TOOL_NAMES } from './capabilities.js';
import { renderMarketplaceAutoDelegationBlock } from './routing.js';
import type { MarketplaceModelPolicy } from './schemas.js';

interface MarketplaceAgentCapabilityCeiling {
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly mcps: readonly string[];
}

export interface MarketplaceAgentMetadata {
  readonly packageId: string;
  readonly runtimeName: string;
  readonly routingInput: {
    readonly manifest: MarketplaceActivationAdmission['manifest']['routing'];
    readonly block: string;
  };
  readonly capabilities: MarketplaceAgentCapabilityCeiling;
  readonly modelPolicy: MarketplaceModelPolicy;
  readonly extension?: {
    readonly builtin: SpecialistRole;
    readonly promptMode: 'append' | 'replace';
  };
}

export interface MarketplaceAgentDefinitions {
  readonly agents: readonly AgentDefinition[];
  readonly metadata: readonly MarketplaceAgentMetadata[];
}

export class MarketplaceAgentConstructionError extends Error {
  readonly code: 'activation-diagnostics' | 'unsupported-capability';

  constructor(
    code: MarketplaceAgentConstructionError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceAgentConstructionError';
    this.code = code;
  }
}

/** Convert an already-admitted plan; this function never reads package storage. */
export function createMarketplaceAgentDefinitions(
  plan: MarketplaceActivationPlan,
): MarketplaceAgentDefinitions {
  if (plan.diagnostics.length > 0) {
    throw new MarketplaceAgentConstructionError(
      'activation-diagnostics',
      `Cannot construct marketplace agents from a diagnostic plan: ${plan.diagnostics
        .map(({ packageId, code }) => `${packageId} (${code})`)
        .join(', ')}`,
    );
  }

  const agents: AgentDefinition[] = [];
  const metadata: MarketplaceAgentMetadata[] = [];
  for (const admission of plan.agents) {
    const manifest = admission.manifest;
    const extension = manifest.extends;
    if (
      extension &&
      !canExtendWithCapabilities(extension.builtin, manifest.tools)
    ) {
      throw new MarketplaceAgentConstructionError(
        'unsupported-capability',
        `Marketplace package ${admission.packageId} requests tools that cannot be represented for read-only builtin ${extension.builtin}`,
      );
    }

    const capabilities = effectiveCapabilities(admission);
    const definition = extension
      ? createExtendedDefinition(admission)
      : createStandaloneDefinition(admission);
    applyPackagePolicy(definition, capabilities);
    agents.push(definition);
    metadata.push(createMetadata(admission, capabilities));
  }

  return deepFreeze({ agents, metadata });
}

function createExtendedDefinition(
  admission: MarketplaceActivationAdmission,
): AgentDefinition {
  const manifest = admission.manifest;
  const extension = manifest.extends;
  if (!extension) throw new Error('Extension expected');

  const explicitModel =
    manifest.model.source === 'explicit'
      ? candidateId(manifest.model.candidates[0])
      : undefined;
  const role = ROLE_DEFINITIONS[extension.builtin];
  const append =
    manifest.schemaVersion === 3 || extension.promptMode === 'append';
  const roleAgent = createRoleAgent(
    role,
    explicitModel ?? '',
    append ? undefined : manifest.prompt,
    append ? manifest.prompt : undefined,
  );
  const config: AgentConfig = { ...roleAgent.config };
  if (explicitModel === undefined) delete config.model;
  const startupVariant = firstModelVariant(manifest.model);
  if (startupVariant !== undefined) config.variant = startupVariant;
  return withPackagePolicy(
    {
      ...roleAgent,
      name: admission.agentName,
      description: manifest.description,
      config,
    },
    admission,
  );
}

function createStandaloneDefinition(
  admission: MarketplaceActivationAdmission,
): AgentDefinition {
  const manifest = admission.manifest;
  const explicitModel =
    manifest.model.source === 'explicit'
      ? candidateId(manifest.model.candidates[0])
      : undefined;
  const config: AgentConfig = {
    prompt: manifest.prompt,
    ...(explicitModel ? { model: explicitModel } : {}),
  };
  const startupVariant = firstModelVariant(manifest.model);
  if (startupVariant !== undefined) config.variant = startupVariant;
  return withPackagePolicy(
    {
      name: admission.agentName,
      description: manifest.description,
      config,
    },
    admission,
  );
}

function applyPackagePolicy(
  definition: AgentDefinition,
  capabilities: MarketplaceAgentCapabilityCeiling,
): void {
  definition.config.tools = Object.fromEntries(
    capabilities.tools.map((tool) => [tool, true]),
  );
}

function firstModelVariant(policy: MarketplaceModelPolicy): string | undefined {
  if (policy.source !== 'explicit') return undefined;
  const first = policy.candidates[0];
  return typeof first === 'string' ? undefined : first.variant;
}

function effectiveCapabilities(
  admission: MarketplaceActivationAdmission,
): MarketplaceAgentCapabilityCeiling {
  const manifest = admission.manifest;
  const extension = manifest.extends;
  const builtin = extension
    ? getBuiltinCapabilities(extension.builtin)
    : { tools: [], skills: [], mcps: [] };
  return {
    tools: union(builtin.tools, manifest.tools),
    skills: union(builtin.skills, manifest.skills),
    mcps: union(builtin.mcps, manifest.mcps),
  };
}

function getBuiltinCapabilities(
  builtin: SpecialistRole,
): MarketplaceAgentCapabilityCeiling {
  const writeCapable = builtin === 'designer' || builtin === 'fixer';
  const permission = writeCapable ? undefined : createReadOnlyAgentPermission();
  const tools = permission
    ? MARKETPLACE_TOOL_NAMES.filter((tool) => permission[tool] === 'allow')
    : [];
  return {
    tools,
    skills: [],
    mcps: DEFAULT_AGENT_MCPS[builtin] ?? [],
  };
}

function union(
  base: readonly string[],
  additions: readonly string[],
): string[] {
  return [...new Set([...base, ...additions])];
}

function withPackagePolicy(
  definition: AgentDefinition,
  admission: MarketplaceActivationAdmission,
): AgentDefinition {
  const manifest = admission.manifest;
  if (manifest.temperature !== undefined) {
    definition.config.temperature = manifest.temperature;
  }
  if (manifest.color !== undefined) definition.config.color = manifest.color;
  if (manifest.model.source === 'explicit') {
    definition._modelArray = manifest.model.candidates.map((candidate) =>
      typeof candidate === 'string' ? { id: candidate } : { ...candidate },
    );
  }
  return definition;
}

function candidateId(
  candidate:
    | string
    | { readonly id: string; readonly variant?: string }
    | undefined,
): string | undefined {
  return typeof candidate === 'string' ? candidate : candidate?.id;
}

function createMetadata(
  admission: MarketplaceActivationAdmission,
  capabilities: MarketplaceAgentCapabilityCeiling,
): MarketplaceAgentMetadata {
  const manifest = admission.manifest;
  const extension = manifest.extends;
  return {
    packageId: admission.packageId,
    runtimeName: admission.agentName,
    routingInput: {
      manifest: structuredClone(manifest.routing),
      block: renderMarketplaceAutoDelegationBlock(
        manifest,
        admission.agentName,
      ),
    },
    capabilities,
    modelPolicy: structuredClone(manifest.model),
    ...(extension
      ? {
          extension: {
            builtin: extension.builtin,
            promptMode: extension.promptMode,
          },
        }
      : {}),
  };
}

function canExtendWithCapabilities(
  builtin: NonNullable<
    MarketplaceActivationAdmission['manifest']['extends']
  >['builtin'],
  tools: readonly string[],
): boolean {
  if (builtin === 'designer' || builtin === 'fixer') return true;
  const readOnlyTools = new Set([
    'read',
    'glob',
    'grep',
    'ast_grep_search',
    'webfetch',
    'websearch',
  ]);
  return tools.every((tool) => readOnlyTools.has(tool));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
