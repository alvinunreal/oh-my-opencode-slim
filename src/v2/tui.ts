/**
 * v2 TUI plugin entry (`./tui` subpath → `dist/tui2.js`).
 *
 * Composes the existing dual-contract TUI plugin (`../tui`): the v1 `tui`
 * field is re-exported unchanged so v1 hosts keep the exact sidebar
 * registration, while the v2 `setup` is extended with the `/preset` keymap
 * flow — v2 hosts get the sidebar plus the same three-level preset manager
 * the v1 TUI has (see `./preset-manager`), reached from `/preset` or the
 * sidebar's preset row; `/preset <name>` stays the direct fast path
 * (on-disk persist → refresh REQUESTED: sidebar re-read + file-write-driven
 * server watcher). The server watcher's outcome is not observable from the
 * TUI process, so success toasts say "Live refresh requested" and failures
 * show the reload fallback.
 *
 * Hosts discover this entry through the package.json `./tui` export
 * (exports-map probe in the host's `kind: "tui"` loader pass); the
 * server-side default export (src/index.ts) plays no role in that — in
 * fact it must stay free of any `tui` key (see the note there).
 */
import type { PluginConfig } from '../config';
import { loadPluginConfig } from '../config/loader';
import {
  type PresetSwitchResult,
  switchPresetOnDisk,
} from '../tools/preset-switch';
import type { TuiRouteView } from '../tui';
import omoTui, { renderUpdateBadge, resolveRouteSessionId } from '../tui';
import {
  KILL_ALL_COMMAND_ID,
  KILL_ALL_KEYBIND,
  killAllRunningSubagents,
  killAllSummaryMessage,
} from '../tui-kill';
import { readTuiSnapshot } from '../tui-state';
import { isPluginDisabledByEnv } from '../utils/env';
import { log } from '../utils/logger';
import { notifyConfigChanged } from './config-change-coordinator';
import {
  liveRefreshFailureMessage,
  liveRefreshSuccessMessage,
  openPresetManagerV2,
  type V2PresetManagerContext,
  type V2PresetUiSurface,
} from './preset-manager';
import { registerUpdateNotice } from './update-notice';

/** A keymap command as accepted by the host's `keymap.layer` reducer. */
export interface V2KeymapCommand {
  id: string;
  title?: string;
  group?: string;
  palette?: boolean;
  bind?: string;
  slash?: { name: string; aliases?: string[]; arguments?: boolean };
  run: (input?: string) => void | Promise<void>;
}

/** A `ui.slot` render runs under the host's Keymap.Provider. */
type V2SlotApi = (claim: {
  append: string;
  render: () => null;
}) => (() => void) | undefined;

/**
 * v2 TUI preset surface. Complements the sidebar context that `../tui`
 * mirrors (location/renderer/theme/ui.slot/ui.router); hosts may provide
 * either or both, so every field is optional and capability-guarded.
 */
export interface V2PresetTuiContext extends V2PresetManagerContext {
  data?: V2PresetManagerContext['data'] & {
    session?: {
      list?: () => Array<{
        id?: string;
        parentID?: string;
        time?: { created?: number };
      }>;
    };
  };
  ui?: V2PresetUiSurface & {
    router?: {
      current?: () => unknown;
      navigate?: (route: { type: string; sessionID: string }) => void;
    };
    tabs?: {
      enabled?: () => boolean;
      open?: (sessionID: string) => boolean;
    };
    slot?: V2SlotApi;
  };
  keymap?: {
    layer: (
      layer: () => {
        mode?: string;
        commands: V2KeymapCommand[];
      },
    ) => void;
  };
}

/** Combined v2 TUI context: sidebar surface from `../tui` + preset surface. */
export type V2TuiPluginContext = Parameters<(typeof omoTui)['setup']>[0] &
  V2PresetTuiContext;

const PRESET_COMMAND_ID = 'omo.preset';
const PRESET_COMMAND_TITLE = 'OMO: manage presets';
const OPEN_SUBAGENT_COMMAND_ID = 'omo.open_subagent';
const PRESET_APP_SLOT = 'app';

/**
 * Apply a preset by name through the shared on-disk switcher
 * (`switchPresetOnDisk`): the preset name is persisted to the user config so
 * the next reload/restart picks it up; the running session is untouched.
 * `runPresetFlow` follows a successful switch with the config refresh.
 * Returns the switch result whose `message` is user-facing (toast-ready).
 */
export function applyPresetByName(
  directory: string,
  config: PluginConfig,
  presetName: string,
): PresetSwitchResult {
  return switchPresetOnDisk(directory, presetName, config, {
    hostFlavor: 'v2',
  });
}

/**
 * `/preset` flow: bare `/preset` opens the three-level preset manager
 * (applying a preset persists the name on disk, reports the toast, and
 * requests the config refresh for new dispatches/sidebar); `/preset <name>`
 * keeps the direct fast path that works even when the host exposes no
 * dialogs. Never throws — failures are surfaced as a toast and logged.
 *
 * Feedback is honest about the process boundary: the TUI can persist and
 * REQUEST the live refresh (local sidebar re-read + the server-side watcher
 * reacting to the file write), but it cannot observe the server watcher's
 * outcome, so a successful switch never claims the refresh was applied and a
 * failed/missing request path shows the actionable reload fallback.
 */
export async function runPresetFlow(
  ctx: V2PresetTuiContext,
  presetArg?: string,
): Promise<void> {
  const directory = ctx.location?.directory ?? process.cwd();
  const toast = (message: string) => {
    const toastApi = ctx.ui?.toast;
    if (toastApi && typeof toastApi.show === 'function') {
      toastApi.show({ message });
    }
  };
  try {
    const config = loadPluginConfig(directory, {
      silent: true,
      hostFlavor: 'v2',
    });

    const requested = presetArg?.trim();
    if (requested) {
      const result = applyPresetByName(directory, config, requested);
      if (!result.ok) {
        toast(result.message);
        return;
      }
      // Persistence succeeded; request the live refresh and report honestly.
      // Success text says "Live refresh requested" (the server watcher owns
      // the outcome); a failed request falls back to the reload action.
      const outcome = await notifyConfigChanged(directory, '/preset');
      if (outcome.ok) {
        toast(liveRefreshSuccessMessage(requested, result.summary));
      } else {
        log(
          '[v2][tui] preset applied but the live refresh request failed',
          outcome.reason,
        );
        toast(
          liveRefreshFailureMessage(
            requested,
            outcome.reason ?? 'live refresh request failed',
          ),
        );
      }
      return;
    }

    // Bare `/preset`: open the three-level manager with the shared
    // config-change coordinator so Apply/Save refresh the sidebar state.
    const managerCtx = Object.create(ctx as object) as V2PresetTuiContext;
    managerCtx.getSessionID = () => {
      const route = ctx.ui?.router?.current?.() as TuiRouteView | undefined;
      return route ? resolveRouteSessionId(route) : undefined;
    };
    managerCtx.isHome = () =>
      (ctx.ui?.router?.current?.() as { type?: string } | undefined)?.type ===
      'home';
    if (ctx.ui?.router?.navigate) {
      managerCtx.openSession = (sessionID) =>
        ctx.ui?.router?.navigate?.({ type: 'session', sessionID });
    }
    managerCtx.onConfigChanged = () =>
      notifyConfigChanged(directory, '/preset-manager');
    await openPresetManagerV2(managerCtx, directory);
  } catch (err) {
    log('[v2][tui] preset flow failed', String(err));
    toast(`Preset switch failed: ${String(err)}`);
  }
}

/**
 * Build the `/preset` keymap layer thunk. The host invokes `layer` as a
 * thunk from inside a `ui.slot` render (which runs under the
 * Keymap.Provider) — calling it directly from plugin `setup` throws
 * `Keymap.Provider is missing`. The command needs an `id` because the
 * host's reducer rejects slash/palette commands without one.
 */
function buildPresetLayer(
  ctx: V2PresetTuiContext,
): () => { mode: string; commands: V2KeymapCommand[] } {
  return () => ({
    mode: 'global',
    commands: [
      {
        id: PRESET_COMMAND_ID,
        title: PRESET_COMMAND_TITLE,
        group: 'System',
        palette: true,
        slash: { name: 'preset', arguments: true },
        run: (input?: string) => void runPresetFlow(ctx, input),
      },
      buildKillAllCommand(ctx),
      buildOpenSubagentCommand(ctx),
    ],
  });
}

/**
 * Emergency `omo.kill_all` keymap command: abort every running subagent
 * of the conversation the current route shows (alt+w, also
 * palette + `/killall`). No picker, no confirmation — instant, fail-soft.
 * Targets come from the shared tui-state snapshot projection; the aborts
 * go through the shared `src/tui-kill.ts` helper; the existing idle
 * pipeline does all reconciliation.
 */
function buildKillAllCommand(
  ctx: V2PresetTuiContext & {
    client?: unknown;
    ui?: {
      router?: { current?: () => unknown };
      toast?: { show?: (toast: { message: string }) => void };
    };
  },
): V2KeymapCommand {
  return {
    id: KILL_ALL_COMMAND_ID,
    title: 'OMO: kill all running subagents',
    group: 'System',
    palette: true,
    slash: { name: 'killall' },
    bind: KILL_ALL_KEYBIND,
    run: () => {
      void runKillAllFlow(ctx);
    },
  };
}

/**
 * Fallback surface for v2 hosts that cannot host panes (standalone private
 * servers, malformed launch modes): open the most recent subagent session of
 * the visible conversation in a host tab. Manual only — nothing opens
 * automatically, and a host without tab support just toasts.
 */
function buildOpenSubagentCommand(ctx: V2PresetTuiContext): V2KeymapCommand {
  return {
    id: OPEN_SUBAGENT_COMMAND_ID,
    title: 'OMO: open latest subagent in a tab',
    group: 'System',
    palette: true,
    slash: { name: 'subagent' },
    run: () => {
      void runOpenSubagentFlow(ctx);
    },
  };
}

/** Opens the newest child of the displayed session in a tab; never throws. */
async function runOpenSubagentFlow(ctx: V2PresetTuiContext): Promise<void> {
  const toast = (message: string) => ctx.ui?.toast?.show?.({ message });
  try {
    const route = ctx.ui?.router?.current?.() as TuiRouteView | undefined;
    const visible = route ? resolveRouteSessionId(route) : undefined;
    if (visible === undefined) {
      toast('No session is displayed.');
      return;
    }
    const children = (ctx.data?.session?.list?.() ?? [])
      .filter((entry) => entry.parentID === visible)
      .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
    const child = children[0];
    if (!child || typeof child.id !== 'string') {
      toast('No subagent session found for this conversation.');
      return;
    }
    const tabs = ctx.ui?.tabs;
    if (tabs?.enabled?.() === false) {
      toast('Session tabs are disabled for this host.');
      return;
    }
    const opened = tabs?.open?.(child.id);
    if (opened === false) {
      toast('Session tabs are unavailable.');
      return;
    }
    toast(`Opened subagent ${child.id} in a tab.`);
  } catch (err) {
    log('[v2][tui] open-subagent flow failed', String(err));
    toast('Open subagent failed.');
  }
}

/** Resolve the visible session, kill, and toast the summary. Never throws. */
async function runKillAllFlow(ctx: {
  client?: unknown;
  location?: { directory: string };
  ui?: {
    router?: { current?: () => unknown };
    toast?: { show?: (toast: { message: string }) => void };
  };
}): Promise<void> {
  try {
    const directory = ctx.location?.directory ?? process.cwd();
    const route = ctx.ui?.router?.current?.() as TuiRouteView | undefined;
    const visible = route ? resolveRouteSessionId(route) : undefined;
    const result = await killAllRunningSubagents(
      ctx.client,
      readTuiSnapshot(directory),
      visible,
      directory,
    );
    ctx.ui?.toast?.show?.({
      message: killAllSummaryMessage(result),
    });
  } catch (err) {
    log('[v2][tui] kill-all flow failed', String(err));
    ctx.ui?.toast?.show?.({ message: 'Kill-all failed.' });
  }
}

/**
 * Dual contract, same as `../tui`: v1 hosts validate `{ id, tui }`, v2 hosts
 * validate `{ id, setup }`; both ignore extra keys. The `tui` field is the
 * identical v1 factory reference; the `setup` wraps the base v2 setup
 * (sidebar) and adds the `/preset` keymap layer.
 */
const plugin = {
  id: omoTui.id,
  tui: omoTui.tui,

  async setup(ctx: V2TuiPluginContext): Promise<undefined | (() => void)> {
    if (isPluginDisabledByEnv()) return omoTui.setup(ctx);

    const disposers: Array<() => void> = [];
    const baseCleanup = await omoTui.setup(ctx);
    if (typeof baseCleanup === 'function') disposers.push(baseCleanup);

    const slotApi = (ctx.ui as { slot?: V2SlotApi } | undefined)?.slot;
    if (typeof slotApi !== 'function') {
      log('[v2][tui] ui.slot unavailable; /preset disabled on this build');
    } else {
      try {
        const disposeSlot = slotApi({
          append: PRESET_APP_SLOT,
          render: () => {
            if (typeof ctx.keymap?.layer === 'function') {
              try {
                ctx.keymap.layer(buildPresetLayer(ctx));
              } catch (err) {
                log('[v2][tui] keymap.layer failed', String(err));
              }
            }
            return null;
          },
        });
        if (typeof disposeSlot === 'function') disposers.push(disposeSlot);
      } catch (err) {
        log(
          '[v2][tui] ui.slot registration failed; /preset disabled',
          String(err),
        );
      }
    }

    // Update notice (issue #1655): the server-side checker detects updates
    // but has no UI channel on V2 — `client.tui.showToast` is a no-op in the
    // shim — so the TUI owns the message. Scheduled off the startup path and
    // silent on every failure; see ./update-notice.
    disposers.push(
      registerUpdateNotice(ctx, {
        renderBadge: (latest, color) => renderUpdateBadge(latest, color),
      }),
    );

    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  },
};

export default plugin;
