/**
 * Shape adapters: convert v1 plugin objects into v2 registration shapes.
 *
 * - `parseModelRef`: "provider/model" string → v2 Model.Ref.
 * - `adaptPermissions`: v1 permission map → v2 Rule[] (with v2 permissive base +
 *   `task`→`subagent`, `bash`→`execute` mapping).
 * - `rewritePromptForV2`: rewrite v1 delegation syntax in agent/system prompts.
 * - `delegationVocabulary`: native per-flavor delegation tool/param names for
 *   prompt-build sites (v2 `subagent`/`agent` vs v1 `task`/`subagent_type`).
 * - `adaptTool`: v1 ToolDefinition ({description,args,execute}) → v2 Tool.Info.
 * - `applyAgentToDraft`: mutate a v2 agent draft entry from a v1 agent config.
 */

import { log } from '../utils/logger';
import type { PermissionCeilings, PermissionPolicyInput } from './permissions';
import { compilePermissionPolicy } from './permissions';
import type {
  ModelRef,
  V2AgentDraft,
  V2PermissionRule,
  V2ToolDefinition,
} from './types';

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

/** Map a v1 permission key (the tool) to v2 (action, resource). The host
 * evaluator matches the tool against `action` and the path/pattern against
 * `resource`. v1 `task` is v2 `subagent`; v1 `bash` is v2 `execute`. */
export function v1PermKeyToV2(
  key: string,
): Array<{ action: string; resource: string }> {
  if (key === 'task') return [{ action: 'subagent', resource: '*' }];
  if (key === 'bash')
    return [
      { action: 'execute', resource: '*' },
      { action: 'bash', resource: '*' },
    ];
  return [{ action: key, resource: '*' }];
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
    for (const [tool, effect] of Object.entries(
      perm as Record<string, unknown>,
    )) {
      if (typeof effect === 'string') {
        for (const target of v1PermKeyToV2(tool)) {
          rules.push({ ...target, effect });
        }
      } else if (effect && typeof effect === 'object') {
        // nested {tool: {pattern: effect}} → action=tool, resource=pattern
        for (const [pattern, subEffect] of Object.entries(
          effect as Record<string, unknown>,
        )) {
          if (typeof subEffect === 'string') {
            for (const target of v1PermKeyToV2(tool)) {
              rules.push({
                action: target.action,
                resource: pattern,
                effect: subEffect,
              });
            }
          }
        }
      }
    }
  }
  return rules;
}

/** Compile the v1 agent permission map as the baseline for native ordered
 * host rules. Native last-match evaluation lets host rules override earlier
 * baseline denials; final denials and configured ceilings remain immutable. */
export function compileAgentPermissions(
  permission: unknown,
  options: {
    tools?: readonly string[];
    hostRules?: readonly V2PermissionRule[];
    ceilings?: PermissionCeilings;
    finalDenials?: readonly string[];
  } = {},
): V2PermissionRule[] {
  const toolsAllow = (options.tools ?? []).map((action) => ({
    action,
    resource: '*',
    effect: 'allow' as const,
  }));
  const baselineRules = [...toolsAllow, ...adaptPermissions(permission)].filter(
    (rule): rule is V2PermissionRule =>
      rule.effect === 'allow' ||
      rule.effect === 'ask' ||
      rule.effect === 'deny',
  );
  const input: PermissionPolicyInput = {
    baselineRules,
    hostRules: options.hostRules ?? [],
    ...(options.ceilings ? { ceilings: options.ceilings } : {}),
  };
  return [
    ...compilePermissionPolicy(input).rules.map((rule) => ({ ...rule })),
    ...(options.finalDenials ?? []).map((action) => ({
      action,
      resource: '*',
      effect: 'deny' as const,
    })),
  ];
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

/** Native delegation vocabulary for a host flavor. v2 hosts expose the
 * built-in `subagent` tool with the `agent` parameter; v1 hosts (and any
 * unknown flavor) use `task` with `subagent_type`. Prompt-build sites call
 * this so generated text matches the host's actual tool directly, instead
 * of emitting v1 wording and relying on `rewritePromptForV2` — which
 * remains as belt-and-suspenders for user-customized presets that still
 * contain v1 wording. */
export interface DelegationVocabulary {
  /** Name of the host's delegation tool: `subagent` on v2, `task` on v1. */
  tool: string;
  /** Name of the tool's agent-selector parameter: `agent` on v2,
   * `subagent_type` on v1. */
  agentParam: string;
  /** Name of the delegation tool's optional model parameter, when the
   * host's subagent tool supports one (OpenCode v2.0.5+). */
  modelParam: string | undefined;
}

export function delegationVocabulary(
  hostFlavor: string | undefined,
): DelegationVocabulary {
  return hostFlavor === 'v2'
    ? { tool: 'subagent', agentParam: 'agent', modelParam: 'model' }
    : { tool: 'task', agentParam: 'subagent_type', modelParam: undefined };
}

/** Adapt a v1 tool definition ({description, args, execute}) to a v2 tool. */
export function adaptTool(
  name: string,
  v1Tool: Record<string, unknown>,
  directory: string,
  inputSchema: unknown,
): V2ToolDefinition {
  const description =
    (v1Tool.description as string | undefined) ?? `Tool ${name}`;

  const execute = v1Tool.execute as
    | ((args: unknown, ctx: unknown) => Promise<unknown>)
    | undefined;

  return {
    name,
    description,
    input: inputSchema,
    // CodeMode opt-out (official plugin pattern, packages/plugin README):
    // v2's Tool.snapshot() only turns `codemode: false` tools into direct
    // model-visible tool definitions. Without this flag the tool registers
    // cleanly but is confined to the `execute` tool's JS runtime — session
    // tool catalogs then yield `Unknown tool: <name>`. Additive field;
    // hosts that don't recognize the field ignore it.
    options: { codemode: false },
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
  compiledPermissions?: readonly V2PermissionRule[],
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
    } else {
      // Absence is meaningful: finalized registrations with no model inherit
      // the session model instead of retaining an earlier draft's model.
      delete agent.model;
    }
    const request = asRecord(agent.request) ?? {};
    const settings = asRecord(request.settings) ?? {};
    const requestConfig = asRecord(v1.request);
    for (const field of ['settings', 'headers', 'body']) {
      const incoming = asRecord(requestConfig?.[field]);
      if (incoming) {
        request[field] = { ...(asRecord(request[field]) ?? {}), ...incoming };
      }
    }
    Object.assign(settings, asRecord(request.settings));
    if (typeof v1.temperature === 'number') {
      settings.temperature = v1.temperature;
    }
    if (Object.keys(settings).length > 0) request.settings = settings;
    agent.request = request;
    // v2 permission evaluation is last-match-wins (findLast). v1 `tools` lists
    // which tools an agent MAY use (implicit allow); the `permission` map holds
    // explicit allow/deny. Place tools-allow FIRST so an explicit permission
    // deny later in the array wins, matching v1 precedence.
    const toolsAllow: Array<Record<string, unknown>> = [];
    if (Array.isArray(v1.tools)) {
      for (const t of v1.tools as unknown[]) {
        if (typeof t === 'string') {
          toolsAllow.push({ action: t, resource: '*', effect: 'allow' });
        }
      }
    }
    agent.permissions = compiledPermissions
      ? compiledPermissions.map((rule) => ({ ...rule }))
      : [...toolsAllow, ...adaptPermissions(v1.permission)];
  });
}

/** Capture native Agent.Info values as the host-config projection used by the
 * registry. Ordered native permissions are kept outside that v1-shaped config
 * because v1 permission maps cannot represent their order or resources. */
export function snapshotNativeAgentForRegistry(
  agent: Record<string, unknown>,
): {
  config: Record<string, unknown>;
  permissions: V2PermissionRule[];
} {
  const model = asRecord(agent.model);
  const request = asRecord(agent.request);
  const settings = asRecord(request?.settings);
  const config: Record<string, unknown> = {};

  if (typeof agent.description === 'string')
    config.description = agent.description;
  if (typeof agent.system === 'string') config.prompt = agent.system;
  if (typeof agent.mode === 'string') config.mode = agent.mode;
  if (typeof agent.hidden === 'boolean') config.hidden = agent.hidden;
  if (typeof model?.providerID === 'string' && typeof model.id === 'string') {
    config.model = `${model.providerID}/${model.id}`;
  }
  if (typeof model?.variant === 'string') config.variant = model.variant;
  if (settings) {
    if (typeof settings.temperature === 'number') {
      config.temperature = settings.temperature;
    }
  }

  // Native request headers/body are intentionally captured as host request
  // values too; applyAgentToDraft merges these into the existing request.
  if (request) {
    config.request = {
      ...(asRecord(request.settings)
        ? { settings: { ...asRecord(request.settings) } }
        : {}),
      ...(asRecord(request.headers)
        ? { headers: { ...asRecord(request.headers) } }
        : {}),
      ...(asRecord(request.body)
        ? { body: { ...asRecord(request.body) } }
        : {}),
    };
  }

  const permissions = Array.isArray(agent.permissions)
    ? agent.permissions.flatMap((rule): V2PermissionRule[] => {
        const value = asRecord(rule);
        if (
          !value ||
          typeof value.action !== 'string' ||
          typeof value.resource !== 'string' ||
          (value.effect !== 'allow' &&
            value.effect !== 'ask' &&
            value.effect !== 'deny')
        ) {
          return [];
        }
        return [
          {
            action: value.action,
            resource: value.resource,
            effect: value.effect,
          },
        ];
      })
    : [];

  return { config, permissions };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
