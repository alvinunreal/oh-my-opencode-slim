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
    sha256: '157f9a302bcda21d1d4976f062f15e7b051d697cbf55e3560696cf4b9fdc3dfa',
  },
  'host override': {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: 'ff1ca89153286d7cfa15f7a338d7f757f88559ea06f68be63e93cbca27a7e1c5',
  },
  preset: {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '465ef29e7f47739fb3a2186fe9b634dd5b33e58e778dd7f3e73585d2757258d1',
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
    sha256: '227da58db5cc2b8b031b15df421e0a4e3e40cdeff68c2c0511426040e19f3db6',
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
    sha256: '5d7b3b7dfcfe4e7b21419ade0073029f204a1f417c48cc92f92ada06973dee80',
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
    sha256: 'e8bfba8a3ae0d5080911f9a71d62fe028bd1c891f4cb0355ce03731cad1ab4c4',
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
    sha256: '3caa730009dddd737567f5cdd53deab9add821dacd44dce2c2db28da2574b592',
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
    sha256: 'a0d6daf421b8976daa083d92a27dc5253150359c7f011dbfdce44a752b60363c',
  },
  'empty host model': {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '0b8b0b4cd85f08e2ac40dc6ba92fbc714a97ba4e81f136c115f79b620f785901',
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
