/**
 * Multiplexer factory - creates the appropriate multiplexer instance
 */

import type { MultiplexerConfig, MultiplexerType } from '../config/schema';
import { log } from '../utils/logger';
import { CmuxMultiplexer } from './cmux';
import { HerdrMultiplexer } from './herdr';
import { KittyMultiplexer } from './kitty';
import { OrcaMultiplexer } from './orca';
import { TmuxMultiplexer } from './tmux';
import type { Multiplexer } from './types';
import { WeztermMultiplexer } from './wezterm';
import { ZellijMultiplexer } from './zellij';

/**
 * Create a multiplexer instance based on config.
 *
 * Adapters capture pane-scoped state as they run (herdr's agent-area pane id
 * and spawn mutex, tmux's pane targets, kitty's applied
 * layout), so a caller that performs more than one operation on one plugin
 * context must reuse a single instance per type - the TUI client wiring
 * memoizes one for its lifetime (`createReusingAdapterFactory`). Callers that
 * only need a short-lived adapter may create a new one; construction itself
 * captures no pane-scoped environment.
 */
export function getMultiplexer(config: MultiplexerConfig): Multiplexer | null {
  const { type } = config;

  if (type === 'none') {
    return null;
  }

  // Create new instance
  let multiplexer: Multiplexer;
  let actualType: MultiplexerType;

  switch (type) {
    case 'tmux':
      multiplexer = new TmuxMultiplexer(config.layout, config.main_pane_size);
      actualType = 'tmux';
      break;
    case 'zellij':
      multiplexer = new ZellijMultiplexer(config.layout, config.main_pane_size);
      actualType = 'zellij';
      break;
    case 'herdr':
      multiplexer = new HerdrMultiplexer(config.layout, config.main_pane_size, {
        equalizePanes: config.equalize_panes,
      });
      actualType = 'herdr';
      break;
    case 'cmux-tui':
      multiplexer = new CmuxMultiplexer(config.layout, config.main_pane_size, {
        binary: config.cmux_tui_binary,
      });
      actualType = 'cmux-tui';
      break;
    case 'kitty':
      multiplexer = new KittyMultiplexer(config.layout, config.main_pane_size);
      actualType = 'kitty';
      break;
    case 'wezterm':
      multiplexer = new WeztermMultiplexer(
        config.layout,
        config.main_pane_size,
      );
      actualType = 'wezterm';
      break;
    case 'orca':
      multiplexer = new OrcaMultiplexer(config.layout);
      actualType = 'orca';
      break;
    case 'auto': {
      // Auto-detect from pane-scoped client environment signals only.
      // Note: Does NOT fall back to binary availability checks.
      if (process.env.CMUX_TUI_SOCKET || process.env.CMUX_MUX_SOCKET) {
        // New-generation cmux TUI; CMUX_TUI_SOCKET takes precedence over the
        // legacy CMUX_MUX_SOCKET alias.
        multiplexer = new CmuxMultiplexer(
          config.layout,
          config.main_pane_size,
          { binary: config.cmux_tui_binary },
        );
        actualType = 'cmux-tui';
      } else if (process.env.TMUX_PANE) {
        multiplexer = new TmuxMultiplexer(config.layout, config.main_pane_size);
        actualType = 'tmux';
      } else if (process.env.ZELLIJ_PANE_ID) {
        multiplexer = new ZellijMultiplexer(
          config.layout,
          config.main_pane_size,
        );
        actualType = 'zellij';
      } else if (process.env.HERDR_PANE_ID) {
        multiplexer = new HerdrMultiplexer(
          config.layout,
          config.main_pane_size,
          { equalizePanes: config.equalize_panes },
        );
        actualType = 'herdr';
      } else if (process.env.KITTY_WINDOW_ID) {
        multiplexer = new KittyMultiplexer(
          config.layout,
          config.main_pane_size,
        );
        actualType = 'kitty';
      } else if (process.env.WEZTERM_PANE) {
        // WezTerm hosts tmux/zellij sessions, which must win when nested
        // inside it.
        multiplexer = new WeztermMultiplexer(
          config.layout,
          config.main_pane_size,
        );
        actualType = 'wezterm';
      } else if (process.env.ORCA_TERMINAL_HANDLE) {
        // Last: Orca hosts the same nested sessions, so it sits at the end of
        // the chain for the same reason WezTerm does.
        multiplexer = new OrcaMultiplexer(config.layout);
        actualType = 'orca';
      } else {
        // Not inside any session, disable multiplexer
        log('[multiplexer] auto: not inside any session, disabling');
        return null;
      }
      break;
    }
    default:
      log(`[multiplexer] Unknown type: ${type}`);
      return null;
  }

  log(`[multiplexer] Created ${actualType} instance`);

  return multiplexer;
}
