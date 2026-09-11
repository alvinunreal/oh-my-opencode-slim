import { isAbsolute, join } from 'node:path';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
  disableMarketplacePackage,
  enableMarketplaceAgent,
  setMarketplaceProfile,
} from '../marketplace/activation-config';
import type { MarketplaceService } from '../marketplace/service';
import {
  collectMarketplaceStatus,
  formatMarketplaceStatus,
  type MarketplaceLiveSnapshot,
  mutationReloadNotice,
  reloadRequiredAfterMutation,
} from '../marketplace/status';

const toolZ = tool.schema;

export const MARKETPLACE_TOOL_ACTIONS = [
  'install',
  'import',
  'list',
  'show',
  'verify',
  'update',
  'enable',
  'disable',
  'profile',
  'remove',
  'status',
] as const;

export type MarketplaceToolAction = (typeof MARKETPLACE_TOOL_ACTIONS)[number];

const MarketplaceToolRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('install'), path: z.string().min(1) }).strict(),
  z.object({ action: z.literal('import'), path: z.string().min(1) }).strict(),
  z.object({ action: z.literal('update'), path: z.string().min(1) }).strict(),
  z
    .object({ action: z.literal('show'), packageId: z.string().min(1) })
    .strict(),
  z
    .object({ action: z.literal('enable'), packageId: z.string().min(1) })
    .strict(),
  z
    .object({ action: z.literal('disable'), packageId: z.string().min(1) })
    .strict(),
  z
    .object({
      action: z.literal('verify'),
      packageId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('remove'),
      packageId: z.string().min(1),
      force: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('profile'),
      role: z.string().min(1),
      packageId: z.string().min(1).optional(),
      clear: z.literal(true).optional(),
    })
    .strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('status') }).strict(),
]);

export type MarketplaceToolRequest = z.infer<
  typeof MarketplaceToolRequestSchema
>;

export interface MarketplaceToolOptions {
  service: MarketplaceService;
  projectDir: string;
  getLiveSnapshot?: () => MarketplaceLiveSnapshot | undefined;
  getDesiredLive?: () => MarketplaceLiveSnapshot;
  shouldManageSession: (sessionID: string) => boolean;
  resolveAgentName?: (agent: string) => string;
  registerSessionAsOrchestrator?: (sessionID: string) => void;
  isMarketplaceDenied?: () => boolean;
}

function definedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined),
  );
}

export function parseMarketplaceToolArgs(
  args: Record<string, unknown>,
): MarketplaceToolRequest {
  const result = MarketplaceToolRequestSchema.safeParse(definedArgs(args));
  if (!result.success) {
    throw new Error(result.error.message);
  }
  const request = result.data;
  if (request.action === 'profile') {
    if (request.clear === true) {
      if (request.packageId !== undefined) {
        throw new Error('profile --clear accepts only a role');
      }
    } else if (!request.packageId) {
      throw new Error('profile requires a role and package ID');
    }
  }
  return request;
}

function resolvePackagePath(projectDir: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(projectDir, filePath);
}

function mutationResult(
  options: MarketplaceToolOptions,
  message: string,
): string {
  return mutationReloadNotice(
    message,
    reloadRequiredAfterMutation({
      service: options.service,
      projectDir: options.projectDir,
      live: options.getLiveSnapshot?.(),
      desiredLive: options.getDesiredLive?.(),
    }),
  );
}

function formatPackageLine(pkg: {
  manifest: {
    id: string;
    version: string;
    kind: string;
    displayName: string;
    description: string;
    baseRole?: string;
    targetRole?: string;
  };
  source: unknown;
}): string {
  const role =
    pkg.manifest.kind === 'agent'
      ? pkg.manifest.baseRole
      : pkg.manifest.targetRole;
  return [
    `${pkg.manifest.id}@${pkg.manifest.version}`,
    `kind: ${pkg.manifest.kind}`,
    `role: ${role}`,
    `displayName: ${pkg.manifest.displayName}`,
    `description: ${pkg.manifest.description}`,
    `source: ${JSON.stringify(pkg.source)}`,
  ].join('\n');
}

export function createMarketplaceTool(
  options: MarketplaceToolOptions,
): Record<'marketplace', ToolDefinition> {
  const marketplace = tool({
    description: `Manage local offline marketplace packages.

Use this tool for install, import, list, show, verify, update, enable, disable, profile, remove, and status. Do not shell out to the CLI for these actions. There is no network registry.

list, show, verify, and status are read-only. install, import, update, enable, disable, profile, and remove write the local store and plugin config only and never hot-swap the live agent registry. Those mutations report reload_required only when disk activation differs from this session; no-op or inactive changes do not.

Action-specific fields: path for install/import/update; packageId for show/enable/disable/remove and optional for verify; role plus packageId or role plus clear=true for profile; no extra fields.`,
    args: {
      action: toolZ
        .enum(MARKETPLACE_TOOL_ACTIONS)
        .describe('Marketplace action to perform'),
      path: toolZ
        .string()
        .min(1)
        .optional()
        .describe('Local package.json path for install, import, or update'),
      packageId: toolZ
        .string()
        .min(1)
        .optional()
        .describe(
          'Canonical package ID for show, verify, enable, disable, profile, or remove',
        ),
      role: toolZ
        .string()
        .min(1)
        .optional()
        .describe('Specialist role for profile'),
      force: toolZ
        .boolean()
        .optional()
        .describe('Force remove even if the package is still referenced'),
      clear: toolZ
        .boolean()
        .optional()
        .describe('Clear the selected profile for a specialist role'),
    },
    async execute(args, toolContext) {
      const sessionID = toolContext?.sessionID;
      if (!sessionID) throw new Error('marketplace requires sessionID');
      const rawAgent = toolContext?.agent;
      const agent =
        typeof rawAgent === 'string'
          ? (options.resolveAgentName?.(rawAgent) ?? rawAgent)
          : undefined;
      if (agent && agent !== 'orchestrator') {
        throw new Error('marketplace can only be used by orchestrator');
      }
      if (options.isMarketplaceDenied?.()) {
        throw new Error('marketplace is denied by permission');
      }
      if (!options.shouldManageSession(sessionID)) {
        if (agent === 'orchestrator') {
          options.registerSessionAsOrchestrator?.(sessionID);
        }
      }
      if (!options.shouldManageSession(sessionID)) {
        throw new Error(
          'marketplace can only be used in orchestrator sessions',
        );
      }

      const request = parseMarketplaceToolArgs(args as Record<string, unknown>);
      const service = options.service;
      const projectDir = options.projectDir;

      switch (request.action) {
        case 'install':
        case 'import': {
          const pkg = service.installFile(
            resolvePackagePath(projectDir, request.path),
          );
          return mutationResult(
            options,
            `Installed ${pkg.manifest.id}@${pkg.manifest.version}`,
          );
        }
        case 'update': {
          const pkg = service.updateFile(
            resolvePackagePath(projectDir, request.path),
          );
          return mutationResult(
            options,
            `Updated ${pkg.manifest.id}@${pkg.manifest.version}`,
          );
        }
        case 'list':
          return service
            .list()
            .map((pkg) => {
              const role =
                pkg.manifest.kind === 'agent'
                  ? pkg.manifest.baseRole
                  : pkg.manifest.targetRole;
              return `${pkg.manifest.id}@${pkg.manifest.version}\t${pkg.manifest.kind}\t${role}\t${pkg.manifest.displayName}`;
            })
            .join('\n');
        case 'show':
          return formatPackageLine(service.show(request.packageId));
        case 'verify': {
          const results = service.verify(request.packageId);
          return results
            .map(
              (result) => `${result.valid ? 'OK' : 'FAIL'} ${result.message}`,
            )
            .join('\n');
        }
        case 'remove':
          service.remove(request.packageId, { force: request.force });
          return mutationResult(options, `Removed ${request.packageId}`);
        case 'enable':
          enableMarketplaceAgent(projectDir, request.packageId, service.store);
          return mutationResult(
            options,
            `Enabled ${request.packageId} in the active preset`,
          );
        case 'disable':
          disableMarketplacePackage(projectDir, request.packageId);
          return mutationResult(
            options,
            `Disabled ${request.packageId} in the active preset`,
          );
        case 'profile':
          if (request.clear === true) {
            setMarketplaceProfile(
              projectDir,
              request.role,
              null,
              service.store,
            );
            return mutationResult(
              options,
              `Cleared the ${request.role} profile`,
            );
          }
          if (!request.packageId) {
            throw new Error('profile requires a role and package ID');
          }
          setMarketplaceProfile(
            projectDir,
            request.role,
            request.packageId,
            service.store,
          );
          return mutationResult(
            options,
            `Selected ${request.packageId} for ${request.role}`,
          );
        case 'status':
          return formatMarketplaceStatus(
            collectMarketplaceStatus({
              service,
              projectDir,
              live: options.getLiveSnapshot?.(),
              desiredLive: options.getDesiredLive?.(),
            }),
          );
      }
    },
  });

  return { marketplace };
}
