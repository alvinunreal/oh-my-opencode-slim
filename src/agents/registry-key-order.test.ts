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
// Run this suite on the base commit (8d202cbd) and print serialize(run()) per scenario.
// Re-pin only for intentional byte changes.
const DIR = 'runtime-key-order-registry';

function runtimeFor(config: Parameters<typeof RuntimeConfig.init>[1]) {
  RuntimeConfig.reset(DIR);
  return RuntimeConfig.init(DIR, config);
}

function build(
  runtime: RuntimeConfig,
  hostSnapshot: Record<string, unknown>,
  options: Record<string, unknown> = {},
) {
  const definitions = createAgents(
    runtime,
    options as Parameters<typeof createAgents>[1],
  );
  return buildResolvedAgentRegistry(runtime, {
    hostSnapshot,
    definitions,
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
    sha256: 'b85df70e8ce1f3696c9a13708c0c0e781be6cecc4b0da90a39b7e4f928cf131e',
  },
  'host override': {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: 'b3d8603d9bc944f105640b9093f87b9ef04569666776235d0078684c55d5a6af',
  },
  preset: {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: 'fadeea73ceb43080cd6fc3dd8afb630c2707985c6901af88daae0c307a13a523',
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
    sha256: '6517198ebaa7589f66a9630cb484cecdaa32725db2b9c09354c5ff16c28583fc',
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
    sha256: '938ab8e8db94329d4c3166dbb7c6d5e2e6edf93efddccdc2f06694ef362f7590',
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
    sha256: 'adb4fa530c2d2d6c5a5b639a8364890d2b6194fadad8dda6e4559f33e4f12d1f',
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
    sha256: '1141667db901c08a927d159948c8615b911eb1e265e07c8332c1cff1102b41c9',
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
    sha256: '9d493d1b3426cc6de022a5570cbd575470a356d3e44ffa38f4fc16acb6d0ecbf',
  },
  'empty host model': {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '416e1c73f31d6192f9d907db09b1e38d803256cb5ee8c9790446a348e36d7a86',
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
