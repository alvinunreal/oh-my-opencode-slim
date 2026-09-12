import { isAbsolute, join } from 'node:path';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
  disableMarketplacePackage,
  enableMarketplaceAgent,
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
  'remove',
  'status',
] as const;

export type MarketplaceToolAction = (typeof MARKETPLACE_TOOL_ACTIONS)[number];

const MarketplaceToolRequestSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('install'), packageId: z.string().min(1) })
    .strict(),
  z
    .object({
      action: z.literal('import'),
      path: z.string().min(1),
      update: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ action: z.literal('update'), packageId: z.string().min(1) })
    .strict(),
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
    displayName: string;
    description: string;
  };
  source: unknown;
}): string {
  return [
    `${pkg.manifest.id}@${pkg.manifest.version}`,
    `displayName: ${pkg.manifest.displayName}`,
    `description: ${pkg.manifest.description}`,
    `source: ${JSON.stringify(pkg.source)}`,
  ].join('\n');
}

export function createMarketplaceTool(
  options: MarketplaceToolOptions,
): Record<'marketplace', ToolDefinition> {
  const marketplace = tool({
    description: `Manage marketplace packages.

Use install and update with a canonical package ID for the default HTTPS registry. Use import with a local path (and update=true for an existing package). Do not infer whether an argument is a path or registry ID. Do not shell out to the CLI for these actions.

list, show, verify, and status are read-only and always offline. Remote network work occurs only for explicit install/update. All mutations use the local transaction store and never hot-swap the live agent registry.

Action-specific fields: packageId for install/update/show/enable/disable/remove; path and optional update=true for import; no extra fields.`,
    args: {
      action: toolZ
        .enum(MARKETPLACE_TOOL_ACTIONS)
        .describe('Marketplace action to perform'),
      path: toolZ
        .string()
        .min(1)
        .optional()
        .describe('Local package.json path for explicit import'),
      packageId: toolZ
        .string()
        .min(1)
        .optional()
        .describe(
          'Canonical package ID for registry install/update or local actions',
        ),
      force: toolZ
        .boolean()
        .optional()
        .describe('Force remove even if the package is still referenced'),
      update: toolZ
        .boolean()
        .optional()
        .describe('Use with import to update an existing local package'),
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
        case 'install': {
          const pkg = await service.installRemote(
            request.packageId,
            toolContext?.abort,
          );
          return mutationResult(
            options,
            `Installed ${pkg.manifest.id}@${pkg.manifest.version}`,
          );
        }
        case 'import': {
          const pkg = request.update
            ? service.importFileUpdate(
                resolvePackagePath(projectDir, request.path),
              )
            : service.importFile(resolvePackagePath(projectDir, request.path));
          return mutationResult(
            options,
            `${request.update ? 'Updated' : 'Imported'} ${pkg.manifest.id}@${pkg.manifest.version}`,
          );
        }
        case 'update': {
          const pkg = await service.updateRemote(
            request.packageId,
            toolContext?.abort,
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
              return `${pkg.manifest.id}@${pkg.manifest.version}\t${pkg.manifest.displayName}`;
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
