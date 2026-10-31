/**
 * v2 "a newer oh-my-opencode-slim is available" notice.
 *
 * Why this lives on the TUI side: on OpenCode V2 the server plugin still
 * detects updates, but `ctx.client.tui.showToast(...)` is a logging no-op in
 * `./client-shim.ts` and the call site swallows the failure, so the message
 * never reaches the screen. Showing a toast is a TUI-plugin capability
 * (`ctx.ui.toast.show`), not a server one — the server has no UI channel on
 * V2 (issue #1655). The self-updater cannot help either: it only applies to
 * the v1 `packages/<pkg>@<ver>` wrapper layout, while a host-managed install
 * loads from `npm/<pkg>@latest/<stamp>`, so telling the user is the only
 * remaining channel and it has to come from here.
 *
 * Hard rules, in priority order:
 * 1. Nothing runs on the startup critical path — the first paint wins.
 * 2. Nothing throws and nothing is shown when the answer is unknown: offline,
 *    a slow registry, unparseable versions, or a host without `toast`/`slot`
 *    all degrade to a single log line.
 * 3. A notification names the installed version, the available one and the
 *    command that applies it.
 *
 * The module stays free of `solid-js` (and of `semver`, which would add a
 * dependency to the TUI chunk for three numbers): the view factory is
 * injected by the entry point, so every path here is testable without a
 * renderer.
 */
import { fileURLToPath } from 'node:url';
import { log } from '../utils/logger';
import { findOwnedPackageJson } from '../utils/package-root';
import { compareNumericVersions, type NumericVersion } from '../utils/version';

/** The package this notice is about; also the npm name on the registry. */
export const PACKAGE_NAME = 'oh-my-opencode-slim';

/** `/latest` on the npm registry: a small document naming the newest release. */
export const LATEST_VERSION_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

/** v2 host slot for the durable badge (verified on opencode v2.1.2). */
export const UPDATE_BADGE_SLOT = 'sidebar.footer';

/** Wait before checking: the host is still mounting slots at setup time. */
const UPDATE_NOTICE_DELAY_MS = 1_500;

/** A slow registry must never outlive the check, so the fetch is bounded. */
const UPDATE_FETCH_TIMEOUT_MS = 4_000;

/** How long the transient toast stays up (the badge is the real trace). */
const UPDATE_TOAST_DURATION_MS = 10_000;

/** Parsed `major.minor.patch`; the tuple keeps comparison allocation-free. */
export type VersionTriple = NumericVersion;

/** A `ui.toast.show` input (v2 `ToastOptions` subset this module sends). */
interface UpdateNoticeToast {
  title?: string;
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
}

/** Theme tokens read for the badge colour, tolerated in either shape. */
interface UpdateNoticeTheme {
  text?: { muted?: unknown; subdued?: unknown; default?: unknown };
}

/**
 * The v2 TUI context surface this module consumes. Every field is optional
 * because hosts differ (and because a boxed/older host may expose none of
 * them); each call site capability-checks instead of assuming.
 */
interface UpdateNoticeContext {
  location?: { directory?: string };
  client?: unknown;
  ui?: {
    toast?: { show?: (toast: UpdateNoticeToast) => void };
    slot?: (claim: {
      append: string;
      render: () => unknown;
    }) => (() => void) | undefined;
  };
  theme?: UpdateNoticeTheme;
  renderer?: { requestRender?: () => void };
}

/** Minimal `fetch` shape; the global one is assignable to it. */
type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Tunables and seams; production passes none of them. */
export interface UpdateNoticeOptions {
  /** Replacement `fetch` (tests, or a host without a global one). */
  fetchImpl?: FetchLike;
  /** Registry budget; defaults to {@link UPDATE_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Delay before the check; defaults to {@link UPDATE_NOTICE_DELAY_MS}. */
  delayMs?: number;
  /**
   * URL of the module whose own `package.json` names the running version.
   * Defaults to `import.meta.url`; tests point it at a fixture install.
   */
  moduleUrl?: string | URL;
  /** Builds the durable badge element; absent means toast-only. */
  renderBadge?: (latest: string, color: unknown) => unknown;
}

/** What a check found; `notify` is set only when the user should be told. */
export interface UpdateCheck {
  installed?: string;
  latest?: string;
  notify?: string;
}

/**
 * `"3.0.4"`/`"v3.0.4"` → `[3, 0, 4]`; `undefined` for dist-tags (`latest`),
 * git specs (`github:user/repo`, `git+https://…`) and anything else that is
 * not a plain triple. A prerelease/build suffix is accepted but ignored:
 * only the numeric part is ever compared here.
 */
export function parseVersion(value: unknown): VersionTriple | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1 / 0 / 1 for parsed versions, in the usual left-to-right order. */
export function compareVersions(
  left: VersionTriple,
  right: VersionTriple,
): number {
  return compareNumericVersions(left, right);
}

/**
 * The latest version, but only when it is strictly newer AND still on the
 * same major. A new major is a deliberate migration — it changes presets,
 * config and agent behaviour — so nudging for it from a sidebar badge would
 * be wrong; that belongs to the release notes and the updater.
 */
export function decideUpdate(
  installed: string | undefined,
  latest: string | undefined,
): string | undefined {
  const current = parseVersion(installed);
  const next = parseVersion(latest);
  if (current === undefined || next === undefined) return undefined;
  if (next[0] !== current[0]) return undefined;
  return compareVersions(next, current) > 0 ? latest : undefined;
}

/** `plugin.list` rows, tolerating the SDK's `{ data }` wrapper and bare arrays. */
function pluginRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result === null || typeof result !== 'object') return [];
  const data = (result as { data?: unknown }).data;
  if (Array.isArray(data)) return data;
  if (data !== null && typeof data === 'object') {
    const nested = (data as { data?: unknown }).data;
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

/** A row is ours when its id or its source target names our package. */
function isOwnRow(id: string | undefined, target: string | undefined): boolean {
  for (const name of [id, target]) {
    if (typeof name !== 'string') continue;
    if (name === PACKAGE_NAME) return true;
    if (name.startsWith(`${PACKAGE_NAME}@`)) return true;
  }
  return false;
}

/** Installed version from `plugin.list` (the CLI's own source of truth). */
function versionFromPluginList(result: unknown): string | undefined {
  for (const candidate of pluginRows(result)) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const row = candidate as {
      id?: unknown;
      version?: unknown;
      source?: { target?: unknown; version?: unknown };
    };
    const id = typeof row.id === 'string' ? row.id : undefined;
    const target =
      typeof row.source?.target === 'string' ? row.source.target : undefined;
    if (!isOwnRow(id, target)) continue;
    const version = row.source?.version ?? row.version;
    if (typeof version === 'string') return version;
  }
  return undefined;
}

/**
 * Version of the copy that is actually executing — the only copy whose version
 * describes what the user is running. The module lives in several places over
 * a release — `src/v2/` in the source tree, `dist/tui2.js` in the bundle, and
 * a split `dist/chunks/<hash>.js` in a host install — so the manifest is
 * resolved by walking up from the running module itself, not by a fixed list
 * of relative candidates (which the chunk layout breaks).
 *
 * This deliberately does NOT look around at sibling install directories. The
 * cache keeps several versions at once, so "newest on disk" can be an
 * unrelated leftover — trusting it hides exactly the update this module exists
 * to announce (a running 3.0.4 next to a leftover 3.0.5 reads as "up to date").
 */
function resolveRunningVersion(
  moduleUrl: string | URL = import.meta.url,
): string | undefined {
  let modulePath: string;
  try {
    modulePath = fileURLToPath(new URL(moduleUrl));
  } catch {
    return undefined;
  }

  const manifest = findOwnedPackageJson(modulePath, PACKAGE_NAME);
  if (manifest === null) return undefined;
  return parseVersion(manifest.version) === undefined
    ? undefined
    : manifest.version;
}

/**
 * Installed version, in the order that describes what the user is running:
 *
 * 1. the running copy's own `package.json` (authoritative — nothing else can
 *    be newer without this copy also being newer);
 * 2. `client.plugin.list`, the same source as `opencode plugin list` and the
 *    version the update command acts on — the fallback for hosts/layouts where
 *    the manifest cannot be read.
 *
 * There is deliberately no third "scan the cache" source: the cache holds one
 * directory per install, so a scan can only pick somebody else's copy.
 */
export async function resolveInstalledVersion(
  context: unknown,
  options: UpdateNoticeOptions = {},
): Promise<string | undefined> {
  const running = resolveRunningVersion(options.moduleUrl ?? import.meta.url);
  if (running !== undefined) return running;

  const ctx = (context ?? {}) as UpdateNoticeContext;
  try {
    const client = ctx.client as
      | {
          plugin?: {
            list?: (input: {
              location: { directory: string };
            }) => Promise<unknown>;
          };
        }
      | undefined;
    const plugin = client?.plugin;
    const list = plugin?.list;
    if (typeof list === 'function') {
      const directory = ctx.location?.directory ?? process.cwd();
      const version = versionFromPluginList(
        await list.call(plugin, { location: { directory } }),
      );
      if (version !== undefined) return version;
    }
  } catch {
    // Documented path failed: nothing left to ask without guessing.
  }
  return undefined;
}

/**
 * Newest published version. `undefined` on any failure — offline, DNS,
 * non-OK status, a body without `version`, or a registry that outlives the
 * timeout. The timeout bounds the complete request (`fetch` *and* the body
 * read), so a stalled response cannot hold the check past its budget; the
 * losing promise is subscribed by `Promise.race`, so a late rejection cannot
 * surface as an unhandled one.
 */
export async function fetchLatestVersion(
  options: UpdateNoticeOptions = {},
): Promise<string | undefined> {
  const fetchImpl: FetchLike | undefined =
    options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') return undefined;

  const timeoutMs = options.timeoutMs ?? UPDATE_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`version check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    // The race covers the WHOLE operation, not just the headers: a body read
    // can stall indefinitely even when the response arrived, and the caller
    // was promised a bounded check. The abort signal stays as belt and braces
    // for hosts that honour it; the race covers the ones that do not.
    const version = await Promise.race([
      (async (): Promise<string | undefined> => {
        const response = await fetchImpl(LATEST_VERSION_URL, {
          signal: controller.signal,
        });
        if (response.ok !== true) return undefined;
        const body = (await response.json()) as
          | { version?: unknown }
          | undefined;
        return typeof body?.version === 'string' ? body.version : undefined;
      })(),
      timedOut,
    ]);
    return version;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Resolve both sides and decide. Total: every failure yields no `notify`. */
export async function checkForUpdate(
  context: unknown,
  options: UpdateNoticeOptions = {},
): Promise<UpdateCheck> {
  const installed = await resolveInstalledVersion(context, options);
  const latest = await fetchLatestVersion(options);
  return { installed, latest, notify: decideUpdate(installed, latest) };
}

/** Muted text colour for the badge; `undefined` falls back to the host default. */
function resolveMutedColor(theme?: UpdateNoticeTheme): unknown {
  const text = theme?.text;
  return text?.muted ?? text?.subdued ?? text?.default;
}

/**
 * Wire the notice into a v2 TUI plugin. Returns a disposer, so `setup` can
 * keep its teardown symmetric. Synchronous by design: it only schedules the
 * work, which is why nothing here can delay or break startup.
 */
export function registerUpdateNotice(
  context: unknown,
  options: UpdateNoticeOptions = {},
): () => void {
  const ctx = (context ?? {}) as UpdateNoticeContext;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopBadge: (() => void) | undefined;

  const showToast = (check: UpdateCheck): boolean => {
    const toast = ctx.ui?.toast;
    const show = toast?.show;
    if (typeof show !== 'function') return false;
    try {
      show.call(toast, {
        title: `OMO-Slim ${check.notify}`,
        message: `v${check.installed} → v${check.notify} · run opencode plugin update`,
        variant: 'info',
        duration: UPDATE_TOAST_DURATION_MS,
      });
      return true;
    } catch {
      // A host that cannot toast still gets the badge.
      return false;
    }
  };

  /**
   * The badge is registered only once there is something to say (a launch
   * without an update renders no extra chrome at all), then the host is asked
   * for a repaint because the slot appeared after the initial mount.
   */
  const registerBadge = (check: UpdateCheck): boolean => {
    const ui = ctx.ui;
    const slot = ui?.slot;
    const renderBadge = options.renderBadge;
    if (typeof slot !== 'function' || typeof renderBadge !== 'function') {
      return false;
    }
    try {
      const stop = slot.call(ui, {
        append: UPDATE_BADGE_SLOT,
        render: () =>
          renderBadge(String(check.notify), resolveMutedColor(ctx.theme)),
      });
      if (typeof stop === 'function') stopBadge = stop;
      return true;
    } catch {
      // No footer on this host (or the claim was refused): toast-only.
      return false;
    } finally {
      try {
        ctx.renderer?.requestRender?.();
      } catch {
        // Repaint is a nicety; a host without it paints on the next tick.
      }
    }
  };

  const run = async (): Promise<void> => {
    try {
      const check = await checkForUpdate(ctx, options);
      if (disposed) return;
      if (check.notify === undefined) {
        // One line, always: without it a missing badge looks exactly like a
        // check that never ran.
        log(
          `[v2][tui] update check: installed=${
            check.installed ?? 'unknown'
          } latest=${check.latest ?? 'unknown'} notified=false`,
        );
        return;
      }
      showToast(check);
      registerBadge(check);
      log(`[v2][tui] update available: ${check.installed} -> ${check.notify}`);
    } catch {
      // A failed check is not news: the sidebar must outlive it.
    }
  };

  // Off the startup path: the host is still mounting slots, and first paint
  // wins. The wrapper keeps a surprise rejection off the process handler.
  timer = setTimeout(() => {
    void run().catch(() => {
      // `run` is already total; this is belt and braces.
    });
  }, options.delayMs ?? UPDATE_NOTICE_DELAY_MS);

  return () => {
    disposed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (stopBadge !== undefined) {
      try {
        stopBadge();
      } catch {
        // Teardown is best-effort; the host may already be gone.
      }
      stopBadge = undefined;
    }
  };
}
