import { resolve } from 'node:path';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import { retryMarketplaceLeases } from '../marketplace/lease';
import type { MarketplaceService } from '../marketplace/service';
import type { StoredMarketplacePackage } from '../marketplace/store';
import { normalizeAgentName } from '../utils/agent-variant';

const z = tool.schema;
const INSPECT_ACTIONS = [
  'list',
  'show',
  'verify',
  'status',
  'request_reload',
] as const;
const MANAGE_ACTIONS = [
  'install',
  'import',
  'update',
  'update_file',
  'uninstall',
  'enable',
  'disable',
] as const;

function summarizePackage(stored: StoredMarketplacePackage) {
  return {
    id: stored.manifest.id,
    version: stored.manifest.version,
    name: stored.manifest.displayName,
    source: stored.source,
    digest: stored.digest,
  };
}

export interface MarketplaceToolOptions {
  readonly service: MarketplaceService;
  readonly orchestratorIdentities?: ReadonlySet<string>;
  readonly getOrchestratorIdentities?: () => ReadonlySet<string>;
  readonly cwd?: string;
  readonly readSkillIds?: () => Promise<readonly string[]>;
}

export function resolveFinalizedOrchestratorIdentities(input: {
  readonly agentNames: readonly string[];
  readonly identities: Readonly<Record<string, string>>;
}): ReadonlySet<string> {
  const ownersByIdentity = new Map<string, Set<string>>();
  const addOwner = (identity: string, owner: string) => {
    const normalizedIdentity = normalizeAgentName(identity);
    const owners =
      ownersByIdentity.get(normalizedIdentity) ?? new Set<string>();
    owners.add(owner);
    ownersByIdentity.set(normalizedIdentity, owners);
  };

  for (const agentName of input.agentNames) {
    const displayIdentity = input.identities[agentName] ?? agentName;
    addOwner(agentName, agentName);
    addOwner(displayIdentity, agentName);
  }

  return new Set(
    [...ownersByIdentity]
      .filter(([, owners]) => owners.size === 1 && owners.has('orchestrator'))
      .map(([identity]) => identity),
  );
}

function assertOrchestrator(
  agent: string | undefined,
  identities: ReadonlySet<string>,
  getOrchestratorIdentities?: () => ReadonlySet<string>,
): void {
  let allowedIdentities = identities;
  try {
    if (getOrchestratorIdentities) {
      allowedIdentities = getOrchestratorIdentities();
    }
  } catch {
    throw new Error(
      'Marketplace tools are unavailable until the agent registry is finalized',
    );
  }
  if (!agent || !allowedIdentities.has(normalizeAgentName(agent))) {
    throw new Error('Marketplace tools are available only to the orchestrator');
  }
}

function targetSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .describe('Nonblank package ID, selector, or bundle path');
}

export function createMarketplaceTools(options: MarketplaceToolOptions): {
  marketplace_inspect: ToolDefinition;
  marketplace_manage: ToolDefinition;
} {
  const identities = options.getOrchestratorIdentities
    ? new Set<string>()
    : new Set([
        'orchestrator',
        ...[...(options.orchestratorIdentities ?? [])].map(normalizeAgentName),
      ]);
  const cwd = options.cwd ?? options.service.projectDir;
  const marketplace_inspect = tool({
    description:
      'Inspect marketplace packages and runtime status. request_reload reports whether a host reload is required; it never reloads the host.',
    args: {
      action: z.enum(INSPECT_ACTIONS).describe('Inspection action'),
      target: z.string().optional().describe('Package ID for show/verify'),
    },
    async execute(args, context) {
      assertOrchestrator(
        context?.agent,
        identities,
        options.getOrchestratorIdentities,
      );
      if (args.action === 'show' && !args.target?.trim()) {
        throw new Error('show requires a nonblank target');
      }
      if (
        args.action !== 'show' &&
        args.action !== 'verify' &&
        args.target !== undefined
      ) {
        throw new Error(`${args.action} does not accept a target`);
      }
      let availableSkillNames: readonly string[] | undefined;
      if (args.action === 'status' || args.action === 'request_reload') {
        try {
          availableSkillNames = await options.readSkillIds?.();
        } catch {
          // An unavailable inventory remains unknown, not an empty catalog.
        }
      }
      return retryMarketplaceLeases(() => {
        switch (args.action) {
          case 'list':
            return JSON.stringify(
              options.service.list().map(summarizePackage),
              null,
              2,
            );
          case 'show':
            return JSON.stringify(
              options.service.show(args.target?.trim() ?? ''),
              null,
              2,
            );
          case 'verify':
            return JSON.stringify(
              options.service.verify(args.target?.trim()),
              null,
              2,
            );
          case 'status':
            return JSON.stringify(
              options.service.status(availableSkillNames),
              null,
              2,
            );
          case 'request_reload':
            return JSON.stringify(
              options.service.requestReload(availableSkillNames),
              null,
              2,
            );
        }
      }, context?.abort);
    },
  });

  const marketplace_manage = tool({
    description:
      'Manage marketplace desired disk state. Mutations never change the live agent registry; use request_reload to learn whether the host must be restarted.',
    args: {
      action: z.enum(MANAGE_ACTIONS).describe('Management action'),
      target: targetSchema(),
      acknowledge_other_projects: z
        .boolean()
        .optional()
        .describe(
          'Must be true for global uninstall; confirms other projects are not inspected',
        ),
      scope: z
        .enum(['project', 'user'])
        .optional()
        .describe('Activation scope; defaults to project'),
    },
    async execute(args, context) {
      assertOrchestrator(
        context?.agent,
        identities,
        options.getOrchestratorIdentities,
      );
      const target = args.target.trim();
      if (!target)
        throw new Error('marketplace_manage requires a nonblank target');
      if (
        args.scope !== undefined &&
        args.action !== 'enable' &&
        args.action !== 'disable'
      ) {
        throw new Error('scope is only supported by enable and disable');
      }
      const executeAction = async () => {
        let result: unknown;
        switch (args.action) {
          case 'install':
            result = summarizePackage(
              await options.service.installRemote(target, context?.abort),
            );
            break;
          case 'import':
            result = summarizePackage(
              options.service.importFile(resolve(cwd, target)),
            );
            break;
          case 'update':
            result = summarizePackage(
              await options.service.updateRemote(target, context?.abort),
            );
            break;
          case 'update_file':
            result = summarizePackage(
              options.service.updateFile(resolve(cwd, target)),
            );
            break;
          case 'uninstall':
            if (args.acknowledge_other_projects !== true) {
              throw new Error(
                'uninstall requires acknowledge_other_projects: true because other projects are not inspected',
              );
            }
            result = options.service.uninstallGlobal(
              target,
              args.acknowledge_other_projects,
            );
            break;
          case 'enable':
            options.service.enable(target, args.scope ?? 'project');
            result = { enabled: true };
            break;
          case 'disable':
            options.service.disable(target, args.scope ?? 'project');
            result = { enabled: false };
            break;
        }
        return JSON.stringify(result, null, 2);
      };
      return args.action === 'install' || args.action === 'update'
        ? executeAction()
        : retryMarketplaceLeases(executeAction, context?.abort);
    },
  });
  return { marketplace_inspect, marketplace_manage };
}
