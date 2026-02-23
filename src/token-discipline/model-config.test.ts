import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MODEL_CONFIG,
  MODEL_COSTS,
  ModelConfigSchema,
  ROLE_TO_AGENT,
  validateModelConfig,
} from './model-config';

describe('model-config', () => {
  test('DEFAULT_MODEL_CONFIG has all required roles', () => {
    const requiredRoles = [
      'orchestrator',
      'researcher',
      'repo_scout',
      'implementer',
      'validator',
      'designer',
      'summarizer',
    ];

    for (const role of requiredRoles) {
      expect(DEFAULT_MODEL_CONFIG.model_assignments[role]).toBeDefined();
      expect(DEFAULT_MODEL_CONFIG.model_assignments[role].model).toBeDefined();
      expect(DEFAULT_MODEL_CONFIG.model_assignments[role].tier).toBeDefined();
    }
  });

  test('DEFAULT_MODEL_CONFIG has all fallback tiers', () => {
    expect(DEFAULT_MODEL_CONFIG.model_fallbacks.premium.length).toBeGreaterThan(
      0,
    );
    expect(DEFAULT_MODEL_CONFIG.model_fallbacks.mid.length).toBeGreaterThan(0);
    expect(DEFAULT_MODEL_CONFIG.model_fallbacks.cheap.length).toBeGreaterThan(
      0,
    );
  });

  test('ROLE_TO_AGENT maps all roles to agents', () => {
    const roles = [
      'ORCHESTRATOR',
      'RESEARCHER',
      'REPO_SCOUT',
      'IMPLEMENTER',
      'VALIDATOR',
      'DESIGNER',
      'SUMMARIZER',
    ];

    for (const role of roles) {
      expect(ROLE_TO_AGENT[role]).toBeDefined();
    }
  });

  test('ModelConfigSchema validates correct config', () => {
    const result = ModelConfigSchema.safeParse(DEFAULT_MODEL_CONFIG);
    expect(result.success).toBe(true);
  });

  test('ModelConfigSchema rejects invalid tier', () => {
    const invalidConfig = {
      ...DEFAULT_MODEL_CONFIG,
      model_assignments: {
        ...DEFAULT_MODEL_CONFIG.model_assignments,
        orchestrator: {
          model: 'test-model',
          tier: 'invalid-tier',
        },
      },
    };

    const result = ModelConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
  });

  test('validateModelConfig returns valid for correct config', () => {
    const result = validateModelConfig(DEFAULT_MODEL_CONFIG);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('validateModelConfig detects missing role', () => {
    const invalidConfig = {
      model_assignments: {},
      model_fallbacks: DEFAULT_MODEL_CONFIG.model_fallbacks,
    };

    const result = validateModelConfig(invalidConfig);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('validateModelConfig requires role names not agent names', () => {
    const agentBasedConfig = {
      model_assignments: {
        orchestrator: { model: 'test/model-1', tier: 'premium' },
        librarian: { model: 'test/model-2', tier: 'cheap' },
        explorer: { model: 'test/model-3', tier: 'cheap' },
        fixer: { model: 'test/model-4', tier: 'mid' },
        oracle: { model: 'test/model-5', tier: 'mid' },
        designer: { model: 'test/model-6', tier: 'mid' },
        summarizer: { model: 'test/model-7', tier: 'cheap' },
      },
      model_fallbacks: DEFAULT_MODEL_CONFIG.model_fallbacks,
    };

    const result = validateModelConfig(agentBasedConfig);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Missing model assignment for role: researcher',
    );
    expect(result.errors).toContain(
      'Missing model assignment for role: repo_scout',
    );
    expect(result.errors).toContain(
      'Missing model assignment for role: implementer',
    );
    expect(result.errors).toContain(
      'Missing model assignment for role: validator',
    );
  });

  test('validateModelConfig accepts correct role-name-based config', () => {
    const roleBasedConfig = {
      model_assignments: {
        orchestrator: { model: 'test/model-1', tier: 'premium' },
        researcher: { model: 'test/model-2', tier: 'cheap' },
        repo_scout: { model: 'test/model-3', tier: 'cheap' },
        implementer: { model: 'test/model-4', tier: 'mid' },
        validator: { model: 'test/model-5', tier: 'mid' },
        designer: { model: 'test/model-6', tier: 'mid' },
        summarizer: { model: 'test/model-7', tier: 'cheap' },
      },
      model_fallbacks: DEFAULT_MODEL_CONFIG.model_fallbacks,
    };

    const result = validateModelConfig(roleBasedConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('MODEL_COSTS has known models', () => {
    expect(MODEL_COSTS['anthropic/claude-opus-4']).toBeDefined();
    expect(MODEL_COSTS['openai/gpt-4o']).toBeDefined();
    expect(MODEL_COSTS['anthropic/claude-haiku-3.5']).toBeDefined();
  });
});
