/**
 * V2 plugin-config watcher + lossless refresh orchestration.
 *
 * The v1 factory resolves the runtime profiles once at init; after a config
 * edit (preset manager Save & Apply, or a manual file write) NEW child
 * dispatches and the sidebar must see the refreshed inference fields. This
 * module watches the plugin config CANDIDATES — both `.json` and `.jsonc` for
 * every user search location and `<project>/.opencode`, whether or not they
 * exist yet — and runs a debounced `onChanged(signal)` refresh.
 *
 * Lossless scheduling (dirty/ready/running):
 * - an fs event marks the state dirty and resets the debounce timer;
 * - the timer firing marks it ready and drains;
 * - drain runs only when ready+dirty and nothing is running;
 * - an event during an in-flight refresh survives and produces exactly one
 *   trailing refresh after the quiet window;
 * - dispose is idempotent, clears timers/watchers, aborts the signal, and
 *   awaits the active run; the refresh callback must not commit after the
 *   signal aborts.
 *
 * Missing config directories are handled by watching the nearest existing
 * ancestor of each candidate's directory (plus that ancestor's parent, so a
 * watched config directory's deletion stays observable). Reconcile is
 * CANDIDATE-DRIVEN, not basename-driven: ANY event whose path is equal to (or
 * an ancestor of) a candidate file or directory — or a config-file sibling
 * inside a candidate directory — reconciles the watchers and schedules a
 * refresh. That covers arbitrary `OPENCODE_CONFIG_DIR` names (including
 * spaces), nested missing ancestors, XDG/`~/.config/opencode`, and a
 * delayed `.opencode` creation, deletion, or rename. JSON/JSONC sibling
 * creation/deletion/rename inside a candidate directory stays accepted via
 * the candidate basename set. Watchers are deduped per directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getPluginConfigCandidates as getConfigCandidates } from '../config/loader';
import { log } from '../utils/logger';
import type { V2AgentRuntimeProfiles } from './runtime-profiles';

/** Debounce window for config change bursts (atomic-save style rewrites). */
export const CONFIG_REFRESH_DEBOUNCE_MS = 300;

export interface ConfigWatchHandle {
  /** Stop watching, abort the active refresh, and await it. Idempotent. */
  dispose(): Promise<void>;
}

export type ConfigWatchListener = (
  eventType: string,
  filename: string | null,
) => void;

export interface WatchPluginConfigOptions {
  /** Project directory whose `.opencode` config participates in the load. */
  directory: string;
  /**
   * Runs once per settled change burst. Receive an AbortSignal that is
   * aborted on dispose; implementations must not commit after abort.
   */
  onChanged: (signal: AbortSignal) => void | Promise<void>;
  /** Debounce window; defaults to `CONFIG_REFRESH_DEBOUNCE_MS`. */
  debounceMs?: number;
  /** Test seam: candidate paths (existence-independent) for this directory. */
  resolvePaths?: () => string[];
  /** Test seam: override `fs.watch`. */
  watchImpl?: (
    path: string,
    listener: ConfigWatchListener,
  ) => { close: () => void };
  /** Test seam: override the logger. */
  log?: (message: string, meta?: unknown) => void;
}

/** All config candidates for a directory (existence-independent). */
export function getPluginConfigCandidates(directory: string): string[] {
  const { user, project } = getConfigCandidates(directory, 'v2');
  return [...user, ...project];
}

/** Nearest existing ancestor directory of `dir` (inclusive). */
function nearestExistingAncestor(dir: string): string {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Watch the plugin config candidates for changes. Returns a lossless handle
 * (see the module doc). Watching failures are logged and degrade gracefully
 * rather than throwing.
 */
export function watchPluginConfigFiles(
  options: WatchPluginConfigOptions,
): ConfigWatchHandle {
  const debounceMs = options.debounceMs ?? CONFIG_REFRESH_DEBOUNCE_MS;
  const emitLog = options.log ?? log;
  const watchImpl =
    options.watchImpl ??
    ((watchPath, listener) =>
      fs.watch(watchPath, { persistent: false }, listener));

  const candidatePaths = (
    options.resolvePaths
      ? options.resolvePaths()
      : getPluginConfigCandidates(options.directory)
  ).map((candidate) => path.resolve(candidate));

  const basenames = new Set<string>();
  for (const candidate of candidatePaths) {
    const base = path.basename(candidate);
    basenames.add(base);
    // `findConfigPath` prefers .jsonc over .json: a write that creates the
    // sibling variant changes which file the loader reads, so react to it.
    if (base.endsWith('.jsonc')) {
      basenames.add(`${base.slice(0, -'.jsonc'.length)}.json`);
    } else if (base.endsWith('.json')) {
      basenames.add(`${base.slice(0, -'.json'.length)}.jsonc`);
    }
  }

  const watchedDirectories = new Map<string, { close: () => void }>();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let ready = false;
  let activeRun: Promise<void> | undefined;
  let disposed = false;

  // Case-normalized keys for Windows, where `fs.watch` may report a
  // different letter case than the candidate path.
  const normalizeKey = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const candidateKeys = new Set(candidatePaths.map(normalizeKey));
  const candidateDirKeys = new Set(
    candidatePaths.map((candidate) => normalizeKey(path.dirname(candidate))),
  );
  const basenameKeys = new Set(
    [...basenames].map((base) =>
      process.platform === 'win32' ? base.toLowerCase() : base,
    ),
  );

  /**
   * Candidate-driven event filter. An event path matters when it is the
   * candidate file itself, the candidate's directory (created/deleted/
   * renamed), a strict ancestor of that directory (a missing path segment
   * appeared), or a config-file sibling inside the candidate directory
   * (`.json` ↔ `.jsonc` precedence flips). Directory basenames play no role,
   * so arbitrary `OPENCODE_CONFIG_DIR` names and multi-level missing
   * ancestors rebind correctly.
   */
  const isRelevantEventPath = (eventPath: string): boolean => {
    const eventKey = normalizeKey(eventPath);
    if (candidateKeys.has(eventKey)) return true;
    if (candidateDirKeys.has(eventKey)) return true;
    for (const dirKey of candidateDirKeys) {
      if (dirKey.startsWith(`${eventKey}${path.sep}`)) return true;
    }
    const parentKey = normalizeKey(path.dirname(eventPath));
    const baseKey =
      process.platform === 'win32'
        ? path.basename(eventPath).toLowerCase()
        : path.basename(eventPath);
    return candidateDirKeys.has(parentKey) && basenameKeys.has(baseKey);
  };

  /**
   * Resolve an event filename against every watched root: `fs.watch` does
   * not tell the shared listener which watch fired, and the filename is
   * relative to that watch's directory. Accepts when any resolution is
   * candidate-relevant.
   */
  const isRelevantFilename = (filename: string): boolean => {
    for (const dir of watchedDirectories.keys()) {
      if (isRelevantEventPath(path.resolve(dir, filename))) return true;
    }
    return false;
  };

  const onFsEvent: ConfigWatchListener = (_eventType, filename) => {
    if (disposed) return;
    // Null/empty filename: the platform did not report the entry; refresh
    // rather than risk missing a real config write.
    if (filename !== null && filename !== '' && !isRelevantFilename(filename)) {
      return;
    }
    // A newly created/removed config directory changes which candidates are
    // watched; rebind before scheduling so subsequent writes are seen.
    reconcileWatchers();
    schedule();
  };

  /** Bind watchers for every candidate's nearest existing ancestor. */
  function reconcileWatchers(): void {
    if (disposed) return;
    const wanted = new Set<string>();
    for (const candidate of candidatePaths) {
      const ancestor = nearestExistingAncestor(path.dirname(candidate));
      wanted.add(ancestor);
      // Watch the watched directory's parent as well so the deletion or
      // rename of a config directory that currently exists (e.g.
      // `.opencode`, an arbitrary OPENCODE_CONFIG_DIR) is observable from
      // outside it; rebinding then walks back up on the next event.
      const parent = path.dirname(ancestor);
      if (parent !== ancestor) wanted.add(parent);
    }
    for (const dir of [...watchedDirectories.keys()]) {
      if (wanted.has(dir)) continue;
      const handle = watchedDirectories.get(dir);
      watchedDirectories.delete(dir);
      try {
        handle?.close();
      } catch (err) {
        // Closing a watcher must never throw into plugin disposal.
        emitLog('[v2] config watcher close failed', {
          directory: dir,
          error: String(err),
        });
      }
    }
    for (const dir of wanted) {
      if (watchedDirectories.has(dir)) continue;
      try {
        watchedDirectories.set(dir, watchImpl(dir, onFsEvent));
      } catch (err) {
        emitLog('[v2] config watch failed', {
          directory: dir,
          error: String(err),
        });
      }
    }
  }

  /** Drain when ready+dirty and nothing is running. */
  function drain(): Promise<void> {
    if (disposed || activeRun || !dirty || !ready) {
      return activeRun ?? Promise.resolve();
    }
    dirty = false;
    ready = false;
    const run = (async () => {
      try {
        await options.onChanged(controller.signal);
      } catch (err) {
        if (!controller.signal.aborted && !disposed) {
          emitLog('[v2] config watcher refresh failed', String(err));
        }
      } finally {
        activeRun = undefined;
        // An event that arrived while the refresh ran leaves dirty+ready set
        // (the debounce timer fired during the run): one trailing refresh.
        if (!disposed && dirty && ready) {
          void drain();
        }
      }
    })();
    activeRun = run;
    return run;
  }

  function schedule(): void {
    if (disposed) return;
    dirty = true;
    ready = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      ready = true;
      void drain();
    }, debounceMs);
  }

  reconcileWatchers();
  if (watchedDirectories.size > 0) {
    emitLog('[v2] watching plugin config candidates for changes', {
      candidates: candidatePaths,
      directories: [...watchedDirectories.keys()],
    });
  }

  return {
    async dispose() {
      if (disposed) {
        await activeRun?.catch(() => {});
        return;
      }
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      dirty = false;
      ready = false;
      controller.abort();
      for (const handle of watchedDirectories.values()) {
        try {
          handle.close();
        } catch (err) {
          // Closing a watcher must never throw into plugin disposal.
          emitLog('[v2] config watcher close failed', String(err));
        }
      }
      watchedDirectories.clear();
      await activeRun?.catch(() => {});
    },
  };
}

/** Discriminated refresh outcome (matches the v1 `v2.refreshProfiles` hook). */
type ProfileRefreshOutcome =
  | { ok: true; profiles: V2AgentRuntimeProfiles }
  | { ok: false; reason: string };

export interface ProfileRefreshRunnerOptions {
  /** Re-resolve the profiles (the v1 factory hook). */
  refresh: () => Promise<ProfileRefreshOutcome>;
  /** Swap the resolved profiles; only called on success and before abort. */
  apply: (profiles: V2AgentRuntimeProfiles) => void;
  /** Test seam: override the logger. */
  log?: (message: string, meta?: unknown) => void;
}

/**
 * Build the watcher callback for the runtime-profile refresh. Honest
 * failure: the resolved profiles are swapped only on `ok` and only while the
 * signal is live; a failure throws so the scheduler logs exactly one cause
 * (and never a success line). Nothing else (agent registry, prompts, tools)
 * is reloaded.
 */
export function createProfileRefreshRunner(
  options: ProfileRefreshRunnerOptions,
): (signal?: AbortSignal) => Promise<void> {
  const emitLog = options.log ?? log;
  return async (signal) => {
    if (signal?.aborted) return;
    const result = await options.refresh();
    if (!result.ok) {
      throw new Error(result.reason);
    }
    if (signal?.aborted) {
      // Disposal raced the refresh: forbid the post-disposal commit.
      return;
    }
    options.apply(result.profiles);
    emitLog('[v2] runtime profiles refreshed', {
      agents: Object.keys(result.profiles).length,
    });
  };
}
