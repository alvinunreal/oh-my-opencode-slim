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
    sha256: '0ffbb77d1549ebb725419c9685745d8914e165f9500b93d5981a5eb6c7caf027',
  },
  'host override': {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '787cb6140275257d97da3083acb6e6dd347b4deb68f31f44052ab1ffaa08a8ec',
  },
  preset: {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: 'acdd96deceb769d9735819940e5ec318dac161151debba5245a664c1dc380b6c',
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
    sha256: '0adb9239949e240a627fbf21d8b912b5e98d1c2c7cbc4fde0b2ba0acb15711a5',
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
    sha256: 'c2bc2d6139ab58deed5e4ac4c9e9dec002b32e80faee4b6325d92ce80fe83264',
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
    sha256: '5223497bf9b41bbf67588d0cf3a82e63294fda981ea00654d2cc373ce1a2a4f8',
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
    sha256: '022ca433c7a2e23fcb58224c696d03e7781fe0206e6e9228849edd0b8541a587',
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
    sha256: 'ab12bd9ebb885b3c79bdac23e4a7c4b951b17a23cfeb853c9d5c24fd7fd52752',
  },
  'empty host model': {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '7e7ec35a459cc39a78a5451d9f3640ff35acacfa4dda5b5a49248b53f2b9a17c',
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
