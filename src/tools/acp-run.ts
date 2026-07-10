import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import {
  type AcpAgentConfig,
  type AcpAgentsConfig,
  MAX_ACP_TIMEOUT_MS,
} from '../config';

const z = tool.schema;

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

class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending = new Map<number, Pending>();
  private chunks: string[] = [];
  private errors: string[] = [];
  private sessionId: string | undefined;
  private lastUpdate = Date.now();
  private authMethods: Array<Record<string, unknown>> = [];
  private active = false;
  private activeRequests = 0;

  constructor(
    private name: string,
    private config: AcpAgentConfig,
    private cwd: string,
    private ask: (
      title: string,
      metadata: Record<string, unknown>,
    ) => Promise<void>,
  ) {
    this.child = spawn(config.command, config.args, {
      cwd,
      env: { ...process.env, ...config.env },
      stdio: 'pipe',
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

  async run(prompt: string): Promise<string> {
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'oh-my-opencode-ultraslim',
        title: 'oh-my-opencode-ultraslim ACP bridge',
      },
    });
    this.authMethods = readAuthMethods(init);
    const created = await this.newSession();
    const sessionId = readSessionId(created);
    this.sessionId = sessionId;
    this.active = true;
    await this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });
    await this.drain();
    this.active = false;
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

  close(): void {
    if (this.active && this.sessionId && !this.child.killed) {
      this.notify('session/cancel', { sessionId: this.sessionId });
    }
    if (!this.child.killed) this.child.kill('SIGTERM');
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

  private notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
    );
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
      this.close();
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
          await this.ask(title, message.params ?? {});
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

  private handleNotification(message: RpcNotification): void {
    if (message.method !== 'session/update') return;
    this.lastUpdate = Date.now();
    const update = message.params?.update;
    if (!isRecord(update)) return;
    collectText(update, this.chunks);
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

export function createAcpRunTool(agents: AcpAgentsConfig = {}): ToolDefinition {
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

      const client = new AcpClient(
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
      );
      const timeoutMs = args.timeout_ms ?? config.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout =
        timeoutMs > 0
          ? new Promise<string>(
              (_, reject) =>
                (timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `ACP agent '${args.agent}' timed out after ${timeoutMs}ms`,
                      ),
                    ),
                  timeoutMs,
                )),
            )
          : undefined;
      const abort = () => client.close();
      ctx.abort.addEventListener('abort', abort, { once: true });
      try {
        const run = client.run(args.prompt);
        return timeout ? await Promise.race([run, timeout]) : await run;
      } finally {
        if (timer) clearTimeout(timer);
        ctx.abort.removeEventListener('abort', abort);
        client.close();
      }
    },
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

function readText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.text === 'string') return value.text;
  return undefined;
}
