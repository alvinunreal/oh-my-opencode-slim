export type BooleanArg = 'yes' | 'no';

export interface InstallArgs {
  tui: boolean;
  kimi?: BooleanArg;
  openai?: BooleanArg;
  anthropic?: BooleanArg;
  copilot?: BooleanArg;
  zaiPlan?: BooleanArg;
  antigravity?: BooleanArg;
  chutes?: BooleanArg;
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
}

export interface DynamicAgentAssignment {
  model: string;
  variant?: string;
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
  hasOpencodeZen: boolean;
  useOpenCodeFreeModels?: boolean;
  preferredOpenCodeModel?: string;
  selectedOpenCodePrimaryModel?: string;
  selectedOpenCodeSecondaryModel?: string;
  availableOpenCodeFreeModels?: OpenCodeFreeModel[];
  selectedChutesPrimaryModel?: string;
  selectedChutesSecondaryModel?: string;
  availableChutesModels?: DiscoveredModel[];
  dynamicModelPlan?: DynamicModelPlan;
  scoringEngineVersion?: ScoringEngineVersion;
  artificialAnalysisApiKey?: string;
  openRouterApiKey?: string;
  balanceProviderUsage?: boolean;
  hasTmux: boolean;
  installSkills: boolean;
  installCustomSkills: boolean;
  setupMode: 'quick' | 'manual';
  manualAgentConfigs?: Record<string, ManualAgentConfig>;
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
  hasOpencodeZen: boolean;
  hasTmux: boolean;
}
