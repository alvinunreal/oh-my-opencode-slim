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
  opencodeFreeModel?: string;
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

export interface DynamicModelPlan {
  agents: Record<string, DynamicAgentAssignment>;
  chains: Record<string, string[]>;
}

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
  availableChutesFreeModels?: OpenCodeFreeModel[];
  dynamicModelPlan?: DynamicModelPlan;
  hasTmux: boolean;
  installSkills: boolean;
  installCustomSkills: boolean;
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
