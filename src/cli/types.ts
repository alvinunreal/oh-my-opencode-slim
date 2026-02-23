export type BooleanArg = 'yes' | 'no';

export type AgentName =
  | 'orchestrator'
  | 'oracle'
  | 'designer'
  | 'explorer'
  | 'librarian'
  | 'fixer';

export type BillingMode = 'subscription' | 'paygo';

export interface AgentModelAssignment {
  model: string;
  variant?: string;
  billingMode?: BillingMode;
  confidence?: number;
  reasoning?: string;
}

export type AgentModelMap = Record<AgentName, AgentModelAssignment>;

export type ModelPreferencesByAgent = Partial<Record<AgentName, string[]>>;

export type ChutesMonthlyPacingMode = 'quality-first' | 'balanced' | 'economy';

export interface InstallArgs {
  tui: boolean;
  kimi?: BooleanArg;
  openai?: BooleanArg;
  anthropic?: BooleanArg;
  copilot?: BooleanArg;
  zaiPlan?: BooleanArg;
  antigravity?: BooleanArg;
  chutes?: BooleanArg;
  nanogpt?: BooleanArg;
  smartRoutingV3?: BooleanArg;
  nanogptPolicy?: 'subscription-only' | 'hybrid' | 'paygo-only';
  nanogptDailyBudget?: number;
  nanogptMonthlyBudget?: number;
  nanogptMonthlyUsed?: number;
  chutesPacing?: ChutesMonthlyPacingMode;
  chutesMonthlyBudget?: number;
  chutesMonthlyUsed?: number;
  tmux?: BooleanArg;
  skills?: BooleanArg;
  opencodeFree?: BooleanArg;
  balancedSpend?: BooleanArg;
  opencodeFreeModel?: string;
  aaKey?: string;
  openrouterKey?: string;
  dryRun?: boolean;
  modelsOnly?: boolean;
}

export interface OpenCodeFreeModel {
  providerID: string;
  model: string;
  name: string;
  status: 'alpha' | 'beta' | 'deprecated' | 'active';
  contextLimit: number;
  outputLimit: number;
  reasoning: boolean;
  toolcall: boolean;
  attachment: boolean;
  dailyRequestLimit?: number;
}

export interface DiscoveredModel {
  providerID: string;
  model: string;
  name: string;
  status: 'alpha' | 'beta' | 'deprecated' | 'active';
  contextLimit: number;
  outputLimit: number;
  reasoning: boolean;
  toolcall: boolean;
  attachment: boolean;
  dailyRequestLimit?: number;
  costInput?: number;
  costOutput?: number;
  nanoGptAccess?: 'subscription' | 'paid' | 'visible';
}

export interface DynamicAgentAssignment {
  model: string;
  variant?: string;
  billingMode?: BillingMode;
  confidence?: number;
  reasoning?: string;
}

export type ScoringEngineVersion = 'v1' | 'v2-shadow' | 'v2' | 'v3';

export type ResolutionLayerName =
  | 'opencode-direct-override'
  | 'manual-user-plan'
  | 'pinned-model'
  | 'dynamic-recommendation'
  | 'provider-fallback-policy'
  | 'system-default';

export interface AgentResolutionProvenance {
  winnerLayer: ResolutionLayerName;
  winnerModel: string;
}

export interface DynamicPlanScoringMeta {
  engineVersionApplied: 'v1' | 'v2' | 'v3';
  shadowCompared: boolean;
  diffs?: Record<string, { v1TopModel?: string; v2TopModel?: string }>;
}

export type ScoringEngineVersion = 'v1' | 'v2-shadow' | 'v2';

export type ResolutionLayerName =
  | 'opencode-direct-override'
  | 'manual-user-plan'
  | 'pinned-model'
  | 'dynamic-recommendation'
  | 'provider-fallback-policy'
  | 'system-default';

export interface AgentResolutionProvenance {
  winnerLayer: ResolutionLayerName;
  winnerModel: string;
}

export interface DynamicPlanScoringMeta {
  engineVersionApplied: 'v1' | 'v2';
  shadowCompared: boolean;
  diffs?: Record<string, { v1TopModel?: string; v2TopModel?: string }>;
}

export interface DynamicModelPlan {
  agents: Record<string, DynamicAgentAssignment>;
  chains: Record<string, string[]>;
  provenance?: Record<string, AgentResolutionProvenance>;
  scoring?: DynamicPlanScoringMeta;
  explanations?: Record<string, string>;
  metadata?: {
    policy?: string;
    providerDistribution?: Record<string, number>;
    estimatedDailyCostUsd?: number;
    quotaPressure?: 'healthy' | 'warning' | 'critical';
    canaryTrend?: {
      experimentId?: string;
      promoteCount: number;
      holdCount: number;
      rollbackCount: number;
      recommendedAction: 'promote' | 'hold' | 'rollback';
    };
  };
}

export interface ExternalModelSignal {
  qualityScore?: number;
  codingScore?: number;
  latencySeconds?: number;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  source: 'artificial-analysis' | 'openrouter' | 'merged';
}

export type ExternalSignalMap = Record<string, ExternalModelSignal>;

export type ManualAgentConfig = {
  primary: string;
  fallback1: string;
  fallback2: string;
  fallback3: string;
};

export interface OpenCodeConfig {
  plugin?: string[];
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InstallConfig {
  hasKimi: boolean;
  hasOpenAI: boolean;
  hasAnthropic?: boolean;
  hasCopilot?: boolean;
  hasZaiPlan?: boolean;
  hasAntigravity: boolean;
  hasChutes?: boolean;
  hasNanoGpt?: boolean;
  hasOpencodeZen: boolean;
  useOpenCodeFreeModels?: boolean;
  preferredOpenCodeModel?: string;
  selectedOpenCodePrimaryModel?: string;
  selectedOpenCodeSecondaryModel?: string;
  selectedOpenCodeModelsByAgent?: AgentModelMap;
  availableOpenCodeFreeModels?: OpenCodeFreeModel[];
  selectedChutesPrimaryModel?: string;
  selectedChutesSecondaryModel?: string;
  selectedChutesModelsByAgent?: AgentModelMap;
  availableChutesModels?: DiscoveredModel[];
  selectedNanoGptModelsByAgent?: AgentModelMap;
  availableNanoGptModels?: DiscoveredModel[];
  nanoGptSubscriptionModels?: string[];
  nanoGptPaidModels?: string[];
  preferredModelsByAgent?: ModelPreferencesByAgent;
  nanoGptRoutingPolicy?: 'subscription-only' | 'hybrid' | 'paygo-only';
  nanoGptDailyBudget?: number;
  nanoGptMonthlyBudget?: number;
  nanoGptMonthlyUsed?: number;
  chutesPacingMode?: ChutesMonthlyPacingMode;
  chutesMonthlyBudget?: number;
  chutesMonthlyUsed?: number;
  dynamicModelPlan?: DynamicModelPlan;
  scoringEngineVersion?: ScoringEngineVersion;
  artificialAnalysisApiKey?: string;
  openRouterApiKey?: string;
  balanceProviderUsage?: boolean;
  smartRoutingV3?: boolean;
  hasTmux: boolean;
  installSkills: boolean;
  installCustomSkills: boolean;
  setupMode: 'quick' | 'manual';
  manualAgentConfigs?: Record<string, ManualAgentConfig>;
  _migratedFromV1?: boolean;
  _migrationTimestamp?: string;
  _migrationWarnings?: string[];
  dryRun?: boolean;
  modelsOnly?: boolean;
}

export interface ConfigMergeResult {
  success: boolean;
  configPath: string;
  error?: string;
}

export interface DetectedConfig {
  isInstalled: boolean;
  hasKimi: boolean;
  hasOpenAI: boolean;
  hasAnthropic?: boolean;
  hasCopilot?: boolean;
  hasZaiPlan?: boolean;
  hasAntigravity: boolean;
  hasChutes?: boolean;
  hasNanoGpt?: boolean;
  hasOpencodeZen: boolean;
  hasTmux: boolean;
}
