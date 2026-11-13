/**
 * Shared cached read of the merged plugin configuration.
 *
 * Identity is the selected source files (`findPluginConfigPaths` reruns, so a
 * new `.jsonc` can win precedence) plus their stat fields and the current
 * values of referenced `{env:NAME}` entries. A stat/read failure bypasses the
 * cache; an explicit watcher/notification read passes `fresh` to cover writes
 * that the filesystem timestamp granularity cannot distinguish.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigLoadWarning } from './loader';
import { findPluginConfigPaths, loadPluginConfig } from './loader';
import type { ResolvedPluginConfig } from './schema';

const MAX_ENTRIES = 16;
const ENV_REFERENCE_PATTERN = /\{env:([^}]+)\}/g;

interface PluginConfigSnapshotPaths {
  userConfigPath: string | null;
  projectConfigPath: string | null;
  projectConfigPaths: string[];
}

export interface PluginConfigSnapshot {
  readonly config: ResolvedPluginConfig;
  readonly warnings: readonly ConfigLoadWarning[];
  readonly paths: PluginConfigSnapshotPaths;
  readonly fingerprint: string;
}

export interface ReadPluginConfigSnapshotOptions {
  hostFlavor?: string;
  presetName?: string;
  /** Existing watcher/notification proved a write despite unchanged stats. */
  fresh?: boolean;
  onWarning?: (warning: ConfigLoadWarning) => void;
}

interface CacheEntry {
  stats: string;
  envNames: readonly string[];
  envSignature: string;
  snapshot: PluginConfigSnapshot;
}

const entries = new Map<string, CacheEntry>();
let uncachedId = 0;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function cloneConfigValue<T>(value: T): T {
  return structuredClone(value);
}

function contextKey(
  directory: string,
  hostFlavor: string | undefined,
  presetName: string | undefined,
): string {
  return `${directory}\u0000${hostFlavor ?? ''}\u0000${presetName ?? ''}`;
}

function selectedFiles(paths: PluginConfigSnapshotPaths): string[] {
  return [
    ...new Set(
      [paths.userConfigPath, ...paths.projectConfigPaths].filter(
        (file): file is string => file !== null,
      ),
    ),
  ];
}

function statSignature(files: readonly string[]): string | null {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      parts.push(
        `${file}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        parts.push(`${file}:absent`);
        continue;
      }
      return null;
    }
  }
  return parts.join('|');
}

function readSourceState(files: readonly string[]): {
  envNames: string[];
  contentHash: string;
  complete: boolean;
} {
  const names = new Set<string>();
  let complete = true;
  const content = createHash('sha256');
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf-8');
      content.update(`${file}\u0000${text}\u0000`);
      for (const match of text.matchAll(ENV_REFERENCE_PATTERN)) {
        if (match[1]) names.add(match[1]);
      }
    } catch (error) {
      // An absent file is stable; any other failure means the env names
      // read here may be incomplete, so the result must not be cached.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') complete = false;
      content.update(`${file}\u0000<unreadable>\u0000`);
    }
  }
  return {
    envNames: [...new Set(['OH_MY_OPENCODE_SLIM_PRESET', ...names])].sort(),
    contentHash: content.digest('hex'),
    complete,
  };
}

function envSignature(names: readonly string[]): string {
  return names
    .map((name) => `${name}=${process.env[name] ?? ''}`)
    .join('\u0000');
}

function replayWarnings(
  warnings: readonly ConfigLoadWarning[],
  onWarning: ((warning: ConfigLoadWarning) => void) | undefined,
): void {
  if (!onWarning) return;
  for (const warning of warnings) onWarning(warning);
}

export function readPluginConfigSnapshot(
  directory: string,
  options: ReadPluginConfigSnapshotOptions = {},
): PluginConfigSnapshot {
  const resolved = path.resolve(directory);
  const key = contextKey(resolved, options.hostFlavor, options.presetName);
  if (options.fresh) {
    const prefix = `${resolved}\u0000${options.hostFlavor ?? ''}\u0000`;
    for (const cachedKey of entries.keys()) {
      if (cachedKey.startsWith(prefix)) entries.delete(cachedKey);
    }
  }

  const paths = findPluginConfigPaths(resolved, options.hostFlavor);
  const files = selectedFiles(paths);
  const stats = statSignature(files);
  const cached = stats === null ? undefined : entries.get(key);
  if (
    cached &&
    cached.stats === stats &&
    envSignature(cached.envNames) === cached.envSignature
  ) {
    replayWarnings(cached.snapshot.warnings, options.onWarning);
    return cached.snapshot;
  }

  const warnings: ConfigLoadWarning[] = [];
  const config = loadPluginConfig(resolved, {
    hostFlavor: options.hostFlavor,
    presetName: options.presetName,
    silent: true,
    onWarning: (warning) => warnings.push(warning),
  });
  const sourceState =
    stats === null
      ? {
          envNames: ['OH_MY_OPENCODE_SLIM_PRESET'],
          contentHash: '',
          complete: false,
        }
      : readSourceState(files);
  const envSig = envSignature(sourceState.envNames);
  const signature =
    stats === null
      ? null
      : `${stats}\u0000${envSig}\u0000${sourceState.contentHash}`;
  let fingerprint = signature;
  if (fingerprint === null) {
    uncachedId += 1;
    fingerprint = `uncached:${resolved}:${uncachedId}`;
  }
  const snapshot: PluginConfigSnapshot = Object.freeze({
    config: deepFreeze(config),
    warnings: Object.freeze([...warnings]),
    paths: Object.freeze({
      ...paths,
      projectConfigPaths: Object.freeze([...paths.projectConfigPaths]),
    }) as PluginConfigSnapshotPaths,
    fingerprint,
  });

  if (
    signature !== null &&
    sourceState.complete &&
    signature ===
      `${statSignature(files)}\u0000${envSig}\u0000${sourceState.contentHash}` &&
    !warnings.some((warning) => warning.kind === 'read-error')
  ) {
    entries.set(key, {
      stats: stats as string,
      envNames: sourceState.envNames,
      envSignature: envSig,
      snapshot,
    });
    if (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
  }
  replayWarnings(snapshot.warnings, options.onWarning);
  return snapshot;
}
