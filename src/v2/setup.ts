/**
 * v2 setup orchestration.
 *
 * Returns the `setup(ctx)` function v2 calls via `default.setup`. The setup
 * wraps the existing v1 factory (reusing ALL build logic) and translates the
 * returned v1 `Hooks` into v2 registrations: agent/tool/command transforms,
 * a single session context hook (system/messages transforms, chat.message
 * tracking, and interview + generic command marker dispatch), tool execute
 * hooks, and the event stream. Each bridge is independently try/catch-guarded.
 */

import { loadPluginConfig } from '../config/loader';
import { InterviewConfigSchema } from '../config/schema';
import { OhMyOpenCodeLite } from '../index';
import { initLogger, log } from '../utils/logger';
import { adaptTool, applyAgentToDraft } from './adapters';
import { buildPluginInput } from './client-shim';
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

/** Wrap slash-command arguments in the generic v2 command marker. v2 command
 * drafts are add-only (no `template`), so `execute` submits this marker as a
 * plain user prompt and the session context hook recovers it below. */
export function wrapCommandMarker(name: string, args: string): string {
  return `<omos-cmd-command data-name="${name}">${args}</omos-cmd-command>`;
}

// Whole-text anchored: v2 writes the marker as the entire submitted prompt,
// so whole-text anchoring is the contract. A user-typed embedded marker must
// not hijack dispatch in the merged session context hook.
const COMMAND_MARKER_PATTERN =
  /^\s*<omos-cmd-command\s+data-name="([\w.-]+)">([\s\S]*?)<\/omos-cmd-command>\s*$/;

export interface ParsedCommandMarker {
  name: string;
  args: string;
}

/** Parse the generic command marker from a message text, if present. */
export function parseCommandMarker(
  text: string,
): ParsedCommandMarker | undefined {
  const match = text.match(COMMAND_MARKER_PATTERN);
  if (!match) return undefined;
  return { name: match[1], args: match[2] };
}

/** Strip the marker tags from marker-only `text`, leaving the raw args. */
export function stripCommandMarker(text: string): string {
  // Function replacer: a string replacer would interpret `$`-sequences in
  // the captured args. Group 1 is the command name; group 2 the args.
  return text.replace(
    COMMAND_MARKER_PATTERN,
    (_match, _name: string, args: string) => args,
  );
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

/** Deps injected into the single session context hook. */
export interface V2SessionContextHandlerDeps {
  /** Interview bridge handleContext (transcript projection + /interview
   * marker dispatch). */
  interviewHandleContext: (event: V2SessionContextEvent) => Promise<void>;
  /** v1 `command.execute.before` hook (generic command marker dispatch). */
  commandBefore?: V1CommandBeforeHook;
  /** v1 `chat.message` hook (agent tracking). */
  chatMessage?: (
    input: { sessionID: string; agent?: string },
    output: unknown,
  ) => Promise<void>;
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
    // Agent tracking (chat.message equivalent).
    if (deps.chatMessage) {
      try {
        await deps.chatMessage(
          { sessionID: event.sessionID, agent: event.agent },
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
      try {
        const v1messages = event.messages.map((m) => ({
          info: m,
          parts: m.content,
        }));
        await deps.messagesTransform({}, { messages: v1messages });
        event.messages = v1messages.map((m) => {
          const info = m.info as { content?: unknown };
          info.content = m.parts;
          return m.info;
        }) as V2SessionContextEvent['messages'];
      } catch (err) {
        log('[v2] messages transform bridge failed', String(err));
      }
    }
  };
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

    const directory = process.cwd();
    const disposers: Array<() => Promise<void> | void> = [];
    let v1Hooks: Record<string, unknown> | undefined;

    try {
      log('[v2] importing v1 factory...');
      const pluginInput = buildPluginInput(directory);
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
    // marker dispatch (deepwork/reflect/loop), chat.message agent tracking,
    // and the v1 system/messages transforms.
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
        | ((
            i: { sessionID: string; agent?: string },
            o: unknown,
          ) => Promise<void>)
        | undefined;

      const handler = createSessionContextHandler({
        interviewHandleContext: (event) => interviewBridge.handleContext(event),
        commandBefore,
        chatMessage,
        systemTransform,
        messagesTransform,
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
      if (before) {
        const reg = await ctx.tool.hook('execute.before', async (event) => {
          const e = event as V2ToolBeforeEvent;
          try {
            const out = { args: e.input };
            await before(
              { tool: e.tool, sessionID: e.sessionID, callID: e.id },
              out,
            );
            // Hooks like apply-patch replace output.args with recovered/
            // normalized arguments; write back so v2 executes the repaired
            // input instead of the original.
            e.input = out.args;
          } catch (err) {
            log('[v2] tool.execute.before bridge failed', String(err));
          }
        });
        disposers.push(() => reg.dispose());
      }
      if (after) {
        const reg = await ctx.tool.hook('execute.after', async (event) => {
          const e = event as V2ToolAfterEvent;
          // Map v2 Tool.Result.content (string | Content[]) -> v1 output.output
          // string; the v1 after-hooks (postFileToolNudge, jsonErrorRecovery,
          // taskSessionManagerAfter) read output.output to decide nudges.
          const result = e.result as
            | {
                content?: unknown;
                metadata?: Record<string, unknown>;
              }
            | undefined;
          const rawContent = result?.content;
          const content =
            typeof rawContent === 'string'
              ? rawContent
              : Array.isArray(rawContent)
                ? (rawContent as Array<{ type?: string; text?: string }>)
                    .filter((p) => p?.type === 'text')
                    .map((p) => p.text ?? '')
                    .join('')
                : '';
          try {
            await after(
              {
                tool: e.tool,
                sessionID: e.sessionID,
                callID: e.id,
                args: e.input,
              },
              { output: content, title: '', metadata: result?.metadata ?? {} },
            );
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
                await interviewBridge.handleEvent(next.value);
                if (eventHook) await eventHook({ event: next.value });
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
      try {
        await dispose?.();
      } catch (err) {
        log('[v2] v1 dispose failed', String(err));
      }
    };
  };
}
