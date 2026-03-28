import { z } from 'zod';

/**
 * Validates model IDs in "provider/model" format.
 * Inlined here to avoid circular dependency with schema.ts.
 */
const ModelIdSchema = z
  .string()
  .regex(
    /^[^/\s]+\/[^\s]+$/,
    'Expected provider/model format (e.g. "openai/gpt-5.4-mini")',
  );

/**
 * Configuration for a single councillor within a preset.
 * Each councillor is an independent LLM that processes the same prompt.
 *
 * Councillors run as agent sessions with read-only codebase access
 * (read, glob, grep, lsp, list). They can examine the codebase but
 * cannot modify files or spawn subagents.
 */
export const CouncillorConfigSchema = z.object({
  model: ModelIdSchema.describe(
    'Model ID in provider/model format (e.g. "openai/gpt-5.4-mini")',
  ),
  variant: z.string().optional(),
});

export type CouncillorConfig = z.infer<typeof CouncillorConfigSchema>;

/**
 * A named preset grouping several councillors.
 * Key = councillor name (e.g. "alpha", "beta", "gamma").
 */
export const CouncilPresetSchema = z.record(z.string(), CouncillorConfigSchema);

export type CouncilPreset = z.infer<typeof CouncilPresetSchema>;

/**
 * Council Master configuration.
 * The master receives all councillor responses and produces the final synthesis.
 *
 * Note: The master runs as a council-master agent session with zero
 * permissions (deny all). Synthesis is a text-in/text-out operation —
 * no tools or MCPs are needed.
 */
export const CouncilMasterConfigSchema = z.object({
  model: ModelIdSchema.describe(
    'Model ID for the council master (e.g. "anthropic/claude-opus-4-6")',
  ),
  variant: z.string().optional(),
});

export type CouncilMasterConfig = z.infer<typeof CouncilMasterConfigSchema>;

/**
 * Top-level council configuration.
 *
 * Example JSONC:
 * ```jsonc
 * {
 *   "council": {
 *     "master": { "model": "anthropic/claude-opus-4-6" },
 *     "presets": {
 *       "default": {
 *         "alpha": { "model": "openai/gpt-5.4-mini" },
 *         "beta":  { "model": "openai/gpt-5.3-codex" },
 *         "gamma": { "model": "google/gemini-3-pro" }
 *       }
 *     },
 *     "master_timeout": 300000,
 *     "councillors_timeout": 180000
 *   }
 * }
 * ```
 */
export const CouncilConfigSchema = z.object({
  master: CouncilMasterConfigSchema,
  presets: z.record(z.string(), CouncilPresetSchema),
  master_timeout: z.number().min(0).default(300000),
  councillors_timeout: z.number().min(0).default(180000),
  default_preset: z.string().default('default'),
  master_fallback: z
    .array(ModelIdSchema)
    .optional()
    .transform((val) => {
      if (!val) return val;
      const unique = [...new Set(val)];
      if (unique.length !== val.length) {
        // Zod will catch this — dedupe and let the transform proceed
        return unique;
      }
      return val;
    })
    .describe(
      'Fallback models for the council master. Tried in order if the primary model fails. ' +
        'Example: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"]',
    ),
});

export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;

/**
 * A sensible default council configuration that users can copy into their
 * opencode.jsonc. Provides a 3-councillor preset using common models.
 *
 * Users should replace models with ones they have access to.
 *
 * ```jsonc
 * "council": DEFAULT_COUNCIL_CONFIG
 * ```
 */
export const DEFAULT_COUNCIL_CONFIG: z.input<typeof CouncilConfigSchema> = {
  master: { model: 'anthropic/claude-opus-4-6' },
  presets: {
    default: {
      alpha: { model: 'openai/gpt-5.4-mini' },
      beta: { model: 'openai/gpt-5.3-codex' },
      gamma: { model: 'google/gemini-3-pro' },
    },
  },
};

/**
 * Result of a council session.
 */
export interface CouncilResult {
  success: boolean;
  result?: string;
  error?: string;
  councillorResults: Array<{
    name: string;
    model: string;
    status: 'completed' | 'failed' | 'timed_out';
    result?: string;
    error?: string;
  }>;
}
