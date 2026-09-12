/**
 * v2 setup orchestration.
 *
 * Returns the `setup(ctx)` function v2 calls via `default.setup`. The setup
 * wraps the existing v1 factory (reusing ALL build logic) and translates the
 * returned v1 `Hooks` into v2 registrations: agent/tool/command transforms,
 * a single session context hook (system/messages transforms, chat.message
 * tracking, and interview + generic command marker dispatch), the native
 * `session.prompt` hook (once-per-admission chat.message fidelity, with a
 * context-hook fallback on older hosts), tool execute hooks, and the event
 * stream. Each bridge is independently try/catch-guarded.
 */

import { loadPluginConfig } from '../config/loader';
import { InterviewConfigSchema } from '../config/schema';
import {
  runWithSyntheticPartCacheHintScope,
  type SyntheticPartCacheHint,
  setDefaultSyntheticPartCacheHint,
} from '../hooks/cache-safe-injection';
import { OhMyOpenCodeLite } from '../index';
import type { McpConfig } from '../mcp/types';
import { INTERNAL_INITIATOR_METADATA_KEY } from '../utils/internal-initiator';
import { initLogger, log } from '../utils/logger';
import { adaptTool, applyAgentToDraft } from './adapters';
import { buildPluginInput, resolveV2Directory } from './client-shim';
import { createCommandMarkerKit } from './command-marker';
import { subagentArgsToV1, toolNameToV1, v1ArgsToSubagent } from './delegation';
import { mapV2EventToV1 } from './event-adapter';
import { createV2InterviewBridge } from './interview-bridge';
import {
  createSessionSubmit,
  textFromContent,
  type V2CommandSubmit,
} from './session-submit';
import type {
  V2Cleanup,
  V2CommandDefinition,
  V2CommandDraft,
  V2Context,
  V2SessionContextEvent,
  V2SessionPromptEvent,
  V2ToolAfterEvent,
  V2ToolBeforeEvent,
} from './types';

/** v1 `command.execute.before` hook shape (see src/index.ts wiring). */
export type V1CommandBeforeHook = (
  input: { command: string; sessionID: string; arguments: string },
  output: {
    parts: Array<{
      type: string;
      text?: string;
      synthetic?: boolean;
      metadata?: Record<string, unknown>;
    }>;
  },
) => Promise<void>;

/** v1 command hook part shape. */
type V1CommandPart = {
  type: string;
  text?: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
};

/** Generic v2 command marker kit (deepwork / reflect / loop) — shared,
 * byte-stable marker machinery; see ./command-marker.ts. Exported for
 * tests: command-marker.test.ts pins the configured pattern bytes
 * against config drift. */
export const COMMAND_MARKER = createCommandMarkerKit({
  tag: 'omos-cmd-command',
  nameAttribute: 'data-name',
  namePattern: '[\\w.-]+',
});

/** Wrap slash-command arguments in the generic v2 command marker. v2 command
 * drafts are add-only (no `template`), so `execute` submits this marker as a
 * plain user prompt and the session context hook recovers it below. */
export function wrapCommandMarker(name: string, args: string): string {
  return COMMAND_MARKER.wrap({ name, args });
}

export interface ParsedCommandMarker {
  name: string;
  args: string;
}

/** Parse the generic command marker from a message text, if present. */
export function parseCommandMarker(
  text: string,
): ParsedCommandMarker | undefined {
  const parsed = COMMAND_MARKER.parse(text);
  // The pattern requires the name attribute, so a match always carries one;
  // the narrowing only satisfies the shared kit's optional-name type.
  return parsed?.name === undefined
    ? undefined
    : { name: parsed.name, args: parsed.args };
}

/** Strip the marker tags from marker-only `text`, leaving the raw args. */
export function stripCommandMarker(text: string): string {
  return COMMAND_MARKER.strip(text);
}

/** Register one v1 synth command on a v2 command draft. Uses `add` when
 * present; callers wrap per-command in try/catch so a throwing `draft.add`
 * only skips that command. */
export function createCommandRegistration(
  draft: V2CommandDraft,
  name: string,
  cmd: { description?: string },
  submit: V2CommandSubmit,
): void {
  if (typeof draft.add !== 'function') {
    log('[v2] command draft has no add', { name });
    return;
  }
  const definition: V2CommandDefinition = {
    name,
    ...(typeof cmd.description === 'string'
      ? { description: cmd.description }
      : {}),
    execute: async (invocation) => {
      // Never throw: v2 surfaces command execution errors to the user.
      try {
        await submit(
          invocation?.sessionID ?? '',
          wrapCommandMarker(name, invocation?.prompt?.text ?? ''),
        );
      } catch (err) {
        log('[v2] command submit failed', { name, err: String(err) });
      }
    },
  };
  draft.add(definition);
}

/** Register the v1 synth commands on a v2 command draft. `interview` is
 * owned by the interview bridge's own registration (whose context hook owns
 * the interview marker), so it is skipped here — a duplicate `draft.add`
 * would break `/interview` on host builds that are first-wins or throw on
 * duplicates. */
export function registerSynthCommands(
  draft: V2CommandDraft,
  entries: Array<[string, { description?: string }]>,
  submit: V2CommandSubmit,
): void {
  for (const [name, cmd] of entries) {
    if (name === 'interview') continue; // owned by the interview bridge registration below
    try {
      createCommandRegistration(draft, name, cmd, submit);
    } catch (err) {
      log('[v2] command adapt failed', { name, err: String(err) });
    }
  }
}

/** Dispatch a generic command marker found in the trailing user message to
 * the v1 `command.execute.before` hook, then replace that message's content
 * with the hook-produced parts. Mirrors the interview bridge mutation
 * semantics: only the trailing message is touched so earlier messages stay
 * byte-for-byte identical (provider prompt-cache prefix reuse). */
export async function applyCommandMarkerToContext(
  event: V2SessionContextEvent,
  commandBefore: V1CommandBeforeHook,
): Promise<void> {
  const trailing = event.messages.at(-1);
  if (trailing?.role !== 'user') return;
  const text = textFromContent(trailing.content);
  const parsed = parseCommandMarker(text);
  if (!parsed) return;

  const output = { parts: [] as V1CommandPart[] };
  await commandBefore(
    {
      command: parsed.name,
      sessionID: event.sessionID,
      arguments: parsed.args.trim(),
    },
    output,
  );

  if (output.parts.length > 0) {
    trailing.content = output.parts.map((part) => ({ ...part }));
    return;
  }
  // Hook produced nothing: strip the marker and leave the raw args text.
  trailing.content = [{ type: 'text', text: stripCommandMarker(text) }];
}

/** Payload the v1 `chat.message` bridge feeds its consumers (a subset of
 * the real v1 hook input — see src/index.ts wiring). */
export type V1ChatMessageInput = {
  sessionID: string;
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  messageID?: string;
  parts?: unknown[];
};

/** Deps injected into the single session context hook. */
export interface V2SessionContextHandlerDeps {
  /** Interview bridge handleContext (transcript projection + /interview
   * marker dispatch). */
  interviewHandleContext: (event: V2SessionContextEvent) => Promise<void>;
  /** v1 `command.execute.before` hook (generic command marker dispatch). */
  commandBefore?: V1CommandBeforeHook;
  /** v1 `chat.message` hook (per-request context emulation). Omitted when
   * the native v2 `session.prompt` hook owns message-scoped delivery. */
  chatMessage?: (input: V1ChatMessageInput, output: unknown) => Promise<void>;
  /** Native prompt-hook mode: records per-session agent/model from
   * context events and forwards newly learned state to the v1
   * `chat.message` hook (see createSessionPromptBridge). */
  observeContextAgent?: (event: V2SessionContextEvent) => Promise<void>;
  /** Agent known for a session, from the agent-learned state the
   * session-prompt bridge / context events maintain. Used to enrich
   * transcript user messages the v1 injection gates key on when the
   * context event itself carries no agent. */
  knownAgentForSession?: (sessionID: string) => string | undefined;
  /** v1 `experimental.chat.system.transform` hook. */
  systemTransform?: (
    input: unknown,
    output: { system: string[] },
  ) => Promise<void>;
  /** v1 `experimental.chat.messages.transform` hook. */
  messagesTransform?: (
    input: unknown,
    output: {
      messages: Array<{ info: { role: string }; parts: unknown[] }>;
    },
  ) => Promise<void>;
  /** CacheHint stamped on parts injected while the bridged messages
   * transform runs (v2 ContentPart.cache; v1 bytes never change — see
   * cache-safe-injection). */
  syntheticPartCacheHint?: SyntheticPartCacheHint;
}

/** Build the single `ctx.session.hook("context")` handler: interview marker
 * bridge, generic command marker dispatch, chat.message agent tracking, and
 * the v1 system/messages transforms — each independently try/catch-guarded. */
export function createSessionContextHandler(
  deps: V2SessionContextHandlerDeps,
): (event: V2SessionContextEvent) => Promise<void> {
  return async (event) => {
    // Interview marker bridge (transcript projection + /interview).
    try {
      await deps.interviewHandleContext(event);
    } catch (err) {
      log('[v2] interview context bridge failed', String(err));
    }
    // Generic command marker dispatch (deepwork / reflect / loop).
    if (deps.commandBefore) {
      try {
        await applyCommandMarkerToContext(event, deps.commandBefore);
      } catch (err) {
        log('[v2] command context bridge failed', String(err));
      }
    }
    // Agent/model discovery (native prompt-hook mode): the prompt hook
    // fires before the first context event, so first-admission agent/model
    // must be discovered here and forwarded to the v1 chat.message hook
    // (once per newly learned state, not per request).
    if (deps.observeContextAgent) {
      try {
        await deps.observeContextAgent(event);
      } catch (err) {
        log('[v2] chat.message agent-discovery bridge failed', String(err));
      }
    }
    // Agent tracking (chat.message equivalent, per-request emulation —
    // only when the native prompt hook did NOT take over).
    if (deps.chatMessage) {
      try {
        const userMessage = [...event.messages]
          .reverse()
          .find((message) => message.role === 'user');
        await deps.chatMessage(
          {
            sessionID: event.sessionID,
            agent: event.agent,
            ...(userMessage?.id ? { messageID: userMessage.id } : {}),
          },
          undefined,
        );
      } catch (err) {
        log('[v2] chat.message bridge failed', String(err));
      }
    }
    // System transform: v2 SystemPart[] -> v1 string[] -> mutate -> back.
    if (deps.systemTransform && Array.isArray(event.system)) {
      try {
        const sysStrings = event.system.map((s) => s.text ?? '');
        await deps.systemTransform(
          { sessionID: event.sessionID },
          { system: sysStrings },
        );
        event.system = sysStrings.map((text) => ({
          type: 'text' as const,
          text,
        }));
      } catch (err) {
        log('[v2] system transform bridge failed', String(err));
      }
    }
    // Messages transform: v2 Message.content -> v1 {info, parts} -> back.
    // Pass the full v2 message as `info` (preserves id/metadata identity;
    // isMessageWithParts only needs info.role + parts) with content as
    // `parts` (shared ref so in-place part edits propagate). The transform
    // can splice/reorder/replace the array (background-job-board
    // injection does), so rebuild event.messages from the transformed
    // v1messages rather than index-based content copy-back.
    if (deps.messagesTransform && Array.isArray(event.messages)) {
      // Transcript identity enrichment (v2-only): live v2 hosts carry
      // only {id, time, text, type} on transcript user messages, but the
      // bridged v1 injection gates (phase-reminder, background-job-board,
      // post-file-tool-nudge) key on user-message info.sessionID /
      // info.agent — without this stamp every injection skips on v2.
      // Metadata-only (envelope fields; parts/content bytes untouched)
      // and strictly absence-gated: host-provided values always win.
      // Idempotent across context events — a message stamped once never
      // qualifies for stamping again.
      const knownAgent =
        typeof event.agent === 'string' && event.agent
          ? event.agent
          : deps.knownAgentForSession?.(event.sessionID);
      for (const message of event.messages) {
        if (message.role !== 'user') continue;
        if (message.sessionID === undefined) {
          message.sessionID = event.sessionID;
        }
        if (message.agent === undefined && knownAgent) {
          message.agent = knownAgent;
        }
      }
      // CacheHint tagging (v2-only): parts injected through
      // cache-safe-injection while the bridged transform runs carry an
      // ephemeral cache hint (v2 ContentPart.cache), so providers cap the
      // injected zone's cache contribution. Scoped set/restore inside an
      // isolated AsyncLocalStorage hint scope — the v2 host serves
      // different sessions' requests concurrently, so a shared module
      // default could be restored by one session's transform while
      // another's is still injecting. The v1 pipeline never executes
      // inside this wrapper, so v1 payload bytes never change (pinned by
      // the v1 snapshot/property suites).
      const messagesTransform = deps.messagesTransform;
      await runWithSyntheticPartCacheHintScope(async () => {
        const restoreCacheHint = deps.syntheticPartCacheHint
          ? setDefaultSyntheticPartCacheHint(deps.syntheticPartCacheHint)
          : undefined;
        try {
          const v1messages = event.messages.map((m) => ({
            info: m,
            parts: m.content,
          }));
          await messagesTransform({}, { messages: v1messages });
          event.messages = v1messages.map((m) => {
            const info = m.info as { content?: unknown };
            info.content = m.parts;
            return m.info;
          }) as V2SessionContextEvent['messages'];
        } catch (err) {
          log('[v2] messages transform bridge failed', String(err));
        } finally {
          restoreCacheHint?.();
        }
      });
    }
  };
}

/** Cap on per-session bookkeeping maps (FIFO eviction) — mirrors the
 * tool-loop guard's MAX_TRACKED_SESSIONS rationale. */
const MAX_PROMPT_BRIDGE_SESSIONS = 1024;

function pruneSessionMap<T>(map: Map<string, T>): void {
  while (map.size > MAX_PROMPT_BRIDGE_SESSIONS) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** v2 Model.Ref from a context event (`{id, providerID, variant?}`) →
 * v1 chat.message model (`{providerID, modelID, variant?}`). */
function v1ModelFromContext(
  model: Record<string, unknown> | undefined,
): { providerID: string; modelID: string; variant?: string } | undefined {
  if (!model) return undefined;
  const id = model.id;
  const providerID = model.providerID;
  if (typeof id !== 'string' || typeof providerID !== 'string') {
    return undefined;
  }
  return {
    providerID,
    modelID: id,
    ...(typeof model.variant === 'string' ? { variant: model.variant } : {}),
  };
}

export interface V2SessionPromptBridge {
  /** `ctx.session.hook("prompt")` handler — one v1 chat.message delivery
   * per admitted input (dedupe by messageID). The FIRST admission per
   * session is deferred until the agent is learned (see
   * `observeContext`) so it is delivered with parts + agent together. */
  handlePrompt(event: V2SessionPromptEvent): Promise<void>;
  /** Record per-session agent/model from context events; forward NEWLY
   * learned state to the v1 chat.message hook, flushing any deferred
   * first admission with the agent attached. */
  observeContext(event: V2SessionContextEvent): Promise<void>;
  /** Latest agent known for a session from the learned state above (the
   * identity source for transcript user-message enrichment). */
  agentForSession(sessionID: string): string | undefined;
}

/**
 * Native `session.prompt` hook → v1 `chat.message` bridge.
 *
 * v2's prompt hook fires ONCE per admitted input — endpoint prompts AND
 * subagent-tool child prompts (synthetic/shell/compaction inputs skip
 * it) — with the eventual inbox User `messageID`, the exact identity the
 * v1 chat.message consumers key on (task-session-manager +
 * orchestrator-wake `observeChatMessage`, toolLoopGuard
 * `observeNewUserMessage`). The context-hook emulation cannot provide
 * this: it fires per LLM request and has no prompt parts, so
 * `observeChatMessage`'s non-synthetic-part gate never passed on v2.
 *
 * The prompt payload carries NO agent/model, so `observeContext` learns
 * them from the (immediately following) context events and forwards
 * first-seen/changed state — preserving the v1 timing where the session
 * agent is known before the first tool call of a turn.
 *
 * First-admission deferral: the v1 chat.message handler only registers
 * the session agent (sessionMetadata.setAgent) when a delivery carries
 * one, and its consumers gate on that registration
 * (shouldManageSession → getAgent === 'orchestrator'). Forwarding the
 * FIRST admitted prompt before any agent was learned would therefore be
 * dropped by every consumer, and the follow-up agent-only forward (no
 * parts) is dropped by the parts gate — the first external message's
 * state effects (input-wait latch clearing, wake-progress rearm) would
 * be lost. The bridge instead latches that first prompt per session and
 * flushes it once the first agent-bearing context event arrives (parts +
 * agent delivered together, mirroring v1's single chat.message). Bounded
 * fallbacks keep delivery from being lost outright when no agent is ever
 * learned: the next admitted prompt for the session flushes a
 * still-pending one best-known, and so does a context event whose
 * trailing user message shows the conversation has moved past it.
 *
 * Child-session filtering: none, deliberately — the context-hook
 * emulation never filtered child sessions either, and every consumer
 * gates itself (e.g. `shouldManageSession`).
 */
export function createSessionPromptBridge(
  chatMessage: (input: V1ChatMessageInput, output: unknown) => Promise<void>,
): V2SessionPromptBridge {
  /** Last admitted messageID per session (once-per-admission dedupe). */
  const seenAdmissions = new Map<string, string>();
  /** Latest known agent/model per session (learned from context). */
  const sessionState = new Map<
    string,
    { agent?: string; model?: { providerID: string; modelID: string } }
  >();
  /** First admitted prompt per session, deferred until the agent is
   * learned from a context event (bounded: one per session). */
  const pendingPrompts = new Map<string, V1ChatMessageInput>();

  function trailingUserId(event: V2SessionContextEvent): string | undefined {
    const id = [...event.messages]
      .reverse()
      .find((message) => message.role === 'user')?.id;
    return typeof id === 'string' && id ? id : undefined;
  }

  async function deliver(
    label: string,
    input: V1ChatMessageInput,
  ): Promise<void> {
    try {
      await chatMessage(input, undefined);
    } catch (err) {
      log(`[v2] ${label} chat.message bridge failed`, String(err));
    }
  }

  return {
    async handlePrompt(event) {
      if (!event || typeof event !== 'object') return;
      const sessionID = event.sessionID;
      const messageID = event.messageID;
      if (typeof sessionID !== 'string' || !sessionID) return;
      if (typeof messageID !== 'string' || !messageID) return;
      if (seenAdmissions.get(sessionID) === messageID) return;
      seenAdmissions.set(sessionID, messageID);
      pruneSessionMap(seenAdmissions);

      const state = sessionState.get(sessionID);
      const prompt: Record<string, unknown> = isRecord(event.prompt)
        ? event.prompt
        : {};
      // Internal-initiator admissions (v2 orchestrator-wake queue prompts)
      // arrive as prompt `metadata` — the part metadata cannot survive the
      // text-only v2 translation (see client-shim). Restore it onto the
      // text part so isInternalInitiatorPart consumers classify the
      // admission as internal (wake admissions must not rearm the
      // no-progress cap or clear wake timers as user activity would).
      const internalInitiator =
        isRecord(event.metadata) &&
        event.metadata[INTERNAL_INITIATOR_METADATA_KEY] === true;
      // Rebuild the v1 parts view: observeChatMessage gates on a
      // non-synthetic text/file part being present.
      const parts: Array<Record<string, unknown>> = [];
      if (typeof prompt.text === 'string' && prompt.text) {
        parts.push(
          internalInitiator
            ? {
                type: 'text',
                text: prompt.text,
                synthetic: true,
                metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: true },
              }
            : { type: 'text', text: prompt.text },
        );
      }
      if (Array.isArray(prompt.files)) {
        for (const file of prompt.files) {
          if (isRecord(file)) parts.push({ type: 'file', ...file });
        }
      }
      const input: V1ChatMessageInput = {
        sessionID,
        messageID,
        ...(state?.agent ? { agent: state.agent } : {}),
        ...(state?.model ? { model: state.model } : {}),
        ...(parts.length > 0 ? { parts } : {}),
      };
      if (state?.agent) {
        await deliver('prompt-hook', input);
        return;
      }
      // Agent not yet learned: forwarding now would be dropped by every
      // v1 consumer (see the first-admission deferral note above). Latch
      // the prompt; the first agent-bearing context event flushes it with
      // the agent attached. Bounded fallback: a still-pending prompt is
      // flushed best-known when the next admission arrives, so delivery
      // is deferred, never lost.
      const pending = pendingPrompts.get(sessionID);
      if (pending) {
        await deliver('prompt-hook', pending);
      }
      pendingPrompts.set(sessionID, input);
      pruneSessionMap(pendingPrompts);
    },

    async observeContext(event) {
      if (!event || typeof event !== 'object') return;
      const sessionID = event.sessionID;
      if (typeof sessionID !== 'string' || !sessionID) return;
      const agent =
        typeof event.agent === 'string' && event.agent
          ? event.agent
          : undefined;
      const model = v1ModelFromContext(event.model);
      const previous = sessionState.get(sessionID);
      const unchanged =
        !!previous &&
        previous.agent === agent &&
        ((previous.model === undefined && model === undefined) ||
          (previous.model !== undefined &&
            model !== undefined &&
            previous.model.providerID === model.providerID &&
            previous.model.modelID === model.modelID));
      if (!unchanged) {
        sessionState.set(sessionID, {
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
        });
        pruneSessionMap(sessionState);
      }
      const pending = pendingPrompts.get(sessionID);
      if (pending) {
        if (agent && previous?.agent !== agent) {
          // Agent newly learned: flush the deferred first admission with
          // the agent attached — one delivery carrying parts + agent
          // together, so the v1 chat.message handler registers the
          // session agent BEFORE its consumers gate on it. This flush
          // supersedes the no-parts state forward below (same trailing
          // messageID, strictly more information).
          pendingPrompts.delete(sessionID);
          await deliver('agent-discovery', {
            ...pending,
            agent,
            ...(model ? { model } : {}),
          });
          return;
        }
        if (
          trailingUserId(event) &&
          trailingUserId(event) !== pending.messageID
        ) {
          // The conversation moved past the pending admission without the
          // agent ever being learned (e.g. a synthetic/compaction request
          // followed): flush best-known so the delivery is not lost.
          pendingPrompts.delete(sessionID);
          await deliver('agent-discovery', pending);
        }
      }
      if (unchanged) return; // nothing newly learned — once-per-admission fidelity holds
      await deliver('agent-discovery', {
        sessionID,
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(trailingUserId(event) ? { messageID: trailingUserId(event) } : {}),
      });
    },

    agentForSession(sessionID) {
      return sessionState.get(sessionID)?.agent;
    },
  };
}

/** The v2→v1 tool.execute bridge pair produced by
 * `createToolExecuteBridges`. */
export interface V2ToolBridgeEvents {
  beforeBridge: (
    event: Record<string, unknown> & { input: unknown },
  ) => Promise<void>;
  afterBridge: (
    event: Record<string, unknown> & { result?: unknown },
  ) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter(isRecord)
    .filter((part) => part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function renderOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

/** Formatted error text from a v2 execute.after `error` payload (string,
 * Error-like `{message}`, or structured record). Empty string when the
 * host provided nothing. */
function errorTextOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error.message === 'string' && error.message) {
    return error.message;
  }
  return renderOutput(error);
}

/**
 * Copy a v1 after-hook's string output back into v2 without changing the
 * representation chosen by the v2 tool. In particular, image/file parts
 * must survive a v1 hook which can only see the concatenated text output.
 */
function updateToolResultContent(
  original: unknown,
  originalText: string,
  updated: unknown,
): unknown {
  const text = typeof updated === 'string' ? updated : renderOutput(updated);
  if (typeof original === 'string') return text;
  if (!Array.isArray(original)) return updated;

  // The common after-hook mutation appends a warning. Put only the suffix on
  // the last text part so mixed content keeps its original ordering.
  if (text.startsWith(originalText) && text.length > originalText.length) {
    const suffix = text.slice(originalText.length);
    for (let index = original.length - 1; index >= 0; index -= 1) {
      const part = original[index];
      if (isRecord(part) && part.type === 'text') {
        return original.map((entry, entryIndex) =>
          entryIndex === index
            ? { ...part, text: `${part.text ?? ''}${suffix}` }
            : entry,
        );
      }
    }
  }

  let replacedTextPart = false;
  const content = original.map((part) => {
    if (!isRecord(part) || part.type !== 'text') return part;
    if (replacedTextPart) return { ...part, text: '' };
    replacedTextPart = true;
    return { ...part, text };
  });
  if (!replacedTextPart && text !== '') {
    content.push({ type: 'text', text });
  }
  return content;
}

/** Build the tool.execute.before/after v2→v1 bridges, including the
 * `subagent`→`task` delegation normalization. Exported for tests. */
export function createToolExecuteBridges(
  before:
    | ((
        i: { tool: string; sessionID: string; callID: string },
        o: { args: unknown },
      ) => Promise<void>)
    | undefined,
  after: ((i: unknown, o: unknown) => Promise<void>) | undefined,
): V2ToolBridgeEvents {
  const beforeBridge = async (
    event: Record<string, unknown> & { input: unknown },
  ): Promise<void> => {
    if (!before) return;
    const e = event as unknown as V2ToolBeforeEvent;
    const isDelegation = e.tool.toLowerCase() === 'subagent';
    const argsView = isDelegation
      ? subagentArgsToV1(e.input)
      : { ...(e.input as object) };
    const out: { args: unknown } = { args: argsView };
    // Rethrow: v2 rejects the tool call when execute.before fails, which is
    // how the v1 anti-duplicate / relaunch-lease guards enforce on v2.
    await before(
      { tool: toolNameToV1(e.tool), sessionID: e.sessionID, callID: e.id },
      out,
    );
    // Hooks like apply-patch replace output.args with recovered/normalized
    // arguments; write back (translated back to v2 names for delegation)
    // so v2 executes the repaired input instead of the original.
    e.input = isDelegation
      ? v1ArgsToSubagent(out.args as Record<string, unknown>)
      : out.args;
  };

  const afterBridge = async (
    event: Record<string, unknown> & { result?: unknown },
  ): Promise<void> => {
    if (!after) return;
    const e = event as unknown as V2ToolAfterEvent;
    const isDelegation = e.tool.toLowerCase() === 'subagent';
    // v2 execute.after is status-discriminated: `completed` → mutable
    // result; `error` → `error` payload (result may be absent or stale).
    // Absent status (older hosts) keeps the completed path. On error the
    // v1 output is synthesized from the error text — that is exactly the
    // v1 shape, where a failed tool's model-visible output WAS the error
    // message — so error-recovery consumers (json-error-recovery appends
    // its reminder to output.output) still run meaningfully. An errored
    // call never presents its result content as a successful output.
    const errored = e.status === 'error';
    // Map v2 Tool.Result.content (string | Content[]) -> v1 output.output
    // string; the v1 after-hooks (postFileToolNudge, jsonErrorRecovery,
    // taskSessionManagerAfter) read output.output to decide nudges.
    const result = e.result as
      | {
          content?: unknown;
          output?: unknown;
          metadata?: Record<string, unknown>;
        }
      | undefined;
    const rawContent = result?.content;
    const hasRenderableContent =
      result !== undefined &&
      (typeof rawContent === 'string' ||
        (Array.isArray(rawContent) && rawContent.length > 0));
    const rawOutput = result?.output;
    const content = errored
      ? errorTextOf(e.error)
      : hasRenderableContent
        ? textContent(rawContent)
        : renderOutput(rawOutput);
    const originalMetadata = result?.metadata;
    const initialTitle =
      isRecord(result?.metadata) && typeof result.metadata.title === 'string'
        ? result.metadata.title
        : '';
    const output: {
      output: unknown;
      title: string;
      metadata: Record<string, unknown>;
    } = {
      output: content,
      title: initialTitle,
      metadata: isRecord(originalMetadata) ? originalMetadata : {},
    };
    await after(
      {
        tool: toolNameToV1(e.tool),
        sessionID: e.sessionID,
        callID: e.id,
        args: isDelegation ? subagentArgsToV1(e.input) : e.input,
      },
      output,
    );

    if (result) {
      const updatedText =
        typeof output.output === 'string'
          ? output.output
          : renderOutput(output.output);
      if (updatedText !== content) {
        if (errored) {
          // Errored call: the model-visible content is the synthesized
          // error text plus whatever the hook appended (e.g. the
          // json-error-recovery reminder). Written as plain string
          // content — never keep a stale/empty result content looking
          // like a successful output.
          result.content = updatedText;
        } else if (hasRenderableContent) {
          result.content = updateToolResultContent(
            rawContent,
            content,
            output.output,
          );
        } else if (Object.hasOwn(result, 'output')) {
          // Keep output as the machine-readable value. The hook's transformed
          // text belongs in the model-visible content field.
          result.content = updatedText;
        }
      }
      const metadataChanged =
        isRecord(output.metadata) &&
        output.metadata !== originalMetadata &&
        (isRecord(originalMetadata) || Object.keys(output.metadata).length > 0);
      if (metadataChanged) {
        result.metadata = output.metadata;
      }
      if (output.title !== initialTitle) {
        result.metadata = {
          ...(isRecord(result.metadata) ? result.metadata : {}),
          title: output.title,
        };
      }
    }
  };

  return { beforeBridge, afterBridge };
}

/** v1 McpConfig → v2 Mcp.ServerConfig（字段几乎同构；仅剔除 undefined）。 */
export function adaptMcpServer(v1: McpConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { type: v1.type };
  if (v1.type === 'remote') {
    out.url = v1.url;
    if (v1.headers) out.headers = v1.headers;
    if (v1.oauth === false) out.oauth = false;
  } else {
    out.command = v1.command;
    if (v1.environment) out.environment = v1.environment;
  }
  return out;
}

export function createV2Setup(): (ctx: V2Context) => Promise<V2Cleanup> {
  return async (ctx: V2Context): Promise<V2Cleanup> => {
    const sessionId = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .slice(0, 15);
    initLogger(sessionId);
    // Capability guard: some hosts load this same `setup` with a reduced or
    // TUI-side context where agent/tool/session/event domains are missing.
    // Skip registration instead of crashing the host (and retry-storming).
    if (!ctx || typeof ctx.agent?.transform !== 'function') {
      log(
        '[v2] setup skipped: host context lacks agent.transform (TUI-side or reduced host)',
      );
      return async () => {};
    }
    log('[v2] setup invoked', { app: ctx.app, cwd: process.cwd() });

    // Directory/location resolution lives in the shim now (single source);
    // setup still needs the directory for config loading and tool adapters.
    const directory = resolveV2Directory(ctx);
    const disposers: Array<() => Promise<void> | void> = [];
    let v1Hooks: Record<string, unknown> | undefined;

    try {
      log('[v2] importing v1 factory...');
      // Capability probe: v2 one-shot generation (`ctx.generate.text`),
      // probed structurally since V2Context stays minimal by design.
      // Powers the smartfetch secondary-model summaries without a temp
      // session; absent on older hosts → no `experimental_v2` key at all.
      const generateText = (
        ctx as {
          generate?: {
            text?: (input: {
              prompt: string;
              model?: { id: string; providerID: string; variant?: string };
            }) => Promise<{ text: string }>;
          };
        }
      ).generate?.text;
      const generateChannel =
        typeof generateText === 'function'
          ? {
              generateText: (
                prompt: string,
                model?: { id: string; providerID: string; variant?: string },
              ) => generateText({ prompt, ...(model ? { model } : {}) }),
            }
          : undefined;
      log('[v2] ctx.generate.text', {
        available: typeof generateText === 'function',
      });
      const pluginInput = buildPluginInput(ctx, generateChannel);
      log('[v2] calling OhMyOpenCodeLite...');
      v1Hooks = (await OhMyOpenCodeLite(
        pluginInput as never,
      )) as unknown as Record<string, unknown>;
      log('[v2] v1 factory initialized', {
        agents: Object.keys((v1Hooks as { agent?: object }).agent ?? {}).length,
        tools: Object.keys((v1Hooks as { tool?: object }).tool ?? {}).length,
      });
    } catch (err) {
      log('[v2] FATAL: v1 factory init failed', String(err));
      console.error('[oh-my-opencode-slim][v2] factory init failed:', err);
      // Don't hard-fail the whole plugin; register nothing and stay loaded.
      return async () => {};
    }

    if (!v1Hooks) return async () => {};

    const interviewConfig = InterviewConfigSchema.parse(
      loadPluginConfig(directory).interview ?? {},
    );
    const interviewBridge = createV2InterviewBridge(ctx, interviewConfig);
    disposers.push(() => interviewBridge.dispose());

    // Resolve agents/commands via the v1 config() hook (model resolution etc.).
    let resolvedAgents: Record<string, Record<string, unknown>> | undefined;
    let synthCommands:
      | Record<string, { template?: string; description?: string }>
      | undefined;
    try {
      const synth: Record<string, unknown> = {};
      const configFn = v1Hooks.config as
        | ((c: Record<string, unknown>) => Promise<void>)
        | undefined;
      if (configFn) {
        await configFn(synth);
        if (synth.agent && typeof synth.agent === 'object') {
          resolvedAgents = synth.agent as Record<
            string,
            Record<string, unknown>
          >;
        }
        const cmd = synth.command as
          | Record<string, { template?: string; description?: string }>
          | undefined;
        if (cmd) synthCommands = cmd;
      }
    } catch (err) {
      log(
        '[v2] config() hook failed (continuing with raw agents)',
        String(err),
      );
    }
    if (!resolvedAgents) {
      resolvedAgents =
        (v1Hooks.agent as Record<string, Record<string, unknown>>) ?? {};
    }

    // ── Agents ──
    try {
      const reg = await ctx.agent.transform((draft) => {
        for (const [name, cfg] of Object.entries(resolvedAgents ?? {})) {
          try {
            applyAgentToDraft(draft, name, cfg);
          } catch (err) {
            log('[v2] agent adapt failed', { name, err: String(err) });
          }
        }
        // Make orchestrator the default primary agent.
        if (resolvedAgents?.orchestrator) {
          try {
            draft.default('orchestrator');
          } catch {
            /* default() optional */
          }
        }
      });
      disposers.push(() => reg.dispose());
      log('[v2] agents registered', {
        count: Object.keys(resolvedAgents ?? {}).length,
      });
    } catch (err) {
      log('[v2] agent.transform failed', String(err));
    }

    // ── Tools ──
    try {
      const tools = (v1Hooks.tool ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const toolEntries = Object.entries(tools);
      if (toolEntries.length > 0) {
        // Precompute JSON schemas from zod shapes (zod is bundled in v2 build).
        const zod = (await import('zod')) as unknown as {
          object?: (s: unknown) => unknown;
          toJSONSchema?: (s: unknown) => unknown;
        };
        const schemaFor = (def: Record<string, unknown>): unknown => {
          const args = def.args;
          if (!args || typeof args !== 'object') {
            return { type: 'object', properties: {} };
          }
          try {
            const obj = zod.object?.(args);
            if (zod.toJSONSchema && obj) return zod.toJSONSchema(obj);
          } catch {
            /* fall through */
          }
          return { type: 'object', properties: {} };
        };

        const reg = await ctx.tool.transform((draft) => {
          for (const [name, def] of toolEntries) {
            try {
              // adaptTool stamps `options: { codemode: false }` on every
              // registration (CodeMode opt-out) — without it v2's
              // Tool.snapshot() confines the tool to the `execute` tool's
              // JS runtime instead of the model-visible tool catalog.
              draft.add(adaptTool(name, def, directory, schemaFor(def)));
            } catch (err) {
              log('[v2] tool adapt failed', { name, err: String(err) });
            }
          }
        });
        disposers.push(() => reg.dispose());
        log('[v2] tools registered', { count: toolEntries.length });
      }
    } catch (err) {
      log('[v2] tool.transform failed', String(err));
    }

    // ── Built-in MCPs (ctx.mcp.transform, v2 ≥ #45408) ──
    try {
      const mcps = (v1Hooks.mcp ?? {}) as Record<string, McpConfig>;
      const entries = Object.entries(mcps);
      if (entries.length > 0 && typeof ctx.mcp?.transform === 'function') {
        const reg = await ctx.mcp.transform((draft) => {
          for (const [name, cfg] of entries) {
            try {
              draft.set(name, adaptMcpServer(cfg));
            } catch (err) {
              log('[v2] mcp adapt failed', { name, err: String(err) });
            }
          }
        });
        disposers.push(() => reg.dispose());
        log('[v2] mcp servers registered', { count: entries.length });
      } else if (entries.length > 0) {
        log('[v2] ctx.mcp.transform unavailable; MCPs stay config-only');
      }
    } catch (err) {
      log('[v2] mcp.transform failed', String(err));
    }

    // ── Commands (deepwork / reflect / loop slash commands) ──
    try {
      const entries = Object.entries(synthCommands ?? {});
      if (entries.length > 0) {
        const submitCommand = createSessionSubmit(ctx);
        const reg = await ctx.command.transform((draft) => {
          registerSynthCommands(draft, entries, submitCommand);
        });
        disposers.push(() => reg.dispose());
        log('[v2] commands registered', {
          // Includes `interview`, which the bridge registers below.
          count: entries.length,
        });
      }
    } catch (err) {
      log('[v2] command.transform failed', String(err));
    }

    // `/interview` is a v2 command marker. The context bridge consumes the
    // rendered marker and delegates the actual behavior to the interview
    // service without expanding the global v2 client shim.
    try {
      const reg = await ctx.command.transform((draft) => {
        try {
          interviewBridge.registerCommand(draft);
        } catch (err) {
          log('[v2] interview command adapt failed', String(err));
        }
      });
      disposers.push(() => reg.dispose());
    } catch (err) {
      log('[v2] interview command registration failed', String(err));
    }

    // ── Session context hook: command markers + system/messages transforms ──
    // One registration handles: the interview marker bridge, generic command
    // marker dispatch (deepwork/reflect/loop), chat.message agent tracking
    // (or agent/model discovery when the native prompt hook is active), and
    // the v1 system/messages transforms.
    try {
      const commandBefore = v1Hooks['command.execute.before'] as
        | V1CommandBeforeHook
        | undefined;
      const systemTransform = v1Hooks['experimental.chat.system.transform'] as
        | ((i: unknown, o: { system: string[] }) => Promise<void>)
        | undefined;
      const messagesTransform = v1Hooks[
        'experimental.chat.messages.transform'
      ] as
        | ((
            i: unknown,
            o: {
              messages: Array<{ info: { role: string }; parts: unknown[] }>;
            },
          ) => Promise<void>)
        | undefined;
      const chatMessage = v1Hooks['chat.message'] as
        | ((i: V1ChatMessageInput, o: unknown) => Promise<void>)
        | undefined;

      // Native per-admission prompt hook (v2): `session.prompt` fires once
      // per admitted input with the eventual inbox User messageID — the
      // identity v1 chat.message consumers key on. When the host supports
      // it, the context hook's per-request chat.message emulation narrows
      // to agent/model discovery; older v2 hosts (hook name rejected)
      // keep the full emulation.
      let promptBridge: V2SessionPromptBridge | undefined;
      if (chatMessage) {
        const bridge = createSessionPromptBridge(chatMessage);
        try {
          const promptReg = await ctx.session.hook(
            'prompt',
            bridge.handlePrompt,
          );
          disposers.push(() => promptReg.dispose());
          promptBridge = bridge;
          log('[v2] native session prompt hook registered');
        } catch (err) {
          log(
            '[v2] session.hook(prompt) unavailable; keeping chat.message context emulation',
            String(err),
          );
        }
      }

      const handler = createSessionContextHandler({
        interviewHandleContext: (event) => interviewBridge.handleContext(event),
        commandBefore,
        chatMessage: promptBridge ? undefined : chatMessage,
        observeContextAgent: promptBridge?.observeContext,
        // Transcript user-message enrichment falls back to the agent the
        // prompt bridge learned when the context event carries none.
        knownAgentForSession: (sessionID) =>
          promptBridge?.agentForSession(sessionID),
        systemTransform,
        messagesTransform,
        // v2 ContentPart cache hint for parts injected by the bridged
        // transforms (v1 bytes never change — see the handler).
        syntheticPartCacheHint: { type: 'ephemeral' },
      });
      const reg = await ctx.session.hook('context', handler);
      disposers.push(() => reg.dispose());
      log('[v2] session context hook registered');
    } catch (err) {
      log('[v2] session.hook(context) failed', String(err));
    }

    // ── Tool execute hooks ──
    try {
      const before = v1Hooks['tool.execute.before'] as
        | ((
            i: { tool: string; sessionID: string; callID: string },
            o: { args: unknown },
          ) => Promise<void>)
        | undefined;
      const after = v1Hooks['tool.execute.after'] as
        | ((i: unknown, o: unknown) => Promise<void>)
        | undefined;
      const bridges = createToolExecuteBridges(before, after);
      if (before) {
        const reg = await ctx.tool.hook('execute.before', async (event) => {
          try {
            await bridges.beforeBridge(event as never);
          } catch (err) {
            log('[v2] tool.execute.before rejected call', String(err));
            throw err; // v2 refuses the call (see createToolExecuteBridges)
          }
        });
        disposers.push(() => reg.dispose());
      }
      if (after) {
        const reg = await ctx.tool.hook('execute.after', async (event) => {
          try {
            await bridges.afterBridge(event as never);
          } catch (err) {
            log('[v2] tool.execute.after bridge failed', String(err));
          }
        });
        disposers.push(() => reg.dispose());
      }
      log('[v2] tool hooks registered', { before: !!before, after: !!after });
    } catch (err) {
      log('[v2] tool.hook registration failed', String(err));
    }

    // ── Event stream ──
    try {
      const eventHook = v1Hooks.event as
        | ((i: { event: Record<string, unknown> }) => Promise<void>)
        | undefined;
      if (eventHook || interviewBridge) {
        const iter = ctx.event.subscribe();
        const eventIterator = iter[Symbol.asyncIterator]();
        let eventStopped = false;
        void (async () => {
          try {
            while (!eventStopped) {
              const next = await eventIterator.next();
              if (next.done) break;
              try {
                // interviewBridge keeps the RAW v2 event; the v1 eventHook
                // loop iterates raw + synthesized v1 shapes (idle,
                // early-registration created, message.updated telemetry).
                await interviewBridge.handleEvent(next.value);
                if (eventHook) {
                  for (const ev of mapV2EventToV1(next.value)) {
                    await eventHook({ event: ev });
                  }
                }
              } catch (err) {
                log('[v2] event handler failed', String(err));
              }
            }
          } catch (err) {
            log('[v2] event stream ended', String(err));
          }
        })();
        disposers.push(async () => {
          eventStopped = true;
          await eventIterator.return?.();
        });
        log('[v2] event stream subscribed');
      }
    } catch (err) {
      log('[v2] event.subscribe failed', String(err));
    }

    // ── Health check: surface silent zero-registration failures ──
    // Every bridge is fail-soft; without this, a fully broken registration
    // would look like a successful load with an empty session.
    if (disposers.length === 0) {
      console.error(
        '[oh-my-opencode-slim][v2] WARNING: no bridges registered — ' +
          'the plugin loaded but registered nothing. Check the plugin log.',
      );
      log('[v2] health check: zero bridges registered');
    } else {
      log('[v2] health check passed', { bridges: disposers.length });
    }

    const dispose = v1Hooks.dispose as (() => Promise<void>) | undefined;

    return async () => {
      log('[v2] dispose invoked');
      for (const d of disposers) {
        try {
          await d();
        } catch (err) {
          log('[v2] disposer failed', String(err));
        }
      }
      // v1 dispose synthesizes `server.instance.disposed` into the v1 event
      // consumers (orchestrator-wake scheduler timers/state, task-session
      // manager) — without it, host teardown would leak wake timers.
      try {
        log('[v2] v1 dispose hook invoked');
        await dispose?.();
      } catch (err) {
        log('[v2] v1 dispose failed', String(err));
      }
    };
  };
}
