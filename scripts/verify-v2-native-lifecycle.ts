#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
/**
 * Packed-artifact, headless OpenCode 2.2.6 lifecycle verification.
 *
 * Build first, then run:
 *   bun scripts/verify-v2-native-lifecycle.ts
 *   bun scripts/verify-v2-native-lifecycle.ts --restart=running
 * --self-check validates the harness without packing or launching a host.
 * Evidence stays under /tmp/opencode/v2-native-lifecycle/. No source imports,
 * user config, external model, service discovery, or plugin job state is used.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type RecordValue = Record<string, unknown>;
type Session = {
  id: string;
  parentID?: string;
  agent?: string;
  outcome?: string;
  model?: { providerID: string; id: string };
};
type Message = {
  id: string;
  type: string;
  text?: string;
  metadata?: RecordValue;
  content?: Array<{
    type: string;
    name?: string;
    text?: string;
    state?: { status: string; content?: unknown; error?: unknown };
  }>;
};
type ModelRequest = {
  model: string;
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string; parameters?: unknown } }>;
};
type Action =
  | { text: string; hold?: string }
  | { tool: string; input: RecordValue; hold?: string };
type Plan = { id: string; actions: Action[]; index: number };
type Evidence = {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  details?: unknown;
};
type PluginInfo = {
  id?: string;
  state: { status: string; error?: string };
};
type Mode = 'default' | 'native' | 'off';
type PackEntry = { filename?: string };

const ROOT = '/tmp/opencode/v2-native-lifecycle';
const HOST = process.env.V2_LIFECYCLE_HOST ?? 'opencode2';
const REPO = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const options = {
  selfCheck: args.includes('--self-check'),
  restart:
    args.find((arg) => arg.startsWith('--restart='))?.split('=')[1] ?? 'none',
  modes: (
    args.find((arg) => arg.startsWith('--modes='))?.split('=')[1] ??
    'default,native,off'
  ).split(',') as Mode[],
};
assert(
  options.modes.every((mode) => ['default', 'native', 'off'].includes(mode)),
  'Unknown --modes value',
);
assert(
  ['none', 'running'].includes(options.restart),
  'Use --restart=none or --restart=running',
);
assert(
  args.every(
    (arg) =>
      arg === '--self-check' ||
      arg.startsWith('--modes=') ||
      arg.startsWith('--restart='),
  ),
  'Unknown argument',
);

function object(value: unknown): RecordValue {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected an object',
  );
  return value as RecordValue;
}
function data<T>(value: unknown): T {
  const result = object(value);
  return (result.data ?? value) as T;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(
  label: string,
  promise: Promise<T>,
  milliseconds = 30_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out (${milliseconds} ms)`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function logTexts(root: string) {
  const texts: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.log'))
        texts.push(
          await Bun.file(full)
            .text()
            .catch(() => ''),
        );
    }
  };
  await walk(root);
  return texts.join('\n');
}
async function poll<T>(
  label: string,
  probe: () => Promise<T | undefined>,
  milliseconds = 30_000,
): Promise<T> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    assert(Date.now() < deadline, `${label} timed out`);
    // Real OS-process/SQLite/HTTP readiness: back off between predicate reads.
    // This interval never represents guessed execution or completion settling.
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
}
function chunk(delta: unknown, finish: string) {
  return `data: ${JSON.stringify({
    id: 'local-lifecycle',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'local',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\ndata: [DONE]\n\n`;
}
function response(action: Action, id: string) {
  return new Response(
    'text' in action
      ? chunk({ role: 'assistant', content: action.text }, 'stop')
      : chunk(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: {
                  name: action.tool,
                  arguments: JSON.stringify(action.input),
                },
              },
            ],
          },
          'tool_calls',
        ),
    {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    },
  );
}
function renderedText(messages: Message[]) {
  return messages
    .flatMap(
      (message) =>
        message.text ??
        message.content?.map((part) => part.text ?? '').join('\n') ??
        '',
    )
    .join('\n');
}
function toolParts(messages: Message[], tool: string) {
  return messages
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === 'tool' && part.name === tool);
}
function toolText(messages: Message[], tool: string) {
  return toolParts(messages, tool)
    .map((part) => JSON.stringify(part.state))
    .join('\n');
}

function createModel() {
  const plans = new Map<string, Plan>();
  const holds = new Map<string, ReturnType<typeof deferred<void>>>();
  const reached = new Set<string>();
  const requests: Array<{ plan?: string; index?: number; body: ModelRequest }> =
    [];
  const failures: string[] = [];
  let sequence = 0;
  function plan(role: 'parent' | 'child', actions: Action[]) {
    const id = `${role === 'parent' ? 'P' : 'C'}${++sequence}`;
    plans.set(id, { id, actions, index: 0 });
    return `[HARNESS:${id}]`;
  }
  function release(name: string) {
    reached.add(`released:${name}`);
    holds.get(name)?.resolve();
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Held responses are released by real event barriers; Bun's default 10 s
    // idle timeout must not manufacture a provider failure during a barrier.
    idleTimeout: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith('/chat/completions'))
        return new Response('Not found', { status: 404 });
      const body = (await request.json()) as ModelRequest;
      const prefix = body.model === 'child' ? 'C' : 'P';
      const transcript = body.messages
        .filter((message) => message.role === 'user')
        .map((message) => JSON.stringify(message.content))
        .join('\n');
      const matches = [
        ...transcript.matchAll(
          new RegExp(`\\[HARNESS:(${prefix}[0-9]+)\\]`, 'g'),
        ),
      ];
      const selected = plans.get(matches.at(-1)?.[1] ?? '');
      // Title/summary requests have no scripted marker and are harmless local calls.
      if (!selected) {
        requests.push({ body });
        return response({ text: 'LOCAL_LIFECYCLE_TITLE' }, 'stop');
      }
      const index = selected.index++;
      requests.push({ plan: selected.id, index, body });
      if (requests.length > 300 || index > selected.actions.length + 12) {
        failures.push(`Unexpected request loop in ${selected.id}`);
        return new Response('Local harness request budget exceeded', {
          status: 400,
        });
      }
      const action = selected.actions[index] ?? {
        text: `SCRIPT_DONE_${selected.id}`,
      };
      if (
        'tool' in action &&
        !body.tools?.some((tool) => tool.function?.name === action.tool)
      ) {
        failures.push(
          `${selected.id}: ${action.tool} absent from model-visible tools`,
        );
        return new Response(`Scripted tool ${action.tool} is unavailable`, {
          status: 400,
        });
      }
      if (action.hold) {
        const gate = deferred<void>();
        holds.set(action.hold, gate);
        reached.add(action.hold);
        if (!reached.has(`released:${action.hold}`)) {
          const aborted = new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else
              request.signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
          await Promise.race([gate.promise, aborted]);
        }
      }
      return response(action, `call_${selected.id}_${index}`);
    },
  });
  return {
    server,
    plan,
    release,
    reached,
    requests,
    failures,
    async wait(name: string) {
      await poll(`mock barrier ${name}`, async () =>
        reached.has(name) ? true : undefined,
      );
    },
    stop() {
      for (const gate of holds.values()) gate.resolve();
      server.stop(true);
    },
  };
}
type Model = ReturnType<typeof createModel>;

async function command(
  commandArgs: string[],
  cwd: string,
  log: string,
  env?: Record<string, string | undefined>,
) {
  const process = Bun.spawn(commandArgs, {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await bounded(
    commandArgs[0],
    Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]),
    90_000,
  ).catch((error) => {
    process.kill('SIGKILL');
    throw error;
  });
  await writeFile(log, `${stdout}\n${stderr}`);
  assert.equal(
    code,
    0,
    `${commandArgs.slice(0, 2).join(' ')} exited ${code}; ${log}`,
  );
  return stdout;
}

function parsePackJson(output: string): PackEntry[] {
  // Same npm array / name-keyed object parsing as verify-release-artifact.ts.
  const arrayStart = output.indexOf('[');
  const objectStart = output.indexOf('{');
  if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
    const end = output.lastIndexOf(']');
    assert(end !== -1 && end >= arrayStart, 'Could not locate npm pack JSON');
    return JSON.parse(output.slice(arrayStart, end + 1)) as PackEntry[];
  }
  const end = output.lastIndexOf('}');
  assert(
    objectStart !== -1 && end !== -1 && end >= objectStart,
    'Could not locate npm pack JSON',
  );
  const parsed = JSON.parse(output.slice(objectStart, end + 1)) as Record<
    string,
    PackEntry | PackEntry[]
  >;
  return Object.values(parsed).flat();
}

const AGENTS = [
  'orchestrator',
  'explorer',
  'fixer',
  'oracle',
  'designer',
  'observer',
  'council',
];
function pluginConfig(mode: Mode | 'managed') {
  return {
    preset: 'local-lifecycle',
    presets: {
      'local-lifecycle': Object.fromEntries(
        AGENTS.map((agent) => [
          agent,
          {
            model: `capture/${agent === 'orchestrator' ? 'parent' : 'child'}`,
          },
        ]),
      ),
    },
    agents: { explorer: { permission: { read: 'ask' } } },
    ...(mode === 'default' ? {} : { backgroundJobs: { mode } }),
    tui: false,
    sidebar: false,
    liveConfigRefresh: false,
    interview: { enabled: false },
    marketplace: { enabled: false },
    companion: { enabled: false },
    fallback: { enabled: false },
    multiplexer: { type: 'none' },
    disabled_mcps: ['context7', 'gh_grep'],
    disabled_tools: [
      'webfetch',
      'acp_run',
      'ast_grep_search',
      'ast_grep_replace',
    ],
    disabled_hooks: [
      'auto-update-checker',
      'foreground-fallback',
      'phase-reminder',
      'json-error-recovery',
      'absolute-path-rescue',
      'cache-monitor',
      'apply-patch',
      'deepwork-goal',
      'chat-headers',
      'tool-loop-guard',
      'search-path-guard',
      'council-inject',
    ],
    disabled_commands: ['interview', 'implement', 'deepwork', 'reflect'],
  };
}
function hostConfig(installed: string, model: Model) {
  return {
    model: 'capture/parent',
    default_agent: 'orchestrator',
    plugins: [pathToFileURL(installed).href],
    update: 'disable',
    share: 'disabled',
    snapshots: false,
    providers: {
      capture: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: {
          baseURL: `http://127.0.0.1:${model.server.port}/v1`,
          apiKey: 'local-lifecycle-only',
          timeout: 120_000,
        },
        models: Object.fromEntries(
          ['parent', 'child'].map((id) => [
            id,
            {
              name: id,
              limit: { context: 200_000, output: 4_000 },
              capabilities: { tools: true },
            },
          ]),
        ),
      },
    },
  };
}

class Host {
  readonly events: RecordValue[] = [];
  readonly env: Record<string, string | undefined>;
  readonly dbPath: string;
  readonly workspace: string;
  private process?: ReturnType<typeof Bun.spawn>;
  private controller?: AbortController;
  private eventReader?: Promise<void>;
  private capture?: Promise<unknown>;
  private headers: Record<string, string> = {};
  private url = '';
  private generation = 0;
  private stopped = true;
  constructor(
    readonly root: string,
    readonly model: Model,
  ) {
    this.dbPath = path.join(root, 'host.db');
    this.workspace = path.join(root, 'workspace');
    this.env = {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      HOME: path.join(root, 'home'),
      USERPROFILE: path.join(root, 'home'),
      TMPDIR: path.join(root, 'tmp'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_STATE_HOME: path.join(root, 'state'),
      OPENCODE_CONFIG_DIR: path.join(root, 'config', 'opencode'),
      OPENCODE_DB: this.dbPath,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_FILEWATCHER_DISABLE: 'true',
      OPENCODE_DISABLE_FFF: 'true',
    };
  }
  async configure(installed: string, mode: Mode | 'managed') {
    for (const directory of [
      'home',
      'tmp',
      'config/opencode',
      'data',
      'cache',
      'state',
      'workspace',
    ]) {
      await mkdir(path.join(this.root, directory), { recursive: true });
    }
    await writeFile(
      path.join(this.env.OPENCODE_CONFIG_DIR as string, 'opencode.json'),
      JSON.stringify(hostConfig(installed, this.model), null, 2),
    );
    await writeFile(
      path.join(
        this.env.OPENCODE_CONFIG_DIR as string,
        'oh-my-opencode-slim.json',
      ),
      JSON.stringify(pluginConfig(mode), null, 2),
    );
    await writeFile(
      path.join(this.workspace, '.env'),
      'LIFECYCLE_SENSITIVE_SENTINEL=must_not_reach_model\n',
    );
  }
  async start() {
    assert(this.stopped, 'Host is already owned by the harness');
    const generation = ++this.generation;
    this.stopped = false;
    this.process = Bun.spawn(
      [
        HOST,
        'serve',
        '--service',
        '--hostname',
        '127.0.0.1',
        '--port',
        '0',
        '--log-level',
        'debug',
        '--print-logs',
      ],
      {
        cwd: this.workspace,
        env: this.env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const child = this.process;
    this.capture = Promise.all([
      new Response(child.stdout)
        .text()
        .then((text) =>
          writeFile(
            path.join(this.root, `host-${generation}.stdout.log`),
            text,
          ),
        ),
      new Response(child.stderr)
        .text()
        .then((text) =>
          writeFile(
            path.join(this.root, `host-${generation}.stderr.log`),
            text,
          ),
        ),
    ]);
    const registration = await poll(
      'isolated service registration',
      async () => {
        assert(
          child.exitCode === null,
          `Host exited before registration (${child.exitCode})`,
        );
        const files = await readdir(
          path.join(this.root, 'state', 'opencode'),
        ).catch(() => [] as string[]);
        for (const file of files.filter((file) =>
          /^service(?:-.*)?\.json$/.test(file),
        )) {
          const value = (await Bun.file(
            path.join(this.root, 'state', 'opencode', file),
          )
            .json()
            .catch(() => undefined)) as
            | { pid?: number; url?: string; password?: string }
            | undefined;
          if (value?.pid === child.pid && value.url && value.password)
            return value;
        }
        return undefined;
      },
      60_000,
    );
    this.url = registration.url as string;
    this.headers = {
      authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}`,
    };
    const info = await poll(
      'registered service HTTP readiness',
      async () => {
        const result = await this.raw('/api/info').catch(() => undefined);
        return result?.ok ? object(await result.json()) : undefined;
      },
      60_000,
    );
    assert(
      JSON.stringify(info).includes('2.2.6'),
      'The registered host is not OpenCode 2.2.6',
    );
    await writeFile(
      path.join(this.root, `host-${generation}.identity.json`),
      JSON.stringify({ pid: child.pid, url: this.url, info }, null, 2),
    );
    this.controller = new AbortController();
    const source = await this.raw('/api/event', {
      signal: this.controller.signal,
    });
    assert(source.ok && source.body, 'Host event stream unavailable');
    this.eventReader = this.readEvents(source);
    await poll('host event subscription', async () =>
      this.events.some((event) => event.type === 'server.connected')
        ? true
        : undefined,
    );
  }
  private async readEvents(source: Response) {
    try {
      let pending = '';
      const reader = source.body?.getReader();
      assert(reader);
      const decoder = new TextDecoder();
      for (;;) {
        const entry = await reader.read();
        if (entry.done) break;
        pending += decoder
          .decode(entry.value, { stream: true })
          .replaceAll('\r\n', '\n');
        const frames = pending.split('\n\n');
        pending = frames.pop() ?? '';
        for (const frame of frames) {
          const text = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (!text) continue;
          this.events.push(object(JSON.parse(text)));
        }
      }
    } catch (error) {
      if (!this.controller?.signal.aborted && !this.stopped) throw error;
    }
  }
  async raw(route: string, init?: RequestInit) {
    const url = new URL(route, this.url);
    if (
      [
        '/api/agent',
        '/api/plugin',
        '/api/command',
        '/api/tool',
        '/api/config',
      ].includes(url.pathname) ||
      url.pathname.startsWith('/api/rpc/')
    ) {
      url.searchParams.set('location[directory]', this.workspace);
    }
    return fetch(url, {
      ...init,
      headers: {
        ...this.headers,
        'content-type': 'application/json',
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });
  }
  async request<T>(
    route: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
  ): Promise<T> {
    const result = await this.raw(route, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await result.text();
    assert(
      result.ok,
      `${method} ${route}: ${result.status} ${text.slice(0, 2_000)}`,
    );
    return text ? data<T>(JSON.parse(text)) : (undefined as T);
  }
  async create(title: string, parentID?: string) {
    return this.request<Session>('/api/session', {
      title,
      agent: parentID ? 'explorer' : 'orchestrator',
      model: { providerID: 'capture', id: parentID ? 'child' : 'parent' },
      ...(parentID
        ? { parentID }
        : { location: { directory: this.workspace } }),
    });
  }
  async messages(sessionID: string) {
    return this.request<Message[]>(`/api/session/${sessionID}/context`);
  }
  async prompt(sessionID: string, marker: string, extras: RecordValue = {}) {
    return this.request<RecordValue>(`/api/session/${sessionID}/prompt`, {
      text: marker,
      ...extras,
    });
  }
  async idle(sessionID: string) {
    await poll(`session ${sessionID} idle`, async () => {
      const active = await this.request<RecordValue>('/api/session/active');
      return active[sessionID] === undefined ? true : undefined;
    });
  }
  async contains(sessionID: string, text: string) {
    return poll(`session ${sessionID}: ${text}`, async () => {
      const messages = await this.messages(sessionID);
      return renderedText(messages).includes(text) ? messages : undefined;
    });
  }
  rows(sql: string, ...values: string[]) {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      return db.query(sql).all(...values) as RecordValue[];
    } finally {
      db.close();
    }
  }
  children(parentID: string) {
    return this.rows(
      'select id, parent_id, agent from session_v2 where parent_id = ? order by time_created',
      parentID,
    );
  }
  async child(parentID: string, expected = 1) {
    return poll(`parent ${parentID}: ${expected} children`, async () => {
      const children = this.children(parentID);
      assert(
        children.length <= expected,
        `Unexpected additional child for ${parentID}`,
      );
      return children.length === expected
        ? String(children.at(-1)?.id)
        : undefined;
    });
  }
  notices(parentID: string, childID: string) {
    return this.events.filter((event) => {
      if (event.type !== 'session.inbox.enqueued') return false;
      const payload = object(event.data);
      if (payload.sessionID !== parentID) return false;
      const item = object(payload.item);
      const synthetic = object(item.payload);
      const metadata = synthetic.metadata as RecordValue | undefined;
      return metadata?.source === 'subagent' && metadata.childID === childID;
    });
  }
  async runTools(sessionID: string, actions: Action[], final: string) {
    const marker = this.model.plan('parent', [...actions, { text: final }]);
    await this.prompt(sessionID, marker);
    await this.contains(sessionID, final);
    await this.idle(sessionID);
    return this.messages(sessionID);
  }
  async stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
    if (!this.process || this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    this.process.kill(signal);
    await bounded('owned host shutdown', this.process.exited, 8_000).catch(
      async () => {
        this.process?.kill('SIGKILL');
        await this.process?.exited;
      },
    );
    await this.capture;
    await this.eventReader;
    await writeFile(
      path.join(this.root, 'events.json'),
      JSON.stringify(this.events, null, 2),
    );
  }
}

async function checkCase(
  results: Evidence[],
  name: string,
  test: () => Promise<unknown>,
) {
  console.log(`verify: ${name}`);
  try {
    const details = await test();
    results.push({ name, status: 'pass', details });
  } catch (error) {
    results.push({
      name,
      status: 'fail',
      details: error instanceof Error ? error.stack : String(error),
    });
    throw error;
  }
}
function subagent(prompt: string, extra: RecordValue = {}): Action {
  return {
    tool: 'subagent',
    input: {
      agent: 'explorer',
      description: 'Local lifecycle verification',
      prompt,
      ...extra,
    },
  };
}
function control(
  tool: string,
  sessionID: string,
  extra: RecordValue = {},
): Action {
  return { tool, input: { sessionID, ...extra } };
}

async function lifecycle(host: Host, mode: Mode, results: Evidence[]) {
  const model = host.model;
  const native = mode !== 'off';
  const requestOffset = model.requests.length;
  let main!: Session;
  let childID = '';
  await checkCase(
    results,
    `${mode}: packed plugin and agent catalog`,
    async () => {
      const plugins = await poll('packed plugin inventory', async () => {
        const list = await host.request<PluginInfo[]>('/api/plugin');
        return list.some((plugin) => plugin.id === 'oh-my-opencode-slim')
          ? list
          : undefined;
      });
      const packed = plugins.find(
        (plugin) => plugin.id === 'oh-my-opencode-slim',
      );
      assert(
        packed?.state.status === 'active',
        `Packed plugin not active: ${packed?.state.error ?? 'missing'}`,
      );
      const agents = await poll('packed agent catalog', async () => {
        const list = await host.request<Array<{ id: string }>>('/api/agent');
        return list.some((agent) => agent.id === 'orchestrator') &&
          list.some((agent) => agent.id === 'explorer')
          ? list
          : undefined;
      });
      await writeFile(
        path.join(host.root, 'agents.json'),
        JSON.stringify(agents, null, 2),
      );
      await writeFile(
        path.join(host.root, 'plugins.json'),
        JSON.stringify(plugins, null, 2),
      );
      return { plugin: 'oh-my-opencode-slim', agentCount: agents.length };
    },
  );
  await checkCase(
    results,
    `${mode}: initial background completion and same-ID new execution`,
    async () => {
      main = await host.create('Background and continuation');
      const marker = model.plan('child', [
        { text: 'ROUND_ONE_NATIVE_TEXT', hold: `${mode}:first` },
      ]);
      await host.runTools(
        main.id,
        [subagent(marker, { background: true })],
        'PARENT_IDLE_AFTER_LAUNCH',
      );
      childID = await host.child(main.id);
      await model.wait(`${mode}:first`);
      assert.equal(
        (await host.request<RecordValue>('/api/session/active'))[main.id],
        undefined,
      );
      model.release(`${mode}:first`);
      await host.contains(main.id, 'ROUND_ONE_NATIVE_TEXT');
      await host.idle(main.id);
      await poll('first host completion admission', async () =>
        host.notices(main.id, childID).length === 1 ? true : undefined,
      );
      const firstNotices = host.notices(main.id, childID).length;
      const second = model.plan('child', [
        { text: 'ROUND_TWO_LATEST_NATIVE_TEXT', hold: `${mode}:second` },
      ]);
      const messages = await host.runTools(
        main.id,
        [subagent(second, { sessionID: childID, background: true })],
        'CONTINUATION_ADMITTED',
      );
      await model.wait(`${mode}:second`);
      assert.equal(
        host.children(main.id).length,
        1,
        'Continuation created another child',
      );
      const calls = toolParts(messages, 'subagent');
      assert.equal(calls.length, 2);
      model.release(`${mode}:second`);
      await host.contains(main.id, 'ROUND_TWO_LATEST_NATIVE_TEXT');
      await host.idle(main.id);
      await poll('second host completion admission', async () =>
        host.notices(main.id, childID).length === 2 ? true : undefined,
      );
      if (native) {
        const childRequests = model.requests.filter(
          (request) => request.body.model === 'child' && request.plan,
        ).length;
        const status = await host.runTools(
          main.id,
          [control('task_status', childID)],
          'STATUS_LATEST_FINISHED',
        );
        const latest = toolText(status, 'task_status');
        assert.match(latest, /ROUND_TWO_LATEST_NATIVE_TEXT/);
        assert.doesNotMatch(latest, /ROUND_ONE_NATIVE_TEXT/);
        assert.equal(
          model.requests.filter(
            (request) => request.body.model === 'child' && request.plan,
          ).length,
          childRequests,
          'A status read started child execution',
        );
      }
      assert.equal(host.children(main.id).length, 1);
      const visible = (await host.messages(main.id)).filter(
        (message) =>
          message.type === 'synthetic' &&
          message.metadata?.source === 'subagent' &&
          message.metadata.childID === childID,
      );
      assert.equal(visible.length, 2);
      assert.equal(
        visible.filter((message) =>
          message.text?.includes('ROUND_ONE_NATIVE_TEXT'),
        ).length,
        1,
      );
      assert.equal(
        visible.filter((message) =>
          message.text?.includes('ROUND_TWO_LATEST_NATIVE_TEXT'),
        ).length,
        1,
      );
      const notices = host.notices(main.id, childID);
      assert.equal(
        notices.length,
        2,
        'Duplicate normal-path completion admission',
      );
      return {
        parentID: main.id,
        childID,
        firstNotices,
        totalNotices: notices.length,
        visibleCompletions: visible.length,
        caveat:
          'Normal successful executions only; no cross-crash exactly-once claim.',
      };
    },
  );
  if (native) {
    await checkCase(
      results,
      `${mode}: omitted background uses the activated default`,
      async () => {
        const parent = await host.create('Omitted background default');
        const child = model.plan('child', [
          { text: 'OMITTED_BACKGROUND_CHILD_TEXT', hold: `${mode}:omitted` },
        ]);
        await host.runTools(
          parent.id,
          [subagent(child)],
          'OMITTED_BACKGROUND_PARENT_CONTINUED',
        );
        const target = await host.child(parent.id);
        await model.wait(`${mode}:omitted`);
        assert(
          renderedText(await host.messages(parent.id)).includes(
            'OMITTED_BACKGROUND_PARENT_CONTINUED',
          ),
          'Omitted background blocked the parent',
        );
        model.release(`${mode}:omitted`);
        await host.contains(parent.id, 'OMITTED_BACKGROUND_CHILD_TEXT');
        await host.idle(parent.id);
        await poll('omitted background completion admission', async () =>
          host.notices(parent.id, target).length === 1 ? true : undefined,
        );
        return {
          parentID: parent.id,
          childID: target,
          notices: 1,
          defaultedTo: 'background',
        };
      },
    );
  }
  await checkCase(
    results,
    `${mode}: running-child steer and busy-parent completion`,
    async () => {
      const parent = await host.create('Running steer');
      const first = model.plan('child', [
        { text: 'PRE_STEER_TEXT', hold: `${mode}:steer-child` },
      ]);
      await host.runTools(
        parent.id,
        [subagent(first, { background: true })],
        'STEER_CHILD_LAUNCHED',
      );
      const runningID = await host.child(parent.id);
      await model.wait(`${mode}:steer-child`);
      const next = model.plan('child', [{ text: 'LATEST_STEERED_TEXT' }]);
      const parentMarker = model.plan('parent', [
        subagent(next, { sessionID: runningID, background: true }),
        { text: 'BUSY_PARENT_RELEASED', hold: `${mode}:busy-parent` },
        { text: 'BUSY_NOTICE_CONSUMED' },
      ]);
      await host.prompt(parent.id, parentMarker);
      await model.wait(`${mode}:busy-parent`);
      model.release(`${mode}:steer-child`);
      await host.contains(runningID, 'LATEST_STEERED_TEXT');
      await poll('busy parent host inbox completion', async () =>
        host.notices(parent.id, runningID).length === 1 ? true : undefined,
      );
      assert(
        (await host.request<RecordValue>('/api/session/active'))[parent.id],
        'Busy parent was not active',
      );
      model.release(`${mode}:busy-parent`);
      await host.contains(parent.id, 'LATEST_STEERED_TEXT');
      await host.idle(parent.id);
      assert.equal(host.children(parent.id).length, 1);
      assert.equal(
        host.notices(parent.id, runningID).length,
        1,
        'Running steer created an extra host job generation',
      );
      return {
        parentID: parent.id,
        childID: runningID,
        nativeCompletionAdmissions: 1,
      };
    },
  );
  await checkCase(
    results,
    `${mode}: native invalid ID is readable and creates no child`,
    async () => {
      const parent = await host.create('Invalid child ID');
      const messages = await host.runTools(
        parent.id,
        [
          subagent('Must not execute', {
            sessionID: 'ses_lifecycle_missing',
            background: true,
          }),
        ],
        'INVALID_ID_FINISHED',
      );
      assert.match(
        toolText(messages, 'subagent'),
        /Subagent session not found: ses_lifecycle_missing/,
      );
      assert.equal(host.children(parent.id).length, 0);
      return { readableNativeError: true };
    },
  );
  if (native) {
    await nativeControls(host, mode, main, childID, results);
  }
  await checkCase(
    results,
    `${mode}: orchestrator/explorer task tool surface and host-only completion messages`,
    async () => {
      const parent = model.requests
        .slice(requestOffset)
        .find(
          (request) => request.body.model === 'parent' && request.plan,
        )?.body;
      const child = model.requests
        .slice(requestOffset)
        .find(
          (request) => request.body.model === 'child' && request.plan,
        )?.body;
      assert(parent && child, 'No rendered parent/child requests');
      const parentTools = (parent.tools ?? [])
        .map((tool) => tool.function?.name)
        .filter(Boolean);
      const childTools = (child.tools ?? [])
        .map((tool) => tool.function?.name)
        .filter(Boolean);
      assert(parentTools.includes('subagent'));
      const expected = native
        ? ['task_cancel', 'task_reply', 'task_status']
        : [];
      assert.deepEqual(
        parentTools.filter((name) => name?.startsWith('task_')).sort(),
        expected,
      );
      assert(
        !parentTools.includes('task_report'),
        'Primary may not report to itself',
      );
      assert.deepEqual(
        childTools.filter((name) => name?.startsWith('task_')).sort(),
        native ? ['task_report'] : [],
      );
      const reply = parent.tools?.find(
        (tool) => tool.function?.name === 'task_reply',
      );
      if (native)
        assert(
          !JSON.stringify(reply).includes('"answers"'),
          'Permission-only reply advertised form answers',
        );
      const all = await host.messages(main.id);
      const synthetic = all.filter((message) => message.type === 'synthetic');
      assert(
        synthetic
          .filter((message) => message.text?.includes('<subagent sessionID='))
          .every((message) => message.metadata?.source === 'subagent'),
        'A plugin terminal delta duplicated native delivery',
      );
      assert.doesNotMatch(
        renderedText(all),
        /<background-jobs>|<background-job-board>|<task-result>|<background-result>|<task-completion>/,
      );
      return {
        parentTools: parentTools.filter((name) => name?.startsWith('task_')),
        childTools: childTools.filter((name) => name?.startsWith('task_')),
      };
    },
  );
  if (!native) {
    await checkCase(
      results,
      `${mode}: omitted/false background arguments retain native foreground behavior`,
      async () => {
        const parent = await host.create('Off native argument semantics');
        const first = model.plan('child', [
          { text: 'OFF_OMITTED_FOREGROUND', hold: 'off:omitted' },
        ]);
        const script = model.plan('parent', [
          subagent(first),
          { text: 'OMITTED_PARENT_FINISHED' },
        ]);
        await host.prompt(parent.id, script);
        await model.wait('off:omitted');
        const firstID = await host.child(parent.id);
        assert(
          !renderedText(await host.messages(parent.id)).includes(
            'OMITTED_PARENT_FINISHED',
          ),
        );
        model.release('off:omitted');
        await host.contains(parent.id, 'OMITTED_PARENT_FINISHED');
        await host.idle(parent.id);
        const second = model.plan('child', [
          { text: 'OFF_FALSE_FOREGROUND', hold: 'off:false' },
        ]);
        const followup = model.plan('parent', [
          subagent(second, { background: false }),
          { text: 'FALSE_PARENT_FINISHED' },
        ]);
        await host.prompt(parent.id, followup);
        await model.wait('off:false');
        const secondID = await host.child(parent.id, 2);
        assert(
          !renderedText(await host.messages(parent.id)).includes(
            'FALSE_PARENT_FINISHED',
          ),
        );
        model.release('off:false');
        await host.contains(parent.id, 'FALSE_PARENT_FINISHED');
        await host.idle(parent.id);
        assert.equal(host.children(parent.id).length, 2);
        assert.equal(host.notices(parent.id, firstID).length, 0);
        assert.equal(host.notices(parent.id, secondID).length, 0);
        return {
          omitted: 'foreground',
          false: 'foreground',
          true: 'background (previous cases)',
        };
      },
    );
  }
  await checkCase(
    results,
    `${mode}: lifecycle storage absence and preset ownership`,
    async () => {
      const keys = host
        .rows('select key from kv')
        .map((row) => String(row.key));
      // The host namespaces plugin KV by character code; scope the lifecycle
      // check to this plugin so unrelated host/plugin keys are not miscounted.
      const namespace = `plugin:${[...'oh-my-opencode-slim']
        .map((character) =>
          character.charCodeAt(0).toString(16).padStart(4, '0'),
        )
        .join('')}:`;
      const pluginKeys = keys
        .filter((key) => key.startsWith(namespace))
        .map((key) => key.slice(namespace.length));
      const presetKeys = pluginKeys.filter((key) =>
        key.startsWith('session-preset/'),
      );
      assert.equal(
        pluginKeys.length,
        presetKeys.length,
        `Managed lifecycle KV found: ${pluginKeys.filter((key) => !key.startsWith('session-preset/')).join(', ')}`,
      );
      if (native)
        assert(
          presetKeys.length > 0,
          'Native mode lost session preset storage',
        );
      else
        assert.equal(
          presetKeys.length,
          0,
          'Off mode constructed session-preset routing',
        );
      await writeFile(
        path.join(host.root, 'kv-keys.json'),
        JSON.stringify({ pluginNamespace: namespace, pluginKeys }, null, 2),
      );
      return {
        pluginKeys,
        presetKeyCount: presetKeys.length,
        managedJobKeyCount: pluginKeys.filter(
          (key) => !key.startsWith('session-preset/'),
        ).length,
      };
    },
  );
}

async function nativeControls(
  host: Host,
  mode: Mode,
  main: Session,
  childID: string,
  results: Evidence[],
) {
  const model = host.model;
  await checkCase(
    results,
    `${mode}: foreign parent and fork continuation/status/cancel refusal`,
    async () => {
      const foreign = await host.create('Foreign parent');
      const fork = await host.request<Session>(
        `/api/session/${main.id}/fork`,
        {},
      );
      for (const parent of [foreign, fork]) {
        const messages = await host.runTools(
          parent.id,
          [
            subagent('FOREIGN_MUST_NOT_EXECUTE', {
              sessionID: childID,
              background: true,
            }),
            control('task_status', childID),
            control('task_cancel', childID),
          ],
          `FOREIGN_REFUSED_${parent.id}`,
        );
        assert.match(
          toolText(messages, 'subagent'),
          /not a child of the current session|does not belong/,
        );
        assert.match(
          toolText(messages, 'task_status'),
          /does not belong to this session/,
        );
        assert.match(
          toolText(messages, 'task_cancel'),
          /does not belong to this session/,
        );
        assert.equal(host.children(parent.id).length, 0);
      }
      return { foreignID: foreign.id, forkID: fork.id, childID };
    },
  );
  await checkCase(
    results,
    `${mode}: cancel active execution and idle no-op retain child`,
    async () => {
      const parent = await host.create('Cancellation');
      const marker = model.plan('child', [
        {
          text: 'CANCELLED_RESPONSE_MUST_NOT_COMPLETE',
          hold: `${mode}:cancel`,
        },
      ]);
      await host.runTools(
        parent.id,
        [subagent(marker, { background: true })],
        'CANCEL_CHILD_LAUNCHED',
      );
      const target = await host.child(parent.id);
      await model.wait(`${mode}:cancel`);
      const active = await host.runTools(
        parent.id,
        [control('task_cancel', target)],
        'ACTIVE_CANCEL_FINISHED',
      );
      assert.match(toolText(active, 'task_cancel'), /Interrupt accepted/);
      await host.idle(target);
      model.release(`${mode}:cancel`);
      const idle = await host.runTools(
        parent.id,
        [control('task_cancel', target)],
        'IDLE_CANCEL_FINISHED',
      );
      assert.match(
        toolText(idle, 'task_cancel'),
        /No active execution interrupted/,
      );
      const retained = await host.request<Session>(`/api/session/${target}`);
      assert.equal(retained.id, target);
      assert.equal(host.children(parent.id).length, 1);
      return {
        childID: target,
        active: 'interrupted=true',
        idle: 'interrupted=false',
        raceGuarantee:
          'Host active execution only; no plugin generation condition.',
      };
    },
  );
  await checkCase(
    results,
    `${mode}: pending permission status and permission-only reply use host open request`,
    async () => {
      const parent = await host.create('Permission rejection');
      const childMarker = model.plan('child', [
        { tool: 'read', input: { path: path.join(host.workspace, '.env') } },
        { text: 'PERMISSION_CHILD_AFTER_REJECTION' },
      ]);
      await host.runTools(
        parent.id,
        [subagent(childMarker, { background: true })],
        'PERMISSION_CHILD_LAUNCHED',
      );
      const target = await host.child(parent.id);
      const pending = await poll('real child permission request', async () => {
        const requests = await host.request<
          Array<{ id: string; sessionID: string; action: string }>
        >(`/api/session/${target}/permission`);
        return requests.find(
          (request) =>
            request.sessionID === target && request.action === 'read',
        );
      });
      const messages = await host.runTools(
        parent.id,
        [
          control('task_status', target),
          control('task_reply', target, {
            request_id: pending.id,
            reply: 'reject',
          }),
        ],
        'PERMISSION_REPLY_FINISHED',
      );
      assert.match(toolText(messages, 'task_status'), new RegExp(pending.id));
      assert.match(toolText(messages, 'task_status'), /permission|waiting/i);
      assert(
        toolParts(messages, 'task_reply').some(
          (part) => part.state?.status === 'completed',
        ),
        'task_reply failed',
      );
      assert.match(toolText(messages, 'task_reply'), /replied with reject/);
      await poll('host permission cleared', async () =>
        (await host.request<unknown[]>(`/api/session/${target}/permission`))
          .length === 0
          ? true
          : undefined,
      );
      assert.equal(
        (await host.request<Session>(`/api/session/${target}`)).id,
        target,
      );
      assert.equal(host.children(parent.id).length, 1);
      assert(
        !JSON.stringify(model.requests).includes(
          'LIFECYCLE_SENSITIVE_SENTINEL=must_not_reach_model',
        ),
        'Rejected read reached the model',
      );
      return {
        parentID: parent.id,
        childID: target,
        requestID: pending.id,
        decision: 'reject',
        driver:
          'Harness observed host pending request, then admitted a parent prompt that called actual task_status/task_reply.',
      };
    },
  );
  await checkCase(
    results,
    `${mode}: progress report queues on idle parent without waking it`,
    async () => {
      const parent = await host.create('Dormant progress report');
      const childMarker = model.plan('child', [
        {
          tool: 'task_report',
          input: { kind: 'progress', message: 'REPORT_IDLE_QUEUED' },
          hold: `${mode}:report`,
        },
        { text: 'REPORT_CHILD_TERMINAL_HELD', hold: `${mode}:report-terminal` },
      ]);
      await host.runTools(
        parent.id,
        [subagent(childMarker, { background: true })],
        'REPORT_PARENT_IDLE',
      );
      const target = await host.child(parent.id);
      await model.wait(`${mode}:report`);
      const before = model.requests.filter(
        (request) => request.body.model === 'parent' && request.plan,
      ).length;
      model.release(`${mode}:report`);
      await model.wait(`${mode}:report-terminal`);
      const inbox = await host.request<
        Array<{ id: string; delivery: string; payload: { text?: string } }>
      >(`/api/session/${parent.id}/inbox`);
      const reports = inbox.filter((item) =>
        item.payload.text?.includes('REPORT_IDLE_QUEUED'),
      );
      assert.equal(
        reports.length,
        1,
        'Report was not admitted once to the host inbox',
      );
      assert.equal(
        reports[0].delivery,
        'queue',
        'Report must use the queue lane',
      );
      const output = toolText(await host.messages(target), 'task_report');
      assert.match(output, /queued|accepted/);
      assert.doesNotMatch(
        output,
        /processed successfully|delivered successfully/i,
      );
      assert.equal(
        (await host.request<RecordValue>('/api/session/active'))[parent.id],
        undefined,
        'Progress report woke idle parent',
      );
      assert.equal(
        model.requests.filter(
          (request) => request.body.model === 'parent' && request.plan,
        ).length,
        before,
        'Progress report called the parent model',
      );
      model.release(`${mode}:report-terminal`);
      await host.contains(parent.id, 'REPORT_CHILD_TERMINAL_HELD');
      await host.idle(parent.id);
      return {
        parentID: parent.id,
        childID: target,
        inboxID: reports[0].id,
        delivery: 'queue',
        resume: false,
        parentModelCallsWhileQueued: 0,
      };
    },
  );
}

async function restartRunning(host: Host, results: Evidence[]) {
  const model = host.model;
  await checkCase(
    results,
    'restart: registered managed service resumes running native child from same DB',
    async () => {
      const parent = await host.create('Crash recovery');
      const child = model.plan('child', [
        { text: 'KILLED_STREAM_MUST_NOT_FINISH', hold: 'restart:running' },
        { text: 'NATIVE_CHILD_RECOVERED_AFTER_RESTART' },
      ]);
      await host.runTools(
        parent.id,
        [subagent(child, { background: true })],
        'RESTART_PARENT_IDLE',
      );
      const target = await host.child(parent.id);
      await model.wait('restart:running');
      const persisted = host.rows(
        'select notification_id, id, status, recovery from job where id = ?',
        target,
      );
      assert.equal(
        persisted.length,
        1,
        'Native background job was not persisted',
      );
      assert.equal(persisted[0].status, 'running');
      await writeFile(
        path.join(host.root, 'restart-before.json'),
        JSON.stringify(persisted, null, 2),
      );
      await host.stop('SIGKILL');
      model.release('restart:running');
      await host.start();
      await host.contains(target, 'NATIVE_CHILD_RECOVERED_AFTER_RESTART');
      await host.contains(parent.id, 'NATIVE_CHILD_RECOVERED_AFTER_RESTART');
      await host.idle(parent.id);
      assert.equal(host.children(parent.id).length, 1);
      const notices = host.notices(parent.id, target);
      assert.equal(
        notices.length,
        1,
        'Unexpected recovery completion count in this run',
      );
      await poll(
        'host removes delivered background notification marker',
        async () =>
          host.rows('select notification_id from job where id = ?', target)
            .length === 0
            ? true
            : undefined,
      );
      return {
        parentID: parent.id,
        childID: target,
        db: host.dbPath,
        registeredService: true,
        samePersistentDatabase: true,
        recovery: 'Host startup sweep only',
        caveat:
          'Observed one successful recovery; host recovery is at-least-once and may repeat external side effects.',
      };
    },
  );
}

async function strictManaged(
  root: string,
  installed: string,
  model: Model,
  results: Evidence[],
) {
  const host = new Host(root, model);
  await host.configure(installed, 'managed');
  await checkCase(
    results,
    'explicit managed on v2: clear startup refusal',
    async () => {
      try {
        await host.start();
        // A failed plugin setup is an inventory failure; the host stays alive.
        // Do not require unrelated HTTP endpoints to fail with the plugin.
        const plugins = await poll('failed plugin inventory', async () => {
          const list = await host.request<PluginInfo[]>('/api/plugin');
          return list.some((plugin) => plugin.state.status === 'failed')
            ? list
            : undefined;
        });
        assert(
          !plugins.some(
            (plugin) =>
              plugin.id === 'oh-my-opencode-slim' &&
              plugin.state.status === 'active',
          ),
          'Explicit managed plugin remained active',
        );
        const inventoryError = plugins
          .map((plugin) => plugin.state.error)
          .filter((error): error is string => typeof error === 'string')
          .join('\n');
        await writeFile(
          path.join(root, 'plugins.json'),
          JSON.stringify(plugins, null, 2),
        );
        // Host stdout is flushed by stop(); combine it with plugin logs before
        // deciding whether the refusal names the unsupported setting.
        await host.stop();
        const diagnostic = [inventoryError, await logTexts(root)].join('\n');
        assert.match(
          diagnostic,
          /Unsupported backgroundJobs\.mode "managed" on OpenCode v2/,
        );
        return { status: 'failed', clearDiagnostic: true };
      } finally {
        // Flush host stdout/stderr before the report is written. No credential
        // registration or authorization header is included in these files.
        await host.stop();
      }
    },
  );
}

async function selfCheck() {
  const model = createModel();
  try {
    const marker = model.plan('parent', [
      {
        tool: 'subagent',
        input: {
          agent: 'explorer',
          description: 'Self check',
          prompt: 'Local',
        },
      },
      { text: 'SELF_CHECK_OK' },
    ]);
    const input = {
      model: 'parent',
      messages: [{ role: 'user', content: marker }],
      tools: [{ function: { name: 'subagent' } }],
    };
    const first = await fetch(
      `http://127.0.0.1:${model.server.port}/v1/chat/completions`,
      { method: 'POST', body: JSON.stringify(input) },
    );
    assert.match(await first.text(), /tool_calls/);
    const second = await fetch(
      `http://127.0.0.1:${model.server.port}/v1/chat/completions`,
      { method: 'POST', body: JSON.stringify(input) },
    );
    assert.match(await second.text(), /SELF_CHECK_OK/);
    const packEntry = { filename: 'local-candidate.tgz' };
    assert.deepEqual(
      parsePackJson(`npm notice\n${JSON.stringify([packEntry])}\n`),
      [packEntry],
    );
    assert.deepEqual(
      parsePackJson(JSON.stringify({ 'oh-my-opencode-slim': packEntry })),
      [packEntry],
    );
    assert.deepEqual(
      parsePackJson(JSON.stringify({ 'oh-my-opencode-slim': [packEntry] })),
      [packEntry],
    );
    assert(!('backgroundJobs' in pluginConfig('default')));
    assert.equal(pluginConfig('off').backgroundJobs?.mode, 'off');
    assert('plugins' in hostConfig('/tmp/opencode/local-only', model));
    assert(!('plugin' in hostConfig('/tmp/opencode/local-only', model)));
    assert.equal(model.failures.length, 0);
    console.log(
      'Harness self-check passed; no candidate packed or host launched.',
    );
  } finally {
    model.stop();
  }
}

async function main() {
  if (options.selfCheck) return selfCheck();
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(path.join(ROOT, 'run-'));
  const results: Evidence[] = [];
  const model = createModel();
  let failure: unknown;
  let installed = '';
  let tarball = '';
  const hosts: Host[] = [];
  console.log(`Evidence: ${root}`);
  try {
    assert(
      await Bun.file(path.join(REPO, 'dist', 'server', 'index.js')).exists(),
      'Build candidate dist before running the harness',
    );
    const version = await command(
      [HOST, '--version'],
      REPO,
      path.join(root, 'version.log'),
      { PATH: process.env.PATH, HOME: root },
    );
    assert.match(version, /2\.2\.6/);
    for (const directory of ['pkg', 'app'])
      await mkdir(path.join(root, directory));
    const packed = await command(
      [
        'npm',
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        path.join(root, 'pkg'),
      ],
      REPO,
      path.join(root, 'pack.log'),
    );
    const filename = parsePackJson(packed)[0]?.filename;
    assert(filename, 'npm pack did not return a tarball filename');
    tarball = path.join(root, 'pkg', filename);
    await writeFile(
      path.join(root, 'app', 'package.json'),
      JSON.stringify({
        name: 'v2-native-lifecycle-verification',
        private: true,
      }),
    );
    await command(
      ['bun', 'add', '--ignore-scripts', tarball],
      path.join(root, 'app'),
      path.join(root, 'install.log'),
    );
    installed = path.join(root, 'app', 'node_modules', 'oh-my-opencode-slim');
    const packageInfo = await Bun.file(
      path.join(installed, 'package.json'),
    ).json();
    await writeFile(
      path.join(root, 'artifact.json'),
      JSON.stringify(
        {
          tarball,
          package: packageInfo,
          host: version.trim(),
          command: [process.execPath, ...process.argv.slice(1)],
        },
        null,
        2,
      ),
    );
    for (const mode of options.modes) {
      const host = new Host(path.join(root, mode), model);
      hosts.push(host);
      await host.configure(installed, mode);
      await host.start();
      await lifecycle(host, mode, results);
      if (options.restart === 'running' && mode === 'native')
        await restartRunning(host, results);
      await host.stop();
    }
    await strictManaged(
      path.join(root, 'explicit-managed'),
      installed,
      model,
      results,
    );
    assert.equal(model.failures.length, 0, model.failures.join('\n'));
  } catch (error) {
    failure = error;
    if (!results.some((result) => result.status === 'fail'))
      results.push({
        name: 'harness setup or runtime',
        status: 'fail',
        details: error instanceof Error ? error.stack : String(error),
      });
  } finally {
    await Promise.all(hosts.map((host) => host.stop()));
    model.stop();
    await writeFile(
      path.join(root, 'model-requests.json'),
      JSON.stringify(model.requests, null, 2),
    );
    await writeFile(
      path.join(root, 'model-failures.json'),
      JSON.stringify(model.failures, null, 2),
    );
    const limitations = [
      'No external provider or user session; deterministic loopback OpenAI-compatible mock only.',
      'The harness assumes dist is already built; it packs with npm --ignore-scripts and installs the tarball into a throwaway Bun app.',
      'Module cold-loading, cancel transport timeout, stop-versus-prompt races, council resolution, native continuation while permission/form-waiting, and preset/cache projections require parent focused source/unit validation; this HTTP harness does not claim them.',
      'Rendered catalogs cover orchestrator/explorer with this local test preset, across requested default/native/off modes. Other caller roles/presets, disabled-tool matrices, and before/after prompt byte comparisons require parent focused validation.',
      'Omitted/false foreground semantics are exercised in off mode; true-background and same-ID steering are exercised in every requested mode. Native/default same-provider foreground conversion requires source/unit validation.',
      'Progress report real-host coverage currently proves idle-parent queue/resume:false; running, interrupted, and form-waiting parents are not separately exercised.',
      'Terminal-but-not-yet-admitted crash and admitted-but-unconsumed restart windows need a deterministic host-side fault seam. No host DB mutations or plugin recovery are used to fabricate those states.',
      ...(options.restart === 'none' || !options.modes.includes('native')
        ? [
            'Running-child restart was not requested; run --modes=native --restart=running to exercise the registered service startup sweep.',
          ]
        : []),
    ];
    const report = {
      root,
      command:
        `bun scripts/verify-v2-native-lifecycle.ts ${args.join(' ')}`.trim(),
      exitCode: failure ? 1 : 0,
      host: HOST,
      expectedHostVersion: '2.2.6',
      tarball,
      installed,
      isolation:
        'Clean environment, isolated HOME/XDG/config/database and owned registered service; local model catalog fetching disabled.',
      results,
      limitations,
    };
    await writeFile(
      path.join(root, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    await writeFile(
      path.join(ROOT, 'latest-report-path.txt'),
      `${path.join(root, 'report.json')}\n`,
    );
    console.log(
      JSON.stringify({
        exitCode: report.exitCode,
        report: path.join(root, 'report.json'),
        passed: results.filter((result) => result.status === 'pass').length,
        failed: results.filter((result) => result.status === 'fail').length,
      }),
    );
    if (failure) {
      console.error(failure);
      process.exitCode = 1;
    }
  }
}

await main();
