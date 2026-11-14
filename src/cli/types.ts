export interface InstallArgs {
  tui: boolean;
  preset?: string;
  dryRun?: boolean;
  reset?: boolean;
}

export interface OpenCodeConfig {
  plugin?: unknown[];
  plugins?: unknown[];
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InstallConfig {
  preset?: string;
  promptForStar?: boolean;
  dryRun?: boolean;
  reset: boolean;
}

export interface ConfigMergeResult {
  success: boolean;
  configPath: string;
  error?: string;
}
