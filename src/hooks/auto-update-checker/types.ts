export interface NpmDistTags {
  latest: string;
  [key: string]: string;
}

export interface OpencodeConfig {
  plugin?: unknown[];
  [key: string]: unknown;
}

export interface PackageJson {
  version: string;
  name?: string;
  [key: string]: unknown;
}

export interface AutoUpdateCheckerOptions {
  autoUpdate?: boolean;
}

export interface PluginEntryInfo {
  entry: string;
  isPinned: boolean;
  pinnedVersion: string | null;
  configPath: string;
}
