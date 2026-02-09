/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  buildDynamicModelPlan,
  rankModelsV1WithBreakdown,
} from './dynamic-model-selection';
import type { DiscoveredModel, InstallConfig } from './types';

function m(
  input: Partial<DiscoveredModel> & { model: string },
): DiscoveredModel {
  const [providerID] = input.model.split('/');
  return {
    providerID: providerID ?? 'openai',
    model: input.model,
    name: input.name ?? input.model,
    status: input.status ?? 'active',
    contextLimit: input.contextLimit ?? 200000,
    outputLimit: input.outputLimit ?? 32000,
    reasoning: input.reasoning ?? true,
    toolcall: input.toolcall ?? true,
    attachment: input.attachment ?? false,
    dailyRequestLimit: input.dailyRequestLimit,
    costInput: input.costInput,
    costOutput: input.costOutput,
  };
}

function baseInstallConfig(): InstallConfig {
  return {
    hasKimi: false,
    hasOpenAI: true,
    hasAnthropic: false,
    hasCopilot: true,
    hasZaiPlan: true,
    hasAntigravity: false,
    hasChutes: true,
    hasOpencodeZen: true,
    useOpenCodeFreeModels: true,
    selectedOpenCodePrimaryModel: 'opencode/glm-4.7-free',
    selectedOpenCodeSecondaryModel: 'opencode/gpt-5-nano',
    selectedChutesPrimaryModel: 'chutes/kimi-k2.5',
    selectedChutesSecondaryModel: 'chutes/minimax-m2.1',
    hasTmux: false,
    installSkills: false,
    installCustomSkills: false,
    setupMode: 'quick',
  };
}

describe('dynamic-model-selection', () => {
  test('builds assignments and chains for all six agents', () => {
    const plan = buildDynamicModelPlan(
      [
        m({ model: 'openai/gpt-5.3-codex', reasoning: true, toolcall: true }),
        m({
          model: 'openai/gpt-5.1-codex-mini',
          reasoning: true,
          toolcall: true,
        }),
        m({
          model: 'github-copilot/grok-code-fast-1',
          reasoning: true,
          toolcall: true,
        }),
        m({
          model: 'zai-coding-plan/glm-4.7',
          reasoning: true,
          toolcall: true,
        }),
        m({ model: 'chutes/kimi-k2.5', reasoning: true, toolcall: true }),
        m({ model: 'chutes/minimax-m2.1', reasoning: true, toolcall: true }),
      ],
      baseInstallConfig(),
    );

    expect(plan).not.toBeNull();
    const agents = plan?.agents ?? {};
    const chains = plan?.chains ?? {};

    expect(Object.keys(agents).sort()).toEqual([
      'designer',
      'explorer',
      'fixer',
      'librarian',
      'oracle',
      'orchestrator',
    ]);
    expect(agents.oracle?.model.startsWith('opencode/')).toBe(false);
    expect(agents.orchestrator?.model.startsWith('opencode/')).toBe(false);
    expect(chains.oracle.some((m: string) => m.startsWith('openai/'))).toBe(
      true,
    );
    expect(chains.orchestrator).toContain('chutes/kimi-k2.5');
    expect(chains.explorer).toContain('opencode/gpt-5-nano');
    expect(chains.fixer[chains.fixer.length - 1]).toBe('opencode/gpt-5-nano');
    expect(plan?.provenance?.oracle?.winnerLayer).toBe(
      'dynamic-recommendation',
    );
    expect(plan?.scoring?.engineVersionApplied).toBe('v1');
  });

  test('supports v2-shadow mode without changing applied engine', () => {
    const plan = buildDynamicModelPlan(
      [
        m({ model: 'openai/gpt-5.3-codex', reasoning: true, toolcall: true }),
        m({ model: 'chutes/kimi-k2.5', reasoning: true, toolcall: true }),
        m({ model: 'opencode/gpt-5-nano', reasoning: true, toolcall: true }),
      ],
      baseInstallConfig(),
      undefined,
      { scoringEngineVersion: 'v2-shadow' },
    );

    expect(plan).not.toBeNull();
    expect(plan?.scoring?.engineVersionApplied).toBe('v1');
    expect(plan?.scoring?.shadowCompared).toBe(true);
    expect(plan?.scoring?.diffs?.oracle).toBeDefined();
  });

  test('balances provider usage when subscription mode is enabled', () => {
    const plan = buildDynamicModelPlan(
      [
        m({ model: 'openai/gpt-5.3-codex', reasoning: true, toolcall: true }),
        m({
          model: 'openai/gpt-5.1-codex-mini',
          reasoning: true,
          toolcall: true,
        }),
        m({
          model: 'zai-coding-plan/glm-4.7',
          reasoning: true,
          toolcall: true,
        }),
        m({
          model: 'zai-coding-plan/glm-4.7-flash',
          reasoning: true,
          toolcall: true,
        }),
        m({
          model: 'chutes/moonshotai/Kimi-K2.5-TEE',
          reasoning: true,
          toolcall: true,
        }),
        m({
          model: 'chutes/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8-TEE',
          reasoning: true,
          toolcall: true,
        }),
      ],
      {
        ...baseInstallConfig(),
        hasCopilot: false,
        balanceProviderUsage: true,
      },
      undefined,
      { scoringEngineVersion: 'v2' },
    );

    expect(plan).not.toBeNull();
    const usage = Object.values(plan?.agents ?? {}).reduce(
      (acc, assignment) => {
        const provider = assignment.model.split('/')[0] ?? 'unknown';
        acc[provider] = (acc[provider] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    expect(usage.openai).toBe(2);
    expect(usage['zai-coding-plan']).toBe(2);
    expect(usage.chutes).toBe(2);
  });

  test('matches external signals for multi-segment chutes ids in v1', () => {
    const ranked = rankModelsV1WithBreakdown(
      [m({ model: 'chutes/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8-TEE' })],
      'fixer',
      {
        'qwen/qwen3-coder-480b-a35b-instruct': {
          source: 'artificial-analysis',
          qualityScore: 95,
          codingScore: 92,
        },
      },
    );

    expect(ranked[0]?.externalSignalBoost).toBeGreaterThan(0);
  });

  test('prefers chutes kimi/minimax over qwen3 in v1 role scoring', () => {
    const catalog = [
      m({
        model: 'chutes/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8-TEE',
        reasoning: true,
        toolcall: true,
      }),
      m({
        model: 'chutes/moonshotai/Kimi-K2.5-TEE',
        reasoning: true,
        toolcall: true,
      }),
      m({
        model: 'chutes/minimax-m2.1',
        reasoning: true,
        toolcall: true,
      }),
    ];

    const fixer = rankModelsV1WithBreakdown(catalog, 'fixer');
    const explorer = rankModelsV1WithBreakdown(catalog, 'explorer');

    expect(fixer[0]?.model).not.toContain('Qwen3-Coder-480B');
    expect(explorer[0]?.model).toContain('minimax-m2.1');
  });

  test('does not apply a positive Gemini bonus in v1 scoring', () => {
    const catalog = [
      m({
        model: 'google/antigravity-gemini-3-pro',
        reasoning: true,
        toolcall: true,
      }),
      m({ model: 'openai/gpt-5.3-codex', reasoning: true, toolcall: true }),
    ];

    const oracle = rankModelsV1WithBreakdown(catalog, 'oracle');
    const orchestrator = rankModelsV1WithBreakdown(catalog, 'orchestrator');
    const designer = rankModelsV1WithBreakdown(catalog, 'designer');
    const librarian = rankModelsV1WithBreakdown(catalog, 'librarian');

    expect(oracle[0]?.model).toBe('openai/gpt-5.3-codex');
    expect(orchestrator[0]?.model).toBe('openai/gpt-5.3-codex');
    expect(designer[0]?.model).toBe('openai/gpt-5.3-codex');
    expect(librarian[0]?.model).toBe('openai/gpt-5.3-codex');
  });
});
