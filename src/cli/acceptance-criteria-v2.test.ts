/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDynamicModelPlan } from './dynamic-model-selection';
import {
  migrateLegacyAssignmentsV1ToV2,
  rollbackAssignmentsV2ToLegacy,
} from './migration';
import { rollbackToV1 } from './migration-rollback';
import { discoverModelCatalog } from './opencode-models';
import { generateLiteConfig } from './providers';
import { buildSmartRoutingPlanV3 } from './smart-routing-v3';
import type { DiscoveredModel, InstallConfig } from './types';

function model(
  input: Partial<DiscoveredModel> & { model: string },
): DiscoveredModel {
  const [providerID] = input.model.split('/');
  return {
    providerID: providerID ?? 'openai',
    model: input.model,
    name: input.name ?? input.model,
    status: input.status ?? 'active',
    contextLimit: input.contextLimit ?? 200_000,
    outputLimit: input.outputLimit ?? 32_000,
    reasoning: input.reasoning ?? true,
    toolcall: input.toolcall ?? true,
    attachment: input.attachment ?? false,
    dailyRequestLimit: input.dailyRequestLimit,
    costInput: input.costInput,
    costOutput: input.costOutput,
  };
}

const CATALOG_6: DiscoveredModel[] = [
  model({ model: 'nanogpt/gpt-4o', costInput: 0, costOutput: 0 }),
  model({ model: 'nanogpt/gpt-4o-mini', costInput: 0, costOutput: 0 }),
  model({ model: 'openai/gpt-5.3-codex', costInput: 4, costOutput: 12 }),
  model({ model: 'openai/gpt-5.1-codex-mini', costInput: 1, costOutput: 3 }),
  model({ model: 'chutes/kimi-k2.5', costInput: 0.2, costOutput: 0.5 }),
  model({ model: 'opencode/big-pickle', costInput: 0, costOutput: 0 }),
];

const CATALOG_MATRIX: DiscoveredModel[] = [
  model({ model: 'nanogpt/gpt-4o', costInput: 0, costOutput: 0 }),
  model({ model: 'nanogpt/gpt-4o-mini', costInput: 0, costOutput: 0 }),
  model({ model: 'openai/gpt-5.3-codex', costInput: 4, costOutput: 12 }),
  model({ model: 'anthropic/claude-opus-4-6', costInput: 6, costOutput: 15 }),
  model({ model: 'chutes/kimi-k2.5', costInput: 0.2, costOutput: 0.5 }),
  model({ model: 'kimi-for-coding/k2p5', costInput: 1.2, costOutput: 2.4 }),
  model({
    model: 'google/antigravity-gemini-3-pro',
    costInput: 1.5,
    costOutput: 3,
  }),
  model({
    model: 'github-copilot/grok-code-fast-1',
    costInput: 2,
    costOutput: 4,
  }),
  model({ model: 'zai-coding-plan/glm-4.7', costInput: 1.8, costOutput: 3.6 }),
  model({ model: 'opencode/gpt-5-nano', costInput: 0, costOutput: 0 }),
  model({ model: 'opencode/glm-4.7-free', costInput: 0, costOutput: 0 }),
  model({ model: 'opencode/big-pickle', costInput: 0, costOutput: 0 }),
];

function baseInstallConfig(): InstallConfig {
  return {
    hasKimi: false,
    hasOpenAI: true,
    hasAnthropic: false,
    hasCopilot: false,
    hasZaiPlan: false,
    hasAntigravity: false,
    hasChutes: true,
    hasNanoGpt: true,
    hasOpencodeZen: true,
    useOpenCodeFreeModels: true,
    selectedOpenCodePrimaryModel: 'opencode/big-pickle',
    selectedOpenCodeSecondaryModel: 'opencode/big-pickle',
    selectedChutesPrimaryModel: 'chutes/kimi-k2.5',
    selectedChutesSecondaryModel: 'chutes/kimi-k2.5',
    nanoGptRoutingPolicy: 'hybrid',
    hasTmux: false,
    installSkills: false,
    installCustomSkills: false,
    setupMode: 'quick',
  };
}

describe('acceptance-criteria-v2', () => {
  test('FR-003/004/005/007/008 with >=4 models across systems', () => {
    const output = buildSmartRoutingPlanV3({
      catalog: CATALOG_6,
      policy: {
        mode: 'subscription-only',
        subscriptionBudget: {
          dailyRequests: 120,
          monthlyRequests: 3_000,
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 100,
        monthlyRemaining: 2_700,
        lastCheckedAt: new Date(),
      },
    });

    expect(Object.keys(output.plan.agents)).toHaveLength(6);

    for (const assignment of Object.values(output.plan.agents)) {
      expect(assignment.billingMode).toBeDefined();
      expect(assignment.billingMode).toBe('subscription');
    }

    for (const chain of Object.values(output.plan.chains)) {
      expect(chain.length).toBeGreaterThanOrEqual(4);
    }

    const chainModels = Object.values(output.plan.chains).flat();
    expect(chainModels.some((value) => value.startsWith('nanogpt/'))).toBe(
      true,
    );
    expect(chainModels.some((value) => value.startsWith('openai/'))).toBe(true);
  });

  test('FR-006 quota pressure reduces subscription preference in hybrid mode', () => {
    const highQuota = buildSmartRoutingPlanV3({
      catalog: CATALOG_6,
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          dailyRequests: 120,
          monthlyRequests: 3_000,
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 100,
        monthlyRemaining: 2_700,
        lastCheckedAt: new Date(),
      },
    }).plan;

    const lowQuota = buildSmartRoutingPlanV3({
      catalog: CATALOG_6,
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          dailyRequests: 120,
          monthlyRequests: 3_000,
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 2,
        monthlyRemaining: 25,
        lastCheckedAt: new Date(),
      },
    }).plan;

    const countSubscription = (plan: typeof highQuota): number =>
      Object.values(plan.agents).filter(
        (assignment) => assignment.billingMode === 'subscription',
      ).length;

    expect(countSubscription(lowQuota)).toBeLessThanOrEqual(
      countSubscription(highQuota),
    );
  });

  test('FR-009/010/011 migration keeps legacy assignments reversible', () => {
    const input: InstallConfig = {
      ...baseInstallConfig(),
      selectedChutesPrimaryModel: 'chutes/kimi-k2.5',
      selectedChutesSecondaryModel: 'chutes/minimax-m2.5',
      selectedOpenCodePrimaryModel: 'opencode/big-pickle',
      selectedOpenCodeSecondaryModel: 'opencode/big-pickle',
    };

    const migrated = migrateLegacyAssignmentsV1ToV2(input);
    expect(migrated.migrated).toBe(true);
    expect(
      migrated.config.selectedChutesModelsByAgent?.orchestrator.model,
    ).toBe('chutes/kimi-k2.5');
    expect(migrated.config.selectedChutesModelsByAgent?.fixer.model).toBe(
      'chutes/minimax-m2.5',
    );

    const rolledBack = rollbackAssignmentsV2ToLegacy(migrated.config);
    expect(rolledBack.selectedChutesPrimaryModel).toBe(
      input.selectedChutesPrimaryModel,
    );
    expect(rolledBack.selectedChutesSecondaryModel).toBe(
      input.selectedChutesSecondaryModel,
    );
    expect(rolledBack.selectedOpenCodePrimaryModel).toBe(
      input.selectedOpenCodePrimaryModel,
    );
    expect(rolledBack.selectedOpenCodeSecondaryModel).toBe(
      input.selectedOpenCodeSecondaryModel,
    );
  });

  test('FR-012 rollback restores V1 backup from migrated config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omos-acceptance-rollback-'));

    try {
      const configPath = join(dir, 'oh-my-opencode-slim.json');
      writeFileSync(
        configPath,
        `${JSON.stringify({
          preset: 'dynamic',
          presets: { dynamic: {} },
          _migratedFromV1: true,
        })}\n`,
      );
      writeFileSync(
        `${configPath}.v1-backup`,
        `${JSON.stringify({
          preset: 'zen-free',
          presets: { 'zen-free': {} },
        })}\n`,
      );

      const result = rollbackToV1(configPath);
      expect(result.success).toBe(true);
      expect(result.rollbackPath).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('PR-001/003/004 and QR-003 with >=4 models', async () => {
    const catalog50: DiscoveredModel[] = Array.from(
      { length: 50 },
      (_, index) =>
        model({
          model:
            index % 4 === 0
              ? `nanogpt/model-${index}`
              : index % 4 === 1
                ? `openai/model-${index}`
                : index % 4 === 2
                  ? `chutes/model-${index}`
                  : `opencode/model-${index}`,
          costInput: index % 4 === 3 ? 0 : 0.1 + (index % 3),
          costOutput: index % 4 === 3 ? 0 : 0.2 + (index % 2),
        }),
    );

    const memBefore = process.memoryUsage().heapUsed;
    const startSelection = performance.now();
    const v3 = buildSmartRoutingPlanV3({
      catalog: catalog50,
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          dailyRequests: 120,
          monthlyRequests: 3_000,
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 100,
        monthlyRemaining: 2_700,
        lastCheckedAt: new Date(),
      },
    });
    const selectionMs = performance.now() - startSelection;
    const memAfter = process.memoryUsage().heapUsed;
    const memDelta = Math.max(0, memAfter - memBefore);

    expect(Object.keys(v3.plan.agents)).toHaveLength(6);
    expect(selectionMs).toBeLessThan(500);
    expect(memDelta).toBeLessThan(100 * 1024 * 1024);

    const installConfig: InstallConfig = {
      ...baseInstallConfig(),
      dynamicModelPlan: v3.plan,
    };

    const startConfig = performance.now();
    const lite = generateLiteConfig(installConfig);
    const configMs = performance.now() - startConfig;
    const serialized = JSON.stringify(lite);
    expect(configMs).toBeLessThan(100);
    expect(() => JSON.parse(serialized)).not.toThrow();

    const shadow = buildDynamicModelPlan(
      [
        model({ model: 'openai/a-best', costInput: 0.2, costOutput: 0.4 }),
        model({ model: 'openai/b-mid', costInput: 1, costOutput: 2 }),
        model({ model: 'openai/c-mid', costInput: 1.2, costOutput: 2.1 }),
        model({ model: 'openai/d-low', reasoning: false, costInput: 2 }),
      ],
      {
        ...baseInstallConfig(),
        hasChutes: false,
        useOpenCodeFreeModels: false,
      },
      undefined,
      { scoringEngineVersion: 'v2-shadow' },
    );

    const diffs = shadow?.scoring?.diffs ?? {};
    const total = Object.keys(diffs).length;
    const changed = Object.values(diffs).filter(
      (diff) => diff.v1TopModel !== diff.v2TopModel,
    ).length;
    const driftPct = total > 0 ? changed / total : 0;
    expect(driftPct).toBeLessThanOrEqual(0.05);

    const spawnCommand: typeof Bun.spawn = (() => {
      return {
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        exited: new Promise<number>(() => {}),
        kill: () => {},
      } as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const discoveryStart = performance.now();
    const discovered = await discoverModelCatalog({
      timeoutMs: 100,
      opencodePath: 'opencode',
      spawnCommand,
    });
    const discoveryMs = performance.now() - discoveryStart;
    expect(discoveryMs).toBeLessThan(10_000);
    expect(Array.isArray(discovered.models)).toBe(true);
    expect(discovered.error).toContain('Model discovery timeout after 100ms');
  }, 20_000);

  test('QR-002 provider-combination integration matrix runs across diverse combinations', () => {
    const combinations: Array<Partial<InstallConfig>> = [
      { hasNanoGpt: true },
      { hasNanoGpt: true, hasOpenAI: true },
      { hasNanoGpt: true, hasChutes: true },
      { hasNanoGpt: true, hasKimi: true, hasOpenAI: true },
      { hasNanoGpt: true, hasAntigravity: true, hasChutes: true },
      { hasNanoGpt: true, hasAnthropic: true, hasCopilot: true },
      { hasNanoGpt: true, hasZaiPlan: true, hasOpenAI: true, hasChutes: true },
      {
        hasNanoGpt: true,
        hasOpenAI: true,
        hasAnthropic: true,
        hasCopilot: true,
        hasZaiPlan: true,
        hasAntigravity: true,
        hasKimi: true,
        hasChutes: true,
      },
    ];

    for (const partial of combinations) {
      const config: InstallConfig = {
        ...baseInstallConfig(),
        ...partial,
      };

      const v1 = buildDynamicModelPlan(CATALOG_MATRIX, config, undefined, {
        scoringEngineVersion: 'v1',
      });
      const v2 = buildDynamicModelPlan(CATALOG_MATRIX, config, undefined, {
        scoringEngineVersion: 'v2',
      });
      const shadow = buildDynamicModelPlan(CATALOG_MATRIX, config, undefined, {
        scoringEngineVersion: 'v2-shadow',
      });

      expect(v1).not.toBeNull();
      expect(v2).not.toBeNull();
      expect(shadow).not.toBeNull();
      expect(Object.keys(v2?.agents ?? {})).toHaveLength(6);
      expect(Object.keys(v2?.chains ?? {})).toHaveLength(6);
      expect(shadow?.scoring?.shadowCompared).toBe(true);

      const v3 = buildSmartRoutingPlanV3({
        catalog: CATALOG_MATRIX,
        policy: {
          mode: config.hasNanoGpt ? 'hybrid' : 'paygo-only',
          subscriptionBudget: {
            dailyRequests: 120,
            monthlyRequests: 3_000,
            enforcement: 'soft',
          },
        },
        quotaStatus: {
          dailyRemaining: 100,
          monthlyRemaining: 2_700,
          lastCheckedAt: new Date(),
        },
      });

      expect(Object.keys(v3.plan.agents)).toHaveLength(6);
      expect(Object.keys(v3.plan.chains)).toHaveLength(6);
    }
  });
});
