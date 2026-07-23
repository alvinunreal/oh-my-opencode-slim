import { z } from 'zod';
import { DEFAULT_MAX_RETAINED_SNAPSHOTS } from './constants';
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

// Permission schemas — mirror the SDK's PermissionConfig type with shallow
// validation. Action values are validated; unknown tool keys pass through.
const PermissionActionSchema = z.enum(['ask', 'allow', 'deny']);

// A rule key accepts either a single action (whole-tool default) or a
// pattern→action map (e.g. bash: { "git status*": "allow", "*": "ask" })
const PermissionRuleSchema = z.union([
  PermissionActionSchema,
  z.record(z.string(), PermissionActionSchema),
]);

// Known keys are typed for typo protection; .catchall() types the index
// signature to match the SDK's PermissionConfig, so no cast is needed at
// the assignment site. Unknown tool keys are still validated as rules.
const PermissionObjectSchema = z
  .object({
    read: PermissionRuleSchema.optional(),
    edit: PermissionRuleSchema.optional(),
    glob: PermissionRuleSchema.optional(),
    grep: PermissionRuleSchema.optional(),
    list: PermissionRuleSchema.optional(),
    bash: PermissionRuleSchema.optional(),
    task: PermissionRuleSchema.optional(),
    external_directory: PermissionRuleSchema.optional(),
    lsp: PermissionRuleSchema.optional(),
    skill: PermissionRuleSchema.optional(),
    todowrite: PermissionActionSchema.optional(),
    question: PermissionActionSchema.optional(),
    webfetch: PermissionActionSchema.optional(),
    websearch: PermissionActionSchema.optional(),
    codesearch: PermissionActionSchema.optional(),
    doom_loop: PermissionActionSchema.optional(),
  })
  .catchall(PermissionRuleSchema);

export const PermissionConfigSchema = z.union([
  PermissionActionSchema,
  PermissionObjectSchema,
]);

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
    permission: PermissionConfigSchema.optional(), // tool-level permission rules enforced by the SDK
  })
  .strict();

// Multiplexer type options
export const MultiplexerTypeSchema = z.enum([
  'auto',
  'tmux',
  'zellij',
  'herdr',
  'kitty',
  'cmux',
  'none',
]);
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

// Multiplexer integration configuration (new unified config)
export const MultiplexerConfigSchema = z.object({
  type: MultiplexerTypeSchema.default('none'),
  layout: MultiplexerLayoutSchema.default('main-vertical'),
  main_pane_size: z.number().min(20).max(80).default(60), // percentage for main pane
  zellij_pane_mode: ZellijPaneModeSchema.default('agent-tab'),
});

export type MultiplexerConfig = z.infer<typeof MultiplexerConfigSchema>;

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
  strategy: z
    .enum(['latest', 'checkpoint-compatible'])
    .default('latest')
    .describe(
      'Board injection strategy. "latest" replaces prior board messages; "checkpoint-compatible" preserves them and appends only changed board snapshots.',
    ),
  maxSessionsPerAgent: z.number().int().min(1).max(10).default(2),
  maxContextLines: z.number().int().min(0).max(500_000).default(50_000),
  readContextMinLines: z.number().int().min(0).max(1000).default(10),
  readContextMaxFiles: z.number().int().min(0).max(50).default(8),
  maxRetainedSnapshots: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(DEFAULT_MAX_RETAINED_SNAPSHOTS)
    .describe(
      'Maximum board snapshots retained per checkpoint cache epoch (1–100). Exceeding the limit starts a new epoch with the current snapshot and intentionally creates one cache miss.',
    ),
  continueOnIdle: z
    .boolean()
    .default(false)
    .describe(
      'Beta opt-in. When true, idle orchestrator sessions with incomplete todos may receive one automatic hidden continuation prompt. Disabled by default; idle reconciliation and background-job orchestration continue without automatic continuation prompts.',
    ),
});

export type BackgroundJobsConfig = z.infer<typeof BackgroundJobsConfigSchema>;

export const FailoverConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().min(0).default(15000),
    retryDelayMs: z.number().min(0).default(500),
    maxRetries: z
      .number()
      .int()
      .min(0)
      .default(3)
      .describe(
        'Number of consecutive 429/rate-limit responses tolerated on the ' +
          'same model before aborting (or swapping to the next fallback ' +
          'model when a chain is configured).',
      ),
    retry_on_empty: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), empty provider responses are treated as failures, ' +
          'triggering fallback/retry. Set to false to treat them as successes.',
      ),
    // DEPRECATED: accepted for backward compatibility but no longer used.
    // Fallback is now always disabled when a user explicitly selects a model
    // via /model, so this flag has no effect.
    runtimeOverride: z
      .boolean()
      .optional()
      .describe(
        'DEPRECATED: no longer used. Previously controlled whether out-of-chain ' +
          'runtime model picks triggered fallback. Fallback is now always ' +
          'disabled when a user explicitly selects a model via /model.',
      ),
  })
  .strict();

export type FailoverConfig = z.infer<typeof FailoverConfigSchema>;

export const CompanionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  binaryPath: z
    .string()
    .min(1)
    .optional()
    .describe('Path to a custom companion binary to launch.'),
  position: z
    .enum(['bottom-right', 'bottom-left', 'top-right', 'top-left'])
    .optional(),
  size: z.enum(['small', 'medium', 'large']).optional(),
  gifPack: z
    .enum(['default'])
    .optional()
    .describe('Bundled companion animation pack to use.'),
  loopStyle: z
    .enum(['classic', 'smooth'])
    .optional()
    .describe(
      'Companion animation playback style: classic loops or smooth ping-pong playback.',
    ),
  speed: z
    .number()
    .min(0.25)
    .max(4)
    .optional()
    .describe('Companion animation playback speed multiplier. Defaults to 1.'),
  debug: z
    .boolean()
    .optional()
    .describe('Enable verbose native companion debug logs.'),
});

export type CompanionConfig = z.infer<typeof CompanionConfigSchema>;

export const AcpAgentPermissionModeSchema = z.enum(['ask', 'allow', 'reject']);

export const MAX_ACP_TIMEOUT_MS = 2_147_483_647;

export const AcpAgentConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    orchestratorPrompt: z.string().min(1).optional(),
    wrapperModel: ProviderModelIdSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(MAX_ACP_TIMEOUT_MS)
      .default(0)
      .describe(
        'Timeout for a single ACP run in milliseconds. Set to 0 to disable the timeout.',
      ),
    permissionMode: AcpAgentPermissionModeSchema.default('ask'),
  })
  .strict();

export const AcpAgentsConfigSchema = z.record(z.string(), AcpAgentConfigSchema);

export type AcpAgentPermissionMode = z.infer<
  typeof AcpAgentPermissionModeSchema
>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
export type AcpAgentsConfig = z.infer<typeof AcpAgentsConfigSchema>;

function rejectOrchestratorPromptOnOrchestrator(
  overrides: Record<string, z.infer<typeof AgentOverrideConfigSchema>>,
  ctx: z.RefinementCtx,
  pathPrefix: Array<string | number>,
): void {
  for (const [name, override] of Object.entries(overrides)) {
    if (name === 'orchestrator' && override.orchestratorPrompt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, name, 'orchestratorPrompt'],
        message:
          'orchestratorPrompt is not supported for the orchestrator agent',
      });
    }
  }
}

export const PluginConfigSchema = z
  .object({
    preset: z.string().optional(),
    setDefaultAgent: z.boolean().optional(),
    compactSidebar: z
      .boolean()
      .optional()
      .describe(
        'Use the compact TUI sidebar layout. Defaults to true; set false to use the expanded layout.',
      ),
    stripOrchestratorModel: z
      .boolean()
      .optional()
      .describe(
        'When true, omit orchestrator.model and orchestrator.variant from the SDK config so OpenCode uses the session model selected with /model after subagent dispatch. An explicitly selected preset that sets orchestrator.model is preserved. Defaults to false.',
      ),
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
    image_routing: z
      .enum(['auto', 'direct'])
      .optional()
      .describe(
        'How image attachments are handled. ' +
          'When omitted, preserves legacy conditional behavior: intercept ' +
          'attachments only when observer is enabled. "auto": requires ' +
          'observer to be enabled and saves attachments to disk before ' +
          'nudging delegation to @observer. "direct": always passes ' +
          'attachments to the orchestrator untouched.',
      ),
    disabled_mcps: z
      .array(z.string())
      .optional()
      .describe(
        'MCP server names to disable completely. Disabled servers are not ' +
          'started and cannot be used by agents.',
      ),
    disabled_tools: z
      .array(z.string())
      .optional()
      .describe(
        'Tool names to disable completely. Disabled tools are not registered with OpenCode and cannot be used by agents.',
      ),
    disabled_skills: z
      .array(z.string())
      .optional()
      .describe(
        'Skill names to disable completely. Disabled skills are not granted to agents, even when referenced by presets or agent overrides.',
      ),
    // Multiplexer config
    multiplexer: MultiplexerConfigSchema.optional(),
    websearch: WebsearchConfigSchema.optional(),
    interview: InterviewConfigSchema.optional(),
    backgroundJobs: BackgroundJobsConfigSchema.optional(),
    fallback: FailoverConfigSchema.optional(),
    council: CouncilConfigSchema.optional(),
    companion: CompanionConfigSchema.optional(),
    acpAgents: AcpAgentsConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.agents) {
      rejectOrchestratorPromptOnOrchestrator(value.agents, ctx, ['agents']);
    }

    if (value.presets) {
      for (const [presetName, preset] of Object.entries(value.presets)) {
        rejectOrchestratorPromptOnOrchestrator(preset, ctx, [
          'presets',
          presetName,
        ]);
      }
    }
  });

export type PluginConfig = z.infer<typeof PluginConfigSchema>;

// Agent names - re-exported from constants for convenience
export type { AgentName } from './constants';
