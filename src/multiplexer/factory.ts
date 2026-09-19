/**
 * Multiplexer factory - creates the appropriate multiplexer instance
 */

import type { MultiplexerConfig, MultiplexerType } from '../config/schema';
import { log } from '../utils/logger';
import { CmuxMultiplexer } from './cmux';
import { HerdrMultiplexer } from './herdr';
import { KittyMultiplexer } from './kitty';
import { TmuxMultiplexer } from './tmux';
import type { Multiplexer } from './types';
import { ZellijMultiplexer } from './zellij';

/**
 * Create a multiplexer instance based on config.
 *
 * Do not cache instances: the adapters depend on pane-scoped per-process
 * environment (TMUX_PANE, ZELLIJ_PANE_ID, HERDR_PANE_ID, KITTY_WINDOW_ID,
 * CMUX_TUI_SOCKET/CMUX_MUX_SOCKET), which should be captured fresh for each
 * plugin context.
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
      multiplexer = new HerdrMultiplexer(config.layout, config.main_pane_size);
      actualType = 'herdr';
      break;
    case 'cmux':
      multiplexer = new CmuxMultiplexer(config.layout, config.main_pane_size);
      actualType = 'cmux';
      break;
    case 'kitty':
      multiplexer = new KittyMultiplexer(config.layout, config.main_pane_size);
      actualType = 'kitty';
      break;
    case 'auto': {
      // Auto-detect from pane-scoped client environment signals only.
      // Note: Does NOT fall back to binary availability checks.
      if (process.env.CMUX_TUI_SOCKET || process.env.CMUX_MUX_SOCKET) {
        // New-generation cmux TUI; CMUX_TUI_SOCKET takes precedence over the
        // legacy CMUX_MUX_SOCKET alias.
        multiplexer = new CmuxMultiplexer(config.layout, config.main_pane_size);
        actualType = 'cmux';
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
        );
        actualType = 'herdr';
      } else if (process.env.KITTY_WINDOW_ID) {
        multiplexer = new KittyMultiplexer(
          config.layout,
          config.main_pane_size,
        );
        actualType = 'kitty';
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

/**
 * Start background availability check for a multiplexer
 */
export function startAvailabilityCheck(config: MultiplexerConfig): void {
  const multiplexer = getMultiplexer(config);
  if (multiplexer) {
    // Fire and forget - don't await
    multiplexer.isAvailable().catch(() => {});
  }
}
