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
import { resolveV2EventPayload } from '../../v2/runtime-profiles';

/**
 * Requests below this input size are ignored: tiny prompts sit under
 * provider minimum-cacheable-prefix thresholds and legitimately report
 * zero cached tokens.
 */
const MIN_INPUT_TOKENS_FOR_WARNING = 2048;
const MAX_TRACKED_SESSIONS = 256;
const MAX_TRACKED_MESSAGES_PER_SESSION = 512;

/**
 * A session busted from its very first request never trips the
 * `everReportedCache` warning below — that was the field signature of the
 * v2.2.5 checkpoint board regression, where every request re-paid full
 * input from turn one and the monitor stayed silent.
 *
 * OpenCode coalesces missing provider cache telemetry to zeros, so explicit
 * zeros cannot distinguish "prefix changes every request" from "provider
 * has no prompt cache". Both thresholds must be met before warning — at
 * least this many consecutive sizeable zero-cache requests AND this much
 * cumulative uncached input — so the warning only fires where a working
 * cache would have saved a large amount, and the wording stays hedged.
 */
const NEVER_CACHED_STREAK_FOR_WARNING = 3;
const NEVER_CACHED_INPUT_TOKENS_FOR_WARNING = 100_000;

/**
 * Cache-read plateau (issue #874 signature): `cache.read` stays frozen at
 * the same nonzero value across consecutive requests while sizeable uncached
 * input accumulates — the provider's reusable prefix has stopped growing
 * even though nothing reads zero. Providers round reads to coarse
 * boundaries, so short frozen streaks with small inputs are normal; both
 * thresholds must be met before warning.
 */
const PLATEAU_STREAK_FOR_WARNING = 4;
const PLATEAU_INPUT_TOKENS_FOR_WARNING = 50_000;

interface SessionCacheState {
  completedRequests: number;
  everReportedCache: boolean;
  lastCacheRead: number;
  warnedSinceLastHit: boolean;
  neverCachedStreak: number;
  neverCachedInputTokens: number;
  neverCachedWarned: boolean;
  plateauStreak: number;
  plateauInputTokens: number;
  plateauWarned: boolean;
  processedMessageIDs: Set<string>;
  /** Agent/model/provider of the latest started step. */
  config?: string;
}

/**
 * Cleared when the producing configuration changes: the new prompt prefix
 * makes the next cold cache expected. Request count and message dedupe
 * survive.
 */
const EMPTY_CACHE_BASELINE = {
  everReportedCache: false,
  lastCacheRead: 0,
  warnedSinceLastHit: false,
  neverCachedStreak: 0,
  neverCachedInputTokens: 0,
  neverCachedWarned: false,
  plateauStreak: 0,
  plateauInputTokens: 0,
  plateauWarned: false,
} satisfies Partial<SessionCacheState>;

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
    if (existing) {
      // Refresh recency for every observed event (start or completion), so
      // the cap evicts the least recently observed session.
      sessions.delete(sessionID);
      sessions.set(sessionID, existing);
      return existing;
    }

    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    const state: SessionCacheState = {
      ...EMPTY_CACHE_BASELINE,
      completedRequests: 0,
      processedMessageIDs: new Set(),
    };
    sessions.set(sessionID, state);
    return state;
  }

  /**
   * v2 completed-step telemetry carries no agent/model; the started event
   * does. A session runs one step at a time, so the first step under a new
   * configuration is exactly where the prompt prefix changes — clear the
   * baseline there, before that step completes.
   */
  function observeStepStarted(event: Record<string, unknown>): void {
    const payload = resolveV2EventPayload(event);
    const sessionID = payload.sessionID;
    const model = isRecord(payload.model) ? payload.model : undefined;
    if (
      typeof sessionID !== 'string' ||
      typeof payload.agent !== 'string' ||
      typeof model?.id !== 'string' ||
      typeof model.providerID !== 'string'
    ) {
      return;
    }
    // Variants are excluded: the host keeps prompt-cache settings at the
    // model level, so a variant-only switch keeps the prefix.
    const config = JSON.stringify([payload.agent, model.providerID, model.id]);
    const state = getSessionState(sessionID);
    if (state.config !== undefined && state.config !== config) {
      Object.assign(state, EMPTY_CACHE_BASELINE);
    }
    state.config = config;
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

    // A session that never serves a single cached token, over enough
    // sizeable requests that a working cache would have saved a large
    // amount, is busted from turn one — it never arms the
    // everReportedCache warning above. Small requests neither extend nor
    // reset the streak: they sit under provider minimum-prefix thresholds
    // and legitimately miss.
    if (!state.everReportedCache) {
      if (
        message.cacheRead === 0 &&
        message.cacheWrite === 0 &&
        message.inputTokens >= MIN_INPUT_TOKENS_FOR_WARNING
      ) {
        state.neverCachedStreak += 1;
        state.neverCachedInputTokens += message.inputTokens;
      }
      if (
        !state.neverCachedWarned &&
        state.neverCachedStreak >= NEVER_CACHED_STREAK_FOR_WARNING &&
        state.neverCachedInputTokens >= NEVER_CACHED_INPUT_TOKENS_FOR_WARNING
      ) {
        state.neverCachedWarned = true;
        logger(
          '[cache-monitor] session is not hitting the provider cache: every sizeable request in the current configuration window reported 0 cache-read tokens. If this provider supports prompt caching, the prompt prefix is likely changing on every request; if not, this session is re-paying full input each turn — see docs/cache-verification.md.',
          {
            sessionID: message.sessionID,
            requestNumber: state.completedRequests,
            consecutiveUncachedRequests: state.neverCachedStreak,
            uncachedInputTokens: state.neverCachedInputTokens,
          },
        );
      }
    }

    // Cache-read plateau (issue #874): reads frozen at the same nonzero
    // boundary while uncached input keeps accumulating — the reusable
    // prefix has stopped growing. Reads changing (any direction) end the
    // streak and re-arm the warning.
    if (message.cacheRead > 0 && message.cacheRead === state.lastCacheRead) {
      state.plateauStreak += 1;
      state.plateauInputTokens += message.inputTokens;
      if (
        !state.plateauWarned &&
        state.plateauStreak >= PLATEAU_STREAK_FOR_WARNING &&
        state.plateauInputTokens >= PLATEAU_INPUT_TOKENS_FOR_WARNING
      ) {
        state.plateauWarned = true;
        logger(
          '[cache-monitor] cache-read plateau: the provider is reusing the same frozen prefix while sizeable uncached input accumulates — the reusable prefix has stopped growing (issue #874 signature). See docs/cache-verification.md.',
          {
            sessionID: message.sessionID,
            requestNumber: state.completedRequests,
            frozenCacheRead: message.cacheRead,
            consecutiveFrozenRequests: state.plateauStreak,
            uncachedInputTokensDuringPlateau: state.plateauInputTokens,
          },
        );
      }
    } else {
      state.plateauStreak = 0;
      state.plateauInputTokens = 0;
      state.plateauWarned = false;
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

        if (
          isRecord(input.event) &&
          input.event.type === 'session.step.started'
        ) {
          observeStepStarted(input.event);
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
