/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { buildDynamicModelPlan } from './dynamic-model-selection';
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

const CATALOG: DiscoveredModel[] = [
  m({ model: 'openai/gpt-5.3-codex' }),
  m({ model: 'openai/gpt-5.1-codex-mini' }),
  m({ model: 'anthropic/claude-opus-4-6' }),
  m({ model: 'anthropic/claude-sonnet-4-5' }),
  m({ model: 'anthropic/claude-haiku-4-5', reasoning: false }),
  m({ model: 'github-copilot/grok-code-fast-1' }),
  m({ model: 'zai-coding-plan/glm-4.7' }),
  m({ model: 'google/antigravity-gemini-3-pro' }),
  m({ model: 'google/antigravity-gemini-3-flash' }),
  m({ model: 'chutes/kimi-k2.5' }),
  m({ model: 'chutes/minimax-m2.1' }),
  m({ model: 'kimi-for-coding/k2p5' }),
  m({ model: 'opencode/glm-4.7-free' }),
  m({ model: 'opencode/gpt-5-nano' }),
  m({ model: 'opencode/big-pickle' }),
];

function baseConfig(): InstallConfig {
  return {
    hasKimi: false,
    hasOpenAI: false,
    hasAnthropic: false,
    hasCopilot: false,
    hasZaiPlan: false,
    hasAntigravity: false,
    hasChutes: false,
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

describe('dynamic-model-selection matrix', () => {
  const scenarios = [
    {
      name: 'C1 openai+anthropic+chutes+opencode',
      config: {
        ...baseConfig(),
        hasOpenAI: true,
        hasAnthropic: true,
        hasChutes: true,
      },
      expectedV1: {
        oracle: 'openai/gpt-5.3-codex',
        orchestrator: 'openai/gpt-5.3-codex',
        fixer: 'chutes/minimax-m2.1',
        designer: 'chutes/kimi-k2.5',
        librarian: 'anthropic/claude-opus-4-6',
        explorer: 'chutes/minimax-m2.1',
      },
      expectedV2: {
        oracle: 'openai/gpt-5.3-codex',
        orchestrator: 'openai/gpt-5.3-codex',
        fixer: 'chutes/minimax-m2.1',
        designer: 'chutes/kimi-k2.5',
        librarian: 'anthropic/claude-opus-4-6',
        explorer: 'chutes/minimax-m2.1',
      },
    },
    {
      name: 'C2 openai+copilot+zai+google+opencode',
      config: {
        ...baseConfig(),
        hasOpenAI: true,
        hasCopilot: true,
        hasZaiPlan: true,
        hasAntigravity: true,
      },
      expectedV1: {
        oracle: 'openai/gpt-5.3-codex',
        orchestrator: 'openai/gpt-5.3-codex',
        fixer: 'github-copilot/grok-code-fast-1',
        designer: 'google/antigravity-gemini-3-pro',
        librarian: 'zai-coding-plan/glm-4.7',
        explorer: 'google/antigravity-gemini-3-flash',
      },
      expectedV2: {
        oracle: 'openai/gpt-5.3-codex',
        orchestrator: 'openai/gpt-5.3-codex',
        fixer: 'github-copilot/grok-code-fast-1',
        designer: 'zai-coding-plan/glm-4.7',
        librarian: 'google/antigravity-gemini-3-pro',
        explorer: 'google/antigravity-gemini-3-flash',
      },
    },
    {
      name: 'C3 kimi+google+chutes+opencode',
      config: {
        ...baseConfig(),
        hasKimi: true,
        hasAntigravity: true,
        hasChutes: true,
      },
      expectedV1: {
        oracle: 'google/antigravity-gemini-3-pro',
        orchestrator: 'chutes/kimi-k2.5',
        fixer: 'google/antigravity-gemini-3-pro',
        designer: 'chutes/kimi-k2.5',
        librarian: 'kimi-for-coding/k2p5',
        explorer: 'google/antigravity-gemini-3-flash',
      },
      expectedV2: {
        oracle: 'google/antigravity-gemini-3-pro',
        orchestrator: 'chutes/kimi-k2.5',
        fixer: 'google/antigravity-gemini-3-pro',
        designer: 'chutes/kimi-k2.5',
        librarian: 'kimi-for-coding/k2p5',
        explorer: 'google/antigravity-gemini-3-flash',
      },
    },
    {
      name: 'R1 anthropic+copilot+opencode',
      config: { ...baseConfig(), hasAnthropic: true, hasCopilot: true },
      expectedV1: {
        oracle: 'anthropic/claude-opus-4-6',
        orchestrator: 'github-copilot/grok-code-fast-1',
        fixer: 'github-copilot/grok-code-fast-1',
        designer: 'anthropic/claude-opus-4-6',
        librarian: 'github-copilot/grok-code-fast-1',
        explorer: 'github-copilot/grok-code-fast-1',
      },
      expectedV2: {
        oracle: 'anthropic/claude-opus-4-6',
        orchestrator: 'github-copilot/grok-code-fast-1',
        fixer: 'github-copilot/grok-code-fast-1',
        designer: 'anthropic/claude-opus-4-6',
        librarian: 'github-copilot/grok-code-fast-1',
        explorer: 'github-copilot/grok-code-fast-1',
      },
    },
    {
      name: 'R2 openai+kimi+zai+chutes+opencode',
      config: {
        ...baseConfig(),
        hasOpenAI: true,
        hasKimi: true,
        hasZaiPlan: true,
        hasChutes: true,
      },
      expectedV1: {
        oracle: 'openai/gpt-5.3-codex',
        orchestrator: 'openai/gpt-5.3-codex',
        fixer: 'chutes/minimax-m2.1',
        designer: 'chutes/kimi-k2.5',
        librarian: 'zai-coding-plan/glm-4.7',
        explorer: 'chutes/minimax-m2.1',
      },
      expectedV2: {
        oracle: 'openai/gpt-5.3-codex',
        orchestrator: 'openai/gpt-5.3-codex',
        fixer: 'chutes/minimax-m2.1',
        designer: 'chutes/kimi-k2.5',
        librarian: 'zai-coding-plan/glm-4.7',
        explorer: 'chutes/minimax-m2.1',
      },
    },
    {
      name: 'R3 google+anthropic+chutes+opencode',
      config: {
        ...baseConfig(),
        hasAntigravity: true,
        hasAnthropic: true,
        hasChutes: true,
      },
      expectedV1: {
        oracle: 'google/antigravity-gemini-3-pro',
        orchestrator: 'chutes/kimi-k2.5',
        fixer: 'google/antigravity-gemini-3-pro',
        designer: 'anthropic/claude-opus-4-6',
        librarian: 'chutes/minimax-m2.1',
        explorer: 'google/antigravity-gemini-3-flash',
      },
      expectedV2: {
        oracle: 'google/antigravity-gemini-3-pro',
        orchestrator: 'chutes/kimi-k2.5',
        fixer: 'google/antigravity-gemini-3-pro',
        designer: 'anthropic/claude-opus-4-6',
        librarian: 'chutes/minimax-m2.1',
        explorer: 'google/antigravity-gemini-3-flash',
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    test(scenario.name, () => {
      const v1 = buildDynamicModelPlan(CATALOG, scenario.config, undefined, {
        scoringEngineVersion: 'v1',
      });
      const shadow = buildDynamicModelPlan(
        CATALOG,
        scenario.config,
        undefined,
        {
          scoringEngineVersion: 'v2-shadow',
        },
      );
      const v2 = buildDynamicModelPlan(CATALOG, scenario.config, undefined, {
        scoringEngineVersion: 'v2',
      });

      expect(v1).not.toBeNull();
      expect(v2).not.toBeNull();
      expect(shadow).not.toBeNull();

      expect(v1?.agents).toMatchObject(
        Object.fromEntries(
          Object.entries(scenario.expectedV1).map(([agent, model]) => [
            agent,
            { model },
          ]),
        ),
      );
      expect(v2?.agents).toMatchObject(
        Object.fromEntries(
          Object.entries(scenario.expectedV2).map(([agent, model]) => [
            agent,
            { model },
          ]),
        ),
      );

      expect(shadow?.agents).toEqual(v1?.agents);
      expect(shadow?.scoring?.engineVersionApplied).toBe('v1');
      expect(shadow?.scoring?.shadowCompared).toBe(true);
    });
  }
});
