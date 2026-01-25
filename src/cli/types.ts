export type BooleanArg = 'yes' | 'no';

export interface InstallArgs {
  tui: boolean;
  antigravity?: BooleanArg;
  openai?: BooleanArg;
  tmux?: BooleanArg;
  skills?: BooleanArg;
}

export interface OpenCodeConfig {
  plugin?: string[];
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InstallConfig {
  hasAntigravity: boolean;
  hasOpenAI: boolean;
  hasOpencodeZen: boolean;
  hasTmux: boolean;
  installSkills: boolean;
}

export interface ConfigMergeResult {
  success: boolean;
  configPath: string;
  error?: string;
}

export interface DetectedConfig {
  isInstalled: boolean;
  hasAntigravity: boolean;
  hasOpenAI: boolean;
  hasOpencodeZen: boolean;
  hasTmux: boolean;
}
