/**
 * v2 TUI plugin entry (`./tui` subpath → `dist/tui2.js`).
 *
 * Composes the existing dual-contract TUI plugin (`../tui`): the v1 `tui`
 * field is re-exported unchanged so v1 hosts keep the exact sidebar
 * registration, while the v2 `setup` is extended with the `/preset` keymap
 * flow — v2 hosts get the sidebar plus the same three-level preset manager
 * the v1 TUI has (see `./preset-manager`), reached from `/preset` or the
 * sidebar's preset row; `/preset <name>` is the direct fast path that binds
 * the preset to the session on screen through the session-preset RPC (the
 * same result as the manager's Current session action). The global default is
 * configuration, not a command effect.
 *
 * Hosts discover this entry through the package.json `./tui` export
 * (exports-map probe in the host's `kind: "tui"` loader pass); the
 * server-side default export (src/index.ts) plays no role in that — in
 * fact it must stay free of any `tui` key (see the note there).
 */
import { loadPluginConfig } from '../config/loader';
import { isCommandEnabled } from '../hooks/command-hook-utils';
import { PANE_VIEWER_ENV } from '../multiplexer/shared';
import type { TuiRouteView } from '../tui';
import omoTui, {
  readTuiGates,
  renderUpdateBadge,
  resolveRouteSessionId,
} from '../tui';
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
  openPresetManagerV2,
  sessionPresetClient,
  type V2PresetManagerContext,
  type V2PresetUiSurface,
} from './preset-manager';
import { bindSessionPreset } from './session-preset-apply';
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
    router?: { current?: () => unknown };
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
const PRESET_COMMAND_TITLE = 'OMO: switch preset';
const OPEN_SUBAGENT_COMMAND_ID = 'omo.open_subagent';
const PRESET_APP_SLOT = 'app';

/** The session the current route shows; undefined on the home screen. */
function currentSessionID(ctx: V2PresetTuiContext): string | undefined {
  const route = ctx.ui?.router?.current?.() as TuiRouteView | undefined;
  return route ? resolveRouteSessionId(route) : undefined;
}

/**
 * `/preset` flow: bare `/preset` opens the three-level preset manager;
 * `/preset <name>` binds the named preset to the session on screen through the
 * session-preset RPC — the same result as the manager's Current session
 * action, and no restart. Neither path writes the global default. Never
 * throws — failures are surfaced as a toast and logged.
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
    const requested = presetArg?.trim();
    if (requested) {
      const sessionID = currentSessionID(ctx);
      if (sessionID === undefined) {
        toast(
          'No session is displayed. Open a conversation first. Nothing was applied.',
        );
        return;
      }
      const outcome = await bindSessionPreset({
        directory,
        presetName: requested,
        bind: (presetName) =>
          sessionPresetClient(ctx).apply(
            { sessionID, presetName },
            { location: { ...ctx.location, directory } },
          ),
      });
      toast(outcome.message);
      return;
    }

    // Bare `/preset`: open the three-level manager with the shared
    // config-change coordinator so Apply/Save refresh the sidebar state.
    const managerCtx = Object.create(ctx as object) as V2PresetTuiContext;
    managerCtx.getSessionID = () => currentSessionID(ctx);
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
 * host's reducer rejects slash/palette commands without one. Only enabled
 * commands are included: a disabled command's palette/slash/keybind must
 * not exist at all.
 */
function buildPresetLayer(
  ctx: V2PresetTuiContext,
  gates: V2CommandGates,
): () => { mode: string; commands: V2KeymapCommand[] } {
  return () => ({
    mode: 'global',
    commands: [
      ...(gates.preset
        ? [
            {
              id: PRESET_COMMAND_ID,
              title: PRESET_COMMAND_TITLE,
              group: 'System',
              palette: true,
              slash: { name: 'preset', arguments: true },
              run: (input?: string) => void runPresetFlow(ctx, input),
            },
          ]
        : []),
      ...(gates.killall ? [buildKillAllCommand(ctx)] : []),
      ...(gates.subagent ? [buildOpenSubagentCommand(ctx)] : []),
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
 * Which TUI keymap commands the config still enables, resolved from one
 * config read via the shared `disabled_commands` decision surface.
 * `undefined` (config read failure) keeps every command — fail-open,
 * matching every other degraded path here.
 */
interface V2CommandGates {
  preset: boolean;
  killall: boolean;
  subagent: boolean;
}

function commandGates(disabledCommands: ReadonlySet<string>): V2CommandGates {
  return {
    preset: isCommandEnabled('preset', { disabledCommands }),
    killall: isCommandEnabled('killall', { disabledCommands }),
    subagent: isCommandEnabled('subagent', { disabledCommands }),
  };
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

  async setup(
    ctx: V2TuiPluginContext,
  ): Promise<undefined | (() => Promise<void>)> {
    if (isPluginDisabledByEnv()) return;

    const directory = ctx.location?.directory ?? process.cwd();
    const gatesRead = readTuiGates(directory, 'v2');
    if (!gatesRead.gates.tuiEnabled) {
      // `tui: false` master switch: the TUI entry registers nothing — no
      // sidebar, no keymap, no preset manager, no update notice.
      log('[v2][tui] tui disabled by config (tui: false); registering nothing');
      return undefined;
    }

    const disposers: Array<() => void | Promise<void>> = [];
    const baseCleanup = await omoTui.setup(ctx, gatesRead);
    if (typeof baseCleanup === 'function') disposers.push(baseCleanup);

    // `disabled_commands` gates the TUI entry exactly like it gates the
    // server command: a disabled command's palette/slash/keybind does not
    // exist anywhere.
    const gates = commandGates(gatesRead.gates.disabledCommands);

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
                ctx.keymap.layer(buildPresetLayer(ctx, gates));
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
    // `disabled_hooks: ["auto-update-checker"]` is the explicit off switch.
    if (
      process.env[PANE_VIEWER_ENV] !== '1' &&
      !gatesRead.gates.disabledHooks.has('auto-update-checker')
    ) {
      disposers.push(
        registerUpdateNotice(ctx, {
          renderBadge: (latest, color) => renderUpdateBadge(latest, color),
        }),
      );
    } else if (gatesRead.gates.disabledHooks.has('auto-update-checker')) {
      log('[v2][tui] update notice skipped: auto-update-checker disabled');
    }

    return () =>
      Promise.all(disposers.reverse().map((dispose) => dispose())).then(
        () => {},
      );
  },
};

export default plugin;
