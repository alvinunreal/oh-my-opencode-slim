/**
 * Shape adapters: convert v1 plugin objects into v2 registration shapes.
 *
 * - `parseModelRef`: "provider/model" string → v2 Model.Ref.
 * - `adaptPermissions`: v1 permission map → v2 Rule[] (with v2 permissive base +
 *   `task`→`subagent`, `bash`→`execute` mapping).
 * - `rewritePromptForV2`: rewrite v1 delegation syntax in agent/system prompts.
 * - `adaptTool`: v1 ToolDefinition ({description,args,execute}) → v2 Tool.Info.
 * - `applyAgentToDraft`: mutate a v2 agent draft entry from a v1 agent config.
 */

import { log } from '../utils/logger';
import type { ModelRef, V2AgentDraft } from './types';

/** Parse a v1 "provider/model" string into a v2 Model.Ref. */
export function parseModelRef(model: unknown): ModelRef | undefined {
  if (typeof model !== 'string') return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash >= model.length - 1) {
    // No provider separator; better to leave model undefined than guess a
    // provider. Many configs use bare ids; these resolve via the host default.
    return undefined;
  }
  return {
    providerID: model.slice(0, slash),
    id: model.slice(slash + 1),
  };
}

/** v1 lists only EXPLICIT permission entries; unlisted tools fall through to
 * opencode's implicit default-allow. v2 has no implicit default, so we start
 * from v2's standard permissive base ruleset (mirrors Agent.Info.default) and
 * overlay the v1 entries. Without this base, v2 would deny every v2-native tool
 * the v1 permission map never heard of (subagent, execute, read, edit, ...). */
const V2_DEFAULT_PERMISSIONS = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'external_directory', resource: '*', effect: 'ask' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
];

/** Map v1 permission keys to v2 (action, resource). v1 `task` is v2 `subagent`;
 * v1 `bash` is v2 `execute`. */
function v1PermKeyToV2(
  key: string,
): Array<{ action: string; resource: string }> {
  if (key === 'task') return [{ action: 'subagent', resource: '*' }];
  if (key === 'bash')
    return [
      { action: '*', resource: 'execute' },
      { action: '*', resource: 'bash' },
    ];
  return [{ action: '*', resource: key }];
}

/** Convert a v1 permission map (or shorthand string) into v2 permission rules. */
export function adaptPermissions(
  perm: unknown,
): Array<{ action: string; resource: string; effect: string }> {
  const rules: Array<{ action: string; resource: string; effect: string }> = [
    ...V2_DEFAULT_PERMISSIONS,
  ];
  if (typeof perm === 'string') {
    rules.push({ action: '*', resource: '*', effect: perm });
    return rules;
  }
  if (perm && typeof perm === 'object') {
    for (const [resource, effect] of Object.entries(
      perm as Record<string, unknown>,
    )) {
      if (typeof effect === 'string') {
        for (const target of v1PermKeyToV2(resource)) {
          rules.push({ ...target, effect });
        }
      } else if (effect && typeof effect === 'object') {
        // nested {tool: {pattern: effect}}
        for (const [sub, subEffect] of Object.entries(
          effect as Record<string, unknown>,
        )) {
          if (typeof subEffect === 'string') {
            rules.push({ action: sub, resource, effect: subEffect });
          }
        }
      }
    }
  }
  return rules;
}

/** Rewrite v1 delegation syntax to v2. v2 renamed `task` → `subagent` and
 * `subagent_type` → `agent`. Applied to agent prompts at registration and to
 * the runtime system prompt so the orchestrator emits valid v2 tool calls. */
export function rewritePromptForV2(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\bsubagent_type\b/g, 'agent')
    .replace(/\btask\s*\(/g, 'subagent(');
}

/** Adapt a v1 tool definition ({description, args, execute}) to a v2 tool. */
export function adaptTool(
  name: string,
  v1Tool: Record<string, unknown>,
  directory: string,
  inputSchema: unknown,
): Record<string, unknown> {
  const description =
    (v1Tool.description as string | undefined) ?? `Tool ${name}`;

  const execute = v1Tool.execute as
    | ((args: unknown, ctx: unknown) => Promise<unknown>)
    | undefined;

  return {
    name,
    description,
    input: inputSchema,
    execute: async (input: unknown, context: unknown) => {
      if (!execute) return { output: {} };
      const ctx = context as {
        sessionID?: string;
        messageID?: string;
        agent?: string;
        progress?: (m: unknown) => unknown;
      };
      const v1Ctx = {
        sessionID: ctx?.sessionID ?? '',
        messageID: ctx?.messageID ?? '',
        agent: ctx?.agent ?? 'orchestrator',
        directory,
        worktree: directory,
        abort: new AbortController().signal,
        metadata(m: unknown) {
          log('[v2][tool] metadata (no-op)', { tool: name, m });
        },
        async ask(_m: unknown) {
          /* permission deferred to v2 model */
        },
      };
      const result = await execute(input, v1Ctx);
      if (typeof result === 'string') {
        return { content: result };
      }
      if (result && typeof result === 'object') {
        const r = result as {
          output?: string;
          title?: string;
          metadata?: Record<string, unknown>;
          attachments?: unknown[];
        };
        return {
          content: typeof r.output === 'string' ? r.output : '',
          metadata: {
            ...(r.metadata ?? {}),
            ...(r.title ? { title: r.title } : {}),
          },
        };
      }
      return { content: String(result ?? '') };
    },
  };
}

/** Mutate a v2 agent draft entry from a v1 agent config. */
export function applyAgentToDraft(
  draft: V2AgentDraft,
  name: string,
  v1: Record<string, unknown>,
): void {
  const model = parseModelRef(v1.model);
  draft.update(name, (agent) => {
    agent.id = name;
    agent.name = name;
    agent.mode =
      (v1.mode as string) ?? (name === 'orchestrator' ? 'primary' : 'subagent');
    agent.hidden = v1.hidden === true;
    if (typeof v1.description === 'string') agent.description = v1.description;
    if (typeof v1.prompt === 'string')
      agent.system = rewritePromptForV2(v1.prompt);
    if (model) {
      agent.model = {
        id: model.id,
        providerID: model.providerID,
        ...(v1.variant ? { variant: v1.variant } : {}),
      };
    }
    const request: Record<string, unknown> = {
      settings: {},
      headers: {},
      body: {},
    };
    if (typeof v1.temperature === 'number') {
      (request.settings as Record<string, unknown>).temperature =
        v1.temperature;
    }
    agent.request = request;
    // v2 permission evaluation is last-match-wins (findLast). v1 `tools` lists
    // which tools an agent MAY use (implicit allow); the `permission` map holds
    // explicit allow/deny. Place tools-allow FIRST so an explicit permission
    // deny later in the array wins, matching v1 precedence.
    const toolsAllow: Array<Record<string, unknown>> = [];
    if (Array.isArray(v1.tools)) {
      for (const t of v1.tools as unknown[]) {
        if (typeof t === 'string') {
          toolsAllow.push({ action: '*', resource: t, effect: 'allow' });
        }
      }
    }
    agent.permissions = [...toolsAllow, ...adaptPermissions(v1.permission)];
  });
}
