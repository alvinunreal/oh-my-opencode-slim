import { PLUGIN_ID } from '../config/constants';
import { readTuiGatesOnly } from '../tui-gates';
import { isPluginDisabledByEnv } from '../utils/env';
import { log } from '../utils/logger';
import type { V2TuiPluginContext } from './tui-impl';

const plugin = {
  id: `${PLUGIN_ID}:tui`,

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
