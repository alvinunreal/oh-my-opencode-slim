/**
 * Multiplexer factory - creates the appropriate multiplexer instance
 */

import type { MultiplexerConfig, MultiplexerType } from '../config/schema';
import { log } from '../utils/logger';
import { TmuxMultiplexer } from './tmux';
import type { Multiplexer } from './types';
import { ZellijMultiplexer } from './zellij';

const multiplexerCache = new Map<MultiplexerType | 'auto', Multiplexer>();

/**
 * Create or retrieve a multiplexer instance based on config
 */
export function getMultiplexer(config: MultiplexerConfig): Multiplexer | null {
  const { type } = config;

  if (type === 'none') {
    return null;
  }

  // Return cached instance if available
  const cached = multiplexerCache.get(type);
  if (cached) {
    return cached;
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
    case 'auto': {
      // Auto-detect based on environment variables only
      // Note: Does NOT fall back to binary availability checks
      if (process.env.TMUX) {
        multiplexer = new TmuxMultiplexer(config.layout, config.main_pane_size);
        actualType = 'tmux';
      } else if (process.env.ZELLIJ) {
        multiplexer = new ZellijMultiplexer(
          config.layout,
          config.main_pane_size,
        );
        actualType = 'zellij';
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

  // Cache the instance under the actual type (not 'auto')
  multiplexerCache.set(actualType, multiplexer);
  log(`[multiplexer] Created ${actualType} instance`);

  return multiplexer;
}

/**
 * Clear the multiplexer cache (useful for testing)
 */
export function clearMultiplexerCache(): void {
  multiplexerCache.clear();
}

/**
 * Get the effective multiplexer type for auto mode
 * Returns the actual type that would be used (tmux/zellij/none)
 */
export function getAutoMultiplexerType(): 'tmux' | 'zellij' | 'none' {
  if (process.env.TMUX) {
    return 'tmux';
  }
  if (process.env.ZELLIJ) {
    return 'zellij';
  }
  return 'none';
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
