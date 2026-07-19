export type BooleanArg = 'yes' | 'no';
export type SkillsArg = BooleanArg | 'force';
export type BackgroundSubagentsArg = 'ask' | 'yes' | 'no';
export type CompanionArg = 'ask' | BooleanArg;

export interface InstallArgs {
  tui: boolean;
  skills?: SkillsArg;
  preset?: string;
  dryRun?: boolean;
  reset?: boolean;
  backgroundSubagents?: BackgroundSubagentsArg;
  backgroundSubagentsTarget?: string;
  companion?: CompanionArg;
}

export interface OpenCodeConfig {
  plugin?: unknown[];
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InstallConfig {
  installCustomSkills: boolean;
  forceSkillSync: boolean;
  preset?: string;
  promptForStar?: boolean;
  dryRun?: boolean;
  reset: boolean;
  backgroundSubagents: BackgroundSubagentsArg;
  backgroundSubagentsTarget?: string;
  companion?: CompanionArg;
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
}
