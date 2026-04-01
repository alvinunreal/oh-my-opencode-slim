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
  prompt: z
    .string()
    .optional()
    .describe(
      'Optional role/guidance injected into the councillor user prompt',
    ),
});

export type CouncillorConfig = z.infer<typeof CouncillorConfigSchema>;

/**
 * Per-preset master override. All fields are optional — any field
 * provided here overrides the global `council.master` for this preset.
 * Fields not provided fall back to the global master config.
 */
export const PresetMasterOverrideSchema = z.object({
  model: ModelIdSchema.optional().describe(
    'Override the master model for this preset',
  ),
  variant: z
    .string()
    .optional()
    .describe('Override the master variant for this preset'),
  prompt: z
    .string()
    .optional()
    .describe('Override the master synthesis guidance for this preset'),
});

export type PresetMasterOverride = z.infer<typeof PresetMasterOverrideSchema>;

/**
 * A named preset grouping several councillors with an optional master override.
 *
 * The reserved key `"master"` provides per-preset overrides for the council
 * master (model, variant, prompt). All other keys are treated as councillor
 * names mapping to councillor configs.
 *
 * After parsing, the preset resolves to:
 * `{ councillors: Record<string, CouncillorConfig>, master?: PresetMasterOverride }`
 */
export const CouncilPresetSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .transform((entries, ctx) => {
    const councillors: Record<string, CouncillorConfig> = {};
    let masterOverride: PresetMasterOverride | undefined;

    for (const [key, raw] of Object.entries(entries)) {
      if (key === 'master') {
        const parsed = PresetMasterOverrideSchema.safeParse(raw);
        if (!parsed.success) {
          ctx.addIssue(
            `Invalid master override in preset: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
          );
          return z.NEVER;
        }
        masterOverride = parsed.data;
      } else {
        const parsed = CouncillorConfigSchema.safeParse(raw);
        if (!parsed.success) {
          ctx.addIssue(
            `Invalid councillor "${key}": ${parsed.error.issues.map((i) => i.message).join(', ')}`,
          );
          return z.NEVER;
        }
        councillors[key] = parsed.data;
      }
    }

    return { councillors, master: masterOverride };
  });

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
  prompt: z
    .string()
    .optional()
    .describe(
      'Optional role/guidance injected into the master synthesis prompt',
    ),
});

export type CouncilMasterConfig = z.infer<typeof CouncilMasterConfigSchema>;

/**
 * Execution mode for councillors.
 * - parallel: Run all councillors concurrently (default, fastest for multi-model systems)
 * - serial: Run councillors one at a time (required for single-model systems to avoid conflicts)
 */
export const CouncillorExecutionModeSchema = z
  .enum(['parallel', 'serial'])
  .default('parallel')
  .describe(
    'Execution mode for councillors. Use "serial" for single-model systems to avoid conflicts. ' +
      'Use "parallel" for multi-model systems for faster execution.',
  );

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
 *     "councillors_timeout": 180000,
 *     "councillor_execution_mode": "serial"
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
        // Silently deduplicate — no validation error is raised for
        // duplicate entries; duplicates are removed transparently.
        return unique;
      }
      return val;
    })
    .describe(
      'Fallback models for the council master. Tried in order if the primary model fails. ' +
        'Example: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"]',
    ),
  councillor_execution_mode: CouncillorExecutionModeSchema.describe(
    'Execution mode for councillors. "serial" runs them one at a time (required for single-model systems). "parallel" runs them concurrently (default, faster for multi-model systems).',
  ),
  councillor_retries: z
    .number()
    .int()
    .min(0)
    .max(5)
    .default(3)
    .describe(
      'Number of retry attempts for councillors and master that return empty responses ' +
        '(e.g. due to provider rate limiting). Default: 3 retries.',
    ),
});

export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;
export type CouncillorExecutionMode = z.infer<
  typeof CouncillorExecutionModeSchema
>;

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
