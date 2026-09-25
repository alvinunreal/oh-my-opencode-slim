import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildResolvedAgentRegistry,
  resolveDesiredMarketplaceLiveFromDisk,
} from '../agents';
import { loadPluginConfig } from '../config';
import { RuntimeConfig } from '../config/runtime';
import type { MarketplacePackageBundle } from './schemas';
import { MarketplaceService } from './service';
import { collectMarketplaceStatus } from './status';

const previousConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});

function agentBundle(
  id = 'community/docs-researcher',
  version = '1.0.0',
  overrides: Partial<MarketplacePackageBundle['manifest']> = {},
): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      version,
      displayName: 'Docs researcher',
      description: 'A derived explorer.',
      agentName: id.split('/')[1]?.replaceAll('-', '') ?? 'docsresearcher',
      prompt: 'Prefer documentation paths first.',
      author: { name: 'Community' },
      tags: ['docs'],
      license: 'MIT',
      compatibility: {
        plugin: '>=3.0.0-beta.3 <4.0.0',
      },
      routing: {
        description: 'Research docs.',
        keywords: ['docs'],
        when: 'When needed.',
      },
      skills: [],
      mcps: [],
      tools: [],
      model: { source: 'explicit', candidates: ['provider/model'] },
      ...overrides,
    } as MarketplacePackageBundle['manifest'],
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'marketplace-status-'));
  const configHome = join(root, 'config');
  const project = join(root, 'project');
  mkdirSync(join(configHome, 'opencode'), { recursive: true });
  mkdirSync(join(project, '.opencode'), { recursive: true });
  process.env.XDG_CONFIG_HOME = configHome;
  writeFileSync(
    join(configHome, 'opencode', 'oh-my-opencode-slim.json'),
    JSON.stringify({
      preset: 'work',
      presets: {
        work: {
          marketplace: { agents: ['community/docs-researcher'] },
        },
      },
    }),
  );
  const service = new MarketplaceService({
    rootDir: join(root, 'store'),
    projectDir: project,
  });
  return { root, project, service };
}

describe('marketplace status', () => {
  test('reports an unsupported permission policy as invalid rather than pending', () => {
    const { root, project, service } = setup();
    try {
      service.install(
        agentBundle('community/docs-researcher', '1.0.0', {
          tools: ['read'],
        }),
      );
      writeFileSync(
        join(root, 'config', 'opencode', 'oh-my-opencode-slim.json'),
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
              agents: {
                docsresearcher: {
                  permission: { read: { 'private/**': 'ask' } },
                },
              },
            },
          },
        }),
      );
      const directory = `${project}\0unsupported-status`;
      RuntimeConfig.reset(directory);
      const runtime = RuntimeConfig.init(directory, loadPluginConfig(project));
      const registry = buildResolvedAgentRegistry(runtime, {
        projectDirectory: project,
        marketplaceStore: service.store,
        hostFlavor: 'v2',
        nativePermissionsByAgent: {
          docsresearcher: [
            { action: 'read', resource: 'private/**', effect: 'deny' },
          ],
        },
      });
      const status = collectMarketplaceStatus({
        service,
        projectDir: project,
        live: {
          packages: registry.marketplaceLive,
          diagnostics: registry.diagnostics,
        },
        desiredLive: resolveDesiredMarketplaceLiveFromDisk(
          project,
          service.store,
          runtime.host(),
          registry,
        ),
      });
      expect(status.reloadStatus).toBe('applied');
      expect(status.live?.packages).toEqual([]);
      expect(status.diagnostics).toContainEqual({
        packageId: 'community/docs-researcher',
        code: 'unsupported-permission-policy',
        message:
          'community/docs-researcher is disabled: Unsupported marketplace permission composition for read: scoped ask private/** may reopen native deny read:private/**',
        provenance: 'live',
      });
      expect(
        status.diagnostics.some((entry) => entry.code === 'operational'),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('v2 configured MCP availability stays applied until disk configuration changes', () => {
    const { root, project, service } = setup();
    try {
      service.install(
        agentBundle('community/docs-researcher', '1.0.0', {
          mcps: ['custom_docs'],
        }),
      );
      const host = { mcp: { custom_docs: { type: 'remote' } } };
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            servers: {
              custom_docs: {
                type: 'remote',
                url: 'https://example.com/mcp',
              },
            },
          },
        }),
      );
      const directory = `${project}\0live-v2-status-test`;
      const configPath = join(
        root,
        'config',
        'opencode',
        'oh-my-opencode-slim.json',
      );
      RuntimeConfig.reset(directory);
      const runtime = RuntimeConfig.init(directory, loadPluginConfig(project));
      runtime.captureHostConfig(host);
      const liveRegistry = buildResolvedAgentRegistry(runtime, {
        projectDirectory: project,
        marketplaceStore: service.store,
        hostFlavor: 'v2',
        availableMcpNames: ['custom_docs'],
        preflightMcpNames: ['custom_docs'],
      });
      const live = {
        packages: liveRegistry.marketplaceLive,
        diagnostics: liveRegistry.diagnostics,
      };
      const status = () =>
        collectMarketplaceStatus({
          service,
          projectDir: project,
          live,
          desiredLive: resolveDesiredMarketplaceLiveFromDisk(
            project,
            service.store,
            runtime.host(),
            liveRegistry,
          ),
        });

      expect(live.packages).toHaveLength(1);
      expect(Object.isFrozen(liveRegistry.availableMcpNames)).toBe(true);
      expect(status().reloadStatus).toBe('applied');

      writeFileSync(
        configPath,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              agents: { docsresearcher: { displayName: 'docsalias' } },
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
      );
      expect(status().reloadStatus).toBe('pending');

      RuntimeConfig.reset(directory);
      const reloadedRuntime = RuntimeConfig.init(
        directory,
        loadPluginConfig(project),
      );
      reloadedRuntime.captureHostConfig(host);
      const reloadedRegistry = buildResolvedAgentRegistry(reloadedRuntime, {
        projectDirectory: project,
        marketplaceStore: service.store,
        hostFlavor: 'v2',
        availableMcpNames: liveRegistry.availableMcpNames,
        preflightMcpNames: liveRegistry.availableMcpNames,
      });
      const afterReload = collectMarketplaceStatus({
        service,
        projectDir: project,
        live: { packages: reloadedRegistry.marketplaceLive },
        desiredLive: resolveDesiredMarketplaceLiveFromDisk(
          project,
          service.store,
          reloadedRuntime.host(),
          reloadedRegistry,
        ),
      });
      expect(reloadedRegistry.marketplaceLive[0]?.runtimeName).toBe(
        'docsalias',
      );
      expect(afterReload.reloadStatus).toBe('applied');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const change of [
    'removed',
    'disabled',
    'added',
    'namespace collision',
  ] as const) {
    test(`v2 MCP ${change} is pending until reload`, () => {
      const { root, project, service } = setup();
      const runtimeDirectory = `${project}\0v2-mcp-status`;
      const mcpPath = join(project, '.opencode', 'opencode.json');
      const requiredMcp = change === 'added' ? 'new_docs' : 'custom_docs';
      const definition = {
        type: 'remote',
        url: 'https://example.com/mcp',
      };
      const initialServers =
        change === 'added' ? {} : { custom_docs: definition };
      const updatedServers =
        change === 'removed'
          ? {}
          : change === 'disabled'
            ? { custom_docs: { ...definition, disabled: true } }
            : change === 'added'
              ? { new_docs: definition }
              : { custom_docs: definition, custom_docs_extra: definition };
      const writeServers = (servers: Record<string, unknown>) =>
        writeFileSync(mcpPath, JSON.stringify({ mcp: { servers } }));
      const reload = (servers: Record<string, unknown>) => {
        RuntimeConfig.reset(runtimeDirectory);
        const runtime = RuntimeConfig.init(
          runtimeDirectory,
          loadPluginConfig(project),
        );
        const names = Object.entries(servers)
          .filter(([, value]) => !(value as { disabled?: boolean }).disabled)
          .map(([name]) => name);
        runtime.captureHostConfig({
          mcp: Object.fromEntries(names.map((name) => [name, servers[name]])),
        });
        const registry = buildResolvedAgentRegistry(runtime, {
          projectDirectory: project,
          marketplaceStore: service.store,
          hostFlavor: 'v2',
          availableMcpNames: names,
          preflightMcpNames: names,
        });
        return { runtime, registry };
      };
      const status = (live: ReturnType<typeof reload>) =>
        collectMarketplaceStatus({
          service,
          projectDir: project,
          live: { packages: live.registry.marketplaceLive },
          desiredLive: resolveDesiredMarketplaceLiveFromDisk(
            project,
            service.store,
            live.runtime.host(),
            live.registry,
          ),
        });
      try {
        service.install(
          agentBundle('community/docs-researcher', '1.0.0', {
            mcps: [requiredMcp],
          }),
        );
        writeServers(initialServers);
        const initial = reload(initialServers);
        expect(status(initial).reloadStatus).toBe('applied');

        writeServers(updatedServers);
        const pending = status(initial);
        expect(pending.reloadStatus).toBe('pending');
        if (change === 'namespace collision') {
          expect(pending.diagnostics).toContainEqual(
            expect.objectContaining({
              code: 'ambiguous-mcp-namespace',
              provenance: 'disk',
            }),
          );
        }
        expect(status(reload(updatedServers)).reloadStatus).toBe('applied');
      } finally {
        RuntimeConfig.reset(runtimeDirectory);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('v2 desired MCPs respect newly disabled Slim MCPs', () => {
    const { root, project, service } = setup();
    try {
      service.install(
        agentBundle('community/docs-researcher', '1.0.0', {
          mcps: ['context7'],
        }),
      );
      const configPath = join(
        root,
        'config',
        'opencode',
        'oh-my-opencode-slim.json',
      );
      const runtimeDirectory = `${project}\0v2-disabled-mcp`;
      RuntimeConfig.reset(runtimeDirectory);
      const runtime = RuntimeConfig.init(
        runtimeDirectory,
        loadPluginConfig(project),
      );
      const registry = buildResolvedAgentRegistry(runtime, {
        projectDirectory: project,
        marketplaceStore: service.store,
        hostFlavor: 'v2',
        availableMcpNames: ['context7'],
        preflightMcpNames: ['context7'],
      });
      expect(registry.marketplaceLive).toHaveLength(1);
      writeFileSync(
        configPath,
        JSON.stringify({
          preset: 'work',
          disabled_mcps: ['context7'],
          presets: {
            work: { marketplace: { agents: ['community/docs-researcher'] } },
          },
        }),
      );
      const desired = resolveDesiredMarketplaceLiveFromDisk(
        project,
        service.store,
        runtime.host(),
        registry,
      );
      expect(desired.packages).toEqual([]);
      expect(
        collectMarketplaceStatus({
          projectDir: project,
          service,
          live: { packages: registry.marketplaceLive },
          desiredLive: desired,
        }).reloadStatus,
      ).toBe('pending');
      RuntimeConfig.reset(runtimeDirectory);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('v1 desired registry retains on-disk MCP preflight', () => {
    const { root, project, service } = setup();
    try {
      service.install(
        agentBundle('community/docs-researcher', '1.0.0', {
          mcps: ['custom_docs'],
        }),
      );
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            custom_docs: {
              type: 'remote',
              url: 'https://example.com/mcp',
            },
          },
        }),
      );
      const desired = resolveDesiredMarketplaceLiveFromDisk(
        project,
        service.store,
        { mcp: {} },
        { hostFlavor: 'v1', availableMcpNames: [] },
      );
      expect(desired.packages).toHaveLength(1);
      expect(desired.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI without a live registry reports reload as unavailable', () => {
    const { root, project, service } = setup();
    try {
      service.install(agentBundle());
      const report = collectMarketplaceStatus({ service, projectDir: project });
      expect(report.reloadStatus).toBe('unavailable');
      expect(report.live).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('survives corrupt packages and labels disk diagnostics', () => {
    const { root, project, service } = setup();
    try {
      const installed = service.install(agentBundle());
      service.install(agentBundle('community/other', '1.0.0'));
      writeFileSync(join(installed.path, 'package.json'), '{broken');
      const report = collectMarketplaceStatus({
        service,
        projectDir: project,
      });
      expect(report.installed.some((pkg) => pkg.id === 'community/other')).toBe(
        true,
      );
      expect(
        report.installed.find((pkg) => pkg.id === 'community/docs-researcher')
          ?.valid,
      ).toBe(false);
      const corrupt = report.diagnostics.find(
        (entry) => entry.packageId === 'community/docs-researcher',
      );
      expect(corrupt?.code).toBe('corrupt');
      expect(corrupt?.provenance).toBe('disk');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps disk and live diagnostics of the same class when provenance differs', () => {
    const { root, project, service } = setup();
    try {
      const report = collectMarketplaceStatus({
        service,
        projectDir: project,
        live: {
          packages: [],
          diagnostics: [
            {
              packageId: 'community/docs-researcher',
              code: 'missing',
              message: 'live wording differs',
            },
            {
              packageId: 'community/docs-researcher',
              code: 'missing',
              message: 'duplicate live wording',
            },
          ],
        },
      });
      const missing = report.diagnostics.filter(
        (entry) =>
          entry.packageId === 'community/docs-researcher' &&
          entry.code === 'missing',
      );
      expect(missing.map((entry) => entry.provenance).sort()).toEqual([
        'disk',
        'live',
      ]);
      expect(
        report.live?.diagnostics.filter(
          (entry) =>
            entry.packageId === 'community/docs-researcher' &&
            entry.code === 'missing',
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('classifies inspect operational errors separately from corruption', () => {
    const { root, project, service } = setup();
    try {
      const inspect = spyOn(service.store, 'inspectAll');
      inspect.mockImplementation(() => {
        throw new Error('lease timed out');
      });
      const report = collectMarketplaceStatus({
        service,
        projectDir: project,
      });
      expect(
        report.diagnostics.some(
          (entry) =>
            entry.code === 'operational' && entry.message === 'lease timed out',
        ),
      ).toBe(true);
      expect(report.reloadStatus).toBe('unavailable');
      inspect.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('operational inspect leaves reload unavailable even with live identities', () => {
    const { root, project, service } = setup();
    try {
      const inspect = spyOn(service.store, 'inspectAll');
      inspect.mockImplementation(() => ({
        packages: [],
        verifications: [],
        operationalError: 'EACCES',
      }));
      const report = collectMarketplaceStatus({
        service,
        projectDir: project,
        live: { packages: [] },
        desiredLive: { packages: [] },
      });
      expect(report.reloadStatus).toBe('unavailable');
      inspect.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('compares desired registry identities so aliases match and collisions are excluded', () => {
    const { root, project, service } = setup();
    try {
      service.install(agentBundle('community/docs-researcher', '1.0.0'));
      service.install(
        agentBundle('community/reserved-explorer', '1.0.0', {
          agentName: 'explorer',
          displayName: 'Reserved explorer',
        }),
      );
      writeFileSync(
        join(root, 'config', 'opencode', 'oh-my-opencode-slim.json'),
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              agents: { docsresearcher: { displayName: 'docsalias' } },
              marketplace: {
                agents: [
                  'community/docs-researcher',
                  'community/reserved-explorer',
                ],
              },
            },
          },
        }),
      );
      const desiredLive = resolveDesiredMarketplaceLiveFromDisk(
        project,
        service.store,
      );
      expect(desiredLive.packages).toEqual([
        expect.objectContaining({
          packageId: 'community/docs-researcher',
          runtimeName: 'docsalias',
        }),
      ]);
      expect(
        desiredLive.diagnostics?.some(
          (entry) =>
            entry.packageId === 'community/reserved-explorer' &&
            entry.code === 'collision',
        ),
      ).toBe(true);
      const matching = collectMarketplaceStatus({
        service,
        projectDir: project,
        live: { packages: desiredLive.packages },
        desiredLive,
      });
      expect(matching.reloadStatus).toBe('applied');
      expect(
        matching.diagnostics.some(
          (entry) =>
            entry.packageId === 'community/reserved-explorer' &&
            entry.code === 'collision' &&
            entry.provenance === 'disk',
        ),
      ).toBe(true);
      const staleName = collectMarketplaceStatus({
        service,
        projectDir: project,
        live: {
          packages: desiredLive.packages.map((entry) => ({
            ...entry,
            runtimeName: 'docsresearcher',
          })),
        },
        desiredLive,
      });
      expect(staleName.reloadStatus).toBe('pending');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps desired rejection diagnostics in status', () => {
    const { root, project, service } = setup();
    try {
      service.install(agentBundle('community/docs-researcher', '1.0.0'));
      service.install(
        agentBundle('community/needs-skill', '1.0.0', {
          agentName: 'needsskill',
          displayName: 'Needs skill',
          skills: ['not-a-real-skill'],
          mcps: [],
        }),
      );
      writeFileSync(
        join(root, 'config', 'opencode', 'oh-my-opencode-slim.json'),
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              agents: { docsresearcher: { displayName: 'Docs Researcher' } },
              marketplace: {
                agents: ['community/docs-researcher', 'community/needs-skill'],
              },
            },
          },
        }),
      );
      const desiredLive = resolveDesiredMarketplaceLiveFromDisk(
        project,
        service.store,
      );
      expect(desiredLive.packages).toEqual([]);
      expect(
        desiredLive.diagnostics?.map((entry) => entry.code).sort(),
      ).toEqual(['invalid-alias', 'missing-required-dependency']);
      const report = collectMarketplaceStatus({
        service,
        projectDir: project,
        live: { packages: [] },
        desiredLive,
      });
      expect(report.reloadStatus).toBe('applied');
      expect(report.diagnostics.map((entry) => entry.code).sort()).toEqual([
        'invalid-alias',
        'missing-required-dependency',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unreadable lockfile is operational and leaves in-session reload unavailable', () => {
    const { root, project, service } = setup();
    try {
      service.install(agentBundle());
      chmodSync(service.store.paths.lockfilePath, 0);
      try {
        const desiredLive = resolveDesiredMarketplaceLiveFromDisk(
          project,
          service.store,
        );
        const report = collectMarketplaceStatus({
          service,
          projectDir: project,
          live: { packages: [] },
          desiredLive,
        });
        expect(
          report.diagnostics.some(
            (entry) =>
              entry.code === 'operational' &&
              /EACCES|permission/i.test(entry.message),
          ),
        ).toBe(true);
        expect(report.reloadStatus).toBe('unavailable');
      } finally {
        chmodSync(service.store.paths.lockfilePath, 0o644);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
