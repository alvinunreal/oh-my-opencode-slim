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
    expect(chains.oracle).toContain('openai/gpt-5.3-codex');
    expect(chains.orchestrator).toContain('chutes/kimi-k2.5');
    expect(chains.explorer).toContain('opencode/gpt-5-nano');
    expect(chains.fixer[chains.fixer.length - 1]).toBe('opencode/big-pickle');
  });
});
