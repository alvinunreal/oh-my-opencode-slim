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
 * The reserved key `"master"` is silently ignored (legacy from when
 * council-master was a separate agent).
 */
export const CouncilPresetSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .transform((entries, ctx) => {
    const councillors: Record<string, CouncillorConfig> = {};

    for (const [key, raw] of Object.entries(entries)) {
      // Silently skip the legacy "master" key - no longer parsed as a
      // councillor. Old configs with per-preset master overrides won't
      // error, but the override has no effect.
      if (key === 'master') continue;

      // Legacy nested format: old configs wrapped councillors in a
      // "councillors" key inside each preset. Unwrap them into the
      // parent so the config still works without migration.
      if (key === 'councillors' && typeof raw === 'object' && raw !== null) {
        for (const [innerKey, innerRaw] of Object.entries(
          raw as Record<string, unknown>,
        )) {
          const innerParsed = CouncillorConfigSchema.safeParse(innerRaw);
          if (!innerParsed.success) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Invalid councillor "${innerKey}" (nested under legacy "councillors" key): ${innerParsed.error.issues
                .map((i) => i.message)
                .join(', ')}`,
            });
            return z.NEVER;
          }
          councillors[innerKey] = innerParsed.data;
        }
        continue;
      }

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
 *     }
 *   }
 * }
 * ```
 */
export const CouncilConfigSchema = z
  .object({
    presets: z.record(z.string(), CouncilPresetSchema),
    default_preset: z.string().default('default'),
  })
  .passthrough()
  .transform((data) => {
    // Detect deprecated fields and attach warning for consumers
    const deprecated: string[] = [];
    if ('master' in data) deprecated.push('master');

    return {
      presets: data.presets,
      default_preset: data.default_preset,
      _deprecated: deprecated.length > 0 ? deprecated : undefined,
    };
  });

export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;
