/**
 * v2 → v1 event mapper for the v2 event pump.
 *
 * v2 renamed/re-shaped several server events the v1 hooks depend on:
 * - `session.idle` is gone (`session.status` with `status.type: 'idle'`);
 * - `session.created` carries flat `{sessionID, parentID?}` instead of
 *   v1's `properties.info` object;
 * - token/cache telemetry moved to `session.usage.updated` /
 *   `session.step.ended` (v2 has no `message.updated`).
 *
 * Payload key: live v2 hosts deliver the event payload under `data`
 * (`{id, created, type, location?, durable?, data}` — the wire/plugin
 * `OpenCodeEvent` shape, verified live on beta-19365); the `properties`
 * spelling is accepted as a legacy/test fallback. The v1 consumers the
 * synthesized shapes target all read `properties`, so every synthesized
 * event below writes `properties` regardless of the source key.
 *
 * `mapV2EventToV1` is additive synthesis only: the first element of the
 * returned array is ALWAYS the raw input event, unmodified (byte-identical
 * reference), so v2-native handlers (interview bridge) and any v1 handler
 * already tolerant of the v2 shape keep seeing it. Synthesized v1-shape
 * events are appended after it.
 *
 * Lifecycle note: newer v2 hosts (verified live on beta-19365/beta-19378)
 * publish durable `session.execution.started/succeeded/failed/interrupted`
 * events and no longer stream busy/idle `session.status` on the SSE event
 * flow (`session.status` remains only in the schema). The execution events
 * are synthesized into the v1 lifecycle shapes below; the idle
 * `session.status` → `session.idle` path is retained for older hosts, and
 * hosts emitting both simply deliver idle more than once — tolerated by
 * the documented double-idle invariant.
 *
 * The synthesized shapes are pinned to what the v1 consumers actually read:
 * - `session.created` early registration (task-session-manager
 *   event-router): `properties.info.{id,parentID,agent?}` — plugin
 *   relevance is gated on `info.parentID` (child sessions only).
 * - `message.updated` telemetry (cache-monitor
 *   parseCompletedAssistantMessage): `properties.info.{role:'assistant',
 *   sessionID, id, time.completed, tokens.input, tokens.cache.read,
 *   tokens.cache.write}`.
 * - `question.asked/replied/rejected` (companionManager,
 *   task-session-manager input-wait tracker, orchestrator-wake): the v1
 *   QuestionV1 shapes `{id, sessionID, questions}` /
 *   `{sessionID, requestID, answers}` / `{sessionID, requestID}`,
 *   synthesized from the v2 Form flow (form.created/replied/cancelled).
 *   Forms owned by the `"global"` sentinel session stay unsynthesized.
 * - `permission.asked` field mapping (same consumers): v1 names
 *   `{id, sessionID, permission, patterns, metadata, always}` ← v2
 *   `{id, sessionID, action, resources, metadata?, save?}`.
 *   `permission.replied` passes through raw — v2's shape already matches
 *   the v1 event.
 */

import { isRecord } from '../utils/guards';

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Resolve the v2 event payload: live hosts carry it under `data` (the
 * `OpenCodeEvent` wire shape); `properties` is the legacy/test spelling.
 */
function payloadOf(event: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(event.data)) return event.data;
  if (isRecord(event.properties)) return event.properties;
  return {};
}

/**
 * v2 usage telemetry (`session.usage.updated` / `session.step.ended`)
 * → v1 completed-assistant `message.updated`.
 *
 * The documented v2 event carries no message identity, so `info.id` is a
 * deterministic fingerprint of the telemetry content: the
 * step.ended/usage.updated pair for one request dedups to a single
 * observation (cache-monitor dedups by message id), replays are stable,
 * and genuinely distinct token snapshots stay distinct. No wall-clock or
 * randomness — only fields already on the event.
 */
function usageToMessageUpdated(
  props: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const sessionID = props.sessionID;
  if (typeof sessionID !== 'string') return undefined;
  const tokens = isRecord(props.tokens) ? props.tokens : undefined;
  if (!tokens) return undefined;
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const input = finiteNumber(tokens.input);
  const cacheRead = finiteNumber(cache?.read);
  const cacheWrite = finiteNumber(cache?.write);
  // Fail-open like the consumer: incomplete token blocks are dropped,
  // never mapped into a half-readable shape.
  if (
    input === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const output = finiteNumber(tokens.output) ?? 0;
  const reasoning = finiteNumber(tokens.reasoning) ?? 0;
  const id = `v2-usage:${sessionID}:${input}:${output}:${cacheRead}:${cacheWrite}`;
  // cache-monitor only requires a non-null completed marker; prefer a
  // real timestamp from the event when the host provides one.
  const completedAt =
    finiteNumber(props.timestamp) ?? finiteNumber(props.activityAt) ?? 0;
  return {
    type: 'message.updated',
    properties: {
      info: {
        id,
        role: 'assistant',
        sessionID,
        time: { completed: completedAt },
        tokens: {
          input,
          output,
          reasoning,
          cache: { read: cacheRead, write: cacheWrite },
        },
      },
    },
  };
}

/**
 * v2 Form field → v1 QuestionV1.Info (`{question, header, options,
 * multiple?}`). Only fields with a usable title/key survive; option
 * labels/descriptions pass through with v1's required-string shape.
 */
function formFieldToQuestion(
  field: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const title =
    typeof field.title === 'string' && field.title
      ? field.title
      : typeof field.key === 'string' && field.key
        ? field.key
        : undefined;
  if (!title) return undefined;
  const options = Array.isArray(field.options)
    ? field.options.filter(isRecord).map((option) => ({
        label: typeof option.label === 'string' ? option.label : '',
        description:
          typeof option.description === 'string' ? option.description : '',
      }))
    : [];
  const question: Record<string, unknown> = {
    question: title,
    // v1 QuestionV1 caps the header at 30 chars.
    header: title.slice(0, 30),
    options,
  };
  if (field.type === 'multiselect') question.multiple = true;
  return question;
}

/** v1 QuestionV1 answers are `string[][]` (selected labels per question,
 * in question order); map the v2 `Record<key, Value>` preserving the
 * record's insertion order. */
function formAnswerToV1Answers(answer: unknown): Array<Array<string>> {
  if (!isRecord(answer)) return [];
  return Object.values(answer).map((value) =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [String(value)],
  );
}

/**
 * v2 `form.created` → v1 `question.asked`. v2 replaced the v1
 * question.* events with the Form flow; the v1 consumers
 * (companionManager, task-session-manager input-wait tracker,
 * orchestrator-wake) key on `{id, sessionID}` for asks and
 * `{sessionID, requestID}` for resolutions — the shapes below follow the
 * v1 QuestionV1 event schema so the full contract stays intact.
 *
 * Forms owned by the `"global"` sentinel (MCP elicitation) are skipped:
 * v1 question.* are session-scoped, and the tracker gates on
 * `shouldManageSession(sessionID)` (a real orchestrator session).
 */
function formCreatedToQuestionAsked(
  props: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const form = isRecord(props.form) ? props.form : undefined;
  if (!form) return undefined;
  const id = typeof form.id === 'string' ? form.id : undefined;
  const sessionID =
    typeof form.sessionID === 'string' ? form.sessionID : undefined;
  if (!id || !sessionID || sessionID === 'global') return undefined;
  const questions = Array.isArray(form.fields)
    ? form.fields
        .filter(isRecord)
        .map(formFieldToQuestion)
        .filter((q): q is Record<string, unknown> => q !== undefined)
    : [];
  return {
    type: 'question.asked',
    properties: { id, sessionID, questions },
  };
}

/**
 * v2 `permission.asked` → v1 field names. The repo consumers read
 * `{id, sessionID}` (input-wait tracker requestID, wake-scheduler
 * suppress) — both already present on the raw v2 event, which stays
 * first in the output. The synthesized copy restores the v1
 * PermissionV1 names (`permission` ← `action`, `patterns` ←
 * `resources`, `always` ← `save`) so shape-sensitive v1 consumers keep
 * working. Duplicate ask delivery (raw + synthesized, same `id`) is safe:
 * every ask consumer is idempotent per request id (Set-based tracker,
 * status setters, timer suppression) — same invariant as the double-idle
 * note below.
 */
function permissionAskedToV1(
  props: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const id = props.id;
  const sessionID = props.sessionID;
  if (typeof id !== 'string' || typeof sessionID !== 'string') {
    return undefined;
  }
  return {
    type: 'permission.asked',
    properties: {
      id,
      sessionID,
      permission: typeof props.action === 'string' ? props.action : '',
      patterns: Array.isArray(props.resources)
        ? props.resources.filter(
            (resource): resource is string => typeof resource === 'string',
          )
        : [],
      metadata: isRecord(props.metadata) ? props.metadata : {},
      always: Array.isArray(props.save)
        ? props.save.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [],
    },
  };
}

/**
 * Map one v2 server event into zero or more v1-shape events.
 *
 * Returns `[rawEvent, ...synthesizedV1Shapes]` — the raw event is always
 * first and never mutated. Synthesis:
 * - idle `session.status` → v1 `session.idle` `{sessionID}`;
 * - `session.execution.*` (newer hosts; verified live beta-19365/19378)
 *   → the v1 lifecycle shapes: `started` → `session.status`
 *   `{status:{type:'busy'}}`; `succeeded`/`interrupted` → `session.status`
 *   idle + `session.idle`; `failed` → a v1 `session.error` (host error
 *   payload passed through best-effort) followed by the same idle pair —
 *   error-before-idle preserves the error-then-idle flow the
 *   task-session-manager event-router expects (deferred inline errors
 *   are terminalized by the following idle);
 * - child `session.created` (parentID present) → v1 early-registration
 *   shape `{info: {id, parentID, title?, agent?}}`;
 * - usage telemetry → v1 completed-assistant `message.updated`;
 * - `form.created/replied/cancelled` → v1 `question.asked/replied/
 *   rejected` (QuestionV1 shapes; "global"-owned forms skipped);
 * - `permission.asked` → v1 field names (permission ← action, patterns ←
 *   resources). `permission.replied` needs no mapping (shapes match).
 *
 * `interviewBridge.handleEvent` keeps receiving the RAW v2 event (the
 * setup pump dispatches it before iterating this array).
 */
export function mapV2EventToV1(
  event: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [event];
  const type = typeof event.type === 'string' ? event.type : '';
  const props = payloadOf(event);

  if (type === 'session.status') {
    const statusType = isRecord(props.status)
      ? typeof props.status.type === 'string'
        ? props.status.type
        : undefined
      : undefined;
    if (statusType === 'idle' && typeof props.sessionID === 'string') {
      // Double-idle invariant: on v2 an idle-tolerant consumer that watches
      // BOTH the native `session.status` event and the synthesized
      // `session.idle` receives idle twice per session. Safe today because
      // every idle consumer is idempotent per session — idle-reconciliation
      // guards repeats via its per-session timer maps
      // (`idleReconcileTimers.has` / `childIdleReconcileTimers.has`,
      // idle-reconciliation.ts:42,64). Any NEW idle consumer must tolerate
      // duplicate idle delivery.
      out.push({
        type: 'session.idle',
        properties: { sessionID: props.sessionID },
      });
    }
  } else if (
    type === 'session.execution.started' ||
    type === 'session.execution.succeeded' ||
    type === 'session.execution.failed' ||
    type === 'session.execution.interrupted'
  ) {
    // Newer v2 hosts publish durable `session.execution.*` and no longer
    // stream busy/idle `session.status` (verified live beta-19365/19378).
    // Synthesize the v1 lifecycle shapes the wake scheduler, the
    // task-session-manager, and the foreground fallback key on. The
    // `session.status` path above still covers older hosts; a host
    // emitting both delivers idle repeatedly, which the documented
    // double-idle invariant already tolerates. Only the four verified
    // subtypes map — unknown `session.execution.*` variants stay
    // passthrough-only rather than guessing a lifecycle meaning.
    if (typeof props.sessionID === 'string') {
      const sessionID = props.sessionID;
      if (type === 'session.execution.started') {
        out.push({
          type: 'session.status',
          properties: { sessionID, status: { type: 'busy' } },
        });
      } else {
        if (type === 'session.execution.failed') {
          // The v1 `session.error` consumers classify the payload
          // themselves (foreground-fallback `isFailoverError`,
          // event-router failover deferral), so the host's error field
          // passes through verbatim; a missing error degrades to a
          // best-effort message that classifies as non-failover. Emitted
          // BEFORE the idle pair so the error-then-idle ordering the
          // event-router expects is preserved on the synthesized stream.
          out.push({
            type: 'session.error',
            properties: {
              sessionID,
              error:
                props.error !== undefined
                  ? props.error
                  : { message: 'v2 session execution failed' },
            },
          });
        }
        // succeeded / interrupted / failed all terminate the run. Idle
        // (not error/retry) is the correct terminal state for wake
        // arming: `beginContinuousIdle` is idempotent per session, so
        // the synthesized status+idle pair arming twice matches the
        // double-idle invariant.
        out.push({
          type: 'session.status',
          properties: { sessionID, status: { type: 'idle' } },
        });
        out.push({
          type: 'session.idle',
          properties: { sessionID },
        });
      }
    }
  } else if (type === 'session.created') {
    // Only child sessions are plugin-relevant: event-router gates early
    // board registration on `info.parentID` + shouldManageSession(parent).
    // Root sessions pass through untouched — no invented fields.
    if (
      typeof props.sessionID === 'string' &&
      typeof props.parentID === 'string'
    ) {
      const info: Record<string, unknown> = {
        id: props.sessionID,
        parentID: props.parentID,
      };
      if (typeof props.title === 'string') info.title = props.title;
      // event-router matches parallel task calls by child agent; pass the
      // host-provided value through when present, never fabricate one.
      if (typeof props.agent === 'string') info.agent = props.agent;
      out.push({ type: 'session.created', properties: { info } });
    }
  } else if (
    type === 'session.usage.updated' ||
    type === 'session.step.ended'
  ) {
    const mapped = usageToMessageUpdated(props);
    if (mapped) out.push(mapped);
  } else if (type === 'form.created') {
    const mapped = formCreatedToQuestionAsked(props);
    if (mapped) out.push(mapped);
  } else if (type === 'form.replied') {
    // {id, sessionID, answer} → v1 question.replied {sessionID, requestID,
    // answers}. Consumers read sessionID + requestID.
    if (
      typeof props.id === 'string' &&
      typeof props.sessionID === 'string' &&
      props.sessionID !== 'global'
    ) {
      out.push({
        type: 'question.replied',
        properties: {
          sessionID: props.sessionID,
          requestID: props.id,
          answers: formAnswerToV1Answers(props.answer),
        },
      });
    }
  } else if (type === 'form.cancelled') {
    if (
      typeof props.id === 'string' &&
      typeof props.sessionID === 'string' &&
      props.sessionID !== 'global'
    ) {
      out.push({
        type: 'question.rejected',
        properties: { sessionID: props.sessionID, requestID: props.id },
      });
    }
  } else if (type === 'permission.asked') {
    const mapped = permissionAskedToV1(props);
    if (mapped) out.push(mapped);
  }
  // `permission.replied` needs no synthesis: v2's shape
  // {sessionID, requestID, reply} IS the v1 PermissionV1 event shape, and
  // the raw event is always dispatched first above.

  return out;
}
