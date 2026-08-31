import { z } from 'zod';
import {
  AGENT_THEME_COLORS,
  DEFAULT_MAX_RETAINED_SNAPSHOTS,
} from './constants';
import { CouncilConfigSchema } from './council-schema';

export const ProviderModelIdSchema = z
  .string()
  .regex(
    /^[^/\s]+\/[^\s]+$/,
    'Expected provider/model format (provider/.../model)',
  );

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

export const AgentColorSchema = z.union([
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a six-digit hex color (#RRGGBB)'),
  z.enum(AGENT_THEME_COLORS),
]);

// Agent override configuration (distinct from SDK's AgentConfig)
export const ModelInheritanceSourceSchema = z.enum(['session', 'orchestrator']);
export type ModelInheritanceSource = z.infer<
  typeof ModelInheritanceSourceSchema
>;

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
    inheritModelFrom: ModelInheritanceSourceSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    variant: z.string().optional().catch(undefined),
    skills: z.array(z.string()).optional(), // skills this agent can use ("*" = all, "!item" = exclude)
    mcps: z.array(z.string()).optional(), // MCPs this agent can use ("*" = all, "!item" = exclude)
    prompt: z.string().min(1).optional(),
    orchestratorPrompt: z.string().min(1).optional(),
    options: z.record(z.string(), z.unknown()).optional(), // provider-specific model options (e.g., textVerbosity, thinking budget)
    displayName: z.string().min(1).optional(),
    color: AgentColorSchema.optional().describe(
      'Agent display color as #RRGGBB or an OpenCode theme color',
    ),
    description: z.string().min(1).optional(),
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

// MCP names
export const McpNameSchema = z.enum(['context7', 'gh_grep']);
export type McpName = z.infer<typeof McpNameSchema>;

const InterviewOutputFolderSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^(?![\\/])(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/,
    'outputFolder must be a relative path without parent-directory traversal',
  );

export const InterviewConfigSchema = z.object({
  maxQuestions: z.number().int().min(1).max(10).default(2),
  outputFolder: InterviewOutputFolderSchema.default('interview'),
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
  orchestratorWake: z
    .object({
      enabled: z
        .boolean()
        .default(true)
        .describe(
          'When true, idle orchestrator sessions with incomplete todos may receive periodic internal wake prompts. Default enabled.',
        ),
      intervalMs: z
        .number()
        .int()
        .min(60_000)
        .max(2_147_483_647)
        .default(300_000)
        .describe(
          'Continuous parent-idle interval between orchestrator wake evaluations (60,000–2,147,483,647ms). Default 300,000 (5 minutes). 0 is invalid.',
        ),
    })
    .default({ enabled: true, intervalMs: 300_000 })
    .describe(
      'Periodic orchestrator wake scheduler for idle sessions with incomplete todos. Default enabled at a 5-minute interval. Requires host session APIs (session.get, todo, children, status, promptAsync); inactive on the v2 shim.',
    ),
  wallClockTimeoutMs: z
    .union([z.literal(0), z.number().int().min(60_000).max(2_147_483_647)])
    .default(0)
    .describe(
      'Explicit opt-in wall-clock deadline for native task(..., background: true) child sessions. 0 disables supervision; finite values are 60,000–2,147,483,647ms.',
    ),
  abortGraceMs: z
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(10_000)
    .describe(
      'Grace period after a wall-clock deadline while OpenCode confirms the child terminal state (1,000–60,000ms).',
    ),
  stopConfirmationMs: z
    .number()
    .int()
    .min(10_000)
    .max(300_000)
    .default(30_000)
    .describe(
      'Grace period a job must remain host-declared idle before it is marked stopped (10,000–300,000ms). Default 30,000, covering reasoning-model pauses. Sessions absent from the runtime status map are never treated as stop evidence.',
    ),
  waitForUserGuard: z
    .boolean()
    .default(true)
    .describe(
      'When true, intercept wait_for_user calls made while background tasks are still running and the orchestrator wake scheduler is enabled, returning guidance to end the turn instead of blocking on manual input. Default enabled.',
    ),
});

export type BackgroundJobsConfig = z.infer<typeof BackgroundJobsConfigSchema>;

/**
 * Fallback config fields accepted by versions before 2.3.x but no longer
 * meaningful. Kept only so that existing user/project configs containing
 * them still parse: the loader emits a deprecation warning and these keys
 * are stripped before strict validation. Without this, a stale field would
 * make the whole config file fail and drop all the user's settings.
 */
export const LEGACY_FALLBACK_KEYS = [
  'timeoutMs',
  'retryDelayMs',
  'retry_on_empty',
  'runtimeOverride',
] as const;

function stripLegacyFallbackKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const hasLegacy = LEGACY_FALLBACK_KEYS.some((key) => key in record);
  if (!hasLegacy) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    if (!(LEGACY_FALLBACK_KEYS as readonly string[]).includes(key)) {
      cleaned[key] = val;
    }
  }
  return cleaned;
}

export const FailoverConfigSchema = z.preprocess(
  stripLegacyFallbackKeys,
  z
    .object({
      enabled: z.boolean().default(true),
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
    })
    .strict(),
);

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

export const WebfetchConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        'When false, skip registering this enhanced webfetch so OpenCode uses its built-in version.',
      ),
    model: AgentOverrideConfigSchema.shape.model.describe(
      'Dedicated model(s) for smartfetch secondary-model summarization. ' +
        'Same shape as agent model config (string, array of strings/objects with id+variant). ' +
        'Takes priority over small_model, agents.explorer.model, and agents.librarian.model.',
    ),
  })
  .strict();

export type WebfetchConfig = z.infer<typeof WebfetchConfigSchema>;

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
    interview: InterviewConfigSchema.optional(),
    backgroundJobs: BackgroundJobsConfigSchema.optional(),
    fallback: FailoverConfigSchema.optional(),
    council: CouncilConfigSchema.optional(),
    companion: CompanionConfigSchema.optional(),
    webfetch: WebfetchConfigSchema.optional(),
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
