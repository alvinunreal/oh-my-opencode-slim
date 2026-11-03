import type { CompanionConfig } from '../../config/schema';

export interface NpmDistTags {
  latest: string;
  [key: string]: string;
}

export interface NpmPackageMetadata {
  'dist-tags'?: NpmDistTags;
  versions?: Record<string, unknown>;
}

export interface CompatibleVersionResult {
  latestVersion: string | null;
  latestMajorVersion: string | null;
  blockedByMajor: boolean;
  unsafeReason?: 'unparseable-current-version';
}

export interface OpencodeConfig {
  plugins?: unknown[]; // opencode2 (plural, preferred)
  plugin?: unknown[]; // v1 (singular)
  [key: string]: unknown;
}

export interface PackageJson {
  version: string;
  name?: string;
  [key: string]: unknown;
}

export interface AutoUpdateCheckerOptions {
  companion?: CompanionConfig;
}

export interface PluginEntryInfo {
  entry: string;
  isPinned: boolean;
  isInstallerManaged: boolean;
  pinnedVersion: string | null;
  configPath: string;
}
