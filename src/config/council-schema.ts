import { z } from 'zod';
import {
  type CouncillorModelEntry,
  normalizeCouncillorModels,
} from '../utils/councillor-models';

export type { CouncillorModelEntry };

/**
 * Validates model IDs in "provider/model" format.
 * Inlined here to avoid circular dependency with schema.ts.
 */
const ModelIdSchema = z
  .string()
  .regex(
    /^[^/\s]+\/[^\s]+$/,
    'Expected provider/model format (e.g. "openai/gpt-5.6-luna")',
  );

const CouncillorModelEntrySchema = z.object({
  id: ModelIdSchema,
  variant: z.string().optional(),
});

/**
 * A councillor's model: either a single "provider/model" string, or an
 * ordered fallback chain (array of strings and/or { id, variant } entries)
 * tried in order until one responds.
 */
const CouncillorModelSchema = z
  .union([
    ModelIdSchema,
    z.array(z.union([ModelIdSchema, CouncillorModelEntrySchema])).min(1),
  ])
  .describe(
    'Model ID in provider/model format (e.g. "openai/gpt-5.6-luna"), or an ' +
      'ordered fallback chain (array of model IDs or { id, variant } entries) ' +
      'tried in order until one responds.',
  );

/**
 * Configuration for a single councillor within a preset.
 * Each councillor is an independent LLM that processes the same prompt.
 *
 * Councillors run as agent sessions with read-only codebase access
 * (read, glob, grep, lsp, list). They can examine the codebase but
 * cannot modify files or spawn subagents.
 *
 * `model` accepts a single ID or an ordered fallback chain. The parsed config
 * exposes `models` (the normalized chain) plus `model` (the primary, for
 * backward compatibility).
 */
export const CouncillorConfigSchema = z
  .object({
    model: CouncillorModelSchema,
    variant: z.string().optional(),
    prompt: z
      .string()
      .optional()
      .describe(
        'Optional role/guidance injected into the councillor user prompt',
      ),
  })
  .transform((c) => {
    const models = normalizeCouncillorModels(c.model, c.variant);
    return {
      model: models[0].id,
      variant: c.variant,
      prompt: c.prompt,
      models,
    };
  });

export type CouncillorConfig = z.infer<typeof CouncillorConfigSchema>;

/**
 * A named preset grouping several councillors.
 *
 * All keys are treated as councillor names mapping to councillor configs.
 */
export const CouncilPresetSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .transform((entries, ctx) => {
    const councillors: Record<string, CouncillorConfig> = {};

    for (const [key, raw] of Object.entries(entries)) {
      const parsed = CouncillorConfigSchema.safeParse(raw);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid councillor "${key}": ${parsed.error.issues
            .map((i) => i.message)
            .join(', ')}`,
        });
        return z.NEVER;
      }
      councillors[key] = parsed.data;
    }

    return councillors;
  });

export type CouncilPreset = z.infer<typeof CouncilPresetSchema>;

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
 *     "presets": {
 *       "default": {
 *         "alpha": { "model": "openai/gpt-5.6-luna" },
 *         "beta":  { "model": "openai/gpt-5.3-codex" },
 *         "gamma": { "model": "google/gemini-3-pro" }
 *       }
 *     },
 *     "timeout": 180000,
 *     "councillor_execution_mode": "serial"
 *   }
 * }
 * ```
 */
export const CouncilConfigSchema = z
  .object({
    presets: z.record(z.string(), CouncilPresetSchema),
    timeout: z.number().min(0).default(180000),
    default_preset: z.string().default('default'),
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
        'Number of retry attempts for councillors that return empty responses ' +
          '(e.g. due to provider rate limiting). Default: 3 retries.',
      ),
  })
  .transform((data) => {
    return {
      presets: data.presets,
      timeout: data.timeout,
      default_preset: data.default_preset,
      councillor_execution_mode: data.councillor_execution_mode,
      councillor_retries: data.councillor_retries,
    };
  });

export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;
export type CouncillorExecutionMode = z.infer<
  typeof CouncillorExecutionModeSchema
>;

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
