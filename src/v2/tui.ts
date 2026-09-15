/**
 * v2 TUI plugin entry (`./tui` subpath → `dist/tui2.js`).
 *
 * Composes the existing dual-contract TUI plugin (`../tui`): the v1 `tui`
 * field is re-exported unchanged so v1 hosts keep the exact sidebar
 * registration, while the v2 `setup` is extended with the `/preset` keymap
 * flow — v2 hosts get the sidebar plus an interactive preset switcher
 * (dialog select → on-disk persist → toast feedback).
 *
 * Hosts discover this entry through the package.json `./tui` export
 * (exports-map probe in the host's `kind: "tui"` loader pass); the
 * server-side default export (src/index.ts) plays no role in that — in
 * fact it must stay free of any `tui` key (see the note there).
 */
import type { PluginConfig } from '../config';
import { loadPluginConfig } from '../config/loader';
import {
  buildAgentUpdates,
  buildPresetSummary,
  type PresetSwitchResult,
  switchPresetOnDisk,
} from '../tools/preset-switch';
import omoTui from '../tui';
import { isPluginDisabledByEnv } from '../utils/env';
import { log } from '../utils/logger';

/** A single `ui.dialog.select` option for the preset picker. */
export interface PresetOption {
  title: string;
  value: string;
  description?: string;
}

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
 * v2 TUI preset-switcher surface. Complements the sidebar context that
 * `../tui` mirrors (location/renderer/theme/ui.slot/ui.router); hosts may
 * provide either or both, so every field is optional and capability-guarded.
 */
export interface V2PresetTuiContext {
  location?: { directory: string };
  ui?: {
    dialog?: {
      select: <Value>(options: {
        title: string;
        options: Array<{ title: string; value: Value; description?: string }>;
        current?: Value;
      }) => Promise<Value | undefined>;
    };
    toast?: {
      show?: (toast: {
        title?: string;
        message: string;
        variant?: string;
      }) => void;
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
const PRESET_APP_SLOT = 'app';

const NO_PRESETS_MESSAGE =
  'No presets configured. Define presets in oh-my-opencode-slim.jsonc.';

/**
 * Map a plugin config's presets to `ui.dialog.select` options. Each option's
 * description is the per-agent summary (e.g. "orchestrator → model: x"),
 * matching the v1 picker's tooltip.
 */
export function buildPresetOptions(config: PluginConfig): PresetOption[] {
  const presets = config.presets ?? {};
  return Object.entries(presets).map(([name, preset]) => {
    const summary = buildPresetSummary(buildAgentUpdates(preset));
    return {
      title: name,
      value: name,
      ...(summary.length > 0 ? { description: summary.join('; ') } : {}),
    };
  });
}

/**
 * Apply a preset by name through the shared on-disk switcher
 * (`switchPresetOnDisk`): the preset name is persisted to the user config so
 * the next reload/restart picks it up; the running session is untouched.
 * Returns the switch result whose `message` is user-facing (toast-ready).
 */
export function applyPresetByName(
  directory: string,
  config: PluginConfig,
  presetName: string,
): PresetSwitchResult {
  return switchPresetOnDisk(directory, presetName, config);
}

/**
 * Interactive `/preset` flow: open the preset picker (or apply `presetArg`
 * directly when the slash command carried a name, e.g. `/preset cheap`),
 * persist the selection, and toast the result. Never throws — failures are
 * surfaced as a toast and logged.
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
    const config = loadPluginConfig(directory, { silent: true });

    const requested = presetArg?.trim();
    if (requested) {
      toast(applyPresetByName(directory, config, requested).message);
      return;
    }

    const options = buildPresetOptions(config);
    if (options.length === 0) {
      toast(NO_PRESETS_MESSAGE);
      return;
    }
    const dialog = ctx.ui?.dialog;
    if (!dialog || typeof dialog.select !== 'function') {
      log('[v2][tui] ui.dialog.select unavailable; cannot open preset picker');
      return;
    }
    const name = await dialog.select({
      title: 'Select preset',
      options,
      current: config.preset,
    });
    if (name === undefined) return;
    toast(applyPresetByName(directory, config, name).message);
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
    ],
  });
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

    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  },
};

export default plugin;
