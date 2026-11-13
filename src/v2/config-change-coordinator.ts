/**
 * TUI-process config-change coordinator.
 *
 * The v2 sidebar (in `src/tui.ts`) and the v2 TUI entry (`src/v2/tui.ts`) are
 * separate modules in one process: the sidebar owns the config-backed rows
 * (including the preset label) and the entry owns the `/preset` keymap flow
 * plus the preset manager. Both write config through the shared on-disk
 * helpers, and both need the sidebar state to re-read immediately instead of
 * waiting for the 1s poll.
 *
 * A module-level per-directory registry is the single coordinator: the
 * sidebar registers its re-read listener at setup, the manager and
 * `/preset <name>` notify after a successful write, and a failed listener
 * reports a typed failure so callers can be honest (saved but not live)
 * instead of claiming success. There is deliberately no host-registry reload
 * here — session prompt/tool surfaces stay frozen.
 */
import type { V2LiveRefreshResult } from './preset-manager';

export type ConfigChangeListener = () =>
  | undefined
  | V2LiveRefreshResult
  | Promise<undefined | V2LiveRefreshResult>;

/** Default bound for one live-refresh notification round. A listener that
 * hangs must not hang the caller's flow: the timeout reports failure so the
 * caller shows the actionable reload fallback. */
const CONFIG_CHANGE_NOTIFY_TIMEOUT_MS = 2_000;

export interface NotifyConfigChangedOptions {
  /** Test seam: override the per-listener wait bound. */
  timeoutMs?: number;
}

const listenersByDirectory = new Map<string, Set<ConfigChangeListener>>();

async function runListenerWithTimeout(
  listener: ConfigChangeListener,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<undefined | V2LiveRefreshResult | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      listener(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(timeoutMessage), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeDirectory(directory: string): string {
  return directory.replace(/[\\/]+$/, '') || directory;
}

/**
 * Register a re-read listener for one project directory. Returns an
 * idempotent unregister function.
 */
export function registerConfigChangeListener(
  directory: string,
  listener: ConfigChangeListener,
): () => void {
  const key = normalizeDirectory(directory);
  let listeners = listenersByDirectory.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByDirectory.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = listenersByDirectory.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByDirectory.delete(key);
  };
}

/**
 * Notify every registered listener for a directory and report honestly.
 * With no listener registered the change is not live — callers surface the
 * failure instead of claiming a refresh that never ran. A listener that
 * rejects or exceeds the bounded wait reports its failure, so the caller
 * degrades to the reload fallback instead of hanging.
 */
export async function notifyConfigChanged(
  directory: string,
  reason: string,
  options?: NotifyConfigChangedOptions,
): Promise<V2LiveRefreshResult> {
  const listeners = listenersByDirectory.get(normalizeDirectory(directory));
  if (!listeners || listeners.size === 0) {
    return {
      ok: false,
      reason: `no live config-change listener is registered (${reason})`,
    };
  }
  const timeoutMs = options?.timeoutMs ?? CONFIG_CHANGE_NOTIFY_TIMEOUT_MS;
  const outcomes = await Promise.all(
    [...listeners].map(async (listener) => {
      try {
        const timeoutSentinel = `${reason}: live refresh listener timed out`;
        const result = await runListenerWithTimeout(
          listener,
          timeoutMs,
          timeoutSentinel,
        );
        if (typeof result === 'string') return result; // timeout sentinel
        if (result && result.ok === false) {
          return result.reason ?? `${reason}: live refresh reported failure`;
        }
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }),
  );
  const failure = outcomes.find(
    (outcome): outcome is string => typeof outcome === 'string',
  );
  return failure ? { ok: false, reason: failure } : { ok: true };
}

/** Test seam: drop all registered listeners. */
export function resetConfigChangeListeners(): void {
  listenersByDirectory.clear();
}
