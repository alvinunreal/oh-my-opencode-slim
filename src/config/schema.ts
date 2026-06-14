import { z } from 'zod';
import { AGENT_ALIASES, ALL_AGENT_NAMES } from './constants';
import { CouncilConfigSchema } from './council-schema';

const MANUAL_AGENT_NAMES = [
  'orchestrator',
  'oracle',
  'designer',
  'explorer',
  'librarian',
  'fixer',
] as const;

export const ProviderModelIdSchema = z
  .string()
  .regex(
    /^[^/\s]+\/[^\s]+$/,
    'Expected provider/model format (provider/.../model)',
  );

export const ManualAgentPlanSchema = z
  .object({
    primary: ProviderModelIdSchema,
    fallback1: ProviderModelIdSchema,
    fallback2: ProviderModelIdSchema,
    fallback3: ProviderModelIdSchema,
  })
  .superRefine((value, ctx) => {
    const unique = new Set([
      value.primary,
      value.fallback1,
      value.fallback2,
      value.fallback3,
    ]);
    if (unique.size !== 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'primary and fallbacks must be unique per agent',
      });
    }
  });

export const ManualPlanSchema = z
  .object({
    orchestrator: ManualAgentPlanSchema,
    oracle: ManualAgentPlanSchema,
    designer: ManualAgentPlanSchema,
    explorer: ManualAgentPlanSchema,
    librarian: ManualAgentPlanSchema,
    fixer: ManualAgentPlanSchema,
  })
  .strict();

export type ManualAgentName = (typeof MANUAL_AGENT_NAMES)[number];
export type ManualAgentPlan = z.infer<typeof ManualAgentPlanSchema>;
export type ManualPlan = z.infer<typeof ManualPlanSchema>;

// Agent override configuration (distinct from SDK's AgentConfig)
export const AgentOverrideConfigSchema = z
  .object({
    model: z
      .union([
        z.string(),
        z
          .array(
            z.union([
              z.string(),
              z.object({
                id: z.string(),
                variant: z.string().optional(),
              }),
            ]),
          )
          .min(1),
      ])
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    variant: z.string().optional().catch(undefined),
    skills: z.array(z.string()).optional(), // skills this agent can use ("*" = all, "!item" = exclude)
    mcps: z.array(z.string()).optional(), // MCPs this agent can use ("*" = all, "!item" = exclude)
    prompt: z.string().min(1).optional(),
    orchestratorPrompt: z.string().min(1).optional(),
    options: z.record(z.string(), z.unknown()).optional(), // provider-specific model options (e.g., textVerbosity, thinking budget)
    displayName: z.string().min(1).optional(),
  })
  .strict();

// Multiplexer type options
export const MultiplexerTypeSchema = z.enum(['auto', 'tmux', 'zellij', 'none']);
export type MultiplexerType = z.infer<typeof MultiplexerTypeSchema>;

// Layout options (shared across multiplexers)
export const MultiplexerLayoutSchema = z.enum([
  'main-horizontal', // Main pane on top, agents stacked below
  'main-vertical', // Main pane on left, agents stacked on right
  'tiled', // All panes equal size grid
  'even-horizontal', // All panes side by side
  'even-vertical', // All panes stacked vertically
]);

export type MultiplexerLayout = z.infer<typeof MultiplexerLayoutSchema>;

// Zellij pane placement options
export const ZellijPaneModeSchema = z.enum(['agent-tab', 'current-tab']);
export type ZellijPaneMode = z.infer<typeof ZellijPaneModeSchema>;

// Legacy Tmux layout options (for backward compatibility)
export const TmuxLayoutSchema = MultiplexerLayoutSchema;
export type TmuxLayout = MultiplexerLayout;

// Multiplexer integration configuration (new unified config)
export const MultiplexerConfigSchema = z.object({
  type: MultiplexerTypeSchema.default('none'),
  layout: MultiplexerLayoutSchema.default('main-vertical'),
  main_pane_size: z.number().min(20).max(80).default(60), // percentage for main pane
  zellij_pane_mode: ZellijPaneModeSchema.default('agent-tab'),
});

export type MultiplexerConfig = z.infer<typeof MultiplexerConfigSchema>;

// Legacy Tmux integration configuration (for backward compatibility)
// When tmux.enabled is true, it's equivalent to multiplexer.type = 'tmux'
export const TmuxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  layout: TmuxLayoutSchema.default('main-vertical'),
  main_pane_size: z.number().min(20).max(80).default(60), // percentage for main pane
});

export type TmuxConfig = z.infer<typeof TmuxConfigSchema>;

export type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema>;

/** Normalized model entry with optional per-model variant. */
export type ModelEntry = { id: string; variant?: string };

export const PresetSchema = z.record(z.string(), AgentOverrideConfigSchema);

export type Preset = z.infer<typeof PresetSchema>;

// Websearch provider configuration
export const WebsearchConfigSchema = z.object({
  provider: z.enum(['exa', 'tavily']).default('exa'),
});
export type WebsearchConfig = z.infer<typeof WebsearchConfigSchema>;

// MCP names
export const McpNameSchema = z.enum(['websearch', 'context7', 'gh_grep']);
export type McpName = z.infer<typeof McpNameSchema>;

export const InterviewConfigSchema = z.object({
  maxQuestions: z.number().int().min(1).max(10).default(2),
  outputFolder: z.string().min(1).default('interview'),
  autoOpenBrowser: z
    .boolean()
    .default(true)
    .describe(
      'Automatically open the interview UI in your default browser during interactive runs. Disabled automatically in tests and CI.',
    ),
  port: z.number().int().min(0).max(65535).default(0),
  dashboard: z.boolean().default(false),
});

export type InterviewConfig = z.infer<typeof InterviewConfigSchema>;

export const BackgroundJobsConfigSchema = z.object({
  maxSessionsPerAgent: z.number().int().min(1).max(10).default(2),
  readContextMinLines: z.number().int().min(0).max(1000).default(10),
  readContextMaxFiles: z.number().int().min(0).max(50).default(8),
});

export type BackgroundJobsConfig = z.infer<typeof BackgroundJobsConfigSchema>;

export const FailoverConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().min(0).default(15000),
    retryDelayMs: z.number().min(0).default(500),
    retry_on_empty: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), empty provider responses are treated as failures, ' +
          'triggering fallback/retry. Set to false to treat them as successes.',
      ),
  })
  .strict();

export type FailoverConfig = z.infer<typeof FailoverConfigSchema>;

export const CompanionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  position: z
    .enum(['bottom-right', 'bottom-left', 'top-right', 'top-left'])
    .optional(),
  size: z.enum(['small', 'medium', 'large']).optional(),
});

export type CompanionConfig = z.infer<typeof CompanionConfigSchema>;

function validateCustomOnlyPromptFields(
  overrides: Record<string, z.infer<typeof AgentOverrideConfigSchema>>,
  ctx: z.RefinementCtx,
  pathPrefix: Array<string | number>,
): void {
  for (const [name, override] of Object.entries(overrides)) {
    const isBuiltInOrAlias =
      (ALL_AGENT_NAMES as readonly string[]).includes(name) ||
      AGENT_ALIASES[name] !== undefined;

    if (!isBuiltInOrAlias) {
      continue;
    }

    if (override.prompt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, name, 'prompt'],
        message: 'prompt is only supported for custom agents',
      });
    }

    if (override.orchestratorPrompt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, name, 'orchestratorPrompt'],
        message: 'orchestratorPrompt is only supported for custom agents',
      });
    }
  }
}

export const PluginConfigSchema = z
  .object({
    preset: z.string().optional(),
    setDefaultAgent: z.boolean().optional(),
    autoUpdate: z
      .boolean()
      .optional()
      .describe(
        'Disable automatic installation of plugin updates when false. Defaults to true.',
      ),
    presets: z.record(z.string(), PresetSchema).optional(),
    agents: z.record(z.string(), AgentOverrideConfigSchema).optional(),
    disabled_agents: z
      .array(z.string())
      .optional()
      .describe(
        'Agent names to disable completely. ' +
          'Disabled agents are not instantiated and cannot be delegated to. ' +
          'Orchestrator and council internal agents (councillor) cannot be disabled. ' +
          "By default, 'observer' is disabled. Remove it from this list and configure a vision-capable model to enable.",
      ),
    disabled_mcps: z.array(z.string()).optional(),
    // Multiplexer config (new unified config - preferred)
    multiplexer: MultiplexerConfigSchema.optional(),
    // Legacy tmux config (for backward compatibility)
    // When tmux.enabled is true, it's equivalent to multiplexer.type = 'tmux'
    tmux: TmuxConfigSchema.optional(),
    websearch: WebsearchConfigSchema.optional(),
    interview: InterviewConfigSchema.optional(),
    backgroundJobs: BackgroundJobsConfigSchema.optional(),
    fallback: FailoverConfigSchema.optional(),
    council: CouncilConfigSchema.optional(),
    companion: CompanionConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.agents) {
      validateCustomOnlyPromptFields(value.agents, ctx, ['agents']);
    }

    if (value.presets) {
      for (const [presetName, preset] of Object.entries(value.presets)) {
        validateCustomOnlyPromptFields(preset, ctx, ['presets', presetName]);
      }
    }
  });

export type PluginConfig = z.infer<typeof PluginConfigSchema>;

// Agent names - re-exported from constants for convenience
export type { AgentName } from './constants';
