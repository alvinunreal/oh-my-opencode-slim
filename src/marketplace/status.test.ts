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
import { resolveDesiredMarketplaceLiveFromDisk } from '../agents';
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
      schemaVersion: 1,
      id,
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
        description: 'Research docs.',
        keywords: ['docs'],
        delegation: { when: 'When needed.', preferredRoles: [] },
      },
      requirements: {
        skills: { required: [], optional: [] },
        mcps: { required: [], optional: [] },
      },
      capabilities: { tools: [], permissions: [] },
      baseRole: 'explorer',
      agentName: id.split('/')[1]?.replaceAll('-', '') ?? 'docsresearcher',
      overrides: {},
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
          agents: {},
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
  test('CLI without a live registry reports reload status unknown', () => {
    const { root, project, service } = setup();
    try {
      service.install(agentBundle());
      const report = collectMarketplaceStatus({ service, projectDir: project });
      expect(report.reloadRequired).toBe('unknown');
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
      expect(report.reloadRequired).toBe('unknown');
      inspect.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('operational inspect leaves reload unknown even with live identities', () => {
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
      expect(report.reloadRequired).toBe('unknown');
      inspect.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('compares desired registry identities so aliases match and collisions are excluded', () => {
    const { root, project, service } = setup();
    try {
      service.install(
        agentBundle('community/docs-researcher', '1.0.0', {
          overrides: { displayName: 'docsalias' },
        }),
      );
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
              agents: {},
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
      expect(matching.reloadRequired).toBe(false);
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
      expect(staleName.reloadRequired).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps desired rejection diagnostics in status', () => {
    const { root, project, service } = setup();
    try {
      service.install(
        agentBundle('community/docs-researcher', '1.0.0', {
          overrides: { displayName: 'Docs Researcher' },
        }),
      );
      service.install(
        agentBundle('community/needs-skill', '1.0.0', {
          agentName: 'needsskill',
          displayName: 'Needs skill',
          requirements: {
            skills: { required: ['not-a-real-skill'], optional: [] },
            mcps: { required: [], optional: [] },
          },
        }),
      );
      writeFileSync(
        join(root, 'config', 'opencode', 'oh-my-opencode-slim.json'),
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              agents: {},
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
      expect(report.reloadRequired).toBe(false);
      expect(report.diagnostics.map((entry) => entry.code).sort()).toEqual([
        'invalid-alias',
        'missing-required-dependency',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unreadable lockfile is operational and leaves in-session reload unknown', () => {
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
        expect(report.reloadRequired).toBe('unknown');
      } finally {
        chmodSync(service.store.paths.lockfilePath, 0o644);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
