import { z } from 'zod';
import type { AgentName } from '../config/constants';

export const ModelTierSchema = z.enum(['premium', 'mid', 'cheap']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const ModelAssignmentSchema = z.object({
  model: z.string(),
  tier: ModelTierSchema,
  description: z.string().optional(),
});

export type ModelAssignment = z.infer<typeof ModelAssignmentSchema>;

export const ModelFallbacksSchema = z.object({
  premium: z.array(z.string()).min(1),
  mid: z.array(z.string()).min(1),
  cheap: z.array(z.string()).min(1),
});

export type ModelFallbacks = z.infer<typeof ModelFallbacksSchema>;

export const TokenDisciplineSettingsSchema = z.object({
  enforceIsolation: z.boolean().default(true),
  maxPacketSize: z.number().min(500).max(5000).default(2500),
  maxResolutionsPerTask: z.number().min(1).max(10).default(3),
  threadArchiveHours: z.number().min(1).max(168).default(24),
});

export type TokenDisciplineSettings = z.infer<
  typeof TokenDisciplineSettingsSchema
>;

export const ModelConfigSchema = z.object({
  model_assignments: z.record(z.string(), ModelAssignmentSchema),
  model_fallbacks: ModelFallbacksSchema,
  token_discipline: TokenDisciplineSettingsSchema.optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'anthropic/claude-opus-4': { input: 15.0, output: 75.0 },
  'anthropic/claude-sonnet-4': { input: 3.0, output: 15.0 },
  'anthropic/claude-haiku-3.5': { input: 0.8, output: 4.0 },
  'openai/gpt-4o': { input: 2.5, output: 10.0 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai/o1': { input: 15.0, output: 60.0 },
  'google/gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'google/gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'openai/gpt-5.1-codex-mini': { input: 0.5, output: 2.0 },
  'openai/gpt-5.2-codex': { input: 3.0, output: 12.0 },
  'kimi-for-coding/k2p5': { input: 2.0, output: 8.0 },
};

export const ROLE_TO_AGENT: Record<string, AgentName> = {
  ORCHESTRATOR: 'orchestrator',
  RESEARCHER: 'librarian',
  REPO_SCOUT: 'explorer',
  IMPLEMENTER: 'fixer',
  VALIDATOR: 'oracle',
  DESIGNER: 'designer',
  SUMMARIZER: 'librarian',
};

export const AGENT_TO_ROLE: Record<AgentName, string> = {
  orchestrator: 'ORCHESTRATOR',
  librarian: 'RESEARCHER',
  explorer: 'REPO_SCOUT',
  fixer: 'IMPLEMENTER',
  oracle: 'VALIDATOR',
  designer: 'DESIGNER',
  summarizer: 'SUMMARIZER',
};

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model_assignments: {
    orchestrator: {
      model: 'kimi-for-coding/k2p5',
      tier: 'premium',
      description: 'Primary decision-maker, receives packets only',
    },
    researcher: {
      model: 'openai/gpt-5.1-codex-mini',
      tier: 'cheap',
      description: 'External docs and library research',
    },
    repo_scout: {
      model: 'openai/gpt-5.1-codex-mini',
      tier: 'cheap',
      description: 'Codebase analysis and file finding',
    },
    implementer: {
      model: 'openai/gpt-5.2-codex',
      tier: 'mid',
      description: 'Code generation and changes',
    },
    validator: {
      model: 'openai/gpt-5.2-codex',
      tier: 'mid',
      description: 'Testing and code review',
    },
    designer: {
      model: 'kimi-for-coding/k2p5',
      tier: 'mid',
      description: 'UI/UX and styling work',
    },
    summarizer: {
      model: 'openai/gpt-5.1-codex-mini',
      tier: 'cheap',
      description: 'Emergency packet compression fallback',
    },
  },
  model_fallbacks: {
    premium: [
      'kimi-for-coding/k2p5',
      'anthropic/claude-opus-4',
      'openai/o1',
      'openai/gpt-4o',
    ],
    mid: ['openai/gpt-5.2-codex', 'anthropic/claude-sonnet-4', 'openai/gpt-4o'],
    cheap: [
      'openai/gpt-5.1-codex-mini',
      'anthropic/claude-haiku-3.5',
      'openai/gpt-4o-mini',
      'google/gemini-2.0-flash',
    ],
  },
  token_discipline: {
    enforceIsolation: true,
    maxPacketSize: 2500,
    maxResolutionsPerTask: 3,
    threadArchiveHours: 24,
  },
};

export function validateModelConfig(config: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  const requiredRoles = [
    'orchestrator',
    'researcher',
    'repo_scout',
    'implementer',
    'validator',
    'designer',
    'summarizer',
  ];

  if (
    typeof config === 'object' &&
    config !== null &&
    'model_assignments' in config
  ) {
    const assignments = config.model_assignments as Record<string, unknown>;
    for (const role of requiredRoles) {
      if (!(role in assignments)) {
        errors.push(`Missing model assignment for role: ${role}`);
      }
    }
  } else {
    errors.push('Missing model_assignments section');
  }

  if (
    typeof config === 'object' &&
    config !== null &&
    'model_fallbacks' in config
  ) {
    const fallbacks = config.model_fallbacks as Record<string, unknown>;
    const requiredTiers = ['premium', 'mid', 'cheap'];
    for (const tier of requiredTiers) {
      if (!(tier in fallbacks)) {
        errors.push(`Missing fallback models for tier: ${tier}`);
      }
    }
  } else {
    errors.push('Missing model_fallbacks section');
  }

  const result = ModelConfigSchema.safeParse(config);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
