import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginConfig } from '../config';
import { CouncilConfigSchema } from '../config/council-schema';
import { RuntimeConfig } from '../config/runtime';
import { createFilterAvailableSkillsHook } from '../hooks/filter-available-skills';
import { MarketplaceAgentManifestSchema } from '../marketplace/schemas';
import { MarketplaceStore } from '../marketplace/store';
import type { V2PermissionRule } from '../v2/types';
import { COUNCIL_SYNTHESIS_REINFORCEMENT } from './council';
import {
  buildResolvedAgentRegistry,
  createAgents,
  projectAgentPermission,
  type ResolvedAgentRegistry,
} from './index';
import {
  ROLE_DEFINITIONS,
  SUPPORTED_SPECIALIST_ROLES,
} from './role-definitions';
import { TASK_REJECTION_INSTRUCTION } from './task-rejection';

const DIRECTORY = 'resolved-agent-registry-test';

function registryFor(config: PluginConfig = {}): ResolvedAgentRegistry {
  RuntimeConfig.reset(DIRECTORY);
  const runtime = RuntimeConfig.init(DIRECTORY, config);
  return buildResolvedAgentRegistry(runtime);
}

describe('ResolvedAgentRegistry', () => {
  test('excludes only marketplace packages with unsupported native permission composition', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-unsupported-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      for (const [id, agentName] of [
        ['community/blocked', 'blocked'],
        ['community/healthy', 'healthy'],
      ] as const) {
        store.install({
          manifest: {
            schemaVersion: 2,
            id,
            version: '1.0.0',
            displayName: agentName,
            agentName,
            description: `${agentName} agent`,
            prompt: `${agentName} prompt`,
            extends: { builtin: 'explorer', promptMode: 'append' },
            skills: [],
            mcps: [],
            tools: ['read'],
            author: { name: 'Community' },
            tags: [],
            license: 'MIT',
            compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
            model: { source: 'explicit', candidates: ['provider/model'] },
            routing: {
              description: `${agentName} routing`,
              when: 'Needed',
              keywords: [agentName],
            },
          },
        });
      }
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: {
            marketplace: {
              agents: ['community/blocked', 'community/healthy'],
            },
          },
        },
        agents: {
          blocked: {
            displayName: 'blockedalias',
            model: 'owner/model',
            permission: { read: { 'private/**': 'ask' } },
          },
          healthy: { displayName: 'healthyalias' },
        },
      });
      const options = {
        marketplaceStore: store,
        hostFlavor: 'v2',
        nativePermissionsByAgent: {
          blockedalias: [
            { action: 'read', resource: 'private/**', effect: 'deny' },
          ],
        },
      } as const;
      const registry = buildResolvedAgentRegistry(runtime, options);
      expect(registry.diagnostics).toEqual([
        {
          packageId: 'community/blocked',
          code: 'unsupported-permission-policy',
          message:
            'community/blocked is disabled: Unsupported marketplace permission composition for read: scoped ask private/** may reopen native deny read:private/**',
        },
      ]);
      expect(registry.agents.map((agent) => agent.name)).toContain('explorer');
      expect(registry.agents.map((agent) => agent.name)).toContain('healthy');
      expect(registry.marketplaceLive.map((entry) => entry.packageId)).toEqual([
        'community/healthy',
      ]);
      expect(
        registry.routing.some((entry) => entry.agentName === 'healthyalias'),
      ).toBe(true);
      for (const name of ['blocked', 'blockedalias']) {
        expect(registry.agents.some((agent) => agent.name === name)).toBe(
          false,
        );
        expect(registry.sdkConfigs[name]).toBeUndefined();
        expect(registry.v2PermissionPolicies[name]).toBeUndefined();
        expect(registry.modelArrays[name]).toBeUndefined();
        expect(registry.modelChains[name]).toBeUndefined();
        expect(registry.configuredModelChains[name]).toBeUndefined();
        expect(registry.mcpLists[name]).toBeUndefined();
        expect(registry.provenance[name]).toBeUndefined();
        expect(registry.packageIdByRuntimeName[name]).toBeUndefined();
        expect(registry.routing.some((entry) => entry.agentName === name)).toBe(
          false,
        );
      }
      expect(
        registry.runtimeNameByPackageId['community/blocked'],
      ).toBeUndefined();
      expect(registry.sdkConfigs.healthyalias).toBeDefined();
      expect(registry.v2PermissionPolicies.healthy).toBe(
        registry.v2PermissionPolicies.healthyalias,
      );
      expect(Object.isFrozen(registry)).toBe(true);

      const supported = buildResolvedAgentRegistry(runtime, {
        ...options,
        nativePermissionsByAgent: {
          blockedalias: [
            { action: '*', resource: '*', effect: 'deny' },
            { action: 'read', resource: '*', effect: 'allow' },
          ],
        },
      });
      expect(supported.diagnostics).toEqual([]);
      expect(supported.sdkConfigs.blockedalias).toBeDefined();
      expect(
        supported.v2PermissionPolicies.blocked.decide('read', 'private/x'),
      ).toBe('ask');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('compiles ordered native host rules once and shares frozen policy with aliases', () => {
    RuntimeConfig.reset(DIRECTORY);
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        explorer: { model: 'provider/explorer', displayName: 'scout' },
      },
    });
    const hostRules: V2PermissionRule[] = [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
    ];
    const registry = buildResolvedAgentRegistry(runtime, {
      hostFlavor: 'v2',
      nativePermissionsByAgent: { scout: hostRules },
    });
    const policy = registry.v2PermissionPolicies.explorer;

    expect(policy).toBe(registry.v2PermissionPolicies.scout);
    expect(registry.v2PermissionPolicies.explore).toBe(policy);
    expect(policy.decide('read', 'src/index.ts')).toBe('allow');
    expect(policy.decide('edit', 'src/index.ts')).toBe('deny');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.rules)).toBe(true);
    assert(hostRules[1]);
    hostRules[1].effect = 'deny';
    expect(policy.decide('read', 'src/index.ts')).toBe('allow');
  });

  test('keeps immutable subagent gates after native host wildcard allows', () => {
    RuntimeConfig.reset(DIRECTORY);
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: { explorer: { displayName: 'scout' } },
    });
    const registry = buildResolvedAgentRegistry(runtime, {
      hostFlavor: 'v2',
      nativePermissionsByAgent: {
        scout: [
          { action: 'read', resource: 'src/**', effect: 'deny' },
          { action: 'read', resource: 'src/public.ts', effect: 'allow' },
          { action: '*', resource: '*', effect: 'allow' },
        ],
      },
    });
    const policy = registry.v2PermissionPolicies.explorer;
    expect(registry.v2PermissionPolicies.scout).toBe(policy);
    expect(registry.v2PermissionPolicies.explore).toBe(policy);
    for (const action of ['marketplace', 'wait_for_user']) {
      expect(policy.decide(action, 'anything')).toBe('deny');
      expect(
        policy.rules.findLast(
          (rule) =>
            (rule.action === action || rule.action === '*') &&
            rule.resource === '*',
        )?.effect,
      ).toBe('deny');
    }
    expect(policy.decide('read', 'src/public.ts')).toBe('allow');

    const exception = buildResolvedAgentRegistry(runtime, {
      hostFlavor: 'v2',
      nativePermissionsByAgent: {
        scout: [
          { action: 'read', resource: 'src/**', effect: 'deny' },
          { action: 'read', resource: 'src/public.ts', effect: 'allow' },
        ],
      },
    }).v2PermissionPolicies.scout;
    expect(exception.decide('read', 'src/private.ts')).toBe('deny');
    expect(exception.decide('read', 'src/public.ts')).toBe('allow');
  });

  test('includes MCP exclusions in ordered v2 rules while preserving v1 projection', () => {
    RuntimeConfig.reset(DIRECTORY);
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: { explorer: { mcps: ['docs', '!private'] } },
    });
    const options = {
      availableMcpNames: ['docs', 'private', 'other'],
    };
    const registry = buildResolvedAgentRegistry(runtime, {
      ...options,
      hostFlavor: 'v2',
    });
    const policy = registry.v2PermissionPolicies.explorer;
    expect(policy.decide('docs_search', '*')).toBe('allow');
    expect(policy.decide('private_search', '*')).toBe('deny');
    expect(policy.decide('other_search', '*')).toBe('deny');
    expect(
      policy.rules.findLast((rule) => rule.action === 'private_*')?.effect,
    ).toBe('deny');
    expect(
      policy.rules.findLast((rule) => rule.action === 'docs_*')?.effect,
    ).toBe('allow');
    expect(registry.sdkConfigs.explorer.permission).toMatchObject({
      'docs_*': 'allow',
      'private_*': 'deny',
      'other_*': 'deny',
    });

    const withNativeHost = buildResolvedAgentRegistry(runtime, {
      ...options,
      hostFlavor: 'v2',
      nativePermissionsByAgent: {
        explorer: [{ action: 'private_*', resource: '*', effect: 'allow' }],
      },
    });
    expect(
      withNativeHost.v2PermissionPolicies.explorer.decide(
        'private_search',
        '*',
      ),
    ).toBe('allow');
    expect(
      buildResolvedAgentRegistry(runtime, options).sdkConfigs.explorer
        .permission,
    ).toMatchObject({
      'docs_*': 'allow',
      'private_*': 'deny',
      'other_*': 'deny',
    });
  });

  test('projects owner skill and namespace restrictions into marketplace native rules', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-policy-'));
    try {
      const store = new MarketplaceStore({
        rootDir: root,
        pluginVersion: '3.0.0-beta.3',
      });
      store.install({
        manifest: {
          schemaVersion: 2,
          id: 'community/analyst',
          version: '1.0.0',
          displayName: 'Analyst',
          agentName: 'analyst',
          description: 'Analyze.',
          prompt: 'Analyze.',
          skills: ['simplify', 'clonedeps'],
          mcps: ['context7', 'github'],
          tools: ['read', 'bash'],
          author: { name: 'Community' },
          tags: ['analysis'],
          license: 'MIT',
          compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
          model: { source: 'explicit', candidates: ['provider/model'] },
          routing: {
            description: 'Analysis',
            when: 'Needed',
            keywords: ['analysis'],
          },
        },
      });
      RuntimeConfig.reset(root);
      const baselineRuntime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: { agents: {}, marketplace: { agents: ['community/analyst'] } },
        },
      });
      const registryOptions = {
        marketplaceStore: store,
        availableMcpNames: ['context7', 'github'],
        preflightSkillNames: ['simplify', 'clonedeps'],
        preflightMcpNames: ['context7', 'github'],
      };
      const baseline = buildResolvedAgentRegistry(
        baselineRuntime,
        registryOptions,
      ).v2PermissionPolicies.analyst;
      expect(baseline.decide('context7_search', '*')).toBe('allow');
      expect(
        baseline.rules.findLast(
          (rule) =>
            (rule.action === 'context7_*' || rule.action === '*') &&
            rule.resource === '*',
        )?.effect,
      ).toBe('allow');
      expect(baseline.decide('other_server_tool', '*')).toBe('deny');
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: { agents: {}, marketplace: { agents: ['community/analyst'] } },
        },
        agents: {
          analyst: {
            displayName: 'audit',
            permission: {
              skill: { simplify: 'deny', clonedeps: 'ask' },
              'context7_*': 'deny',
              'github_*': 'ask',
            },
          },
        },
      });
      const registry = buildResolvedAgentRegistry(runtime, {
        ...registryOptions,
        nativePermissionsByAgent: {
          audit: [{ action: '*', resource: '*', effect: 'allow' }],
        },
      });
      const policy = registry.v2PermissionPolicies.analyst;
      expect(registry.v2PermissionPolicies.audit).toBe(policy);
      for (const [action, resource, effect] of [
        ['skill', 'simplify', 'deny'],
        ['skill', 'clonedeps', 'ask'],
        ['context7_search', '*', 'deny'],
        ['github_search', '*', 'ask'],
      ] as const) {
        expect(policy.decide(action, resource)).toBe(effect);
        expect(
          policy.rules.findLast(
            (rule) =>
              (rule.action === action ||
                rule.action === '*' ||
                (rule.action.endsWith('_*') &&
                  action.startsWith(rule.action.slice(0, -1)))) &&
              (rule.resource === resource || rule.resource === '*'),
          )?.effect,
        ).toBe(effect);
      }
      expect(registry.skillPermissions.audit.simplify).toBe('deny');
      expect(registry.skillPermissions.audit.clonedeps).toBe('ask');
      RuntimeConfig.reset(root);
      const scalarRuntime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: { agents: {}, marketplace: { agents: ['community/analyst'] } },
        },
        agents: { analyst: { permission: { skill: 'deny' } } },
      });
      const scalarRegistry = buildResolvedAgentRegistry(
        scalarRuntime,
        registryOptions,
      );
      expect(scalarRegistry.skillPermissions.analyst).toEqual({ '*': 'deny' });
      expect(
        scalarRegistry.v2PermissionPolicies.analyst.decideSkill('simplify'),
      ).toBe('deny');
      expect(policy.decide('other_server_tool', '*')).toBe('deny');

      runtime.captureHostConfig({
        agent: {
          audit: {
            permission: {
              read: { 'private/**': 'deny' },
              bash: { '*': 'deny' },
            },
          },
        },
      });
      const scoped = buildResolvedAgentRegistry(runtime, registryOptions);
      expect(scoped.sdkConfigs.analyst.permission).toMatchObject({
        read: { '*': 'allow', 'private/**': 'deny' },
        bash: 'deny',
      });
      const scopedPolicy = scoped.v2PermissionPolicies.analyst;
      expect(scopedPolicy.decide('read', 'private/secret')).toBe('deny');
      expect(scopedPolicy.decide('read', 'public/file')).toBe('allow');
      expect(scopedPolicy.decide('execute', 'echo hello')).toBe('deny');
      for (const [action, resource, effect] of [
        ['read', 'private/secret', 'deny'],
        ['read', 'public/file', 'allow'],
        ['execute', 'echo hello', 'deny'],
      ] as const) {
        expect(
          scopedPolicy.rules.findLast(
            (rule) =>
              (rule.action === action || rule.action === '*') &&
              (rule.resource === '*' || rule.resource === 'private/**') &&
              (rule.resource === '*' || resource.startsWith('private/')),
          )?.effect,
        ).toBe(effect);
      }

      RuntimeConfig.reset(root);
      const narrowRuntime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: { agents: {}, marketplace: { agents: ['community/analyst'] } },
        },
        agents: { analyst: { permission: { read: { 'private/**': 'deny' } } } },
      });
      narrowRuntime.captureHostConfig({
        agent: {
          analyst: {
            permission: {
              read: {
                '*': 'ask',
                'private/*': 'ask',
                'public/**': 'ask',
              },
            },
          },
        },
      });
      const narrow = buildResolvedAgentRegistry(narrowRuntime, registryOptions);
      expect(narrow.sdkConfigs.analyst.permission).toMatchObject({
        read: {
          '*': 'ask',
          'private/*': 'ask',
          'private/**': 'deny',
          'public/**': 'ask',
        },
      });
      const readMap = (
        narrow.sdkConfigs.analyst.permission as Record<string, unknown>
      ).read as Record<string, string>;
      const v1Decision = (resource: string) =>
        Object.entries(readMap).findLast(([pattern]) =>
          new RegExp(`^${pattern.replaceAll('*', '.*')}$`).test(resource),
        )?.[1];
      expect(v1Decision('private/x')).toBe('deny');
      expect(v1Decision('public/x')).toBe('ask');
      expect(v1Decision('other/x')).toBe('ask');
      expect(
        narrow.v2PermissionPolicies.analyst.decide('read', 'private/x'),
      ).toBe('deny');
      expect(
        narrow.v2PermissionPolicies.analyst.decide('read', 'public/x'),
      ).toBe('ask');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps disabled role skills outside marketplace ceilings and skill visibility', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-disabled-skill-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install({
        manifest: {
          schemaVersion: 2,
          id: 'community/reviewer',
          version: '1.0.0',
          displayName: 'Reviewer',
          agentName: 'reviewer',
          description: 'Review.',
          prompt: 'Review.',
          extends: { builtin: 'oracle', promptMode: 'append' },
          skills: ['clonedeps'],
          mcps: [],
          tools: [],
          author: { name: 'Community' },
          tags: [],
          license: 'MIT',
          compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
          model: { source: 'builtin' },
          routing: {
            description: 'Reviews.',
            when: 'Needed.',
            keywords: ['review'],
          },
        },
      });
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        disabled_skills: ['simplify'],
        preset: 'work',
        presets: {
          work: { marketplace: { agents: ['community/reviewer'] } },
        },
        agents: { reviewer: { skills: ['*'] } },
      });
      const registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
        preflightSkillNames: ['clonedeps'],
        hostFlavor: 'v2',
        nativePermissionsByAgent: {
          reviewer: [{ action: '*', resource: '*', effect: 'allow' }],
        },
      });
      const v1Registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
        preflightSkillNames: ['clonedeps'],
        hostFlavor: 'v1',
      });
      const v1Skills = (
        v1Registry.sdkConfigs.reviewer.permission as Record<string, unknown>
      ).skill as Record<string, string>;
      expect(v1Skills.simplify).not.toBe('allow');
      expect(v1Skills.clonedeps).toBe('allow');
      const permission = registry.sdkConfigs.reviewer.permission as Record<
        string,
        unknown
      >;
      const skills = permission.skill as Record<string, string>;
      expect(skills.simplify).not.toBe('allow');
      expect(skills['requesting-code-review']).toBe('allow');
      expect(skills.clonedeps).toBe('allow');
      expect(
        registry.v2PermissionPolicies.reviewer.decide('skill', 'simplify'),
      ).toBe('deny');
      expect(
        registry.v2PermissionPolicies.reviewer.decide(
          'skill',
          'requesting-code-review',
        ),
      ).toBe('allow');
      expect(
        registry.v2PermissionPolicies.reviewer.decide('skill', 'clonedeps'),
      ).toBe('allow');
      expect(Object.isFrozen(registry.skillPermissions.reviewer)).toBe(true);
      expect(registry.skillPermissions.reviewer.simplify).not.toBe('allow');
      expect(registry.skillPermissions.reviewer.clonedeps).toBe('allow');

      const hook = createFilterAvailableSkillsHook({} as PluginInput, registry);
      const output = {
        messages: [
          {
            info: { role: 'system' },
            parts: [
              {
                type: 'text',
                text: '<available_skills><skill><name>simplify</name></skill><skill><name>clonedeps</name></skill><skill><name>requesting-code-review</name></skill></available_skills>',
              },
            ],
          },
          {
            info: { role: 'user', agent: 'reviewer' },
            parts: [{ type: 'text', text: 'review' }],
          },
        ],
      };
      await hook['experimental.chat.messages.transform']({}, output);
      expect(output.messages[0].parts[0].text).not.toContain(
        '<name>simplify</name>',
      );
      expect(output.messages[0].parts[0].text).toContain(
        '<name>clonedeps</name>',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps deny-all authoritative for a role-derived agent under v2 matching', () => {
    const registry = registryFor({
      agents: {
        audit: {
          baseRole: 'fixer',
          model: 'provider/audit',
          permission: 'deny',
        },
      },
    });
    const permission = registry.sdkConfigs.audit?.permission as Record<
      string,
      unknown
    >;

    // v2 resolves an explicit tool rule after the wildcard, so any generated
    // allow would reopen that tool. Only immutable deny gates may be added.
    const v2EffectivePermission = (tool: string): unknown =>
      permission[tool] ?? permission['*'];
    expect(v2EffectivePermission('read')).toBe('deny');
    expect(v2EffectivePermission('edit')).toBe('deny');
    expect(v2EffectivePermission('question')).toBe('deny');
    expect(v2EffectivePermission('task_cancel')).toBe('deny');
    expect(permission.wait_for_user).toBe('deny');
    expect(permission.marketplace).toBe('deny');
  });

  test('keeps wildcard ask effective for built-in and custom role defaults', () => {
    const config: PluginConfig = {
      agents: {
        fixer: { permission: 'ask' },
        audit: {
          baseRole: 'oracle',
          model: 'provider/audit',
          permission: 'ask',
        },
      },
    };
    for (const hostFlavor of [undefined, 'v2']) {
      RuntimeConfig.reset(DIRECTORY);
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init(DIRECTORY, config),
        { hostFlavor },
      );
      for (const name of ['fixer', 'audit']) {
        const permission = registry.sdkConfigs[name]?.permission as Record<
          string,
          unknown
        >;
        expect(permission['*']).toBe('ask');
        expect(permission.read ?? permission['*']).toBe('ask');
        expect(permission.skill ?? permission['*']).toBe('ask');
        expect(permission.question ?? permission['*']).toBe('ask');
        expect(permission.task_cancel).toBe('deny');
        expect(permission.wait_for_user).toBe('deny');
        expect(permission.marketplace).toBe('deny');
        if (name === 'fixer') {
          expect(permission.edit ?? permission['*']).toBe('ask');
        } else {
          expect(permission.edit).toBe('deny');
        }
        if (hostFlavor === 'v2') {
          const policy = registry.v2PermissionPolicies[name];
          expect(policy.decide('read', 'src/index.ts')).toBe('ask');
          expect(
            policy.rules.findLast(
              (rule) => rule.action === 'read' || rule.action === '*',
            )?.effect,
          ).toBe('ask');
          expect(policy.decide('question', '*')).toBe('ask');
          expect(policy.decideSkill('simplify')).toBe('ask');
        }
      }
    }
  });

  test('preserves explicit skill restrictions and intentional read exceptions', () => {
    const registry = registryFor({
      agents: {
        fixer: {
          permission: { '*': 'ask', read: 'allow', skill: 'deny' },
        },
        audit: {
          baseRole: 'fixer',
          model: 'provider/audit',
          permission: {
            '*': 'ask',
            read: { '*': 'ask', 'public/**': 'allow' },
            skill: { '*': 'deny', simplify: 'allow' },
          },
        },
      },
    });
    const fixer = registry.sdkConfigs.fixer.permission as Record<
      string,
      unknown
    >;
    expect(fixer.read).toBe('allow');
    expect(fixer.skill).toBe('deny');
    expect(registry.skillPermissions.fixer).toEqual({ '*': 'deny' });
    expect(registry.v2PermissionPolicies.fixer.decideSkill('simplify')).toBe(
      'deny',
    );
    const audit = registry.sdkConfigs.audit.permission as Record<
      string,
      unknown
    >;
    expect(audit.read).toEqual({ '*': 'ask', 'public/**': 'allow' });
    expect(audit.skill).toMatchObject({ '*': 'deny', simplify: 'allow' });
    expect(
      registry.v2PermissionPolicies.audit.decide('read', 'private/x'),
    ).toBe('ask');
    expect(registry.v2PermissionPolicies.audit.decide('read', 'public/x')).toBe(
      'allow',
    );
    expect(registry.v2PermissionPolicies.audit.decideSkill('other')).toBe(
      'deny',
    );
    expect(registry.v2PermissionPolicies.audit.decideSkill('simplify')).toBe(
      'allow',
    );
  });

  test('captures scalar skill actions for aliases instead of role grants', () => {
    const registry = registryFor({
      agents: {
        oracle: {
          displayName: 'advisor',
          permission: { skill: 'deny' },
        },
        audit: {
          baseRole: 'oracle',
          model: 'provider/audit',
          permission: { skill: 'ask' },
        },
      },
    });
    expect(registry.sdkConfigs.oracle.permission?.skill).toBe('deny');
    expect(registry.skillPermissions.oracle).toEqual({ '*': 'deny' });
    expect(registry.skillPermissions.advisor).toEqual(
      registry.skillPermissions.oracle,
    );
    expect(Object.isFrozen(registry.skillPermissions.oracle)).toBe(true);
    expect(registry.v2PermissionPolicies.advisor.decideSkill('simplify')).toBe(
      'deny',
    );
    expect(registry.skillPermissions.audit).toEqual({ '*': 'ask' });
    expect(registry.v2PermissionPolicies.audit.decideSkill('simplify')).toBe(
      'ask',
    );
  });

  test('native v2 host rules retain their ordered ask and explicit exception', () => {
    RuntimeConfig.reset(DIRECTORY);
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: { fixer: { permission: 'ask' } },
    });
    const registry = buildResolvedAgentRegistry(runtime, {
      hostFlavor: 'v2',
      nativePermissionsByAgent: {
        fixer: [
          { action: '*', resource: '*', effect: 'ask' },
          { action: 'read', resource: 'public/**', effect: 'allow' },
        ],
      },
    });
    const policy = registry.v2PermissionPolicies.fixer;
    expect(policy.decide('read', 'private/x')).toBe('ask');
    expect(policy.decide('read', 'public/x')).toBe('allow');
    expect(
      policy.rules.findLast((rule) => rule.action === 'read')?.effect,
    ).toBe('allow');
    expect(policy.decide('marketplace', '*')).toBe('deny');
  });

  test('keeps SDK, model, skill, MCP, and routing surfaces consistent', () => {
    const registry = registryFor({
      agents: {
        explorer: {
          model: ['provider/primary', 'provider/fallback'],
          skills: ['simplify'],
          mcps: ['context7'],
        },
      },
    });

    expect(registry.agents.map((agent) => agent.name)).toContain('explorer');
    expect(registry.sdkConfigs.explorer.model).toBe('provider/primary');
    expect(registry.modelArrays.explorer).toEqual([
      { id: 'provider/primary' },
      { id: 'provider/fallback' },
    ]);
    expect(registry.modelChains.explorer).toEqual([
      'provider/primary',
      'provider/fallback',
    ]);
    expect(registry.mcpLists.explorer).toEqual(['context7']);
    expect(registry.skillPermissions.explorer.simplify).toBe('allow');
    expect(registry.runtimeNameByCanonicalId.explorer).toBe('explorer');
    expect(registry.canonicalIdByRuntimeName.explorer).toBe('explorer');
    expect(registry.routing.map((entry) => entry.agentName)).toEqual(
      [...registry.routing].map((entry) => entry.agentName).sort(),
    );
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.modelArrays.explorer)).toBe(true);
    expect(Object.isFrozen(registry.sdkConfigs.explorer)).toBe(true);
    expect(Object.isFrozen(registry.sdkConfigs.explorer.permission)).toBe(true);
  });

  test('keeps configured model candidates separate from host-selected models', () => {
    RuntimeConfig.reset(DIRECTORY);
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        explorer: {
          model: [
            'provider/configured-primary',
            'provider/configured-fallback',
          ],
          displayName: 'field-researcher',
        },
      },
    });
    runtime.captureHostConfig({
      agent: { 'field-researcher': { model: 'provider/session-selection' } },
    });

    const registry = buildResolvedAgentRegistry(runtime);
    const configuredChain = [
      'provider/configured-primary',
      'provider/configured-fallback',
    ];

    expect(registry.configuredModelChains.explorer).toEqual(configuredChain);
    expect(registry.configuredModelChains['field-researcher']).toEqual(
      configuredChain,
    );
    expect(registry.modelChains.explorer).toEqual([
      'provider/session-selection',
    ]);
    expect(registry.modelChains['field-researcher']).toEqual([
      'provider/session-selection',
    ]);
    expect(Object.isFrozen(registry.configuredModelChains)).toBe(true);
    expect(Object.isFrozen(registry.configuredModelChains.explorer)).toBe(true);
  });

  test('keeps configured chains available without a host model selection', () => {
    const registry = registryFor({
      agents: {
        explorer: {
          model: [
            'provider/configured-primary',
            'provider/configured-fallback',
          ],
        },
      },
    });

    expect(registry.configuredModelChains.explorer).toEqual([
      'provider/configured-primary',
      'provider/configured-fallback',
    ]);
    expect(registry.modelChains.explorer).toEqual(
      registry.configuredModelChains.explorer,
    );
  });

  test('does not expose special agents as supported role definitions', async () => {
    const { SUPPORTED_SPECIALIST_ROLES } = await import('./role-definitions');
    expect(SUPPORTED_SPECIALIST_ROLES).not.toContain('orchestrator');
    expect(SUPPORTED_SPECIALIST_ROLES).not.toContain('councillor');
  });

  test('preserves complete built-in role parity', () => {
    const registry = registryFor({ disabled_agents: [] });
    for (const roleName of SUPPORTED_SPECIALIST_ROLES) {
      const role = ROLE_DEFINITIONS[roleName];
      const agent = registry.agents.find((entry) => entry.name === roleName);
      expect(agent?.baseRole).toBe(roleName);
      expect(agent?.config.prompt).toContain(role.basePrompt);
      expect(agent?.description).toBe(role.description);
      expect(registry.mcpLists[roleName]).toEqual([...role.defaultMcps]);
      expect(registry.routing).toContainEqual(
        expect.objectContaining({ agentName: roleName }),
      );
      const permission = registry.sdkConfigs[roleName]?.permission as Record<
        string,
        unknown
      >;
      expect(permission.edit).toBe(
        role.permissionPolicy === 'read-write' ? 'allow' : 'deny',
      );
      for (const skill of role.defaultSkills) {
        expect(
          (registry.skillPermissions[roleName] as Record<string, unknown>)[
            skill
          ],
        ).toBe('allow');
      }
    }
  });

  test('discovers preset-only custom agents and preserves their model chains', () => {
    const registry = registryFor({
      preset: 'custom',
      presets: {
        custom: {
          auditOracle: {
            baseRole: 'oracle',
            model: ['provider/one', 'provider/two'],
          },
        },
      },
    });

    expect(registry.agents.map((agent) => agent.name)).toContain('auditOracle');
    expect(registry.modelArrays.auditOracle).toEqual([
      { id: 'provider/one' },
      { id: 'provider/two' },
    ]);
    expect(registry.modelChains.auditOracle).toEqual([
      'provider/one',
      'provider/two',
    ]);
  });

  test('preserves explicit model chains when inheritance is also configured', () => {
    const registry = registryFor({
      agents: {
        orchestrator: { model: 'provider/orchestrator' },
        inheritSession: {
          model: [
            { id: 'provider/session-primary', variant: 'chain-head' },
            'provider/session-fallback',
          ],
          inheritModelFrom: 'session',
        },
        inheritOrchestrator: {
          model: [
            { id: 'provider/orchestrator-primary', variant: 'chain-head' },
            'provider/orchestrator-fallback',
          ],
          inheritModelFrom: 'orchestrator',
        },
      },
    });

    expect(registry.modelChains.inheritSession).toEqual([
      'provider/session-primary',
      'provider/session-fallback',
    ]);
    expect(registry.modelChains.inheritOrchestrator).toEqual([
      'provider/orchestrator-primary',
      'provider/orchestrator-fallback',
    ]);
    expect(registry.modelArrays.inheritSession?.[0]?.variant).toBe(
      'chain-head',
    );
    expect(registry.modelArrays.inheritOrchestrator?.[0]?.variant).toBe(
      'chain-head',
    );
    expect(registry.sdkConfigs.inheritSession?.model).toBeUndefined();
    expect(registry.sdkConfigs.inheritSession?.variant).toBeUndefined();
    expect(registry.sdkConfigs.inheritOrchestrator?.model).toBe(
      'provider/orchestrator',
    );
    expect(registry.sdkConfigs.inheritOrchestrator?.variant).toBeUndefined();
  });

  test('marketplace role append keeps baseline while replace and owner prompt take precedence', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-role-prompt-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      for (const promptMode of ['append', 'replace'] as const) {
        const name = `${promptMode}role`;
        store.install({
          manifest: {
            schemaVersion: 2,
            id: `community/${name}`,
            version: '1.0.0',
            displayName: name,
            agentName: name,
            description: 'Role extension.',
            prompt: 'Package instruction.',
            extends: { builtin: 'oracle', promptMode },
            skills: [],
            mcps: [],
            tools: [],
            author: { name: 'Community' },
            tags: [],
            license: 'MIT',
            compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
            model: { source: 'builtin' },
            routing: {
              description: 'Role routing.',
              when: 'Needed.',
              keywords: ['role'],
            },
          },
        });
      }
      const config: PluginConfig = {
        preset: 'work',
        presets: {
          work: {
            marketplace: {
              agents: ['community/appendrole', 'community/replacerole'],
            },
          },
        },
      };
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, config);
      const registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
      });
      const baselinePrompt = ROLE_DEFINITIONS.oracle.createBaseline(
        ROLE_DEFINITIONS.oracle.defaultModel,
      ).config.prompt;
      expect(registry.sdkConfigs.appendrole?.prompt).toBe(
        `${baselinePrompt}\n\nPackage instruction.`,
      );
      expect(registry.sdkConfigs.replacerole?.prompt).toBe(
        'Package instruction.',
      );

      RuntimeConfig.reset(root);
      const overridden = RuntimeConfig.init(root, {
        ...config,
        agents: { appendrole: { prompt: 'Owner instruction.' } },
      });
      expect(
        buildResolvedAgentRegistry(overridden, { marketplaceStore: store })
          .sdkConfigs.appendrole?.prompt,
      ).toBe('Owner instruction.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves standalone marketplace orchestrator models before owner overrides', () => {
    const manifest = MarketplaceAgentManifestSchema.parse({
      schemaVersion: 2,
      id: 'example/researcher',
      version: '1.0.0',
      displayName: 'Researcher',
      agentName: 'researcher',
      description: 'Independent research agent',
      prompt: 'Research carefully.',
      skills: [],
      mcps: [],
      tools: [],
      author: { name: 'Example' },
      tags: [],
      license: 'MIT',
      compatibility: { plugin: '*' },
      model: { source: 'orchestrator' },
      routing: {
        description: 'Independent research',
        when: 'External research is needed',
        keywords: ['research'],
      },
    });
    const marketplace = {
      agents: [
        {
          packageId: manifest.id,
          version: manifest.version,
          digest: 'test-digest',
          manifest,
          requiredSkills: [],
          requiredMcps: [],
        },
      ],
      diagnostics: [],
    };

    RuntimeConfig.reset(DIRECTORY);
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: { orchestrator: { model: 'provider/orchestrator' } },
    });
    const baseline = createAgents(runtime, { marketplace }).find(
      (agent) => agent.name === 'researcher',
    );
    expect(baseline?.config.model).toBe('provider/orchestrator');

    RuntimeConfig.reset(DIRECTORY);
    const ownerRuntime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        orchestrator: { model: 'provider/orchestrator' },
        researcher: { model: 'provider/owner' },
      },
    });
    const ownerOverride = createAgents(ownerRuntime, { marketplace }).find(
      (agent) => agent.name === 'researcher',
    );
    expect(ownerOverride?.config.model).toBe('provider/owner');
  });

  test('renders derived role routing against the runtime agent name', () => {
    const registry = registryFor({
      agents: {
        auditOracle: { baseRole: 'oracle', model: 'provider/oracle' },
      },
    });
    const route = registry.routing.find(
      (entry) => entry.agentName === 'auditOracle',
    );

    expect(route?.routingBlock).toContain('@auditOracle');
    expect(route?.routingBlock).not.toContain('@oracle');
    expect(
      registry.agents.find((agent) => agent.name === 'orchestrator')?.config
        .prompt,
    ).toContain('@auditOracle');
  });

  test('does not route an unconfigured or disabled council', () => {
    expect(registryFor().routing.map((entry) => entry.agentName)).not.toContain(
      'council',
    );
    expect(
      registryFor({ disabled_agents: ['council'] }).routing.map(
        (entry) => entry.agentName,
      ),
    ).not.toContain('council');
  });

  test('routes an enabled council exactly when it is registered', () => {
    const registry = registryFor({
      disabled_agents: [],
      council: CouncilConfigSchema.parse({
        presets: { default: { alpha: { model: 'provider/councillor' } } },
      }),
    });

    expect(registry.sdkConfigs.council).toBeDefined();
    expect(
      registry.routing.filter((entry) => entry.agentName === 'council'),
    ).toHaveLength(1);
  });

  test('renders council routing with its resolved display name', () => {
    const registry = registryFor({
      agents: { council: { displayName: 'consensus' } },
      council: CouncilConfigSchema.parse({
        presets: { default: { alpha: { model: 'provider/councillor' } } },
      }),
    });
    const route = registry.routing.find(
      (entry) => entry.agentName === 'consensus',
    );

    expect(route?.routingBlock).toContain('@consensus');
    expect(route?.routingBlock).not.toContain('@council');
  });

  test('folds custom and ACP routing guidance into one deterministic registry', () => {
    const rawCustomGuidance =
      'Use @janitor after @explorer completes the initial scan.';
    const customGuidance =
      'Use @janitor after @scout completes the initial scan.';
    const acpGuidance = 'Delegate provider research to @claude-research.';
    const registry = registryFor({
      agents: {
        explorer: { model: 'provider/explorer', displayName: 'scout' },
        janitor: {
          model: 'provider/janitor',
          orchestratorPrompt: rawCustomGuidance,
        },
      },
      acpAgents: {
        'claude-research': {
          command: 'claude-code-acp',
          args: [],
          env: {},
          timeoutMs: 0,
          permissionMode: 'ask',
          orchestratorPrompt: acpGuidance,
        },
      },
    });
    const orchestrator = registry.agents.find(
      (agent) => agent.name === 'orchestrator',
    );
    const prompt = orchestrator?.config.prompt ?? '';

    expect(
      registry.routing.filter((entry) =>
        entry.routingBlock.includes(customGuidance),
      ),
    ).toHaveLength(1);
    expect(
      registry.routing.filter((entry) =>
        entry.routingBlock.includes(acpGuidance),
      ),
    ).toHaveLength(1);
    expect(prompt.match(new RegExp(customGuidance, 'g'))).toHaveLength(1);
    expect(prompt.match(new RegExp(acpGuidance, 'g'))).toHaveLength(1);
    expect(registry.routing.map((entry) => entry.agentName)).toEqual(
      [...registry.routing].map((entry) => entry.agentName).sort(),
    );
    expect(registry.routing.map((entry) => entry.agentName)).toContain('scout');
    expect(registry.routing.map((entry) => entry.agentName)).not.toContain(
      'explorer',
    );
  });

  test('finalizes host fields and MCP permissions in owned registry projections', () => {
    RuntimeConfig.reset(DIRECTORY);
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: { explorer: { mcps: ['context7'] } },
    });
    runtime.captureHostConfig({
      agent: {
        explorer: {
          model: 'host/explorer',
          options: { nested: { value: 1 } },
          permission: {
            bash: { 'git status': 'allow' },
          },
        },
      },
      mcp: { context7: { type: 'remote' } },
    });
    const availableMcpNames = ['context7'];
    const registry = buildResolvedAgentRegistry(runtime, {
      availableMcpNames,
    });
    availableMcpNames.push('added-after-snapshot');
    const explorer = registry.sdkConfigs.explorer as Record<string, unknown>;
    const permission = explorer.permission as Record<string, unknown>;

    expect(explorer.model).toBe('host/explorer');
    expect(explorer.options).toEqual({ nested: { value: 1 } });
    expect(permission['context7_*']).toBe('allow');
    expect(registry.availableMcpNames).toEqual(['context7']);
    expect(Object.isFrozen(registry.availableMcpNames)).toBe(true);
    expect((permission.bash as Record<string, unknown>)['git status']).toBe(
      'allow',
    );
    expect(Object.isFrozen(explorer.options)).toBe(true);
  });

  test('uses RoleDefinition.defaultModel for every built-in specialist', () => {
    const registry = registryFor({ disabled_agents: [] });
    for (const roleName of SUPPORTED_SPECIALIST_ROLES) {
      expect(registry.sdkConfigs[roleName]?.model).toBe(
        ROLE_DEFINITIONS[roleName].defaultModel,
      );
    }
  });

  test('normalizes host shorthand and reapplies only the immutable gate', () => {
    const registry = registryFor({ disabled_agents: [] });
    const hostEntry: Record<string, unknown> = { permission: 'ask' };

    projectAgentPermission('explorer', hostEntry, registry);

    expect(hostEntry.permission).toMatchObject({
      '*': 'ask',
      task_cancel: 'deny',
      wait_for_user: 'deny',
      marketplace: 'deny',
    });
    expect((hostEntry.permission as Record<string, unknown>).edit).toBe('deny');
  });

  test('mirrors display aliases across model, skill, and MCP consumers', () => {
    const registry = registryFor({
      disabled_agents: [],
      agents: {
        explorer: {
          displayName: 'Scout',
          model: ['provider/one', 'provider/two'],
          skills: ['simplify'],
          mcps: ['context7'],
        },
      },
    });

    expect(registry.canonicalIdByRuntimeName.Scout).toBe('explorer');
    expect(registry.modelArrays.Scout).toEqual(registry.modelArrays.explorer);
    expect(registry.mcpLists.Scout).toEqual(['context7']);
    expect(registry.skillPermissions.Scout).toEqual(
      registry.skillPermissions.explorer,
    );
    expect(registry.routing).toContainEqual(
      expect.objectContaining({ agentName: 'Scout' }),
    );
    expect(registry.sdkConfigs.Scout).toMatchObject({
      displayName: 'Scout',
      model: 'provider/one',
      mcps: ['context7'],
    });
    expect(registry.sdkConfigs.Scout.hidden).toBeUndefined();
    expect(registry.sdkConfigs.explorer.hidden).toBe(true);
    expect(
      (registry.sdkConfigs.Scout.permission as Record<string, unknown>)
        .marketplace,
    ).toBe('deny');
    expect(
      (registry.sdkConfigs.explorer.permission as Record<string, unknown>)
        .marketplace,
    ).toBe('deny');
  });

  test('does not let host prompts replace mandatory agent suffixes', () => {
    RuntimeConfig.reset(DIRECTORY);
    const runtime = RuntimeConfig.init(DIRECTORY, {
      disabled_agents: [],
      council: CouncilConfigSchema.parse({
        default_preset: 'default',
        presets: {
          default: {
            alpha: { model: 'provider/councillor' },
          },
        },
      }),
    });
    runtime.captureHostConfig({
      agent: {
        explorer: { prompt: 'host explorer prompt' },
        council: { prompt: 'host council prompt' },
      },
    });

    const registry = buildResolvedAgentRegistry(runtime);
    const explorerPrompt = String(registry.sdkConfigs.explorer.prompt);
    const councilPrompt = String(registry.sdkConfigs.council.prompt);

    expect(explorerPrompt).not.toContain('host explorer prompt');
    expect(explorerPrompt).toContain(TASK_REJECTION_INSTRUCTION);
    expect(councilPrompt).not.toContain('host council prompt');
    expect(councilPrompt).toContain(TASK_REJECTION_INSTRUCTION);
    expect(councilPrompt).toContain(COUNCIL_SYNTHESIS_REINFORCEMENT);
  });
});
