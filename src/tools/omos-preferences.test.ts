/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../config';
import {
  compileManualPlanToConfig,
  deriveManualPlanFromConfig,
  diffManualPlans,
  precedenceWarning,
  resolveTargetPath,
  scoreManualPlan,
} from './omos-preferences';

describe('omos-preferences helpers', () => {
  test('derives manual plan from agents and fallback chains', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { model: 'openai/gpt-5.3-codex' },
      },
      fallback: {
        enabled: true,
        timeoutMs: 15000,
        chains: {
          oracle: [
            'openai/gpt-5.3-codex',
            'anthropic/claude-opus-4-6',
            'chutes/kimi-k2.5',
            'opencode/gpt-5-nano',
          ],
        },
      },
    };

    const manualPlan = deriveManualPlanFromConfig(config);
    expect(manualPlan.oracle.primary).toBe('openai/gpt-5.3-codex');
    expect(manualPlan.oracle.fallback1).toBe('anthropic/claude-opus-4-6');
    expect(manualPlan.oracle.fallback2).toBe('chutes/kimi-k2.5');
    expect(manualPlan.oracle.fallback3).toBe('opencode/gpt-5-nano');
  });

  test('compiles manual plan into runtime agents and fallback chains', () => {
    const input: PluginConfig = {};
    const manualPlan = {
      orchestrator: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      oracle: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      designer: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      explorer: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      librarian: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      fixer: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
    };

    const next = compileManualPlanToConfig(input, manualPlan);
    expect(next.preset).toBe('manual');
    expect(next.agents?.oracle?.model).toBe('openai/gpt-5.3-codex');
    expect(next.fallback?.chains.oracle).toEqual([
      'openai/gpt-5.3-codex',
      'anthropic/claude-opus-4-6',
      'chutes/kimi-k2.5',
      'opencode/gpt-5-nano',
      'opencode/big-pickle',
    ]);
  });

  test('builds per-agent diff summary for confirm-before-apply', () => {
    const before = {
      orchestrator: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      oracle: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      designer: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      explorer: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      librarian: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      fixer: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
    };

    const after = {
      ...before,
      oracle: {
        primary: 'anthropic/claude-opus-4-6',
        fallback1: 'openai/gpt-5.3-codex',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
    };

    const diff = diffManualPlans(before, after);
    expect(diff.changedAgents).toEqual(['oracle']);
    expect(diff.unchangedAgents).toContain('fixer');
    expect(diff.details.oracle?.before[0]).toBe('openai/gpt-5.3-codex');
    expect(diff.details.oracle?.after[0]).toBe('anthropic/claude-opus-4-6');
  });

  test('warns when writing global while project config exists', () => {
    const temp = mkdtempSync(join(tmpdir(), 'omos-precedence-test-'));
    const originalEnv = { ...process.env };

    try {
      process.env.XDG_CONFIG_HOME = join(temp, 'xdg');
      const projectDir = join(temp, 'project');
      mkdirSync(join(projectDir, '.opencode'), { recursive: true });
      writeFileSync(
        join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
        '{"preset":"manual"}\n',
      );

      const globalTarget = resolveTargetPath(projectDir, 'global');
      const warning = precedenceWarning(globalTarget, projectDir);
      expect(warning).toContain('.opencode/oh-my-opencode-slim.json');
    } finally {
      process.env = originalEnv;
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test('scores manual plan candidates for v2', () => {
    const plan = {
      orchestrator: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      oracle: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      designer: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      explorer: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      librarian: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
      fixer: {
        primary: 'openai/gpt-5.3-codex',
        fallback1: 'anthropic/claude-opus-4-6',
        fallback2: 'chutes/kimi-k2.5',
        fallback3: 'opencode/gpt-5-nano',
      },
    };

    const scores = scoreManualPlan(plan, 'v2');
    expect(scores.oracle.length).toBe(4);
    expect(scores.oracle[0]?.totalScore).toBeGreaterThanOrEqual(
      scores.oracle[1]?.totalScore ?? 0,
    );
    expect(scores.oracle[0]?.breakdown).toBeDefined();
  });

  test('scores multi-segment provider model ids for /omos plans', () => {
    const plan = {
      orchestrator: {
        primary: 'chutes/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8-TEE',
        fallback1: 'openai/gpt-5.3-codex',
        fallback2: 'zai-coding-plan/glm-4.7',
        fallback3: 'opencode/gpt-5-nano',
      },
      oracle: {
        primary: 'chutes/Qwen/Qwen3-235B-A22B-Thinking-2507',
        fallback1: 'openai/gpt-5.3-codex',
        fallback2: 'zai-coding-plan/glm-4.7',
        fallback3: 'opencode/gpt-5-nano',
      },
      designer: {
        primary: 'chutes/deepseek-ai/DeepSeek-V3.1',
        fallback1: 'openai/gpt-5.3-codex',
        fallback2: 'zai-coding-plan/glm-4.7',
        fallback3: 'opencode/gpt-5-nano',
      },
      explorer: {
        primary: 'chutes/chutesai/Mistral-Small-3.1-24B-Instruct-2503',
        fallback1: 'openai/gpt-5.1-codex-mini',
        fallback2: 'zai-coding-plan/glm-4.7-flash',
        fallback3: 'opencode/gpt-5-nano',
      },
      librarian: {
        primary: 'chutes/Qwen/Qwen3-235B-A22B-Thinking-2507',
        fallback1: 'openai/gpt-5.3-codex',
        fallback2: 'zai-coding-plan/glm-4.7',
        fallback3: 'opencode/gpt-5-nano',
      },
      fixer: {
        primary: 'chutes/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8-TEE',
        fallback1: 'openai/gpt-5.1-codex-mini',
        fallback2: 'zai-coding-plan/glm-4.7-flash',
        fallback3: 'opencode/gpt-5-nano',
      },
    };

    const scores = scoreManualPlan(plan, 'v2');
    expect(scores.oracle.some((row) => row.model.startsWith('chutes/'))).toBe(
      true,
    );
    expect(scores.fixer[0]?.totalScore).toBeGreaterThanOrEqual(
      scores.fixer[1]?.totalScore ?? 0,
    );
  });
});
