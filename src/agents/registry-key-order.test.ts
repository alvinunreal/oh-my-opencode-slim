import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { CouncilConfigSchema } from '../config';
import { RuntimeConfig } from '../config/runtime';
import type { MarketplaceActivationStore } from '../marketplace/activation';
import * as marketplaceImplementation from '../marketplace/registry-runtime';
import { MarketplacePackageManifestSchema } from '../marketplace/schemas';
import { createAgents } from './index';
import { buildResolvedAgentRegistry } from './registry';

// Re-pin recipe:
// Run this suite on the base commit (908f9a1f) with v2 options and print serialize(run()) per scenario.
// Re-pin only for intentional byte changes.
const DIR = 'runtime-key-order-registry';

function runtimeFor(config: Parameters<typeof RuntimeConfig.init>[1]) {
  RuntimeConfig.reset(DIR);
  return RuntimeConfig.init(DIR, config, 'v2');
}

function build(
  runtime: RuntimeConfig,
  hostSnapshot: Record<string, unknown>,
  options: Record<string, unknown> = {},
) {
  const definitions = createAgents(runtime, {
    hostFlavor: 'v2',
    ...options,
  } as Parameters<typeof createAgents>[1]);
  return buildResolvedAgentRegistry(runtime, {
    hostSnapshot,
    definitions,
    hostFlavor: 'v2',
    ...options,
  } as Parameters<typeof buildResolvedAgentRegistry>[1]);
}

function marketplacePackage(id: string, overrides: Record<string, unknown>) {
  const manifest = MarketplacePackageManifestSchema.parse({
    schemaVersion: 2,
    id,
    version: '1.0.0',
    displayName: 'Marketplace agent',
    description: 'Marketplace specialist',
    prompt: 'Package prompt',
    skills: ['skill-a'],
    mcps: ['host-mcp'],
    tools: ['read'],
    author: { name: 'Author' },
    tags: [],
    license: 'MIT',
    compatibility: { plugin: '>=1.0.0' },
    model: { source: 'explicit', candidates: ['provider/package'] },
    routing: {
      description: 'Specialist lane',
      when: 'Use for package work',
      keywords: ['package'],
    },
    ...overrides,
  });
  return {
    manifest,
    digest: 'a'.repeat(64),
    source: { type: 'registry', registry: 'https://example.test' },
    path: `/marketplace/${id}`,
  };
}

function marketplaceStore(
  packages: Record<string, ReturnType<typeof marketplacePackage>>,
): MarketplaceActivationStore {
  return {
    loadSelected(ids) {
      return {
        packages: new Map(
          ids.flatMap((id) => (packages[id] ? [[id, packages[id]]] : [])),
        ),
        errors: new Map(),
      };
    },
  };
}

function marketplaceOptions(
  selectedPackageIds: readonly string[],
  store: MarketplaceActivationStore,
) {
  return {
    marketplace: {
      implementation: marketplaceImplementation,
      selectedPackageIds,
      store,
      pluginVersion: '3.2.0',
      availableSkillNames: ['skill-a'],
    },
  };
}

const NATIVE_POLICY_PROBES = [
  ['read', '*'],
  ['bash', '*'],
  ['shell', '*'],
  ['task', '*'],
  ['skill', 'skill-a'],
  ['host-mcp_tool', '*'],
  ['external_directory', '*'],
] as const;

function serialize(registry: ReturnType<typeof build>) {
  const childPermissions = Object.fromEntries(
    registry.agentNames.map((name) => {
      try {
        return [name, registry.compileChildPermissions(name, [])];
      } catch (error) {
        return [name, error instanceof Error ? error.message : String(error)];
      }
    }),
  );
  const nativePolicies = Object.fromEntries(
    Object.entries(registry.nativePolicies).map(([name, policy]) => [
      name,
      NATIVE_POLICY_PROBES.map(([action, resource]) => [
        action,
        resource,
        policy.decide(action, resource),
      ]),
    ]),
  );
  const capture = {
    finalAgentConfig: Object.entries(registry.finalAgentConfig),
    effectiveStartupModels: registry.effectiveStartupModels,
    tuiAgentModels: registry.tuiAgentModels,
    tuiAgentVariants: registry.tuiAgentVariants,
    identities: registry.identities,
    modelCandidates: registry.modelCandidates,
    managedAgentConfig: registry.managedAgentConfig,
    childPermissions,
    nativePolicies,
  };
  const bytes = JSON.stringify(capture);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    keys: Object.keys(registry.finalAgentConfig),
    sha256,
  };
}

const EXPECTED: Record<string, { keys: string[]; sha256: string }> = {
  default: {
    keys: ['orchestrator', 'explorer', 'oracle', 'designer', 'fixer'],
    sha256: 'fef33c009ba2349899bb8d050a6ba813e2410e2ff2f96db7341676e85bef74d2',
  },
  'host override': {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '2b7bcf9a1cfc2b313c7a2881548be6ce594546aebe89939bcd94ea5193caa52e',
  },
  preset: {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '2c3eb0eb20dc21d4f00aa56da009e5a4269bb475974f59d5b78f1639ccea5399',
  },
  'marketplace orchestrator': {
    keys: [
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'orchestrator-agent',
    ],
    sha256: '353fd9b9b3bcf9253fd7466ee4e6417711d290f2c9460fcdcabfa4667cd4c538',
  },
  'marketplace builtin': {
    keys: [
      'FixerVisible',
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'writer-agent',
    ],
    sha256: '94c47a3cfdb8df7aac02a5847611472eddb9632a3efbbae34cf4691c3fb86b82',
  },
  'orchestrator display alias': {
    keys: [
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'orchestrator-agent',
      'Lead',
    ],
    sha256: 'e6bddaad7f54a0fb832b267fafc56aa651fb2fb8a321aacaf55e3c4b53d99ecf',
  },
  'session follow': {
    keys: [
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'follows-session',
    ],
    sha256: '547a1bf7f5a53674ee7a268f3bcea0bbcbf784e0a129e6024a4ea5450eb92be8',
  },
  'aliased council': {
    keys: [
      'council',
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'councillor',
      'councillor-alpha',
      'panel',
    ],
    sha256: '45f3c2123fe8d1c0cb27a1d0cc676dab8ea97cb51e0fdaacff49a4911e5cc90f',
  },
  'empty host model': {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '749befee6c3a3e4b8b358157393390facd881f3c9f76d39c02d3c8d47ee1bcc3',
  },
};

const SCENARIOS: Record<string, () => ReturnType<typeof build>> = {
  default: () => build(runtimeFor({}), {}),
  'empty host model': () =>
    build(runtimeFor({}), { agent: { explorer: { model: '' } } }),
  'host override': () =>
    build(runtimeFor({}), {
      agent: {
        explorer: { model: 'host/model' },
        orchestrator: { model: 'host/orchestrator', variant: 'host-v' },
      },
    }),
  preset: () => {
    const runtime = runtimeFor({
      presets: {
        child: { agents: { explorer: { model: 'preset/child' } } },
      },
    });
    runtime.setRuntimePreset('child');
    return build(runtime, {
      agent: { explorer: { prompt: 'host prompt' } },
    });
  },
  'marketplace orchestrator': () => {
    const packages = {
      'team/orchestrator': marketplacePackage('team/orchestrator', {
        agentName: 'orchestrator-agent',
        model: { source: 'orchestrator' },
      }),
    };
    return build(
      runtimeFor({}),
      {
        agent: { orchestrator: { model: 'host/orchestrator' } },
        mcp: { 'host-mcp': { type: 'local' } },
      },
      marketplaceOptions(Object.keys(packages), marketplaceStore(packages)),
    );
  },
  'marketplace builtin': () => {
    const packages = {
      'team/bash': marketplacePackage('team/bash', {
        agentName: 'writer-agent',
        extends: { builtin: 'fixer', promptMode: 'append' },
        tools: ['bash'],
        model: { source: 'builtin' },
      }),
    };
    return build(
      runtimeFor({
        agents: {
          fixer: { model: 'provider/fixer', displayName: 'FixerVisible' },
        },
      }),
      {
        agent: { FixerVisible: { model: 'host/fixer', variant: 'host-v' } },
        mcp: { 'host-mcp': { type: 'local' } },
      },
      marketplaceOptions(Object.keys(packages), marketplaceStore(packages)),
    );
  },
  'orchestrator display alias': () => {
    const packages = {
      'team/orchestrator-alias': marketplacePackage('team/orchestrator-alias', {
        agentName: 'orchestrator-agent',
        model: { source: 'orchestrator' },
      }),
    };
    return build(
      runtimeFor({
        agents: {
          orchestrator: {
            displayName: 'Lead',
            model: 'provider/orchestrator',
          },
        },
      }),
      { mcp: { 'host-mcp': { type: 'local' } } },
      marketplaceOptions(Object.keys(packages), marketplaceStore(packages)),
    );
  },
  'session follow': () => {
    const packages = {
      'team/follows-session': marketplacePackage('team/follows-session', {
        agentName: 'follows-session',
        model: { source: 'session' },
      }),
    };
    return build(
      runtimeFor({}),
      { mcp: { 'host-mcp': { type: 'local' } } },
      marketplaceOptions(Object.keys(packages), marketplaceStore(packages)),
    );
  },
  'aliased council': () =>
    build(
      runtimeFor({
        council: CouncilConfigSchema.parse({
          presets: { default: { alpha: { model: 'provider/council' } } },
        }),
        agents: { council: { displayName: 'panel' } },
      }),
      { agent: { council: { prompt: 'host council prompt' } } },
    ),
};

describe('finalAgentConfig key order and bytes (#1883 characterization)', () => {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    test(name, () => {
      const actual = serialize(run());
      expect(actual).toEqual(EXPECTED[name]);
    });
  }
});
