import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResolvedAgentRegistry } from '../agents';
import { RuntimeConfig } from '../config/runtime';
import { PresetSchema } from '../config/schema';
import { adaptPermissions } from '../v2/adapters';
import {
  composePackagePrompt,
  resolveMarketplaceActivation,
} from './activation';
import { RETIRED_MARKETPLACE_PACKAGE_IDS } from './retirements';
import {
  MarketplaceAgentManifestSchema,
  MarketplacePackageBundleSchema,
} from './schemas';
import { MarketplaceStore } from './store';

const manifest = {
  schemaVersion: 2,
  id: 'community/example',
  version: '1.0.0',
  displayName: 'Example agent',
  description: 'An example marketplace agent.',
  agentName: 'example-agent',
  prompt: 'Package instructions.',
  routing: {
    description: 'Example work.',
    when: 'When appropriate.',
    keywords: ['example'],
  },
  skills: ['simplify'],
  mcps: ['context7'],
  tools: ['read', 'webfetch'],
  author: { name: 'Community' },
  tags: ['example'],
  license: 'MIT',
  compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
  model: {
    source: 'explicit',
    candidates: ['provider/model-a', 'provider/model-b'],
  },
} as const;

function bundle(overrides: Record<string, unknown> = {}) {
  return { manifest: { ...manifest, ...overrides } };
}

describe('agents-only marketplace contract', () => {
  test('requires v2 complete manifests and rejects removed fields', () => {
    expect(MarketplaceAgentManifestSchema.safeParse(manifest).success).toBe(
      true,
    );
    expect(
      MarketplacePackageBundleSchema.safeParse({
        manifest: { ...manifest, legacyField: true },
      }).success,
    ).toBe(false);
    expect(
      MarketplacePackageBundleSchema.safeParse({
        manifest: {
          ...manifest,
          compatibility: { plugin: '>=3.0.0', legacyContract: '^1.0.0' },
        },
      }).success,
    ).toBe(false);
    expect(
      PresetSchema.safeParse({
        marketplace: { agents: ['community/example'], legacyField: {} },
      }).success,
    ).toBe(false);
  });

  test('rejects builtin model policy without an extension', () => {
    expect(
      MarketplaceAgentManifestSchema.safeParse({
        ...manifest,
        model: { source: 'builtin' },
      }).success,
    ).toBe(false);
  });

  test('composes extension prompts in append and replace modes', () => {
    expect(
      composePackagePrompt('Builtin prompt.', 'Package prompt.', 'append'),
    ).toBe('Builtin prompt.\n\nPackage prompt.');
    expect(
      composePackagePrompt('Builtin prompt.', 'Package prompt.', 'replace'),
    ).toBe('Package prompt.');
  });

  test('uses exact declared capabilities and keeps readonly extensions readonly', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-v2-'));
    try {
      const store = new MarketplaceStore({
        rootDir: root,
        pluginVersion: '3.0.0-beta.3',
      });
      store.install(
        bundle({
          id: 'community/standalone',
          agentName: 'standalone',
          skills: [],
          mcps: [],
          tools: ['read'],
        }),
      );
      store.install(
        bundle({
          id: 'community/derived',
          agentName: 'derived',
          skills: [],
          mcps: [],
          tools: ['read'],
          extends: { builtin: 'explorer', promptMode: 'append' },
          model: { source: 'builtin' },
        }),
      );
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: {
            agents: {},
            marketplace: {
              agents: ['community/standalone', 'community/derived'],
            },
          },
        },
      });
      const registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
        availableMcpNames: ['context7'],
      });
      expect(registry.mcpLists.standalone).toEqual([]);
      expect(registry.sdkConfigs.standalone.permission?.read).toBe('allow');
      expect(registry.sdkConfigs.standalone.permission?.bash).toBe('deny');
      expect(registry.modelArrays.standalone).toEqual([
        { id: 'provider/model-a' },
        { id: 'provider/model-b' },
      ]);
      expect(registry.sdkConfigs.derived.permission?.edit).toBe('deny');
      expect(
        registry.agents.find((agent) => agent.name === 'explorer'),
      ).toBeDefined();
      expect(registry.provenance.explorer).toBe('builtin:explorer');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('owner model overrides replace package fallback chains', () => {
    const cases = [
      {
        owner: { model: 'owner/selected' },
        expectedModel: 'owner/selected',
        expectedChain: [{ id: 'owner/selected' }],
      },
      {
        owner: { inheritModelFrom: 'session' as const },
        expectedModel: undefined,
        expectedChain: undefined,
      },
      {
        owner: { inheritModelFrom: 'orchestrator' as const },
        orchestrator: { model: 'owner/orchestrator' },
        expectedModel: 'owner/orchestrator',
        expectedChain: [{ id: 'owner/orchestrator' }],
      },
    ] as const;

    for (const current of cases) {
      const root = mkdtempSync(join(tmpdir(), 'marketplace-model-'));
      try {
        const store = new MarketplaceStore({
          rootDir: root,
          pluginVersion: '3.0.0-beta.3',
        });
        store.install(
          bundle({
            id: 'community/model-chain',
            agentName: 'model-chain',
            skills: [],
            mcps: [],
            tools: ['read'],
          }),
        );
        RuntimeConfig.reset(root);
        const runtime = RuntimeConfig.init(root, {
          preset: 'work',
          presets: {
            work: {
              agents: {
                'model-chain': current.owner,
                ...(current.orchestrator
                  ? { orchestrator: current.orchestrator }
                  : {}),
              },
              marketplace: { agents: ['community/model-chain'] },
            },
          },
        });
        const registry = buildResolvedAgentRegistry(runtime, {
          marketplaceStore: store,
          availableMcpNames: [],
        });
        expect(registry.sdkConfigs['model-chain'].model).toBe(
          current.expectedModel,
        );
        expect(registry.modelArrays['model-chain']).toEqual(
          current.expectedChain,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test(
    'model replacements clear package variants and keep surfaces aligned',
    () => {
      const cases = [
        {
          owner: { model: 'owner/scalar' },
          expectedModel: 'owner/scalar',
          expectedVariant: undefined,
          expectedChain: [{ id: 'owner/scalar' }],
        },
        {
          owner: { model: 'owner/scalar', variant: 'owner-scalar' },
          expectedModel: 'owner/scalar',
          expectedVariant: 'owner-scalar',
          expectedChain: [{ id: 'owner/scalar', variant: 'owner-scalar' }],
        },
        {
          owner: {
            model: [
              { id: 'owner/array', variant: 'owner-array' },
              'owner/fallback',
            ],
          },
          expectedModel: 'owner/array',
          expectedVariant: 'owner-array',
          expectedChain: [
            { id: 'owner/array', variant: 'owner-array' },
            { id: 'owner/fallback' },
          ],
        },
        {
          owner: { model: ['owner/array', 'owner/fallback'] },
          expectedModel: 'owner/array',
          expectedVariant: undefined,
          expectedChain: [{ id: 'owner/array' }, { id: 'owner/fallback' }],
        },
        {
          owner: { inheritModelFrom: 'session' as const },
          expectedModel: undefined,
          expectedVariant: undefined,
          expectedChain: undefined,
        },
        {
          owner: {
            inheritModelFrom: 'session' as const,
            variant: 'owner-session',
          },
          expectedModel: undefined,
          expectedVariant: 'owner-session',
          expectedChain: undefined,
        },
        {
          owner: { inheritModelFrom: 'orchestrator' as const },
          orchestrator: { model: 'owner/orchestrator' },
          expectedModel: 'owner/orchestrator',
          expectedVariant: undefined,
          expectedChain: [{ id: 'owner/orchestrator' }],
        },
        {
          owner: {
            inheritModelFrom: 'orchestrator' as const,
            variant: 'owner-orchestrator',
          },
          orchestrator: { model: 'owner/orchestrator' },
          expectedModel: 'owner/orchestrator',
          expectedVariant: 'owner-orchestrator',
          expectedChain: [
            { id: 'owner/orchestrator', variant: 'owner-orchestrator' },
          ],
        },
        {
          owner: {},
          host: { model: 'host/replacement' },
          expectedModel: 'host/replacement',
          expectedVariant: undefined,
          expectedChain: [{ id: 'host/replacement' }],
        },
        {
          owner: {},
          host: { model: 'host/replacement', variant: 'host-variant' },
          expectedModel: 'host/replacement',
          expectedVariant: 'host-variant',
          expectedChain: [{ id: 'host/replacement', variant: 'host-variant' }],
        },
      ] as const;

      for (const current of cases) {
        const root = mkdtempSync(join(tmpdir(), 'marketplace-model-variant-'));
        try {
          const store = new MarketplaceStore({
            rootDir: root,
            pluginVersion: '3.0.0-beta.3',
          });
          store.install(
            bundle({
              id: 'community/model-variant-chain',
              agentName: 'model-variant-chain',
              skills: [],
              mcps: [],
              tools: ['read'],
              model: {
                source: 'explicit',
                candidates: [
                  { id: 'package/primary', variant: 'package-variant' },
                  { id: 'package/fallback', variant: 'package-fallback' },
                ],
              },
            }),
          );
          RuntimeConfig.reset(root);
          const runtime = RuntimeConfig.init(root, {
            preset: 'work',
            presets: {
              work: {
                agents: {
                  'model-variant-chain': current.owner,
                  ...(current.orchestrator
                    ? { orchestrator: current.orchestrator }
                    : {}),
                },
                marketplace: { agents: ['community/model-variant-chain'] },
              },
            },
          });
          if (current.host) {
            runtime.captureHostConfig({
              agent: { 'model-variant-chain': current.host },
            });
          }

          const registry = buildResolvedAgentRegistry(runtime, {
            marketplaceStore: store,
            availableMcpNames: [],
          });
          const sdkConfig = registry.sdkConfigs['model-variant-chain'];
          expect(sdkConfig.model).toBe(current.expectedModel);
          expect(sdkConfig.variant).toBe(current.expectedVariant);
          expect(registry.modelArrays['model-variant-chain']).toEqual(
            current.expectedChain,
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
    { timeout: 15_000 },
  );

  test('uses canonical retirement IDs and rejects them before install', () => {
    expect(RETIRED_MARKETPLACE_PACKAGE_IDS).toHaveLength(3);
    const store = new MarketplaceStore({
      rootDir: mkdtempSync(join(tmpdir(), 'marketplace-retired-')),
    });
    expect(() =>
      store.install(bundle({ id: RETIRED_MARKETPLACE_PACKAGE_IDS[0] })),
    ).toThrow('retired');
  });

  test('activation reports deterministic collisions', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-collision-'));
    try {
      const store = new MarketplaceStore({
        rootDir: root,
        pluginVersion: '3.0.0-beta.3',
      });
      store.install(
        bundle({
          id: 'community/one',
          agentName: 'same',
          skills: [],
          mcps: [],
          tools: [],
        }),
      );
      store.install(
        bundle({
          id: 'community/two',
          agentName: 'same',
          skills: [],
          mcps: [],
          tools: [],
        }),
      );
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: {
            agents: {},
            marketplace: { agents: ['community/two', 'community/one'] },
          },
        },
      });
      const plan = resolveMarketplaceActivation({
        runtime,
        store,
        availableSkillNames: [],
        availableMcpNames: [],
      });
      expect(plan.agents).toHaveLength(1);
      expect(
        plan.diagnostics.some((diagnostic) => diagnostic.code === 'collision'),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('caps marketplace permissions and MCPs on v1 and v2 hosts', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-capabilities-'));
    try {
      const store = new MarketplaceStore({
        rootDir: root,
        pluginVersion: '3.0.0-beta.3',
      });
      store.install(
        bundle({
          id: 'community/capped',
          agentName: 'capped',
          skills: [],
          mcps: ['context7'],
          tools: ['read'],
        }),
      );
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: {
            agents: {
              capped: {
                permission: {
                  '*': 'allow',
                  read: 'ask',
                  'context7_*': 'deny',
                },
              },
            },
            marketplace: { agents: ['community/capped'] },
          },
        },
      });
      runtime.captureHostConfig({
        agent: {
          capped: {
            permission: { '*': 'allow', edit: 'allow', 'gh_grep_*': 'allow' },
            tools: { task: true, acp_run: true, edit: true, read: true },
          },
        },
      });
      const registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
        availableMcpNames: ['context7', 'gh_grep'],
        preflightMcpNames: ['context7'],
      });
      const permission = registry.sdkConfigs.capped.permission as Record<
        string,
        unknown
      >;
      expect(permission['*']).toBe('deny');
      expect(permission.read).toBe('ask');
      expect(permission.edit).toBe('deny');
      expect(permission.task).toBe('deny');
      expect(permission.acp_run).toBe('deny');
      expect(permission.lsp).toBe('deny');
      expect(permission.list).toBe('deny');
      expect(permission.codesearch).toBe('deny');
      expect(permission['context7_*']).toBe('deny');
      expect(permission['gh_grep_*']).toBe('deny');
      expect(registry.sdkConfigs.capped.tools).toEqual({
        read: true,
      });

      const v2Rules = adaptPermissions(permission);
      expect(
        v2Rules.some(
          (rule) => rule.resource === 'read' && rule.effect === 'ask',
        ),
      ).toBe(true);
      expect(
        v2Rules.some(
          (rule) => rule.resource === 'codesearch' && rule.effect === 'deny',
        ),
      ).toBe(true);
      expect(
        v2Rules.some(
          (rule) => rule.resource === 'context7_*' && rule.effect === 'deny',
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('projects owner and host wildcard deny/ask onto package surfaces', () => {
    for (const owner of [true, false]) {
      for (const action of ['deny', 'ask'] as const) {
        const root = mkdtempSync(join(tmpdir(), 'marketplace-wildcard-'));
        try {
          const store = new MarketplaceStore({
            rootDir: root,
            pluginVersion: '3.0.0-beta.3',
          });
          store.install(
            bundle({
              id: 'community/wildcard',
              agentName: 'wildcard',
              skills: [],
              mcps: ['context7'],
              tools: ['read'],
            }),
          );
          RuntimeConfig.reset(root);
          const runtime = RuntimeConfig.init(root, {
            preset: 'work',
            presets: {
              work: {
                agents: owner
                  ? { wildcard: { permission: { '*': action } } }
                  : {},
                marketplace: { agents: ['community/wildcard'] },
              },
            },
          });
          if (!owner) {
            runtime.captureHostConfig({
              agent: { wildcard: { permission: { '*': action } } },
            });
          }
          const permission = buildResolvedAgentRegistry(runtime, {
            marketplaceStore: store,
            availableMcpNames: ['context7'],
            preflightMcpNames: ['context7'],
          }).sdkConfigs.wildcard.permission as Record<string, unknown>;

          expect(permission.read).toBe(action);
          expect(permission['context7_*']).toBe(action);
          expect(permission.edit).toBe('deny');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });

  test('keeps empty and limited skill ceilings default-deny', () => {
    const cases = [
      {
        id: 'community/empty-skills',
        agentName: 'empty-skills',
        manifest: { skills: [] },
        override: { skills: ['*', 'undeclared'] },
        expectedPermission: {},
      },
      {
        id: 'community/limited-skills',
        agentName: 'limited-skills',
        manifest: { skills: ['simplify'] },
        override: { skills: ['*', 'undeclared'] },
        expectedPermission: { simplify: 'allow' },
      },
      {
        id: 'community/denied-skills',
        agentName: 'denied-skills',
        manifest: { skills: ['simplify'] },
        override: { permission: { skill: 'deny' } },
        expectedPermission: 'deny',
      },
    ] as const;

    for (const current of cases) {
      const root = mkdtempSync(join(tmpdir(), 'marketplace-skills-'));
      try {
        const store = new MarketplaceStore({
          rootDir: root,
          pluginVersion: '3.0.0-beta.3',
        });
        store.install(
          bundle({
            id: current.id,
            agentName: current.agentName,
            skills: current.manifest.skills,
            mcps: [],
            tools: ['read'],
          }),
        );
        RuntimeConfig.reset(root);
        const runtime = RuntimeConfig.init(root, {
          preset: 'work',
          presets: {
            work: {
              agents: { [current.agentName]: current.override },
              marketplace: { agents: [current.id] },
            },
          },
        });
        const registry = buildResolvedAgentRegistry(runtime, {
          marketplaceStore: store,
          availableMcpNames: [],
        });
        const permission = registry.sdkConfigs[current.agentName]
          .permission as Record<string, unknown>;
        expect(permission.skill).toEqual(current.expectedPermission);
        expect(registry.skillPermissions[current.agentName]).toEqual(
          current.expectedPermission === 'deny'
            ? {}
            : current.expectedPermission,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('owner skill deny remains deny under host wildcard and nested ask', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-skill-deny-'));
    try {
      const store = new MarketplaceStore({
        rootDir: root,
        pluginVersion: '3.0.0-beta.3',
      });
      store.install(
        bundle({
          id: 'community/skill-deny',
          agentName: 'skill-deny',
          skills: ['simplify'],
          mcps: [],
          tools: ['read'],
        }),
      );
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: {
            agents: {
              'skill-deny': { permission: { skill: { '*': 'deny' } } },
            },
            marketplace: { agents: ['community/skill-deny'] },
          },
        },
      });
      runtime.captureHostConfig({
        agent: {
          'skill-deny': {
            permission: { '*': 'ask', skill: { '*': 'ask' } },
          },
        },
      });
      const registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
        availableMcpNames: [],
      });
      expect(registry.sdkConfigs['skill-deny'].permission?.skill).toBe('deny');
      expect(registry.skillPermissions['skill-deny']).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
