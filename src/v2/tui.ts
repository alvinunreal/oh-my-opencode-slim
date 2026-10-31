/**
 * v2 TUI plugin entry (`./tui` subpath → `dist/tui2.js`).
 *
 * Thin contract surface, on purpose: the heavy TUI implementation —
 * `src/tui.ts`, `src/tui-kill.ts`, `src/tui-preset.ts`, `@opentui/*`,
 * `solid-js` — lives in `./tui-impl` and is imported only after the config
 * gate says the TUI is enabled. With `tui: false` (or the disable env
 * switch) the TUI host still discovers this module and reads `id`/`setup`,
 * but never evaluates the render stack.
 *
 * Hosts discover this entry through the package.json `./tui` export
 * (exports-map probe in the host's `kind: "tui"` loader pass); the
 * server-side default export (src/index.ts) plays no role in that — in
 * fact it must stay free of any `tui` key (see the note there).
 */
import type { PluginOptions } from '@opencode-ai/plugin';
import type { TuiPluginApi, TuiPluginMeta } from '@opencode-ai/plugin/tui';
import { PLUGIN_ID } from '../config/constants';
import { readTuiGatesOnly } from '../tui-gates';
import { isPluginDisabledByEnv } from '../utils/env';
import { log } from '../utils/logger';
import type { V2TuiPluginContext } from './tui-impl';

const plugin = {
  id: `${PLUGIN_ID}:tui`,

  /** v1 hosts validate `{ id, tui }`; the delegate keeps the identical
   *  factory the composition exposes and defers loading it until called. */
  async tui(
    api: TuiPluginApi,
    options: PluginOptions | undefined,
    meta: TuiPluginMeta,
  ): Promise<void> {
    const impl = await import('./tui-impl');
    await impl.tui(api, options, meta);
  },

  /** v2 hosts validate `{ id, setup }`. Read the gates from the light module
   *  first: `tui: false` must register nothing and load nothing. */
  async setup(
    ctx: V2TuiPluginContext,
  ): Promise<undefined | (() => Promise<void>)> {
    if (isPluginDisabledByEnv()) return;

    const directory = ctx.location?.directory ?? process.cwd();
    const gatesRead = readTuiGatesOnly(directory, 'v2');
    if (!gatesRead.gates.tuiEnabled) {
      // `tui: false` master switch: the TUI entry registers nothing — no
      // sidebar, no keymap, no preset manager, no update notice.
      log('[v2][tui] tui disabled by config (tui: false); registering nothing');
      return undefined;
    }

    const impl = await import('./tui-impl');
    return impl.runSetup(ctx);
  },
};

export default plugin;
