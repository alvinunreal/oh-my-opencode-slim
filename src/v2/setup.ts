/**
 * v2 setup orchestration.
 *
 * Returns the `setup(ctx)` function v2 calls via `default.setup`. The setup
 * wraps the existing v1 factory (reusing ALL build logic) and translates the
 * returned v1 `Hooks` into v2 registrations: agent/tool/command transforms,
 * the session context hook (system + message transforms), tool execute hooks,
 * and the event stream. Each bridge is independently try/catch-guarded.
 */

import { OhMyOpenCodeLite } from '../index';
import { initLogger, log } from '../utils/logger';
import { adaptTool, applyAgentToDraft } from './adapters';
import { buildPluginInput } from './client-shim';
import type {
  V2Cleanup,
  V2Context,
  V2SessionContextEvent,
  V2ToolAfterEvent,
  V2ToolBeforeEvent,
} from './types';

export function createV2Setup(): (ctx: V2Context) => Promise<V2Cleanup> {
  return async (ctx: V2Context): Promise<V2Cleanup> => {
    const sessionId = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .slice(0, 15);
    initLogger(sessionId);
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
        const reg = await ctx.command.transform((draft) => {
          for (const [name, cmd] of entries) {
            try {
              draft.update(name, (c) => {
                c.name = name;
                if (typeof cmd.template === 'string') c.template = cmd.template;
                if (typeof cmd.description === 'string')
                  c.description = cmd.description;
              });
            } catch (err) {
              log('[v2] command adapt failed', { name, err: String(err) });
            }
          }
        });
        disposers.push(() => reg.dispose());
        log('[v2] commands registered', { count: entries.length });
      }
    } catch (err) {
      log('[v2] command.transform failed', String(err));
    }

    // ── System + messages transforms (session context hook) ──
    try {
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

      if (systemTransform || messagesTransform || chatMessage) {
        const reg = await ctx.session.hook('context', async (event) => {
          // Agent tracking (chat.message equivalent).
          if (chatMessage) {
            try {
              await chatMessage(
                { sessionID: event.sessionID, agent: event.agent },
                undefined,
              );
            } catch (err) {
              log('[v2] chat.message bridge failed', String(err));
            }
          }
          // System transform: v2 SystemPart[] -> v1 string[] -> mutate -> back.
          if (systemTransform && Array.isArray(event.system)) {
            try {
              const sysStrings = event.system.map((s) => s.text ?? '');
              await systemTransform(
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
          if (messagesTransform && Array.isArray(event.messages)) {
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
            }
          }
        });
        disposers.push(() => reg.dispose());
        log('[v2] session context hook registered');
      }
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
      if (eventHook) {
        const iter = ctx.event.subscribe();
        void (async () => {
          try {
            for await (const ev of iter) {
              try {
                await eventHook({ event: ev });
              } catch (err) {
                log('[v2] event handler failed', String(err));
              }
            }
          } catch (err) {
            log('[v2] event stream ended', String(err));
          }
        })();
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
