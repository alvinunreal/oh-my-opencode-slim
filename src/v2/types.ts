/**
 * v2 plugin context surface.
 *
 * These interfaces mirror the subset of the v2 promise-plugin Context
 * (`@opencode-ai/plugin`) this adapter consumes. They are defined locally
 * because the v2 plugin package is not a build-time dependency (the v1 host
 * must be able to load the main build without v2 types installed).
 */

export interface V2AgentDraft {
  list(): Array<Record<string, unknown>>;
  get(id: string): Record<string, unknown> | undefined;
  default(id: string | undefined): void;
  update(id: string, update: (agent: Record<string, unknown>) => void): void;
  remove(id: string): void;
}
/** v2 Tool.Options registration flags (upstream `Tool.Options` subset).
 * `codemode: false` is the CodeMode opt-out: upstream `Tool.snapshot()`
 * only promotes `codemode === false` tools to direct model-visible tool
 * definitions — everything else is reachable only inside the `execute`
 * tool's confined JS runtime, so session tool catalogs yield
 * `Unknown tool: <name>` even though registration succeeded. The field
 * is additive: older hosts ignore it. */
export interface V2ToolOptions {
  codemode?: boolean;
  namespace?: string;
  permission?: string;
}
/** v2 tool payload accepted by `tool.transform` drafts (the Tool.Info
 * subset this adapter produces). */
export interface V2ToolDefinition {
  name: string;
  description: string;
  input: unknown;
  options?: V2ToolOptions;
  execute: (input: unknown, context: unknown) => Promise<unknown>;
}
export interface V2ToolDraft {
  add(tool: V2ToolDefinition): void;
}
/** A v2 command definition passed to `command.transform` drafts. The command
 * body runs `execute` directly (no template field). */
export interface V2CommandDefinition {
  name: string;
  description?: string;
  execute: (input: {
    sessionID: string;
    prompt: {
      text: string;
      files?: unknown[];
      agents?: unknown[];
      skills?: unknown[];
    };
    delivery?: unknown;
  }) => Promise<void>;
}
/** Command transform draft. v2 command drafts are add-only;
 * `V2CommandDraft` mirrors the `add()` shape. */
export interface V2CommandDraft {
  add(def: V2CommandDefinition): void;
}
export interface V2SessionContextEvent {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: Record<string, unknown>;
  system: Array<{ type: 'text'; text: string }>;
  messages: Array<{
    id?: string;
    role: string;
    content: Array<Record<string, unknown>>;
    /** Session identity on the message envelope. Live v2 hosts carry only
     * `{id, time, text, type}` on transcript user messages; the v2 context
     * bridge stamps these absence-gated so the bridged v1 injection gates
     * (phase-reminder, board, nudge) keep working. */
    sessionID?: string;
    /** Agent that handled the message (same enrichment contract). */
    agent?: string;
  }>;
  tools: Record<string, unknown>;
}
/**
 * v2 `session.prompt` hook payload: fires ONCE per admitted input (endpoint
 * prompts AND subagent-tool child prompts; synthetic/shell/compaction
 * inputs skip it). `messageID` is the eventual inbox User id — the v1
 * `chat.message` dedupe key.
 */
export interface V2SessionPromptEvent {
  readonly sessionID: string;
  readonly messageID: string;
  prompt: {
    text: string;
    files?: Array<Record<string, unknown>>;
    agents?: Array<Record<string, unknown>>;
    skills?: Array<Record<string, unknown>>;
  };
  metadata?: Record<string, unknown>;
  readonly delivery?: unknown;
}
export interface V2ToolBeforeEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  input: unknown;
}
export interface V2ToolAfterEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly input: unknown;
  readonly status: 'completed' | 'error';
  result?: unknown;
  error?: unknown;
}
export interface V2Registration {
  dispose(): Promise<void> | void;
}
/** v2 mcp transform draft (used after capability probing; RemoteConfig
 * shape see packages/schema/src/mcp.ts — no `enabled`, it uses
 * `disabled?: boolean`; the name is the map key, not in the config). */
export interface V2McpDraft {
  list(): Array<[string, Record<string, unknown>]>;
  get(name: string): Record<string, unknown> | undefined;
  set(name: string, config: Record<string, unknown>): void;
  update(name: string, update: (c: Record<string, unknown>) => void): void;
  remove(name: string): void;
}
export interface V2Context {
  readonly app: { readonly name: string; readonly version: string };
  readonly options: Record<string, unknown>;
  /** Host location (probe before use; fall back to process.cwd()). */
  readonly location?: {
    directory: string;
    workspaceID?: string;
    project: { id: string; directory: string; canonical: string };
  };
  agent: {
    transform(cb: (draft: V2AgentDraft) => void): Promise<V2Registration>;
    reload(): Promise<unknown>;
    list(): Promise<unknown>;
  };
  tool: {
    transform(cb: (draft: V2ToolDraft) => void): Promise<V2Registration>;
    hook(
      name: 'execute.before' | 'execute.after',
      cb: (event: V2ToolBeforeEvent | V2ToolAfterEvent) => Promise<void>,
    ): Promise<V2Registration>;
  };
  command: {
    transform(cb: (draft: V2CommandDraft) => void): Promise<V2Registration>;
    list(): Promise<unknown>;
  };
  session: {
    hook(
      name: 'context',
      cb: (event: V2SessionContextEvent) => Promise<void>,
    ): Promise<V2Registration>;
    /** v2 session.prompt hook — once per admitted input (see
     * V2SessionPromptEvent). Older v2 hosts reject the name; callers must
     * keep a fallback path. */
    hook(
      name: 'prompt',
      cb: (event: V2SessionPromptEvent) => Promise<void>,
    ): Promise<V2Registration>;
    /** v2 session.get — SessionInfo by id (runtime-probed). */
    get?(input: { sessionID: string }): Promise<unknown>;
    /** v2 session.remove — DELETE /api/session/:id (runtime-probed). */
    remove?(input: { sessionID: string }): Promise<unknown>;
    /** v2 session.list — query-filtered listing (runtime-probed).
     * `parentID` accepts a session id or `null`/the literal `"null"`
     * string for root-only listing. */
    list?(input: {
      directory?: string;
      parentID?: string | null;
    }): Promise<unknown>;
    /** v2 session.interrupt — `continue: false` aborts the active run. */
    interrupt?(input: {
      sessionID: string;
      continue?: boolean;
    }): Promise<unknown>;
    /** v2 session.switchModel — v2 prompts carry no model, so a model
     * change must precede the prompt (runtime-probed). */
    switchModel?(input: {
      sessionID: string;
      model: { id: string; providerID: string; variant?: string };
    }): Promise<unknown>;
    /** v2 session.context — full transcript; replaces v1 session.messages. */
    context?(input: {
      sessionID: string;
    }): Promise<Array<Record<string, unknown>>>;
    /** v2 session.prompt — flat PromptInput ({sessionID, text, files?,
     * agents?, skills?, metadata?, delivery?, resume?}). */
    prompt?(input: Record<string, unknown>): Promise<unknown>;
    /** v2 session.synthetic — like prompt but not persisted as user
     * input. `delivery` routes the inbox entry ("steer" | "queue");
     * `resume: false` admits the input WITHOUT waking the session. */
    synthetic?(input: {
      sessionID: string;
      id?: string;
      text: string;
      description?: string;
      metadata?: Record<string, unknown>;
      delivery?: 'steer' | 'queue';
      resume?: boolean;
    }): Promise<unknown>;
    /** v2 session.rename ({sessionID, title}). */
    rename?(input: Record<string, unknown>): Promise<unknown>;
    /** v2 session.switchAgent ({sessionID, agent}). */
    switchAgent?(input: Record<string, unknown>): Promise<unknown>;
  };
  event: {
    subscribe(): AsyncIterable<Record<string, unknown>>;
  };
  /** v2 storage domain (runtime-probed optional, like session.list —
   * hosts without it keep plugin state process-local). Mirrors the
   * upstream StorageDomain subset: `scan` is cursor-paginated via the
   * optional `next` field. Values are JSON. */
  readonly storage?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
      entries: Array<{ key: string; value: unknown }>;
      next?: string;
    }>;
  };
  /** v2 mcp domain (present on hosts ≥ #45408; probe before use). */
  mcp?: {
    transform(cb: (draft: V2McpDraft) => void): Promise<V2Registration>;
    reload(): Promise<void>;
  };
}

/** The v2 session domain (context hook + runtime-probed methods), declared
 * once so adapters share the exact shape. */
export type V2Session = V2Context['session'];

export type V2Cleanup = () => Promise<void> | void;

/** Parsed v2 Model.Ref derived from a v1 "provider/model" string. */
export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}
