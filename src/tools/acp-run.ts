import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import packageJson from '../../package.json' with { type: 'json' };
import {
  type AcpAgentConfig,
  type AcpAgentsConfig,
  MAX_ACP_TIMEOUT_MS,
  ProviderModelIdSchema,
} from '../config';

const z = tool.schema;

const ACP_CANCEL_FLUSH_MS = 250;
const ACP_GRACEFUL_EXIT_MS = 1_000;
const ACP_TERMINATE_EXIT_MS = 1_000;
const ACP_KILL_EXIT_MS = 500;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface RpcResponse {
  id: number;
  result?: Json;
  error?: { code?: number; message?: string; data?: Json };
}

interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

type Pending = {
  resolve: (value: Json | undefined) => void;
  reject: (error: Error) => void;
};

export function createAcpInitializeParams() {
  return {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: {
      name: 'oh-my-opencode-slim',
      version: packageJson.version,
    },
  };
}

class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private exitPromise: Promise<void>;
  private closePromise: Promise<void> | undefined;
  private closing = new AbortController();
  private childTerminated = false;
  private next = 1;
  private pending = new Map<number, Pending>();
  private chunks: string[] = [];
  private errors: string[] = [];
  private progress = new Map<string, string>();
  private sessionId: string | undefined;
  private lastUpdate = Date.now();
  private authMethods: Array<Record<string, unknown>> = [];
  private active = false;
  private activeRequests = 0;
  /** True once run() returned or the client was closed: late session/update arrivals are ignored. */
  private settled = false;

  constructor(
    private name: string,
    private config: AcpAgentConfig,
    private cwd: string,
    private ask: (
      title: string,
      metadata: Record<string, unknown>,
    ) => Promise<void>,
    /**
     * Live progress sink (tool part metadata). Called on every tool_call,
     * tool_call_update, and plan session/update so the parent TUI can show
     * what the external agent is doing while it works.
     */
    private report?: (title: string, metadata: Record<string, unknown>) => void,
  ) {
    this.child = spawn(config.command, config.args, {
      cwd,
      env: { ...process.env, ...config.env },
      stdio: 'pipe',
      // Console-subsystem agents would otherwise show a console window for
      // the whole agent run on GUI hosts.
      windowsHide: true,
    });
    this.exitPromise = new Promise((resolve) => {
      const settle = () => {
        this.child.off('exit', settle);
        this.child.off('close', settle);
        this.childTerminated = true;
        resolve();
      };
      this.child.once('exit', settle);
      this.child.once('close', settle);
    });
    this.child.stderr.on('data', (chunk) => {
      this.errors.push(String(chunk));
    });
    this.child.stdin.on('error', (error) => {
      this.errors.push(String(error));
      this.rejectPending(error);
    });
    this.child.on('error', (error) => {
      this.rejectPending(error);
    });
    this.child.on('exit', (code, signal) => {
      if (this.pending.size === 0) return;
      this.rejectPending(
        new Error(
          `ACP agent '${name}' exited before replying (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
        ),
      );
    });

    createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.receive(line).catch((error) => {
        this.errors.push(String(error));
      });
    });
  }

  async run(prompt: string, model?: string): Promise<string> {
    const init = await this.request('initialize', createAcpInitializeParams());
    this.authMethods = readAuthMethods(init);
    const created = await this.newSession();
    const sessionId = readSessionId(created);
    this.sessionId = sessionId;
    if (model !== undefined) {
      const option = readModelConfigOption(created);
      if (!supportsModelValue(option.options, model)) {
        throw new Error(`ACP model config option does not support '${model}'`);
      }
      const updated = await this.request('session/set_config_option', {
        sessionId,
        configId: option.id,
        value: model,
      });
      const confirmed = readModelConfigOption(updated);
      if (confirmed.id !== option.id || confirmed.currentValue !== model) {
        throw new Error(`ACP model selection was not confirmed as '${model}'`);
      }
    }
    this.active = true;
    await this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });
    await this.drain();
    this.active = false;
    this.settled = true;
    return this.output();
  }
  private async newSession(): Promise<Json | undefined> {
    try {
      return await this.request('session/new', {
        cwd: this.cwd,
        mcpServers: [],
      });
    } catch (error) {
      if (!isAuthError(error) || this.authMethods.length === 0) throw error;
      const method = this.authMethods[0];
      if (typeof method.id !== 'string') throw error;
      await this.request('authenticate', { methodId: method.id });
      return await this.request('session/new', {
        cwd: this.cwd,
        mcpServers: [],
      });
    }
  }
  close(): Promise<void> {
    this.settled = true;
    this.closing.abort();
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  private async shutdown(): Promise<void> {
    if (this.hasExited()) return;

    if (this.active && this.sessionId) {
      await this.withTimeout(
        this.notify('session/cancel', { sessionId: this.sessionId }),
        ACP_CANCEL_FLUSH_MS,
      );
    }

    if (!this.hasExited()) this.child.stdin.end();
    if (await this.waitForExit(ACP_GRACEFUL_EXIT_MS)) return;

    this.child.kill('SIGTERM');
    if (await this.waitForExit(ACP_TERMINATE_EXIT_MS)) return;

    this.child.kill('SIGKILL');
    await this.waitForExit(ACP_KILL_EXIT_MS);
  }

  private hasExited(): boolean {
    return (
      this.childTerminated ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    );
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.hasExited()) return true;
    return await this.withTimeout(this.exitPromise, timeoutMs);
  }

  private async withTimeout(
    promise: Promise<void>,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Json | undefined> {
    const id = this.next++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  private async drain(): Promise<void> {
    this.lastUpdate = Date.now();
    while (this.activeRequests > 0 || Date.now() - this.lastUpdate < 100) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async receive(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: RpcResponse | RpcRequest | RpcNotification;
    try {
      message = JSON.parse(line) as RpcResponse | RpcRequest | RpcNotification;
    } catch {
      const error = new Error(
        `ACP agent '${this.name}' wrote non-JSON stdout: ${line.slice(0, 200)}`,
      );
      this.errors.push(error.message);
      this.rejectPending(error);
      void this.close();
      return;
    }
    if ('id' in message && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(rpcError(message.error));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if ('id' in message && 'method' in message) {
      this.activeRequests++;
      try {
        await this.handleRequest(message);
      } finally {
        this.activeRequests--;
        this.lastUpdate = Date.now();
      }
      return;
    }
    if ('method' in message) this.handleNotification(message);
  }

  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }

  private async handleRequest(message: RpcRequest): Promise<void> {
    if (message.method === 'session/request_permission') {
      const title = readPermissionTitle(message.params);
      try {
        if (this.config.permissionMode === 'ask') {
          const answered = await this.askBeforeClose(
            title,
            message.params ?? {},
          );
          if (!answered) return;
        }
        const optionId = selectPermissionOption(
          message.params,
          this.config.permissionMode,
        );
        if (!optionId)
          throw new Error('ACP permission request had no usable option');
        this.reply(message.id, {
          outcome: { outcome: 'selected', optionId },
        });
      } catch {
        const optionId = selectPermissionOption(message.params, 'reject');
        if (optionId) {
          this.reply(message.id, {
            outcome: { outcome: 'selected', optionId },
          });
          return;
        }
        this.reply(message.id, { outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    this.replyError(
      message.id,
      `Unsupported ACP client method: ${message.method}`,
    );
  }

  private async askBeforeClose(
    title: string,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.closing.signal.aborted) return false;
    return await new Promise<boolean>((resolve, reject) => {
      const onAbort = () => {
        this.closing.signal.removeEventListener('abort', onAbort);
        resolve(false);
      };
      this.closing.signal.addEventListener('abort', onAbort, { once: true });
      this.ask(title, metadata).then(
        () => {
          this.closing.signal.removeEventListener('abort', onAbort);
          resolve(true);
        },
        (error) => {
          this.closing.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }
  private handleNotification(message: RpcNotification): void {
    if (message.method !== 'session/update' || this.settled) return;
    this.lastUpdate = Date.now();
    const update = message.params?.update;
    if (!isRecord(update)) return;
    collectText(update, this.chunks);
    const rendered = trackProgress(update, this.progress);
    if (!rendered) return;
    try {
      this.report?.(rendered.title, { progress: rendered.progress });
    } catch {
      // A host-side metadata failure must not poison the ACP loop.
    }
  }

  private reply(id: number, result: Json): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`,
    );
  }

  private replyError(id: number, message: string): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } })}\n`,
    );
  }

  private output(): string {
    const text = this.chunks.join('').trim();
    if (text) return text;
    const err = this.errors.join('').trim();
    return err
      ? `ACP agent '${this.name}' completed without text output. stderr:\n${err}`
      : `ACP agent '${this.name}' completed without text output.`;
  }
}

/** Read only the V2 session.get response shape, not message/agent defaults. */
export function readAcpSessionModel(response: unknown): string {
  if (isRecord(response) && response.error != null) {
    throw new Error('ACP model following session.get failed');
  }
  const data = isRecord(response) ? response.data : undefined;
  const model = isRecord(data) ? data.model : undefined;
  if (
    !isRecord(model) ||
    typeof model.providerID !== 'string' ||
    !/^[^/\s]+$/.test(model.providerID) ||
    typeof model.id !== 'string'
  ) {
    throw new Error(
      'ACP model following requires session.get data.model with V2 {providerID, id}',
    );
  }
  const parsed = ProviderModelIdSchema.safeParse(
    `${model.providerID}/${model.id}`,
  );
  if (!parsed.success) {
    throw new Error('ACP model following received an invalid session model');
  }
  return parsed.data;
}

export function createAcpRunTool(
  agents: AcpAgentsConfig = {},
  resolveSessionModel?: (sessionID: string) => Promise<string>,
): ToolDefinition {
  return tool({
    description:
      'Run a configured external ACP-compatible coding agent and return its streamed result. Use for configured ACP agents such as Claude Code ACP, Gemini ACP, or custom ACP servers.',
    args: {
      agent: z.string().describe('Configured ACP agent name'),
      prompt: z.string().describe('Task or question to send to the ACP agent'),
      cwd: z
        .string()
        .optional()
        .describe('Optional absolute working directory override'),
      timeout_ms: z
        .number()
        .int()
        .min(0)
        .max(MAX_ACP_TIMEOUT_MS)
        .optional()
        .describe(
          'Optional timeout override in milliseconds. Set to 0 to disable the timeout.',
        ),
    },
    async execute(args, ctx) {
      if (ctx.agent !== args.agent) {
        throw new Error(
          `acp_run for '${args.agent}' can only be used by @${args.agent}`,
        );
      }
      const config = agents[args.agent];
      if (!config) {
        throw new Error(
          `Unknown ACP agent '${args.agent}'. Configured agents: ${Object.keys(agents).join(', ') || '(none)'}`,
        );
      }
      const cwd = args.cwd ?? config.cwd ?? ctx.directory;
      if (!cwd) throw new Error('acp_run requires a working directory');

      await ctx.ask({
        permission: 'acp_run',
        patterns: [`${config.command} ${config.args.join(' ')}`.trim()],
        always: [],
        metadata: {
          agent: args.agent,
          cwd,
          command: config.command,
          args: config.args,
        },
      });

      let client: AcpClient | undefined;
      let requestedModel: string | undefined;
      let acpModel: string | undefined;
      const timeoutMs = args.timeout_ms ?? config.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped: Error | undefined;
      let stop!: (error: Error) => void;
      const interruption = new Promise<never>((_, reject) => {
        stop = (error) => {
          stopped ??= error;
          reject(stopped);
        };
      });
      const aborted = () => new Error(`ACP agent '${args.agent}' aborted`);
      const abort = () => {
        // Preserve legacy close-only aborts when model following is disabled.
        if (config.modelMap !== undefined) stop(aborted());
        void client?.close();
      };
      try {
        // One budget covers the model lookup and ACP run, after permission.
        if (timeoutMs > 0) {
          timer = setTimeout(
            () =>
              stop(
                new Error(
                  `ACP agent '${args.agent}' timed out after ${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          );
        }
        ctx.abort.addEventListener('abort', abort, { once: true });
        const run = async () => {
          if (ctx.abort.aborted) throw aborted();
          // One invocation-local snapshot, before spawn.
          if (config.modelMap !== undefined) {
            if (!resolveSessionModel) {
              throw new Error(
                'ACP model following requires resolveSessionModel',
              );
            }
            if (!ctx.sessionID) {
              throw new Error('ACP model following requires sessionID');
            }
            try {
              requestedModel = await resolveSessionModel(ctx.sessionID);
            } catch (error) {
              throw new Error(
                `ACP model following could not read session '${ctx.sessionID}': ${String(error)}`,
              );
            }
            // The lookup cannot be cancelled; a late result must not spawn ACP.
            if (stopped) throw stopped;
            if (!ProviderModelIdSchema.safeParse(requestedModel).success) {
              throw new Error(
                'ACP model following received an invalid model reference',
              );
            }
            if (!Object.hasOwn(config.modelMap, requestedModel)) {
              throw new Error(
                `ACP agent '${args.agent}' modelMap has no mapping for '${requestedModel}'; refusing to start the default model`,
              );
            }
            acpModel = config.modelMap[requestedModel];
            if (typeof acpModel !== 'string' || acpModel.length === 0) {
              throw new Error(
                `ACP modelMap has an invalid value for '${requestedModel}'`,
              );
            }
          }
          client = new AcpClient(
            args.agent,
            config,
            cwd,
            async (title, metadata) => {
              if (config.permissionMode === 'reject') return;
              await ctx.ask({
                permission: 'acp_run',
                patterns: [`acp:${args.agent}:${title}`],
                always: [],
                metadata,
              });
            },
            (title, metadata) => ctx.metadata({ title, metadata }),
          );
          return await client.run(args.prompt, acpModel);
        };
        const output = await Promise.race([run(), interruption]);
        if (requestedModel !== undefined) {
          try {
            ctx.metadata?.({ metadata: { requestedModel, acpModel } });
          } catch {
            // A host-side metadata failure must not discard successful output.
          }
        }
        return output;
      } finally {
        if (timer) clearTimeout(timer);
        ctx.abort.removeEventListener('abort', abort);
        await client?.close();
      }
    },
  });
}

function readModelConfigOption(value: unknown): Record<string, unknown> {
  const options = isRecord(value) ? value.configOptions : undefined;
  const models = Array.isArray(options)
    ? options
        .filter(isRecord)
        .filter(
          (option) => option.id === 'model' || option.category === 'model',
        )
    : [];
  const model = models[0];
  if (
    models.length !== 1 ||
    typeof model.id !== 'string' ||
    !model.id ||
    model.type !== 'select'
  ) {
    throw new Error(
      'ACP response must contain exactly one model config option',
    );
  }
  return model;
}

function supportsModelValue(options: unknown, value: string): boolean {
  if (!Array.isArray(options)) return false;
  return options.filter(isRecord).some((option) => {
    // ACP select options may be flat values or groups of values.
    if (Array.isArray(option.options)) {
      return option.options
        .filter(isRecord)
        .some((item) => item.value === value);
    }
    return option.value === value;
  });
}

function readSessionId(value: Json | undefined): string {
  if (!isRecord(value) || typeof value.sessionId !== 'string') {
    throw new Error('ACP agent did not return a sessionId');
  }
  return value.sessionId;
}

function readAuthMethods(
  value: Json | undefined,
): Array<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.authMethods)) return [];
  const methods: unknown[] = value.authMethods;
  return methods.filter(isRecord);
}

function rpcError(error: NonNullable<RpcResponse['error']>): Error {
  const err = new Error(error.message ?? 'ACP request failed') as Error & {
    code?: number;
    data?: Json;
  };
  err.code = error.code;
  err.data = error.data;
  return err;
}

function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const meta = error as Error & { code?: number; data?: Json };
  return (
    meta.code === -32001 ||
    error.message.toLowerCase().includes('auth_required') ||
    error.message.toLowerCase().includes('auth required')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPermissionTitle(
  params: Record<string, unknown> | undefined,
): string {
  const tool = isRecord(params?.toolCall) ? params.toolCall : undefined;
  if (typeof tool?.title === 'string') return tool.title;
  if (typeof params?.permission === 'string') return params.permission;
  return 'ACP permission request';
}

function selectPermissionOption(
  params: Record<string, unknown> | undefined,
  mode: AcpAgentConfig['permissionMode'],
): string | undefined {
  const options = Array.isArray(params?.options) ? params.options : [];
  const choices = options
    .filter(isRecord)
    .filter((item) => typeof item.optionId === 'string');
  const reject = choices.find(
    (item) => typeof item.kind === 'string' && item.kind.startsWith('reject'),
  );
  if (mode === 'reject') return reject?.optionId as string | undefined;
  const allow = choices.find(
    (item) => typeof item.kind === 'string' && item.kind.startsWith('allow'),
  );
  return (allow?.optionId ?? reject?.optionId) as string | undefined;
}

function collectText(update: Record<string, unknown>, chunks: string[]): void {
  if (update.sessionUpdate !== 'agent_message_chunk') return;
  const text = readText(update.delta) ?? readText(update.content);
  if (text) chunks.push(text);
}

const PROGRESS_GLYPHS: Record<string, string> = {
  pending: '○',
  in_progress: '▸',
  completed: '✓',
  failed: '✗',
};
/** Rolling progress cap: drop the oldest tracked call beyond this. */
const PROGRESS_CAP = 40;
/** How many recent progress lines the TUI metadata carries. */
const PROGRESS_TAIL = 20;

/**
 * Fold one ACP session/update into the rolling progress log and render the
 * latest view. tool_call/tool_call_update are keyed by toolCallId (later
 * updates replace earlier state); plan replaces as a block. Returns the
 * tail for the TUI plus its last line as a compact title.
 */
export function trackProgress(
  update: Record<string, unknown>,
  progress: Map<string, string>,
): { title: string; progress: string } | undefined {
  const kind = update.sessionUpdate;
  let key: string | undefined;
  let line: string | undefined;
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    if (typeof update.toolCallId !== 'string') return undefined;
    key = update.toolCallId;
    const status = typeof update.status === 'string' ? update.status : '';
    const glyph = PROGRESS_GLYPHS[status] ?? '·';
    // tool_call_update may omit title (status-only): keep the human-readable
    // label already rendered for this toolCallId instead of degrading to the
    // opaque id.
    const previousLine = progress.get(key);
    const previousTitle = previousLine?.slice(previousLine.indexOf(' ') + 1);
    const title =
      typeof update.title === 'string' ? update.title : (previousTitle ?? key);
    line = `${glyph} ${title}`;
  } else if (kind === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const lines = entries
      .filter(
        (entry): entry is Record<string, unknown> & { content: string } =>
          isRecord(entry) &&
          typeof entry.content === 'string' &&
          entry.content.length > 0,
      )
      .map((entry) => {
        const status = typeof entry.status === 'string' ? entry.status : '';
        const glyph = PROGRESS_GLYPHS[status] ?? '·';
        return `${glyph} ${entry.content}`.trimEnd();
      });
    if (lines.length === 0) return undefined;
    key = 'plan';
    line = lines.join('\n');
  }
  if (!key || !line) return undefined;
  if (!progress.has(key) && progress.size >= PROGRESS_CAP) {
    const oldest = progress.keys().next().value;
    if (oldest !== undefined) progress.delete(oldest);
  }
  // Re-set so an updated call lands at the newest tail position; otherwise
  // a late completion of an old call stays outside the visible tail.
  progress.delete(key);
  progress.set(key, line);
  const tail = [...progress.values()]
    .join('\n')
    .split('\n')
    .slice(-PROGRESS_TAIL)
    .join('\n');
  const lastBreak = tail.lastIndexOf('\n');
  const title = lastBreak === -1 ? tail : tail.slice(lastBreak + 1);
  return { title, progress: tail };
}

function readText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.text === 'string') return value.text;
  return undefined;
}
