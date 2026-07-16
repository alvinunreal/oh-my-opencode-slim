import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE_REMINDER, PHASE_REMINDER_TEXT } from '../src/config/constants';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distEntry = path.join(repoRoot, 'dist', 'index.js');
const MODEL_ID = 'capture-model';
const PROVIDER_ID = 'capture';
const TIMEOUT_MS = process.platform === 'darwin' ? 60_000 : 30_000;

type Capture = {
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  url: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[], cwd = repoRoot): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return result.stdout.trim();
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
  fail(`Command failed: ${command} ${args.join(' ')}\n${detail}`);
}

function requireOpenCodeBinary(): string {
  const opencode = process.env.OPENCODE_BIN;
  if (!opencode) {
    fail(
      'OPENCODE_BIN is required and must point to a pre-provisioned opencode-ai@1.18.2 binary. Example: OPENCODE_BIN=/path/to/node_modules/.bin/opencode bun run verify:cache-stability',
    );
  }
  if (!path.isAbsolute(opencode) || !existsSync(opencode)) {
    fail(`OPENCODE_BIN must be an existing absolute path, got: ${opencode}`);
  }
  const version = run(opencode, ['--version']);
  if (!/(^|\s)1\.18\.2(\s|$)/.test(version)) {
    fail(`OPENCODE_BIN must be opencode-ai@1.18.2, got: ${version}`);
  }
  return opencode;
}

function requireLocalPluginTree() {
  const nodeModules = path.join(repoRoot, 'node_modules');
  if (!existsSync(nodeModules)) {
    fail(
      'Local plugin dependency tree is missing. Run `bun install` before verify:cache-stability; the harness never installs dependencies.',
    );
  }
  for (const required of [
    path.join(repoRoot, 'package.json'),
    path.join(repoRoot, 'dist', 'index.js'),
    path.join(nodeModules, '@opencode-ai', 'plugin'),
    path.join(nodeModules, 'zod'),
  ]) {
    if (!existsSync(required)) {
      fail(
        `Local plugin dependency tree is incomplete at ${required}. Run \`bun install\` and \`bun run build\` before verify:cache-stability.`,
      );
    }
  }
  return { nodeModules, plugin: repoRoot };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitFor(url: string, predicate: () => boolean, label: string) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok && predicate()) return;
      lastError = `status=${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`Timed out waiting for ${label}: ${lastError}`);
}

async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

function redact(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
    .replaceAll(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replaceAll(
      /"(api[_-]?key|authorization)"\s*:\s*"[^"]*"/gi,
      '"$1":"[REDACTED]"',
    );
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n...[capped]` : text;
}

function describeDifference(left: string, right: string): string {
  const offset = [...left].findIndex(
    (character, index) => character !== right[index],
  );
  const index = offset === -1 ? Math.min(left.length, right.length) : offset;
  return JSON.stringify({
    leftLength: left.length,
    rightLength: right.length,
    offset: index,
    left: left.slice(Math.max(0, index - 200), index + 400),
    right: right.slice(Math.max(0, index - 200), index + 400),
  });
}

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
}

function toolResponse(id: string, name: string, argumentsJson: string): string {
  return sse({
    id: `capture-${id}`,
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: { name, arguments: argumentsJson },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
}

function textResponse(text: string): string {
  return sse({
    id: 'capture-final',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
  });
}

function isOrchestratorPayload(body: Record<string, unknown>): boolean {
  return (
    body.model === MODEL_ID &&
    Array.isArray(body.tools) &&
    body.tools.some(
      (tool) =>
        typeof tool === 'object' &&
        tool !== null &&
        'function' in tool &&
        typeof tool.function === 'object' &&
        tool.function !== null &&
        'name' in tool.function &&
        tool.function.name === 'read',
    )
  );
}

async function createCaptureServer(readPath: string) {
  const requests: Capture[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end('unexpected local capture request');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      response.writeHead(400).end('invalid JSON');
      return;
    }
    requests.push({ body, headers: request.headers, url: request.url });
    const primary = isOrchestratorPayload(body);
    const index = requests.filter((item) =>
      isOrchestratorPayload(item.body),
    ).length;
    const payload = !primary
      ? textResponse('title')
      : index === 1
        ? toolResponse(
            'call_read',
            'read',
            JSON.stringify({ filePath: readPath }),
          )
        : index === 2
          ? toolResponse(
              'call_todo',
              'todowrite',
              JSON.stringify({
                todos: [
                  {
                    content: 'cache stability checked',
                    status: 'completed',
                    priority: 'low',
                  },
                ],
              }),
            )
          : textResponse(
              index === 3 ? 'tools completed' : 'second turn completed',
            );
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.end(payload);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('Invalid capture address'));
      resolve(address.port);
    });
  });
  return { requests, server, url: `http://127.0.0.1:${port}/v1` };
}

function messages(
  body: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (!Array.isArray(body.messages))
    fail(`Provider payload omitted messages:\n${redact(body)}`);
  return body.messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === 'object' && message !== null,
  );
}

function contentText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) =>
      typeof part === 'object' &&
      part !== null &&
      'text' in part &&
      typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('');
}

function userProjection(body: Record<string, unknown>): string[] {
  return messages(body)
    .filter((message) => message.role === 'user')
    .map(contentText)
    .filter((content) => content.length > 0);
}

function promptProjection(body: Record<string, unknown>) {
  const allMessages = messages(body);
  const system = allMessages.filter(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role === 'system',
  );
  const input = allMessages.filter(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role !== 'system',
  );
  return {
    system,
    input,
    tools: Array.isArray(body.tools) ? body.tools : [],
    options: Object.fromEntries(
      Object.entries(body).filter(([key]) =>
        [
          'model',
          'temperature',
          'top_p',
          'max_tokens',
          'max_completion_tokens',
          'tool_choice',
          'parallel_tool_calls',
          'response_format',
        ].includes(key),
      ),
    ),
  };
}

function assertPromptPrefix(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  index: number,
) {
  const before = promptProjection(previous);
  const after = promptProjection(next);
  for (const field of ['system', 'tools', 'options'] as const) {
    const left = JSON.stringify(before[field]);
    const right = JSON.stringify(after[field]);
    if (left !== right) {
      fail(
        `Prompt ${field} projection changed between requests ${index} and ${index + 1}:\n${describeDifference(left, right)}`,
      );
    }
  }
  if (after.input.length < before.input.length) {
    fail(`Prompt input shrank between requests ${index} and ${index + 1}`);
  }
  for (const [partIndex, part] of before.input.entries()) {
    if (JSON.stringify(part) !== JSON.stringify(after.input[partIndex])) {
      fail(
        `Prompt input is not prefix-stable between requests ${index} and ${index + 1}:\n${redact({ before, after })}`,
      );
    }
  }
}

function assertStability(requests: Capture[]) {
  const modelRequests = requests.filter((request) =>
    isOrchestratorPayload(request.body),
  );
  if (modelRequests.length !== 4) {
    fail(
      `Expected exactly four primary-model requests, got ${modelRequests.length}:\n${redact(requests)}`,
    );
  }
  const payloads = modelRequests.map((request) => request.body);
  const systems = payloads.map((body) =>
    messages(body)
      .filter((message) => message.role === 'system')
      .map((message) => JSON.stringify(message))
      .join('\n'),
  );
  if (systems.some((system) => system.includes(PHASE_REMINDER))) {
    fail(`PHASE_REMINDER leaked into system/instructions:\n${redact(systems)}`);
  }
  for (const [index, system] of systems.entries()) {
    if (system !== systems[0]) {
      const initial = systems[0];
      if (initial === undefined) fail('Missing initial system projection');
      fail(
        `System/instruction projection changed at request ${index}:\n${describeDifference(initial, system)}`,
      );
    }
  }
  for (const [index, payload] of payloads.entries()) {
    const next = payloads[index + 1];
    if (next) assertPromptPrefix(payload, next, index);
  }
  const firstTurn = userProjection(payloads[0]);
  const secondTurn = userProjection(payloads[3]);
  if (!firstTurn.length || secondTurn.length < firstTurn.length) {
    fail(`Missing transformed user prompt projection:\n${redact(payloads)}`);
  }
  for (const [index, projection] of firstTurn.entries()) {
    if (secondTurn[index] !== projection) {
      fail(
        `Historical transformed prompt is not prefix-stable:\n${redact({ firstTurn, secondTurn })}`,
      );
    }
  }
  const reminderCount = (value: string) =>
    value.split(PHASE_REMINDER_TEXT).length - 1;
  const eligible = [...firstTurn, ...secondTurn];
  if (eligible.some((projection) => reminderCount(projection) !== 1)) {
    fail(
      `Expected exactly one reminder per eligible user message:\n${redact(eligible)}`,
    );
  }
  const toolNames = payloads
    .flatMap((body) => (Array.isArray(body.tools) ? body.tools : []))
    .map((tool) =>
      typeof tool === 'object' &&
      tool !== null &&
      'function' in tool &&
      typeof tool.function === 'object' &&
      tool.function !== null &&
      'name' in tool.function
        ? String(tool.function.name)
        : '',
    );
  if (!toolNames.includes('read') || !toolNames.includes('todowrite')) {
    fail(`Expected read and todowrite to be available:\n${redact(toolNames)}`);
  }
  const transcript = payloads
    .flatMap(messages)
    .map((message) => JSON.stringify(message))
    .join('\n');
  if (!transcript.includes('call_read') || !transcript.includes('call_todo')) {
    fail(
      `Expected read and todowrite execution results in transcript:\n${redact(payloads)}`,
    );
  }
}

async function prompt(hostUrl: string, sessionID: string, text: string) {
  const response = await fetch(`${hostUrl}/session/${sessionID}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent: 'orchestrator',
      model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
      parts: [{ type: 'text', text }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok)
    fail(`Prompt failed (${response.status}): ${await response.text()}`);
}

async function main() {
  if (!existsSync(distEntry)) {
    fail(
      'dist/index.js is missing. Run `bun run build` before verify:cache-stability.',
    );
  }
  const opencode = requireOpenCodeBinary();
  const localPlugin = requireLocalPluginTree();
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'omos-cache-stability-'));
  let host: ReturnType<typeof spawn> | undefined;
  let capture: Awaited<ReturnType<typeof createCaptureServer>> | undefined;
  try {
    const home = path.join(tempRoot, 'home');
    const config = path.join(tempRoot, 'config');
    const cache = path.join(tempRoot, 'cache');
    const data = path.join(tempRoot, 'data');
    const state = path.join(tempRoot, 'state');
    const workspace = path.join(tempRoot, 'workspace');
    for (const directory of [home, config, cache, data, state, workspace]) {
      mkdirSync(directory, { recursive: true });
    }
    const readPath = path.join(workspace, 'fixture.txt');
    writeFileSync(readPath, 'cache stability fixture\n');
    const plugins = path.join(config, 'plugins');
    mkdirSync(plugins, { recursive: true });
    const configNodeModules = path.join(config, 'node_modules');
    mkdirSync(configNodeModules, { recursive: true });
    symlinkSync(
      localPlugin.plugin,
      path.join(configNodeModules, 'oh-my-opencode-slim'),
    );
    writeFileSync(
      path.join(config, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { 'oh-my-opencode-slim': `file:${localPlugin.plugin}` },
      }),
    );
    writeFileSync(
      path.join(plugins, 'load-plugin.js'),
      "export { default } from 'oh-my-opencode-slim';\n",
    );
    capture = await createCaptureServer(readPath);
    writeFileSync(
      path.join(workspace, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          autoupdate: false,
          share: 'disabled',
          snapshot: false,
          model: `${PROVIDER_ID}/${MODEL_ID}`,
          small_model: `${PROVIDER_ID}/${MODEL_ID}`,
          default_agent: 'orchestrator',
          enabled_providers: [PROVIDER_ID],
          provider: {
            [PROVIDER_ID]: {
              npm: '@ai-sdk/openai-compatible',
              options: { apiKey: 'local-capture-key', baseURL: capture.url },
              models: {
                [MODEL_ID]: {
                  name: MODEL_ID,
                  tool_call: true,
                  limit: { context: 32_000, output: 4_000 },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );
    const port = await getFreePort();
    let logs = '';
    host = spawn(
      opencode,
      [
        'serve',
        '--print-logs',
        '--log-level',
        'DEBUG',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: workspace,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: config,
          XDG_CACHE_HOME: cache,
          XDG_DATA_HOME: data,
          XDG_STATE_HOME: state,
          OPENCODE_CONFIG_DIR: config,
          OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_DISABLE_MODELS_FETCH: 'true',
          OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
          BUN_AUTO_INSTALL: 'disable',
          BUN_INSTALL_CACHE_DIR: path.join(tempRoot, 'empty-bun-cache'),
          BUN_INSTALL_REGISTRY: 'http://127.0.0.1:9',
          npm_config_offline: 'true',
          NO_PROXY: '*',
          no_proxy: '*',
          PATH: process.env.PATH ?? '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    host.stdout?.on('data', (chunk) => (logs += String(chunk)));
    host.stderr?.on('data', (chunk) => (logs += String(chunk)));
    const hostUrl = `http://127.0.0.1:${port}`;
    await waitFor(`${hostUrl}/global/health`, () => true, 'OpenCode health');
    const created = await fetch(`${hostUrl}/session`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!created.ok)
      fail(
        `Session creation failed: ${await created.text()}\n${logs.slice(-12_000)}`,
      );
    const session = (await created.json()) as { id?: string };
    if (!session.id) fail(`Session creation omitted id: ${redact(session)}`);
    try {
      await prompt(
        hostUrl,
        session.id,
        'First cache-stability turn: use the requested tools.',
      );
    } catch (error) {
      fail(
        `${error instanceof Error ? error.message : String(error)}\nOpenCode logs:\n${logs.slice(-12_000)}`,
      );
    }
    try {
      await waitFor(
        `${hostUrl}/global/health`,
        () =>
          capture?.requests.filter((request) =>
            isOrchestratorPayload(request.body),
          ).length === 3,
        'tool execution',
      );
    } catch (error) {
      fail(
        `${error instanceof Error ? error.message : String(error)}\nCaptured requests:\n${redact(capture?.requests)}\nOpenCode logs:\n${logs.slice(-12_000)}`,
      );
    }
    await prompt(
      hostUrl,
      session.id,
      'Second cache-stability turn: finish without tools.',
    );
    await waitFor(
      `${hostUrl}/global/health`,
      () =>
        capture?.requests.filter((request) =>
          isOrchestratorPayload(request.body),
        ).length === 4,
      'second turn',
    );
    assertStability(capture.requests);
    console.log('OpenCode cache-stability verification passed.');
  } finally {
    if (host) await stop(host);
    const runningCapture = capture;
    if (runningCapture) {
      await new Promise<void>((resolve) =>
        runningCapture.server.close(() => resolve()),
      );
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
