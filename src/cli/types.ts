export type BooleanArg = "yes" | "no"

export interface InstallArgs {
  tui: boolean
  antigravity?: BooleanArg
  openai?: BooleanArg
  cerebras?: BooleanArg
  tmux?: BooleanArg
  skipAuth?: boolean
}

export interface InstallConfig {
  hasAntigravity: boolean
  hasOpenAI: boolean
  hasCerebras: boolean
  hasTmux: boolean
}

export interface ConfigMergeResult {
  success: boolean
  configPath: string
  error?: string
}

export interface DetectedConfig {
  isInstalled: boolean
  hasAntigravity: boolean
  hasOpenAI: boolean
  hasCerebras: boolean
  hasTmux: boolean
}
