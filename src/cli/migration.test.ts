/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  migrateLegacyAssignmentsV1ToV2,
  rollbackAssignmentsV2ToLegacy,
} from './migration';
import type { InstallConfig } from './types';

function baseConfig(): InstallConfig {
  return {
    hasKimi: false,
    hasOpenAI: false,
    hasAnthropic: false,
    hasCopilot: false,
    hasZaiPlan: false,
    hasAntigravity: false,
    hasChutes: false,
    hasNanoGpt: false,
    hasOpencodeZen: true,
    useOpenCodeFreeModels: false,
    hasTmux: false,
    installSkills: false,
    installCustomSkills: false,
    setupMode: 'quick',
  };
}

describe('migration', () => {
  test('migrates legacy Chutes two-slot fields into per-agent map', () => {
    const input: InstallConfig = {
      ...baseConfig(),
      hasChutes: true,
      selectedChutesPrimaryModel: 'chutes/kimi-k2.5',
      selectedChutesSecondaryModel: 'chutes/minimax-m2.1',
    };

    const result = migrateLegacyAssignmentsV1ToV2(input);

    expect(result.migrated).toBe(true);
    expect(result.config.selectedChutesModelsByAgent?.orchestrator.model).toBe(
      'chutes/kimi-k2.5',
    );
    expect(result.config.selectedChutesModelsByAgent?.explorer.model).toBe(
      'chutes/minimax-m2.1',
    );
    expect(result.config._migratedFromV1).toBe(true);
    expect(result.config._migrationTimestamp).toBeDefined();
  });

  test('reuses legacy primary slot when support slot is missing', () => {
    const input: InstallConfig = {
      ...baseConfig(),
      useOpenCodeFreeModels: true,
      selectedOpenCodePrimaryModel: 'opencode/glm-4.7-free',
    };

    const result = migrateLegacyAssignmentsV1ToV2(input);

    expect(result.migrated).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(
      result.config.selectedOpenCodeModelsByAgent?.orchestrator.model,
    ).toBe('opencode/glm-4.7-free');
    expect(result.config.selectedOpenCodeModelsByAgent?.fixer.model).toBe(
      'opencode/glm-4.7-free',
    );
  });

  test('rolls back per-agent map into legacy slots when missing', () => {
    const input: InstallConfig = {
      ...baseConfig(),
      hasChutes: true,
      selectedChutesModelsByAgent: {
        orchestrator: { model: 'chutes/kimi-k2.5' },
        oracle: { model: 'chutes/kimi-k2.5', variant: 'high' },
        designer: { model: 'chutes/kimi-k2.5', variant: 'medium' },
        explorer: { model: 'chutes/minimax-m2.1', variant: 'low' },
        librarian: { model: 'chutes/minimax-m2.1', variant: 'low' },
        fixer: { model: 'chutes/minimax-m2.1', variant: 'low' },
      },
    };

    const rolledBack = rollbackAssignmentsV2ToLegacy(input);

    expect(rolledBack.selectedChutesPrimaryModel).toBe('chutes/kimi-k2.5');
    expect(rolledBack.selectedChutesSecondaryModel).toBe('chutes/minimax-m2.1');
  });
});
