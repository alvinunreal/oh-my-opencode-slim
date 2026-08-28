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
export interface V2ToolDraft {
  add(tool: Record<string, unknown>): void;
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
  }>;
  tools: Record<string, unknown>;
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
export interface V2Context {
  readonly app: { readonly name: string; readonly version: string };
  readonly options: Record<string, unknown>;
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
    /** v2 session.prompt — flat PromptInput ({sessionID, text, files?,
     * agents?, skills?, metadata?, delivery?, resume?}). */
    prompt?(input: Record<string, unknown>): Promise<unknown>;
    /** v2 session.synthetic — like prompt but not persisted as user input. */
    synthetic?(input: Record<string, unknown>): Promise<unknown>;
    /** v2 session.rename ({sessionID, title}). */
    rename?(input: Record<string, unknown>): Promise<unknown>;
    /** v2 session.switchAgent ({sessionID, agent}). */
    switchAgent?(input: Record<string, unknown>): Promise<unknown>;
  };
  event: {
    subscribe(): AsyncIterable<Record<string, unknown>>;
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
