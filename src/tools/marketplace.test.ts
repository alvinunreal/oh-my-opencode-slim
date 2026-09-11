import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isMarketplacePermissionDenied,
  resolveDesiredMarketplaceLiveFromDisk,
} from '../agents';
import type { MarketplacePackageBundle } from '../marketplace/schemas';
import { MarketplaceService } from '../marketplace/service';
import {
  MARKETPLACE_RELOAD_NOTICE,
  type MarketplaceLivePackage,
} from '../marketplace/status';
import { createMarketplaceTool, parseMarketplaceToolArgs } from './marketplace';

const previousConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});

function agentBundle(
  version = '1.0.0',
  overrides: Partial<MarketplacePackageBundle['manifest']> = {},
): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'community/docs-researcher',
      version,
      kind: 'agent',
      displayName: 'Docs researcher',
      description: 'A derived explorer.',
      instructions: 'Prefer documentation paths first.',
      author: { name: 'Community' },
      tags: ['docs'],
      license: 'MIT',
      compatibility: {
        plugin: '>=2.2.0 <3.0.0 || >=3.0.0-beta.0 <4.0.0',
        roleContract: '^1.0.0',
      },
      routing: {
        description: 'Research docs and examples.',
        keywords: ['docs'],
        delegation: {
          when: 'When docs research is needed.',
          preferredRoles: [],
        },
      },
      requirements: {
        skills: { required: [], optional: [] },
        mcps: { required: [], optional: [] },
      },
      capabilities: { tools: [], permissions: [] },
      baseRole: 'explorer',
      agentName: 'docsresearcher',
      overrides: {},
      ...overrides,
    } as MarketplacePackageBundle['manifest'],
  };
}

function profileBundle(): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'community/deep-explorer',
      version: '1.0.0',
      kind: 'profile',
      displayName: 'Deep explorer',
      description: 'A specialist profile.',
      instructions: 'Search more exhaustively than usual.',
      author: { name: 'Community' },
      tags: ['profile'],
      license: 'MIT',
      compatibility: {
        plugin: '>=2.2.0 <3.0.0 || >=3.0.0-beta.0 <4.0.0',
        roleContract: '^1.0.0',
      },
      routing: {
        description: 'Deep exploration profile.',
        keywords: ['deep'],
        delegation: {
          when: 'When exhaustive search is needed.',
          preferredRoles: [],
        },
      },
      requirements: {
        skills: { required: [], optional: [] },
        mcps: { required: [], optional: [] },
      },
      capabilities: { tools: [], permissions: [] },
      targetRole: 'explorer',
      instructionMode: 'append',
      overrides: {},
    } as MarketplacePackageBundle['manifest'],
  };
}

function writeBundle(
  directory: string,
  bundle: MarketplacePackageBundle,
  name = 'package.json',
): string {
  const filePath = join(directory, name);
  writeFileSync(filePath, JSON.stringify(bundle));
  return filePath;
}

function setupHarness() {
  const root = mkdtempSync(join(tmpdir(), 'marketplace-tool-'));
  const configHome = join(root, 'config');
  const project = join(root, 'project');
  mkdirSync(join(configHome, 'opencode'), { recursive: true });
  mkdirSync(join(project, '.opencode'), { recursive: true });
  process.env.XDG_CONFIG_HOME = configHome;
  writeFileSync(
    join(configHome, 'opencode', 'oh-my-opencode-slim.json'),
    JSON.stringify({
      preset: 'work',
      presets: { work: { agents: {} } },
    }),
  );
  const live = {
    packages: [] as MarketplaceLivePackage[],
  };
  const service = new MarketplaceService({
    rootDir: join(root, 'store'),
    projectDir: project,
  });
  const marketplace = createMarketplaceTool({
    service,
    projectDir: project,
    getLiveSnapshot: () => live,
    getDesiredLive: () =>
      resolveDesiredMarketplaceLiveFromDisk(project, service.store),
    shouldManageSession: () => true,
  }).marketplace;
  const context = {
    sessionID: 'parent-1',
    agent: 'orchestrator',
  } as never;
  return { root, project, configHome, service, marketplace, context, live };
}

describe('marketplace tool args', () => {
  test('rejects fields that do not belong to the action', () => {
    expect(() =>
      parseMarketplaceToolArgs({
        action: 'install',
        path: './package.json',
        packageId: 'community/docs-researcher',
      }),
    ).toThrow();
    expect(() =>
      parseMarketplaceToolArgs({ action: 'list', path: './package.json' }),
    ).toThrow();
    expect(() =>
      parseMarketplaceToolArgs({
        action: 'profile',
        role: 'explorer',
        packageId: 'community/deep-explorer',
        clear: true,
      }),
    ).toThrow();
  });
});

describe('marketplace tool', () => {
  test('covers local lifecycle, status, reload notice, and no live-registry mutation', async () => {
    const { root, project, configHome, marketplace, context, live } =
      setupHarness();
    try {
      const agentPath = writeBundle(project, agentBundle());
      const profilePath = writeBundle(project, profileBundle(), 'profile.json');
      const v2Path = writeBundle(
        project,
        agentBundle('1.1.0'),
        'package-v2.json',
      );

      const installed = String(
        await marketplace.execute(
          { action: 'import', path: agentPath },
          context,
        ),
      );
      expect(installed).toContain('Imported community/docs-researcher@1.0.0');
      expect(installed).toContain('reload_required: false');
      expect(installed).not.toContain(MARKETPLACE_RELOAD_NOTICE);

      const imported = String(
        await marketplace.execute(
          { action: 'import', path: profilePath },
          context,
        ),
      );
      expect(imported).toContain('Imported community/deep-explorer@1.0.0');
      expect(imported).toContain('reload_required: false');

      const listed = String(
        await marketplace.execute({ action: 'list' }, context),
      );
      expect(listed).toContain('community/deep-explorer@1.0.0');
      expect(listed).toContain('community/docs-researcher@1.0.0');

      const shown = String(
        await marketplace.execute(
          {
            action: 'show',
            packageId: 'community/docs-researcher',
          },
          context,
        ),
      );
      expect(shown).toContain('kind: agent');
      expect(shown).toContain('role: explorer');

      const verified = String(
        await marketplace.execute(
          {
            action: 'verify',
            packageId: 'community/docs-researcher',
          },
          context,
        ),
      );
      expect(verified).toContain('OK');

      const updated = String(
        await marketplace.execute(
          { action: 'import', path: v2Path, update: true },
          context,
        ),
      );
      expect(updated).toContain('Updated community/docs-researcher@1.1.0');
      expect(updated).toContain('reload_required: false');

      const enabled = String(
        await marketplace.execute(
          {
            action: 'enable',
            packageId: 'community/docs-researcher',
          },
          context,
        ),
      );
      expect(enabled).toContain('Enabled community/docs-researcher');
      expect(enabled).toContain('reload_required: true');
      expect(enabled).toContain(MARKETPLACE_RELOAD_NOTICE);
      expect(live.packages).toEqual([]);

      const profiled = String(
        await marketplace.execute(
          {
            action: 'profile',
            role: 'explorer',
            packageId: 'community/deep-explorer',
          },
          context,
        ),
      );
      expect(profiled).toContain(
        'Selected community/deep-explorer for explorer',
      );
      expect(profiled).toContain(MARKETPLACE_RELOAD_NOTICE);

      const statusAfterMutations = String(
        await marketplace.execute({ action: 'status' }, context),
      );
      expect(statusAfterMutations).toContain('reload_required: true');
      expect(statusAfterMutations).toContain('community/docs-researcher@1.1.0');
      expect(statusAfterMutations).toContain('configured_agents:');
      expect(statusAfterMutations).toContain('community/docs-researcher');
      expect(statusAfterMutations).toContain('live_packages:');
      expect(statusAfterMutations).toContain('  (none)');
      expect(statusAfterMutations).toContain(MARKETPLACE_RELOAD_NOTICE);

      const userConfig = JSON.parse(
        readFileSync(
          join(configHome, 'opencode', 'oh-my-opencode-slim.json'),
          'utf8',
        ),
      ) as {
        presets: {
          work: {
            marketplace: {
              agents: string[];
              profiles: Record<string, string | null>;
            };
          };
        };
      };
      expect(userConfig.presets.work.marketplace.agents).toEqual([
        'community/docs-researcher',
      ]);
      expect(userConfig.presets.work.marketplace.profiles.explorer).toBe(
        'community/deep-explorer',
      );

      const cleared = String(
        await marketplace.execute(
          { action: 'profile', role: 'explorer', clear: true },
          context,
        ),
      );
      expect(cleared).toContain('Cleared the explorer profile');

      const disabled = String(
        await marketplace.execute(
          {
            action: 'disable',
            packageId: 'community/docs-researcher',
          },
          context,
        ),
      );
      expect(disabled).toContain('Disabled community/docs-researcher');
      expect(disabled).toContain('reload_required: false');

      const removed = String(
        await marketplace.execute(
          {
            action: 'remove',
            packageId: 'community/deep-explorer',
          },
          context,
        ),
      );
      expect(removed).toContain('Removed community/deep-explorer');
      expect(live.packages).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports reload required for an active version update', async () => {
    const { root, project, service, marketplace, context, live } =
      setupHarness();
    try {
      const v1 = writeBundle(project, agentBundle());
      await marketplace.execute({ action: 'import', path: v1 }, context);
      await marketplace.execute(
        { action: 'enable', packageId: 'community/docs-researcher' },
        context,
      );
      const installed = service.show('community/docs-researcher');
      live.packages = [
        {
          packageId: installed.manifest.id,
          version: installed.manifest.version,
          digest: installed.digest,
          runtimeName: installed.manifest.agentName,
          kind: 'agent',
        },
      ];
      const v2 = writeBundle(project, agentBundle('1.1.0'), 'package-v2.json');
      const updated = String(
        await marketplace.execute(
          { action: 'import', path: v2, update: true },
          context,
        ),
      );
      expect(updated).toContain('reload_required: true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports reload required after force-removing a live package', async () => {
    const { root, project, service, marketplace, context, live } =
      setupHarness();
    try {
      const path = writeBundle(project, agentBundle());
      await marketplace.execute({ action: 'import', path }, context);
      await marketplace.execute(
        { action: 'enable', packageId: 'community/docs-researcher' },
        context,
      );
      const installed = service.show('community/docs-researcher');
      live.packages = [
        {
          packageId: installed.manifest.id,
          version: installed.manifest.version,
          digest: installed.digest,
          runtimeName: installed.manifest.agentName,
          kind: 'agent',
        },
      ];
      const removed = String(
        await marketplace.execute(
          {
            action: 'remove',
            packageId: 'community/docs-researcher',
            force: true,
          },
          context,
        ),
      );
      expect(removed).toContain('reload_required: true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not claim reload required for idempotent enable', async () => {
    const { root, project, service, marketplace, context, live } =
      setupHarness();
    try {
      const path = writeBundle(project, agentBundle());
      await marketplace.execute({ action: 'import', path }, context);
      await marketplace.execute(
        { action: 'enable', packageId: 'community/docs-researcher' },
        context,
      );
      const installed = service.show('community/docs-researcher');
      live.packages = [
        {
          packageId: installed.manifest.id,
          version: installed.manifest.version,
          digest: installed.digest,
          runtimeName: installed.manifest.agentName,
          kind: 'agent',
        },
      ];
      const again = String(
        await marketplace.execute(
          { action: 'enable', packageId: 'community/docs-researcher' },
          context,
        ),
      );
      expect(again).toContain('reload_required: false');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('enforces nested marketplace permission deny at execution', async () => {
    const { root, context } = setupHarness();
    const permission = { marketplace: { '*': 'deny' } };
    const denied = createMarketplaceTool({
      service: new MarketplaceService({
        rootDir: join(root, 'store-denied'),
        projectDir: root,
      }),
      projectDir: root,
      shouldManageSession: () => true,
      isMarketplaceDenied: () => isMarketplacePermissionDenied(permission),
    }).marketplace;
    try {
      expect(isMarketplacePermissionDenied(permission)).toBe(true);
      await expect(denied.execute({ action: 'list' }, context)).rejects.toThrow(
        'denied by permission',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects marketplace-derived, ACP, and alias callers at execution', async () => {
    const { root, marketplace } = setupHarness();
    try {
      for (const agent of ['docsresearcher', 'bridge', 'Scout']) {
        await expect(
          marketplace.execute({ action: 'status' }, {
            sessionID: 'parent-1',
            agent,
          } as never),
        ).rejects.toThrow('orchestrator');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects non-orchestrator callers', async () => {
    const { root, marketplace } = setupHarness();
    try {
      await expect(
        marketplace.execute({ action: 'list' }, {
          sessionID: 'child-1',
          agent: 'fixer',
        } as never),
      ).rejects.toThrow('orchestrator');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
