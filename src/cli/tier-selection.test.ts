/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  buildAgentAssignments,
  buildAllFallbackChains,
  buildFallbackChain,
  getAvailableProviders,
  loadModelsConfig,
  selectModelForAgent,
} from './tier-selection';

describe('tier-selection', () => {
  describe('loadModelsConfig', () => {
    test('loads default config when no user config provided', () => {
      const config = loadModelsConfig();

      expect(config.providers).toBeDefined();
      expect(config.providers.anthropic).toBeDefined();
      expect(config.providers.openai).toBeDefined();
      expect(config.providers.google).toBeDefined();
      expect(config.agentRequirements).toBeDefined();
      expect(config.agentRequirements.orchestrator).toBeDefined();
    });

    test('merges user config with defaults', () => {
      const userConfig = {
        providers: {
          anthropic: {
            models: {
              'claude-opus-4': {
                tier: 'high' as const, // Override tier
                capabilities: ['reasoning' as const, 'toolcall' as const],
              },
            },
          },
        },
      };

      const config = loadModelsConfig(userConfig as Partial<typeof config>);

      // User override should take effect
      expect(config.providers.anthropic.models['claude-opus-4'].tier).toBe(
        'high',
      );
      // Other providers should still exist from defaults
      expect(config.providers.openai).toBeDefined();
    });
  });

  describe('selectModelForAgent', () => {
    test('selects premium tier model for orchestrator', () => {
      const config = loadModelsConfig();
      const result = selectModelForAgent('orchestrator', ['anthropic'], config);

      expect(result).not.toBeNull();
      expect(result?.model).toBe('anthropic/claude-opus-4');
    });

    test('selects low tier model for explorer', () => {
      const config = loadModelsConfig();
      const result = selectModelForAgent('explorer', ['anthropic'], config);

      expect(result).not.toBeNull();
      expect(result?.model).toBe('anthropic/claude-haiku-3.5');
    });

    test('falls back to next tier when preferred not available', () => {
      const config = loadModelsConfig();
      // Remove premium models from anthropic
      delete config.providers.anthropic.models['claude-opus-4'];
      delete config.providers.anthropic.models['claude-opus-4-5-20250115'];

      const result = selectModelForAgent('orchestrator', ['anthropic'], config);

      expect(result).not.toBeNull();
      // Should fall back to high tier (sonnet)
      expect(result?.model).toMatch(/claude-sonnet/);
    });

    test('returns null when no models meet requirements', () => {
      const config = loadModelsConfig();
      // Create a provider with no reasoning models
      config.providers = {
        test: {
          models: {
            'test-model': {
              tier: 'premium',
              capabilities: ['toolcall'], // Missing 'reasoning'
            },
          },
        },
      };

      const result = selectModelForAgent('orchestrator', ['test'], config);

      // Orchestrator requires reasoning, so should return null
      expect(result).toBeNull();
    });

    test('selects preferred tier first, then considers capabilities', () => {
      const config = loadModelsConfig();
      // Designer prefers medium tier, gpt-5.1-codex-mini is medium
      const result = selectModelForAgent('designer', ['openai'], config);

      expect(result).not.toBeNull();
      // Medium tier is preferred, so gpt-5.1-codex-mini is selected
      expect(result?.model).toBe('openai/gpt-5.1-codex-mini');
    });

    test('includes variant from agent requirements', () => {
      const config = loadModelsConfig();
      // Oracle prefers high tier, anthropic has claude-sonnet-4 at high tier
      const result = selectModelForAgent('oracle', ['anthropic'], config);

      expect(result).not.toBeNull();
      expect(result?.model).toMatch(/claude-sonnet/);
      expect(result?.variant).toBe('high');
    });
  });

  describe('buildAgentAssignments', () => {
    test('builds assignments for all agents', () => {
      const assignments = buildAgentAssignments(['anthropic']);

      expect(assignments.orchestrator).toBeDefined();
      expect(assignments.oracle).toBeDefined();
      expect(assignments.fixer).toBeDefined();
      expect(assignments.designer).toBeDefined();
      expect(assignments.explorer).toBeDefined();
      expect(assignments.librarian).toBeDefined();
      expect(assignments.summarizer).toBeDefined();
    });

    test('uses multiple providers when available', () => {
      const assignments = buildAgentAssignments(['anthropic', 'openai']);

      // Should have assignments from available providers
      expect(assignments.orchestrator).toBeDefined();
      expect(assignments.orchestrator.model).toMatch(/anthropic\/|openai\//);
    });
  });

  describe('buildFallbackChain', () => {
    test('builds chain in tier order', () => {
      const chain = buildFallbackChain('orchestrator', ['anthropic']);

      expect(chain.length).toBeGreaterThan(0);
      // First should be premium tier
      expect(chain[0]).toMatch(/claude-opus/);
    });

    test('includes models from all available providers', () => {
      const chain = buildFallbackChain('orchestrator', ['anthropic', 'openai']);

      const hasAnthropic = chain.some((m) => m.startsWith('anthropic/'));
      const hasOpenai = chain.some((m) => m.startsWith('openai/'));

      expect(hasAnthropic).toBe(true);
      expect(hasOpenai).toBe(true);
    });

    test('deduplicates models in chain', () => {
      const chain = buildFallbackChain('explorer', ['anthropic']);

      const uniqueModels = new Set(chain);
      expect(chain.length).toBe(uniqueModels.size);
    });
  });

  describe('buildAllFallbackChains', () => {
    test('builds chains for all agents', () => {
      const chains = buildAllFallbackChains(['anthropic']);

      expect(chains.orchestrator).toBeDefined();
      expect(chains.oracle).toBeDefined();
      expect(chains.fixer).toBeDefined();
      expect(chains.designer).toBeDefined();
      expect(chains.explorer).toBeDefined();
      expect(chains.librarian).toBeDefined();
      expect(chains.summarizer).toBeDefined();
    });
  });

  describe('getAvailableProviders', () => {
    test('returns empty array when no providers enabled', () => {
      const providers = getAvailableProviders({});

      expect(providers).toEqual([]);
    });

    test('returns correct providers based on flags', () => {
      const providers = getAvailableProviders({
        hasAnthropic: true,
        hasOpenAI: true,
        hasAntigravity: false,
      });

      expect(providers).toContain('anthropic');
      expect(providers).toContain('openai');
      expect(providers).not.toContain('google');
    });

    test('maps hasAntigravity to google provider', () => {
      const providers = getAvailableProviders({
        hasAntigravity: true,
      });

      expect(providers).toContain('google');
    });

    test('includes opencode when useOpenCodeFreeModels is true', () => {
      const providers = getAvailableProviders({
        useOpenCodeFreeModels: true,
      });

      expect(providers).toContain('opencode');
    });
  });
});
