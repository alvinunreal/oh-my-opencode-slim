import { z } from 'zod';

export {
  type PacketV1,
  PacketV1Schema,
} from '../token-discipline/types';

export const TokenDisciplineSettingsSchema = z.object({
  enforceIsolation: z.boolean().default(true),
  maxPacketSize: z.number().min(500).max(5000).default(2500),
  maxResolutionsPerTask: z.number().min(1).max(10).default(3),
  threadArchiveHours: z.number().min(1).max(168).default(24),
});

export type TokenDisciplineSettings = z.infer<
  typeof TokenDisciplineSettingsSchema
>;

const ProviderModelIdSchema = z
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

export type ManualAgentPlan = z.infer<typeof ManualAgentPlanSchema>;
export type ManualPlan = z.infer<typeof ManualPlanSchema>;

const AgentModelChainSchema = z.array(z.string()).min(1);

const FallbackChainsSchema = z
  .object({
    orchestrator: AgentModelChainSchema.optional(),
    oracle: AgentModelChainSchema.optional(),
    designer: AgentModelChainSchema.optional(),
    explorer: AgentModelChainSchema.optional(),
    librarian: AgentModelChainSchema.optional(),
    fixer: AgentModelChainSchema.optional(),
  })
  .catchall(AgentModelChainSchema);

// Agent override configuration (distinct from SDK's AgentConfig)
export const AgentOverrideConfigSchema = z.object({
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  variant: z.string().optional().catch(undefined),
  skills: z.array(z.string()).optional(), // skills this agent can use ("*" = all, "!item" = exclude)
  mcps: z.array(z.string()).optional(), // MCPs this agent can use ("*" = all, "!item" = exclude)
});

// Tmux layout options
export const TmuxLayoutSchema = z.enum([
  'main-horizontal', // Main pane on top, agents stacked below
  'main-vertical', // Main pane on left, agents stacked on right
  'tiled', // All panes equal size grid
  'even-horizontal', // All panes side by side
  'even-vertical', // All panes stacked vertically
]);

export type TmuxLayout = z.infer<typeof TmuxLayoutSchema>;

// Tmux integration configuration
export const TmuxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  layout: TmuxLayoutSchema.default('main-vertical'),
  main_pane_size: z.number().min(20).max(80).default(60), // percentage for main pane
});

export type TmuxConfig = z.infer<typeof TmuxConfigSchema>;

export type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema>;

export const PresetSchema = z.record(z.string(), AgentOverrideConfigSchema);

export type Preset = z.infer<typeof PresetSchema>;

// MCP names
export const McpNameSchema = z.enum(['websearch', 'context7', 'grep_app']);
export type McpName = z.infer<typeof McpNameSchema>;

// Background task configuration
export const BackgroundTaskConfigSchema = z.object({
  maxConcurrentStarts: z.number().min(1).max(50).default(10),
});

export type BackgroundTaskConfig = z.infer<typeof BackgroundTaskConfigSchema>;

export const FailoverConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: z.number().min(0).default(15000),
  chains: FallbackChainsSchema.default({}),
});

export type FailoverConfig = z.infer<typeof FailoverConfigSchema>;

export const TokenDisciplineConfigSchema = z.object({
  enabled: z.boolean().default(true),
  settings: TokenDisciplineSettingsSchema.optional(),
});

export type TokenDisciplineConfig = z.infer<typeof TokenDisciplineConfigSchema>;

export const PluginConfigSchema = z.object({
  preset: z.string().optional(),
  scoringEngineVersion: z.enum(['v1', 'v2-shadow', 'v2']).optional(),
  balanceProviderUsage: z.boolean().optional(),
  manualPlan: ManualPlanSchema.optional(),
  presets: z.record(z.string(), PresetSchema).optional(),
  agents: z.record(z.string(), AgentOverrideConfigSchema).optional(),
  disabled_mcps: z.array(z.string()).optional(),
  tmux: TmuxConfigSchema.optional(),
  background: BackgroundTaskConfigSchema.optional(),
  fallback: FailoverConfigSchema.optional(),
  tokenDiscipline: TokenDisciplineConfigSchema.optional(),
});

export type PluginConfig = z.infer<typeof PluginConfigSchema>;

// Agent names - re-exported from constants for convenience
export type { AgentName } from './constants';
