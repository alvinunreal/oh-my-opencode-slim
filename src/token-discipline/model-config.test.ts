import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_MODEL_CONFIG,
  MODEL_COSTS,
  ModelConfigSchema,
  ROLE_TO_AGENT,
  validateModelConfig,
} from './model-config';
import {
  clearCache,
  getAllAssignments,
  getModelCost,
  getModelForRole,
  getTokenDisciplineSettings,
  setConfigDirectory,
  validateConfig,
} from './model-config-loader';

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

  test('MODEL_COSTS has known models', () => {
    expect(MODEL_COSTS['anthropic/claude-opus-4']).toBeDefined();
    expect(MODEL_COSTS['openai/gpt-4o']).toBeDefined();
    expect(MODEL_COSTS['anthropic/claude-haiku-3.5']).toBeDefined();
  });
});

describe('model-config-loader', () => {
  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  test('getModelForRole returns default model for unknown role', async () => {
    setConfigDirectory('/nonexistent');
    clearCache();
    const model = await getModelForRole('ORCHESTRATOR');
    expect(model).toBeDefined();
    expect(typeof model).toBe('string');
  });

  test('getTokenDisciplineSettings returns defaults', async () => {
    setConfigDirectory('/nonexistent');
    clearCache();
    const settings = await getTokenDisciplineSettings();
    expect(settings.maxPacketSize).toBe(2500);
    expect(settings.maxResolutionsPerTask).toBe(3);
    expect(settings.enforceIsolation).toBe(true);
  });

  test('getModelCost returns costs for known model', () => {
    const costs = getModelCost('anthropic/claude-opus-4');
    expect(costs.input).toBe(15.0);
    expect(costs.output).toBe(75.0);
  });

  test('getModelCost returns zero for unknown model', () => {
    const costs = getModelCost('unknown/model');
    expect(costs.input).toBe(0);
    expect(costs.output).toBe(0);
  });

  test('getAllAssignments returns all roles', async () => {
    setConfigDirectory('/nonexistent');
    clearCache();
    const assignments = await getAllAssignments();
    expect(assignments.orchestrator).toBeDefined();
    expect(assignments.researcher).toBeDefined();
    expect(assignments.implementer).toBeDefined();
  });

  test('validateConfig returns validation result', async () => {
    setConfigDirectory('/nonexistent');
    clearCache();
    const result = await validateConfig();
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('errors');
  });
});
