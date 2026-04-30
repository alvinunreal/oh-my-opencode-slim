import { describe, expect, test } from 'bun:test';
import { formatSidebarModelName, getSidebarAgentNames } from './tui';
import type { TuiSnapshot } from './tui-state';

function createSnapshot(agentModels: TuiSnapshot['agentModels']): TuiSnapshot {
  return {
    version: 1,
    updatedAt: 0,
    agentModels,
  };
}

describe('tui sidebar agents', () => {
  test('hides disabled agents when models are persisted explicitly', () => {
    const agentNames = getSidebarAgentNames(
      createSnapshot({
        explorer: 'openai/gpt-5.4-mini',
        fixer: 'openai/gpt-5.4-mini',
      }),
    );

    expect(agentNames).toEqual(['explorer', 'fixer']);
    expect(agentNames).not.toContain('observer');
    expect(agentNames).not.toContain('librarian');
  });

  test('uses default-enabled fallback before models are persisted', () => {
    const agentNames = getSidebarAgentNames(createSnapshot({}));

    expect(agentNames).toContain('explorer');
    expect(agentNames).toContain('fixer');
    expect(agentNames).not.toContain('observer');
    expect(agentNames).not.toContain('council');
    expect(agentNames).not.toContain('councillor');
  });
});

describe('formatSidebarModelName', () => {
  test('keeps only the segment after the last slash', () => {
    expect(formatSidebarModelName('openai/gpt-5.5-fast')).toBe('gpt-5.5-fast');
    expect(
      formatSidebarModelName(
        'fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo',
      ),
    ).toBe('kimi-k2p5-turbo');
  });

  test('leaves model names without slashes unchanged', () => {
    expect(formatSidebarModelName('pending')).toBe('pending');
  });
});
