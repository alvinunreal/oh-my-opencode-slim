/**
 * Cache monitor — runtime watchdog for provider prompt-cache busts.
 *
 * Offline tests prove the plugin projects a byte-stable payload, but only
 * the provider knows whether a cache prefix was actually reused. OpenCode
 * surfaces per-request cache telemetry on assistant messages
 * (`tokens.cache.read` / `tokens.cache.write`); this hook watches those
 * numbers and logs a loud warning when a session that previously enjoyed
 * cache hits suddenly reports zero cached tokens on a sizeable request —
 * the field signature of a mid-session prompt-prefix change.
 *
 * Observation only: it never mutates messages or state, and it fails open
 * on any unexpected event shape.
 */

import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';

/**
 * Requests below this input size are ignored: tiny prompts sit under
 * provider minimum-cacheable-prefix thresholds and legitimately report
 * zero cached tokens.
 */
const MIN_INPUT_TOKENS_FOR_WARNING = 2048;
const MAX_TRACKED_SESSIONS = 256;
const MAX_TRACKED_MESSAGES_PER_SESSION = 512;

interface SessionCacheState {
  completedRequests: number;
  everReportedCache: boolean;
  lastCacheRead: number;
  warnedSinceLastHit: boolean;
  processedMessageIDs: Set<string>;
}

export interface CacheMonitorOptions {
  logger?: (message: string, data?: unknown) => void;
}

interface CompletedAssistantMessage {
  sessionID: string;
  messageID: string;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function parseCompletedAssistantMessage(
  event: unknown,
): CompletedAssistantMessage | undefined {
  if (!isRecord(event) || event.type !== 'message.updated') return undefined;
  const properties = isRecord(event.properties) ? event.properties : undefined;
  const info =
    properties && isRecord(properties.info) ? properties.info : undefined;
  if (info?.role !== 'assistant') return undefined;
  if (typeof info.sessionID !== 'string' || typeof info.id !== 'string') {
    return undefined;
  }

  // Only completed requests carry final token accounting; message.updated
  // also fires while streaming.
  const time = isRecord(info.time) ? info.time : undefined;
  if (!time || time.completed === undefined || time.completed === null) {
    return undefined;
  }

  const tokens = isRecord(info.tokens) ? info.tokens : undefined;
  if (!tokens) return undefined;
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const inputTokens = asFiniteNumber(tokens.input);
  const cacheRead = asFiniteNumber(cache?.read);
  const cacheWrite = asFiniteNumber(cache?.write);
  if (
    inputTokens === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }

  return {
    sessionID: info.sessionID,
    messageID: info.id,
    inputTokens,
    cacheRead,
    cacheWrite,
  };
}

function deletedSessionID(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== 'session.deleted') return undefined;
  const properties = isRecord(event.properties) ? event.properties : undefined;
  const info =
    properties && isRecord(properties.info) ? properties.info : undefined;
  return info && typeof info.id === 'string' ? info.id : undefined;
}

export function createCacheMonitorHook(options: CacheMonitorOptions = {}) {
  const logger = options.logger ?? log;
  const sessions = new Map<string, SessionCacheState>();

  function getSessionState(sessionID: string): SessionCacheState {
    const existing = sessions.get(sessionID);
    if (existing) return existing;

    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    const state: SessionCacheState = {
      completedRequests: 0,
      everReportedCache: false,
      lastCacheRead: 0,
      warnedSinceLastHit: false,
      processedMessageIDs: new Set(),
    };
    sessions.set(sessionID, state);
    return state;
  }

  function observe(message: CompletedAssistantMessage): void {
    const state = getSessionState(message.sessionID);
    if (state.processedMessageIDs.has(message.messageID)) return;
    if (state.processedMessageIDs.size >= MAX_TRACKED_MESSAGES_PER_SESSION) {
      state.processedMessageIDs.clear();
    }
    state.processedMessageIDs.add(message.messageID);
    state.completedRequests += 1;

    const busted =
      state.completedRequests >= 2 &&
      state.everReportedCache &&
      message.cacheRead === 0 &&
      message.inputTokens >= MIN_INPUT_TOKENS_FOR_WARNING;

    if (busted && !state.warnedSinceLastHit) {
      state.warnedSinceLastHit = true;
      logger(
        '[cache-monitor] possible prompt-cache bust: a session that was hitting the provider cache reported 0 cache-read tokens. A prompt-prefix byte likely changed mid-session — see docs/cache-verification.md.',
        {
          sessionID: message.sessionID,
          requestNumber: state.completedRequests,
          inputTokens: message.inputTokens,
          previousCacheRead: state.lastCacheRead,
        },
      );
    }

    if (message.cacheRead > 0) state.warnedSinceLastHit = false;
    state.everReportedCache =
      state.everReportedCache ||
      message.cacheRead > 0 ||
      message.cacheWrite > 0;
    state.lastCacheRead = message.cacheRead;
  }

  return {
    event: async (input: { event: unknown }): Promise<void> => {
      try {
        const deleted = deletedSessionID(input.event);
        if (deleted) {
          sessions.delete(deleted);
          return;
        }

        const message = parseCompletedAssistantMessage(input.event);
        if (message) observe(message);
      } catch {
        // Observation only — never let telemetry break event handling.
      }
    },
  };
}
