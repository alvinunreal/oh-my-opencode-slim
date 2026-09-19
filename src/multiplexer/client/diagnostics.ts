/**
 * Structured diagnostics for the client-side pane lifecycle (FR-13).
 *
 * Every "no pane" outcome is logged with a `NoPaneReason` from the frozen
 * enumeration; every successful creation logs the full pane identity. The
 * default sink is the plugin's shared file logger; tests inject a capture.
 * Once-per-process semantics belong to the caller (`createOnceGate`).
 */

import { log } from '../../utils/logger';
import type { AdapterType, NoPaneReason, PaneIdentity } from './types';

/** Minimal log surface written through by the diagnostics helpers. */
export interface DiagnosticLogger {
  log(message: string, data?: unknown): void;
}

/** Default sink: the plugin's shared file logger (`src/utils/logger.ts`). */
export const PLUGIN_LOG_SINK: DiagnosticLogger = {
  log: (message, data) => log(message, data),
};

export const DIAGNOSTIC_EVENT_NO_PANE = 'multiplexer.no-pane';
export const DIAGNOSTIC_EVENT_PANE_CREATED = 'multiplexer.pane-created';

/** Optional context attached to a diagnostic record. */
export interface DiagnosticContext {
  childSessionId?: string;
  parentSessionId?: string;
  adapter?: AdapterType;
  anchoredTarget?: string;
}

/**
 * Records one "no pane" outcome. The reason is carried both in the message
 * and in the structured payload so every cause stays distinguishable.
 */
export function logNoPane(
  logger: DiagnosticLogger,
  reason: NoPaneReason,
  context: DiagnosticContext = {},
): void {
  logger.log(`[multiplexer] no pane: ${reason}`, {
    event: DIAGNOSTIC_EVENT_NO_PANE,
    reason,
    ...context,
  });
}

/** Records one successful pane creation with all FR-13 fields. */
export function logPaneCreated(
  logger: DiagnosticLogger,
  pane: PaneIdentity,
): void {
  logger.log(`[multiplexer] pane created: ${pane.paneId}`, {
    event: DIAGNOSTIC_EVENT_PANE_CREATED,
    ...pane,
  });
}

/** Idempotency gate: true only the first time a key is seen. */
export type OnceGate = (key: string) => boolean;

/** Creates an in-process gate used for once-per-process diagnostics. */
export function createOnceGate(): OnceGate {
  const seen = new Set<string>();
  return (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
