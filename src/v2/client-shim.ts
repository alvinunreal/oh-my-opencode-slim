/**
 * v1 PluginInput shim (real delegation).
 *
 * The v1 plugin factory expects a `PluginInput` with an HTTP `client`,
 * project metadata, and a shell. v2's plugin context exposes none of these,
 * so this shim builds a v1-shaped input whose `client` translates the v1
 * SDK call shapes (Hono-style `{path, body}` or flat `{sessionID}`) into
 * v2 flat session calls (`get`/`remove`/`list`/`interrupt`/`switchModel`/
 * `prompt`/`context`). Delegation is real where the v2 host provides the
 * method and explicitly fails or degrades with a log where it does not —
 * the shim never fakes success shapes.
 *
 * The v2 model-switch semantics (prompts carry no model; `switchModel`
 * must precede the prompt) are encapsulated in the `promptAsync`
 * translation, which is what lets the v1 foreground-fallback pipeline work
 * unmodified on v2. A failed `switchModel` degrades to steering on the
 * current model (logged, `switched: false` on the result) because the
 * prompt delivery is the load-bearing action; a host with NO
 * `switchModel` rejects callers that declare `modelSwitch: 'required'`
 * (foreground-fallback) while pin-callers (orchestrator-wake) keep the
 * logged steer.
 */

import { isRecord } from '../utils/guards';
import {
  INTERNAL_INITIATOR_METADATA_KEY,
  isInternalInitiatorPart,
} from '../utils/internal-initiator';
import { log } from '../utils/logger';
import { joinTextParts } from './session-submit';
import type { V2Context } from './types';

/** v2 model reference accepted by `ctx.generate.text`. */
export interface V2GenerateModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

/** Optional v2 capabilities threaded into the v1 PluginInput. Absent
 * capabilities must leave the input object unchanged (v1 parity). */
export interface ExperimentalV2 {
  /** One-shot generation (`ctx.generate.text`); no session involved. */
  generateText?: (
    prompt: string,
    model?: V2GenerateModelRef,
  ) => Promise<{ text: string }>;
}

/** Directory from the host-reported location; cwd on hosts without
 * `ctx.location` (or with an empty directory). */
export function resolveV2Directory(ctx: V2Context): string {
  const directory = ctx.location?.directory;
  return typeof directory === 'string' && directory ? directory : process.cwd();
}

/** Accept both Hono-style ({path:{id}}) and flat ({sessionID}) calls. */
function sessionIDOf(args: Record<string, unknown>): string {
  return (
    (args?.path as { id?: string } | undefined)?.id ??
    (args?.sessionID as string | undefined) ??
    ''
  );
}

/** Join the text parts of a v1 prompt body into v2 prompt text. */
function textFromBody(args: Record<string, unknown>): string {
  const body = (args?.body ?? {}) as {
    parts?: Array<unknown>;
  };
  const parts = Array.isArray(body.parts) ? body.parts : [];
  return joinTextParts(parts, '\n');
}

/** Map non-text v1 prompt parts (images, files) into v2 prompt `files`
 * entries. The fallback replay must not silently drop attachments: v1's
 * prompt API carries parts natively, so a text-only translation would
 * resend an attachment-dependent request without its content. Parts whose
 * uri cannot be derived are logged and skipped (honest degradation). */
function filesFromBody(
  args: Record<string, unknown>,
): Array<{ uri: string; name?: string }> {
  const body = (args?.body ?? {}) as {
    parts?: Array<Record<string, unknown>>;
  };
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const files: Array<{ uri: string; name?: string }> = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text') continue;
    const uri = [p.uri, p.url].find((v) => typeof v === 'string' && v) as
      | string
      | undefined;
    if (!uri) {
      log('[v2][shim] non-text prompt part without uri dropped', {
        type: typeof p.type === 'string' ? p.type : 'unknown',
      });
      continue;
    }
    const name =
      (p.filename as string | undefined) ?? (p.name as string | undefined);
    files.push({ uri, ...(name ? { name } : {}) });
  }
  return files;
}

/** v2 transcript message (content parts) → v1 SDK message view
 * (`{info: {id, role}, parts}`) expected by the v1 pipeline. */
function toV1Message(m: Record<string, unknown>) {
  return {
    info: { id: m.id, role: m.role ?? m.type },
    parts: Array.isArray(m.content)
      ? (m.content as Array<Record<string, unknown>>).map((p) => ({ ...p }))
      : [],
  };
}

/** v1 body model (`{providerID, modelID}`) → v2 model ref
 * (`{id, providerID}`). */
function modelRefFromBody(body: {
  model?: { id?: string; modelID?: string; providerID?: string };
}): { id: string; providerID: string } | undefined {
  const model = body.model;
  if (!model) return undefined;
  const id = model.id ?? model.modelID ?? '';
  const providerID = model.providerID ?? '';
  return id && providerID ? { id, providerID } : undefined;
}

/**
 * Internal-initiator marker for v2 prompts: the v1 part metadata is lost
 * in the text-only v2 translation, so the marker travels as prompt
 * `metadata` (accepted and propagated by the v2 session.prompt endpoint
 * and its hook). The session-prompt bridge restores it onto the rebuilt
 * v1 parts view so `isInternalInitiatorPart` consumers — notably
 * orchestrator-wake's `observeChatMessage`, which must NOT treat a wake
 * admission as external user activity (the two-wake no-progress cap
 * depends on that) — keep working on v2.
 */
function internalInitiatorMetadataFromBody(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const body = (args?.body ?? {}) as {
    parts?: Array<Record<string, unknown>>;
  };
  const parts = Array.isArray(body.parts) ? body.parts : [];
  return parts.some((part) => isInternalInitiatorPart(part))
    ? { [INTERNAL_INITIATOR_METADATA_KEY]: true }
    : undefined;
}

/**
 * Pure-internal routing gate: ONLY bodies whose every part is an internal
 * initiator may take the session.synthetic admission. Mixed bodies —
 * notably foreground-fallback's replay of the user's real parts with an
 * appended internal reminder — must stay on session.prompt so they remain
 * persisted user input and keep their file attachments (the synthetic
 * branch forwards text only). See the mixed-replay regression test and
 * the greptile P1 review on #1158.
 */
function isPureInternalInitiatorBody(args: Record<string, unknown>): boolean {
  const body = (args?.body ?? {}) as {
    parts?: Array<Record<string, unknown>>;
  };
  const parts = Array.isArray(body.parts) ? body.parts : [];
  return (
    parts.length > 0 && parts.every((part) => isInternalInitiatorPart(part))
  );
}

/**
 * Map one v2 `Session.Info` to the v1 list shape the shim's consumers
 * read (interview dashboard directory discovery: `directory`,
 * `time.updated`; identity fields for any future consumer). Only fields
 * with the right type are copied — nothing is fabricated (no invented
 * `version`/`title` defaults).
 */
function toV1SessionInfo(
  info: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof info.id === 'string') out.id = info.id;
  if (typeof info.parentID === 'string') out.parentID = info.parentID;
  if (typeof info.projectID === 'string') out.projectID = info.projectID;
  if (typeof info.title === 'string') out.title = info.title;
  if (typeof info.agent === 'string') out.agent = info.agent;
  // v2 Session.Info.outcome appears only on terminal transition
  // (succeeded|failed|interrupted); orchestrator-wake's children-driven
  // mode reads it as the terminal signal.
  if (typeof info.outcome === 'string') out.outcome = info.outcome;
  if (isRecord(info.model)) out.model = info.model;
  if (isRecord(info.metadata)) out.metadata = info.metadata;
  // v2 carries the directory on `location` (Location.Ref); v1 had it flat.
  if (isRecord(info.location)) {
    if (typeof info.location.directory === 'string') {
      out.directory = info.location.directory;
    }
  }
  if (typeof info.directory === 'string') out.directory = info.directory;
  if (isRecord(info.time)) {
    const time: Record<string, unknown> = {};
    if (typeof info.time.created === 'number') time.created = info.time.created;
    if (typeof info.time.updated === 'number') time.updated = info.time.updated;
    if (typeof info.time.idle === 'number') time.idle = info.time.idle;
    if (Object.keys(time).length > 0) out.time = time;
  }
  return out;
}

/**
 * v1 `client.session.list` over v2 `session.list`. Accepts the v1
 * `{query}` call shape (or a flat query object); passes through the
 * filters shim callers use — `directory` and the `parentID` filter
 * (session id or root-only: the literal `"null"` string, with a real
 * `null` normalized to it) — and wraps the mapped page in the v1
 * `{data}` envelope. Hosts without `session.list` keep the v1-parity
 * empty page (honest absence, not a fake success).
 */
export function createSessionListShim(
  s: V2Context['session'],
): (args: Record<string, unknown>) => Promise<{ data: unknown[] }> {
  return async (args) => {
    if (typeof s.list !== 'function') return { data: [] };
    const query = ((args?.query as Record<string, unknown> | undefined) ??
      (args as Record<string, unknown> | undefined) ??
      {}) as Record<string, unknown>;
    const input: Record<string, unknown> = {};
    if (typeof query.directory === 'string' && query.directory) {
      input.directory = query.directory;
    }
    if (query.parentID === null) {
      input.parentID = 'null'; // root-only sentinel on the wire
    } else if (typeof query.parentID === 'string' && query.parentID !== '') {
      input.parentID = query.parentID;
    }
    const output = (await s.list(input)) as
      | { data?: unknown }
      | Array<Record<string, unknown>>
      | undefined;
    const infos = Array.isArray(output)
      ? output
      : isRecord(output) && Array.isArray(output.data)
        ? (output.data as Array<Record<string, unknown>>)
        : [];
    return { data: infos.filter(isRecord).map(toV1SessionInfo) };
  };
}

/** Build a v1-compatible PluginInput from the v2 context. The optional
 * `extras` threads probed v2 capabilities (e.g. one-shot generation)
 * through as `experimental_v2`; when absent no `experimental_v2` key is
 * added so the v1 pipeline stays byte-identical. */
export function buildPluginInput(
  ctx: V2Context,
  extras?: ExperimentalV2,
): Record<string, unknown> {
  // Null-safe: reduced hosts may load the factory without a session domain;
  // every method then degrades honestly instead of crashing construction.
  const s = (ctx.session ?? {}) as V2Context['session'];
  const client = {
    session: {
      // `get` is exposed only when the host provides session.get — callers
      // like task-result probe method presence as the capability signal,
      // so a degraded stub here would fake verification ability.
      ...(s.get
        ? {
            get: async (args: Record<string, unknown>) => ({
              data: await s.get?.({ sessionID: sessionIDOf(args) }),
            }),
          }
        : {}),
      abort: s.interrupt
        ? async (args: Record<string, unknown>) =>
            s.interrupt?.({ sessionID: sessionIDOf(args), continue: false })
        : async (args: Record<string, unknown>) => {
            log('[v2][shim] session.interrupt unavailable', {
              id: sessionIDOf(args),
            });
          },
      messages: s.context
        ? async (args: Record<string, unknown>) => ({
            data: (
              (await s.context?.({ sessionID: sessionIDOf(args) })) ?? []
            ).map(toV1Message),
          })
        : async (args: Record<string, unknown>) => {
            log('[v2][shim] session.context unavailable', {
              id: sessionIDOf(args),
            });
            return { data: [] };
          },
      // `status` is intentionally OMITTED: v2 has no equivalent of the v1
      // live session-status map, and a stub returning `{data: {}}` would be
      // an empty-but-valid map. getRuntimeSessionStatusSnapshot treats
      // "status is a function" as the capability signal, so the stub let
      // stop-confirmation mark still-running background jobs `stopped`
      // after the grace (false terminalization). With the method absent,
      // the lookup throws → snapshot.error → the reconciler's safe
      // markStatusUncertain branch.
      list: createSessionListShim(s),
      prompt: s.prompt
        ? async (args: Record<string, unknown>) => {
            const files = filesFromBody(args);
            return s.prompt?.({
              sessionID: sessionIDOf(args),
              text: textFromBody(args),
              delivery: 'steer',
              ...(files.length > 0 ? { files } : {}),
            });
          }
        : async () => {
            throw new Error('[v2] session.prompt unavailable');
          },
      // v1 prompt_async QUEUED its prompt. The optional `delivery` argument
      // lets callers preserve that on v2 ('queue' — orchestrator-wake);
      // the default stays 'steer' because the foreground-fallback replay
      // must steer an in-flight run. The optional `modelSwitch` argument
      // declares caller intent for the body model: 'required'
      // (foreground-fallback — the model is the fallback TARGET, so a host
      // without session.switchModel must fail loudly instead of silently
      // replaying on the model that just failed); default callers pass the
      // session's CURRENT model as a pin (orchestrator-wake) and keep the
      // honest degrade-with-log steer.
      promptAsync: async (
        args: Record<string, unknown> & {
          delivery?: 'steer' | 'queue';
          modelSwitch?: 'required';
        },
      ) => {
        const delivery = args?.delivery === 'queue' ? 'queue' : 'steer';
        const body = (args?.body ?? {}) as Parameters<
          typeof modelRefFromBody
        >[0] & { parts?: Array<{ type?: string; text?: string }> };
        const metadata = internalInitiatorMetadataFromBody(args);
        // Internal-initiator injections (orchestrator-wake nudges, interview
        // continuation) must not be persisted as user input on v2: the flat
        // session.prompt translation drops the v1 part-level `synthetic`
        // flag, which regressed them into visible user bubbles. v2's
        // dedicated session.synthetic admission keeps the text model-visible
        // while skipping user-message persistence, and its default `resume`
        // preserves the wake semantics. ONLY purely-internal bodies take
        // this route — mixed bodies (foreground-fallback's user-parts +
        // internal reminder replay) must stay on session.prompt to preserve
        // user-input persistence and file attachments. Hosts without
        // session.synthetic keep the pre-fix prompt path (visible wake,
        // metadata intact).
        const internalViaSynthetic =
          isPureInternalInitiatorBody(args) &&
          typeof s.synthetic === 'function';
        if (!s.prompt && !internalViaSynthetic) {
          throw new Error('[v2] session.prompt unavailable for promptAsync');
        }
        if (metadata !== undefined && !internalViaSynthetic) {
          log(
            '[v2][shim] session.synthetic unavailable; internal wake admitted as a visible prompt',
            { id: sessionIDOf(args) },
          );
        }
        const ref = modelRefFromBody(body);
        let switched = false;
        if (ref) {
          if (s.switchModel) {
            // The prompt delivery is the load-bearing action: a failed
            // model switch degrades to steering on the CURRENT model
            // (logged here; `switched: false` on the result) instead of
            // aborting the caller's fallback chain (upstream #1125).
            try {
              await s.switchModel({ sessionID: sessionIDOf(args), model: ref });
              switched = true;
            } catch (err) {
              log('[v2][shim] session.switchModel failed', {
                id: sessionIDOf(args),
                model: ref,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          } else if (args?.modelSwitch === 'required') {
            const switchErr = new Error(
              '[v2] host provides no session.switchModel; cannot switch model for fallback prompt',
            );
            switchErr.name = 'V2SwitchModelUnavailableError';
            throw switchErr;
          } else {
            log(
              '[v2][shim] session.switchModel unavailable; steering on the current model',
              { id: sessionIDOf(args) },
            );
          }
        }
        if (internalViaSynthetic) {
          const result = await s.synthetic?.({
            sessionID: sessionIDOf(args),
            text: textFromBody(args),
            description: 'oh-my-opencode-slim internal initiator',
            ...(metadata ? { metadata } : {}),
            delivery,
            resume: true,
          });
          // `switched` reports whether the requested model switch was
          // CONFIRMED — same contract as the prompt path below.
          return isRecord(result) ? { ...result, switched } : { switched };
        }
        const files = filesFromBody(args);
        // Reachable only when s.prompt exists (the guard above throws
        // otherwise and internalViaSynthetic returned early).
        const result = await s.prompt?.({
          sessionID: sessionIDOf(args),
          text: textFromBody(args),
          delivery,
          ...(files.length > 0 ? { files } : {}),
          ...(metadata ? { metadata } : {}),
        });
        // `switched` reports whether the requested model switch was
        // CONFIRMED, letting callers gate model-switch bookkeeping on the
        // truth (foreground-fallback's "switched to fallback model"
        // claim). Additive over the v2 ack record; callers that ignore
        // the result are unaffected.
        return isRecord(result) ? { ...result, switched } : { switched };
      },
      update: s.rename
        ? async (args: Record<string, unknown>) => {
            const body = (args?.body ?? {}) as { title?: string };
            return s.rename?.({
              sessionID: sessionIDOf(args),
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
            });
          }
        : async (args: Record<string, unknown>) => {
            log('[v2][shim] session.rename unavailable', {
              id: sessionIDOf(args),
            });
          },
      // v2 removed the delete endpoint in name only: `session.remove` is
      // the same DELETE /api/session/:id. Capability-probed like `get`
      // above — smartfetch's secondary-model cleanup (the real caller)
      // relies on this to not leak temp sessions on v2. Hosts without
      // `remove` degrade with the honest log below (no fake success).
      delete: s.remove
        ? async (args: Record<string, unknown>) => {
            await s.remove?.({ sessionID: sessionIDOf(args) });
          }
        : async (args: Record<string, unknown>) => {
            log('[v2][shim] session.remove unavailable; delete is a no-op', {
              id: sessionIDOf(args),
            });
          },
    },
    app: {
      log: async (args?: Record<string, unknown>) => {
        const body = (args?.body ?? args) as
          | { level?: string; message?: string }
          | undefined;
        const level = body?.level ?? 'info';
        log(`[v2][host-log] ${level}: ${body?.message ?? ''}`);
      },
    },
    tui: {
      showToast: async (args?: Record<string, unknown>) => {
        const body = (args?.body ?? args) as { message?: string } | undefined;
        log('[v2][shim] tui.showToast (no-op on v2)', {
          message: body?.message,
        });
      },
    },
    // Misc methods the plugin may touch; all graceful no-ops.
    model: { list: async () => ({ data: [] }) },
    provider: { list: async () => ({ data: [] }) },
  };

  const directory = resolveV2Directory(ctx);
  return {
    client,
    hostFlavor: 'v2',
    project: {
      id: ctx.location?.project?.id ?? 'global',
      directory,
    },
    directory,
    worktree: directory,
    experimental_workspace: { register() {} },
    $: typeof Bun !== 'undefined' ? Bun.$ : undefined,
    ...(extras?.generateText
      ? { experimental_v2: { generateText: extras.generateText } }
      : {}),
  };
}
