/**
 * Multiplexer factory - creates the appropriate multiplexer instance
 */

import type { MultiplexerConfig, MultiplexerType } from '../config/schema';
import { log } from '../utils/logger';
import { CmuxMultiplexer } from './cmux';
import { HerdrMultiplexer } from './herdr';
import { TmuxMultiplexer } from './tmux';
import type { Multiplexer } from './types';
import { ZellijMultiplexer } from './zellij';

/**
 * Create a multiplexer instance based on config.
 *
 * Do not cache instances: tmux/zellij/herdr integrations may depend on
 * per-process environment like TMUX_PANE/ZELLIJ/HERDR_PANE_ID, which should
 * be captured fresh for each plugin context.
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
      multiplexer = new ZellijMultiplexer(
        config.layout,
        config.main_pane_size,
        config.zellij_pane_mode,
      );
      actualType = 'zellij';
      break;
    case 'herdr':
      multiplexer = new HerdrMultiplexer(config.layout, config.main_pane_size);
      actualType = 'herdr';
      break;
    case 'cmux':
      multiplexer = new CmuxMultiplexer();
      actualType = 'cmux';
      break;
    case 'auto': {
      // Auto-detect based on environment variables only
      // Note: Does NOT fall back to binary availability checks
      if (
        process.env.CMUX_SOCKET_PATH &&
        process.env.CMUX_WORKSPACE_ID &&
        process.env.CMUX_SURFACE_ID
      ) {
        multiplexer = new CmuxMultiplexer();
        actualType = 'cmux';
      } else if (process.env.TMUX) {
        multiplexer = new TmuxMultiplexer(config.layout, config.main_pane_size);
        actualType = 'tmux';
      } else if (process.env.ZELLIJ) {
        multiplexer = new ZellijMultiplexer(
          config.layout,
          config.main_pane_size,
          config.zellij_pane_mode,
        );
        actualType = 'zellij';
      } else if (process.env.HERDR_ENV || process.env.HERDR_PANE_ID) {
        multiplexer = new HerdrMultiplexer(
          config.layout,
          config.main_pane_size,
        );
        actualType = 'herdr';
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
