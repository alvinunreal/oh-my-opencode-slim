import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import { AcpAgentConfigSchema } from '../config';
import { buildPluginInput } from '../v2/client-shim';
import {
  createAcpInitializeParams,
  createAcpRunTool,
  readAcpSessionModel,
  trackProgress,
} from './acp-run';

describe('ACP initialize payload', () => {
  test('sends protocol-compliant client implementation information', () => {
    const params = createAcpInitializeParams();

    expect(params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'oh-my-opencode-slim',
        version: packageJson.version,
      },
    });
    expect(params.clientInfo).not.toHaveProperty('title');
  });
});

const FABLE = 'anthropic/claude-fable-5-1';
const OTHER = 'test/other-model';
const modelMap = { [FABLE]: 'fable', [OTHER]: 'other' };
const args = { agent: 'claude-code', prompt: 'fixture task' };

// Local stdio peer only: no credentials, network, or model generation.
const peer = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const scenario = process.env.ACP_TEST_SCENARIO;
const log = (event) => appendFileSync('events.jsonl', JSON.stringify(event) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let currentValue = 'default';
const choices = [{ value: 'fable', name: 'Fable 5.1' }, { value: 'other', name: 'Test only' }];
const configOptions = () => {
  if (scenario === 'missing') return [];
  const option = {
    id: scenario === 'grouped' ? 'engine' : 'model',
    ...(scenario === 'grouped' ? { category: 'model' } : {}),
    type: scenario === 'wrong-type' ? 'boolean' : 'select', name: 'Model', currentValue,
    options: scenario === 'unsupported' ? [] : scenario === 'grouped'
      ? [{ group: 'test', name: 'Test models', options: choices }] : choices,
  };
  return scenario === 'duplicate' ? [option, option] : [option];
};
log({ method: 'spawn' });
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  log(request);
  const { id, method, params } = request;
  if (method === 'initialize') send({ id, result: { protocolVersion: 1 } });
  else if (method === 'session/new') send({ id, result: { sessionId: 'fixture-session', configOptions: configOptions() } });
  else if (method === 'session/set_config_option') {
    if (scenario === 'setter-error') {
      send({ id, error: { code: -32602, message: 'fixture setter rejected' } });
      return;
    }
    if (scenario !== 'mismatch') currentValue = params.value;
    const confirmed = configOptions();
    if (scenario === 'changed-id') Object.assign(confirmed[0], { id: 'other-id', category: 'model' });
    send({ id, result: { configOptions: confirmed } });
  } else if (method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: currentValue } } } });
    send({ id, result: { stopReason: 'end_turn' } });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(scenario = 'flat') {
  const directory = mkdtempSync(join(tmpdir(), 'acp-model-test-'));
  tempDirs.push(directory);
  const logPath = join(directory, 'events.jsonl');
  const record = (method: string) =>
    appendFileSync(logPath, `${JSON.stringify({ method })}\n`);
  const events = () =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return {
    record,
    events,
    config: AcpAgentConfigSchema.parse({
      command: process.execPath,
      args: ['-e', peer],
      env: { ACP_TEST_SCENARIO: scenario },
      timeoutMs: 3000,
    }),
    ctx: {
      sessionID: 'child-fable',
      messageID: 'test-message',
      agent: 'claude-code',
      directory,
      worktree: directory,
      abort: new AbortController().signal,
      ask: mock(async () => {
        record('permission');
      }),
      metadata: mock(() => {}),
    },
  };
}

describe('ACP model following', () => {
  test('maps the V2 shim session model before prompting; omission preserves defaults', async () => {
    expect(
      AcpAgentConfigSchema.parse({ command: 'fixture', modelMap }).modelMap,
    ).toEqual(modelMap);
    for (const invalidMap of [{ '': 'fable' }, { [FABLE]: '' }]) {
      expect(
        AcpAgentConfigSchema.safeParse({
          command: 'fixture',
          modelMap: invalidMap,
        }).success,
      ).toBe(false);
    }
    for (const scenario of ['flat', 'grouped']) {
      const f = fixture(scenario);
      const get = mock(async (input: unknown) => {
        expect(input).toEqual({ sessionID: 'child-fable' });
        f.record('get');
        return {
          model: {
            providerID: 'anthropic',
            id: 'claude-fable-5-1',
            variant: 'high',
          },
        };
      });
      // Exercise the pinned 3.0.2 shim, not a guessed v1 session response.
      const input = buildPluginInput({
        session: { get },
        location: { directory: f.ctx.directory },
      } as never);
      const client = input.client as {
        session: { get: (args: { path: { id: string } }) => Promise<unknown> };
      };
      const run = createAcpRunTool(
        { 'claude-code': { ...f.config, modelMap } },
        async (sessionID) =>
          readAcpSessionModel(
            await client.session.get({ path: { id: sessionID } }),
          ),
      );
      expect(await run.execute(args, f.ctx)).toBe('fable');
      expect(get).toHaveBeenCalledTimes(1);
      expect(f.events().map((event) => event.method)).toEqual([
        'permission',
        'get',
        'spawn',
        'initialize',
        'session/new',
        'session/set_config_option',
        'session/prompt',
      ]);
      expect(
        f.events().find((event) => event.method === 'session/set_config_option')
          .params,
      ).toEqual({
        sessionId: 'fixture-session',
        configId: scenario === 'grouped' ? 'engine' : 'model',
        value: 'fable',
      });
      expect(f.ctx.metadata).toHaveBeenCalledWith({
        metadata: { requestedModel: FABLE, acpModel: 'fable' },
      });
    }

    const legacy = fixture('missing');
    const unused = mock(async () => {
      throw new Error('must not read host model');
    });
    expect(
      await createAcpRunTool({ 'claude-code': legacy.config }, unused).execute(
        args,
        legacy.ctx,
      ),
    ).toBe('default');
    expect(unused).not.toHaveBeenCalled();
    expect(legacy.events().map((event) => event.method)).not.toContain(
      'session/set_config_option',
    );
    expect(legacy.ctx.metadata).not.toHaveBeenCalled();
  });

  test('fails closed before spawn or prompt without permission, mapping, or setter confirmation', async () => {
    for (const response of [
      {},
      { data: {} },
      {
        error: 'get failed',
        data: { model: { providerID: 'anthropic', id: 'claude-fable-5-1' } },
      },
      { data: { model: 'anthropic/claude-fable-5-1' } },
      {
        data: {
          model: { providerID: 'anthropic', modelID: 'claude-fable-5-1' },
        },
      },
      { data: { model: { providerID: '', id: 'claude-fable-5-1' } } },
      { data: { model: { providerID: 'anthropic', id: '' } } },
    ]) {
      expect(() => readAcpSessionModel(response)).toThrow(
        'ACP model following',
      );
    }
    const f = fixture();
    const resolver = mock(async () => FABLE);
    const configured = { 'claude-code': { ...f.config, modelMap } };
    const run = createAcpRunTool(configured, resolver);
    await expect(
      run.execute(args, { ...f.ctx, agent: 'other' }),
    ).rejects.toThrow('can only be used');
    await expect(
      run.execute(args, {
        ...f.ctx,
        ask: async () => {
          throw new Error('permission denied');
        },
      }),
    ).rejects.toThrow('permission denied');
    expect(resolver).not.toHaveBeenCalled();
    await expect(
      createAcpRunTool(configured).execute(args, f.ctx),
    ).rejects.toThrow('requires resolveSessionModel');
    await expect(
      run.execute(args, { ...f.ctx, sessionID: '' }),
    ).rejects.toThrow('requires sessionID');
    await expect(
      createAcpRunTool(configured, async () => {
        throw new Error('get failed');
      }).execute(args, f.ctx),
    ).rejects.toThrow('could not read session');
    await expect(
      createAcpRunTool(configured, async () => 'invalid').execute(args, f.ctx),
    ).rejects.toThrow('invalid model reference');
    for (const mapping of [{}, Object.create({ [FABLE]: 'fable' })]) {
      await expect(
        createAcpRunTool(
          { 'claude-code': { ...f.config, modelMap: mapping } },
          resolver,
        ).execute(args, f.ctx),
      ).rejects.toThrow('no mapping');
    }
    await expect(
      createAcpRunTool(configured, async () => 'openai/default').execute(
        args,
        f.ctx,
      ),
    ).rejects.toThrow('no mapping');
    expect(f.events().some((event) => event.method === 'spawn')).toBe(false);

    for (const [scenario, error] of [
      ['missing', 'exactly one model config option'],
      ['duplicate', 'exactly one model config option'],
      ['wrong-type', 'exactly one model config option'],
      ['unsupported', 'does not support'],
      ['setter-error', 'fixture setter rejected'],
      ['mismatch', 'not confirmed'],
      ['changed-id', 'not confirmed'],
    ]) {
      const f = fixture(scenario);
      const run = createAcpRunTool(
        { 'claude-code': { ...f.config, modelMap } },
        resolver,
      );
      await expect(run.execute(args, f.ctx)).rejects.toThrow(error);
      expect(f.events().map((event) => event.method)).not.toContain(
        'session/prompt',
      );
      expect(f.ctx.metadata).not.toHaveBeenCalled();
    }
  });

  test('times out during model lookup and ignores a late resolution without spawning', async () => {
    const f = fixture();
    const lookup = Promise.withResolvers<string>();
    const resolver = mock(() => {
      f.record('get');
      return lookup.promise;
    });
    const run = createAcpRunTool(
      { 'claude-code': { ...f.config, modelMap } },
      resolver,
    );
    try {
      await expect(
        run.execute({ ...args, timeout_ms: 25 }, f.ctx),
      ).rejects.toThrow("ACP agent 'claude-code' timed out after 25ms");
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(f.events().map((event) => event.method)).toEqual([
        'permission',
        'get',
      ]);
      lookup.resolve(FABLE);
      await Bun.sleep(100);
      expect(f.events().map((event) => event.method)).toEqual([
        'permission',
        'get',
      ]);
      expect(f.ctx.metadata).not.toHaveBeenCalled();
    } finally {
      lookup.resolve(FABLE);
    }
  });

  test('aborts during model lookup with timeout disabled and ignores a late resolution without spawning', async () => {
    const f = fixture();
    const controller = new AbortController();
    const lookup = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    const resolver = mock(() => {
      f.record('get');
      entered.resolve();
      return lookup.promise;
    });
    const run = createAcpRunTool(
      { 'claude-code': { ...f.config, modelMap } },
      resolver,
    );
    const execution = run.execute(
      { ...args, timeout_ms: 0 },
      { ...f.ctx, abort: controller.signal },
    );
    try {
      await entered.promise;
      controller.abort();
      await expect(execution).rejects.toThrow(
        "ACP agent 'claude-code' aborted",
      );
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(f.events().map((event) => event.method)).toEqual([
        'permission',
        'get',
      ]);
      lookup.resolve(FABLE);
      await Bun.sleep(100);
      expect(f.events().map((event) => event.method)).toEqual([
        'permission',
        'get',
      ]);
      expect(f.ctx.metadata).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      lookup.resolve(FABLE);
    }
  });

  test('returns successful backend text even when the model metadata callback throws', async () => {
    const f = fixture();
    const metadata = mock(() => {
      throw new Error('fixture metadata sink failed');
    });
    const run = createAcpRunTool(
      { 'claude-code': { ...f.config, modelMap } },
      async () => FABLE,
    );
    expect(await run.execute(args, { ...f.ctx, metadata })).toBe('fable');
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledWith({
      metadata: { requestedModel: FABLE, acpModel: 'fable' },
    });
    expect(
      f.events().filter((event) => event.method === 'session/prompt'),
    ).toHaveLength(1);
  });

  test('isolates parallel sessions and reads one startup snapshot again on the next call', async () => {
    const first = fixture();
    const second = fixture();
    second.ctx.sessionID = 'child-other';
    const selected = new Map([
      ['child-fable', FABLE],
      ['child-other', OTHER],
    ]);
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let reads = 0;
    const resolver = mock(async (sessionID: string) => {
      const snapshot = selected.get(sessionID);
      if (!snapshot) throw new Error(`Unknown fixture session '${sessionID}'`);
      if (++reads === 2) ready();
      await gate;
      return snapshot;
    });
    const config = Object.freeze({
      ...first.config,
      modelMap: Object.freeze({ ...modelMap }),
    });
    const run = createAcpRunTool({ 'claude-code': config }, resolver);
    const pending = Promise.all([
      run.execute(args, first.ctx),
      run.execute(args, second.ctx),
    ]);
    await entered;
    selected.set('child-fable', OTHER);
    release();
    expect(await pending).toEqual(['fable', 'other']);
    expect(resolver.mock.calls).toEqual([['child-fable'], ['child-other']]);
    expect(await run.execute(args, first.ctx)).toBe('other');
    expect(resolver.mock.calls).toEqual([
      ['child-fable'],
      ['child-other'],
      ['child-fable'],
    ]);
    expect(
      first
        .events()
        .filter((event) => event.method === 'session/set_config_option')
        .map((event) => event.params.value),
    ).toEqual(['fable', 'other']);
    expect(
      second
        .events()
        .filter((event) => event.method === 'session/set_config_option')
        .map((event) => event.params.value),
    ).toEqual(['other']);
    expect(config.modelMap).toEqual(modelMap);
  });
});

describe('trackProgress', () => {
  test('streams tool_call state and replaces on tool_call_update', () => {
    const progress = new Map<string, string>();
    const first = trackProgress(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read src/server.js',
        status: 'in_progress',
      },
      progress,
    );
    expect(first?.title).toBe('▸ Read src/server.js');
    const second = trackProgress(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'Read src/server.js',
        status: 'completed',
      },
      progress,
    );
    expect(second?.title).toBe('✓ Read src/server.js');
    expect(second?.progress).toBe('✓ Read src/server.js');
  });

  test('renders plan entries as a block with the last line as title', () => {
    const rendered = trackProgress(
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read files', status: 'completed' },
          { content: 'Edit card action', status: 'in_progress' },
          { content: 'Run tests', status: 'pending' },
        ],
      },
      new Map(),
    );
    expect(rendered?.progress).toBe(
      '✓ Read files\n▸ Edit card action\n○ Run tests',
    );
    expect(rendered?.title).toBe('○ Run tests');
  });

  test('ignores non-progress updates and malformed entries', () => {
    expect(
      trackProgress({ sessionUpdate: 'agent_message_chunk' }, new Map()),
    ).toBeUndefined();
    expect(
      trackProgress({ sessionUpdate: 'tool_call' }, new Map()),
    ).toBeUndefined();
    expect(
      trackProgress(
        { sessionUpdate: 'plan', entries: [{ status: 'pending' }] },
        new Map(),
      ),
    ).toBeUndefined();
  });

  test('caps the rolling log and reports only the tail', () => {
    const progress = new Map<string, string>();
    let rendered: { title: string; progress: string } | undefined;
    for (let i = 0; i < 45; i++) {
      rendered = trackProgress(
        {
          sessionUpdate: 'tool_call',
          toolCallId: `t${i}`,
          title: `call ${i}`,
          status: 'in_progress',
        },
        progress,
      );
    }
    expect(progress.size).toBe(40);
    expect(rendered?.progress.split('\n')).toHaveLength(20);
    expect(rendered?.progress).toContain('call 44');
    expect(rendered?.progress).not.toContain('call 15\n');
  });

  test('status-only tool_call_update preserves the previous title', () => {
    const progress = new Map<string, string>();
    trackProgress(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read src/server.js',
        status: 'in_progress',
      },
      progress,
    );
    const completed = trackProgress(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
      },
      progress,
    );
    expect(completed?.title).toBe('✓ Read src/server.js');
  });

  test('a fresh title on tool_call_update replaces the previous one', () => {
    const progress = new Map<string, string>();
    trackProgress(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read src/server.js',
        status: 'in_progress',
      },
      progress,
    );
    const renamed = trackProgress(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'Read src/server.ts',
        status: 'completed',
      },
      progress,
    );
    expect(renamed?.title).toBe('✓ Read src/server.ts');
  });

  test('updating an old call moves it into the tail', () => {
    const progress = new Map<string, string>();
    trackProgress(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'old call',
        status: 'in_progress',
      },
      progress,
    );
    for (let i = 2; i <= 30; i++) {
      trackProgress(
        {
          sessionUpdate: 'tool_call',
          toolCallId: `t${i}`,
          title: `call ${i}`,
          status: 'in_progress',
        },
        progress,
      );
    }
    const completed = trackProgress(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'old call',
        status: 'completed',
      },
      progress,
    );
    expect(completed?.title).toBe('✓ old call');
    const tailLines = (completed?.progress ?? '').split('\n');
    expect(tailLines).toHaveLength(20);
    expect(tailLines.at(-1)).toBe('✓ old call');
  });

  test('a plan longer than the tail is truncated to the last lines', () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      content: `step ${i + 1}`,
      status: 'pending',
    }));
    const rendered = trackProgress(
      { sessionUpdate: 'plan', entries },
      new Map(),
    );
    const tailLines = (rendered?.progress ?? '').split('\n');
    expect(tailLines).toHaveLength(20);
    expect(tailLines[0]).toBe('○ step 6');
    expect(tailLines.at(-1)).toBe('○ step 25');
  });
});

describe('acp_run integration', () => {
  test('streams tool progress through ctx.metadata and returns final text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-progress-'));
    const serverPath = join(dir, 'server.js');
    await writeFile(
      serverPath,
      [
        'let seen = 0; let buf = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        '  buf += chunk; let idx;',
        '  while ((idx = buf.indexOf("\\n")) >= 0) {',
        '    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        '    seen++;',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: seen === 2 ? { sessionId: "sess-t" } : {} }) + "\\n");',
        '    if (seen === 2) {',
        '      const updates = [',
        '        { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read src/server.js", status: "in_progress" },',
        '        { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Read src/server.js", status: "completed" },',
        '        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },',
        '      ];',
        '      for (const update of updates) {',
        '        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update } }) + "\\n");',
        '      }',
        '    }',
        '  }',
        '});',
        'process.stdin.on("end", () => process.exit(0));',
      ].join('\n'),
    );

    const metadataCalls: Array<{
      title?: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const tool = createAcpRunTool({
      cursor: {
        command: process.execPath,
        args: [serverPath],
        permissionMode: 'allow',
      },
    });
    const result = await tool.execute(
      { agent: 'cursor', prompt: 'hi' } as never,
      {
        sessionID: 's',
        messageID: 'm',
        agent: 'cursor',
        directory: dir,
        worktree: dir,
        abort: new AbortController().signal,
        metadata: (input: {
          title?: string;
          metadata?: Record<string, unknown>;
        }) => {
          metadataCalls.push(input);
        },
        ask: async () => {},
      } as never,
    );

    expect(result).toBe('done');
    expect(metadataCalls.length).toBe(2);
    expect(metadataCalls[0]?.title).toBe('▸ Read src/server.js');
    expect(metadataCalls[1]?.title).toBe('✓ Read src/server.js');
    expect(metadataCalls[1]?.metadata?.progress).toBe('✓ Read src/server.js');
  }, 15_000);

  test('waits for graceful bridge shutdown after a timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-shutdown-'));
    const serverPath = join(dir, 'server.js');
    const eventsPath = join(dir, 'events.log');
    await writeFile(
      serverPath,
      [
        'const fs = require("node:fs");',
        'let buf = "";',
        `const eventsPath = ${JSON.stringify(eventsPath)};`,
        'const record = (event) => fs.appendFileSync(eventsPath, event + "\\n");',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        '  buf += chunk; let idx;',
        '  while ((idx = buf.indexOf("\\n")) >= 0) {',
        '    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        '    if (msg.method === "initialize") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");',
        '    } else if (msg.method === "session/new") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-timeout" } }) + "\\n");',
        '    } else if (msg.method === "session/prompt") {',
        '      record("prompt");',
        '    } else if (msg.method === "session/cancel") {',
        '      record("cancel");',
        '    }',
        '  }',
        '});',
        'process.stdin.on("end", () => {',
        '  record("eof");',
        '  setTimeout(() => { record("exit"); process.exit(0); }, 100);',
        '});',
      ].join('\n'),
    );

    const tool = createAcpRunTool({
      cursor: {
        command: process.execPath,
        args: [serverPath],
        permissionMode: 'allow',
      },
    });

    await expect(
      tool.execute(
        { agent: 'cursor', prompt: 'wait', timeout_ms: 1_000 } as never,
        {
          sessionID: 's',
          messageID: 'm',
          agent: 'cursor',
          directory: dir,
          worktree: dir,
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as never,
      ),
    ).rejects.toThrow("ACP agent 'cursor' timed out after 1000ms");

    expect(await readFile(eventsPath, 'utf8')).toBe(
      'prompt\ncancel\neof\nexit\n',
    );
  }, 15_000);

  test('abort settles while an ACP permission request is pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-abort-permission-'));
    const serverPath = join(dir, 'server.js');
    const eventsPath = join(dir, 'events.log');
    await writeFile(
      serverPath,
      [
        'const fs = require("node:fs");',
        'let buf = "";',
        `const eventsPath = ${JSON.stringify(eventsPath)};`,
        'const record = (event) => fs.appendFileSync(eventsPath, event + "\\n");',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        '  buf += chunk; let idx;',
        '  while ((idx = buf.indexOf("\\n")) >= 0) {',
        '    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        '    if (msg.method === "initialize") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");',
        '    } else if (msg.method === "session/new") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-permission" } }) + "\\n");',
        '    } else if (msg.method === "session/prompt") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { permission: "write" } }) + "\\n");',
        '      record("permission");',
        '    } else if (msg.method === "session/cancel") {',
        '      record("cancel");',
        '    }',
        '  }',
        '});',
        'process.stdin.on("end", () => process.exit(0));',
      ].join('\n'),
    );

    const controller = new AbortController();
    let permissionStarted!: () => void;
    const permissionSeen = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    const tool = createAcpRunTool({
      cursor: {
        command: process.execPath,
        args: [serverPath],
        permissionMode: 'ask',
      },
    });
    const execution = tool.execute(
      { agent: 'cursor', prompt: 'wait', timeout_ms: 0 } as never,
      {
        sessionID: 's',
        messageID: 'm',
        agent: 'cursor',
        directory: dir,
        worktree: dir,
        abort: controller.signal,
        metadata: () => {},
        ask: async (input: { metadata?: Record<string, unknown> }) => {
          if (input.metadata?.permission === 'write') {
            permissionStarted();
            await new Promise(() => {});
          }
        },
      } as never,
    );

    await permissionSeen;
    controller.abort();
    await expect(
      Promise.race([
        execution,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('abort did not settle')), 2_000),
        ),
      ]),
    ).resolves.toBeDefined();
    expect(await readFile(eventsPath, 'utf8')).toContain('cancel\n');
  }, 15_000);

  test('a spawn failure does not wait through shutdown grace periods', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-spawn-error-'));
    const tool = createAcpRunTool({
      cursor: {
        command: join(dir, 'missing-acp-command'),
        args: [],
        permissionMode: 'allow',
      },
    });
    const startedAt = Date.now();

    await expect(
      tool.execute(
        { agent: 'cursor', prompt: 'hi' } as never,
        {
          sessionID: 's',
          messageID: 'm',
          agent: 'cursor',
          directory: dir,
          worktree: dir,
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as never,
      ),
    ).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, 15_000);

  test('does not wait for descendant-held stdio after the bridge exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-exit-before-close-'));
    const serverPath = join(dir, 'server.js');
    await writeFile(
      serverPath,
      [
        'const { spawn } = require("node:child_process");',
        'let seen = 0; let buf = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        '  buf += chunk; let idx;',
        '  while ((idx = buf.indexOf("\\n")) >= 0) {',
        '    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line); seen++;',
        '    const result = seen === 2 ? { sessionId: "sess-exit" } : {};',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");',
        '  }',
        '});',
        'process.stdin.on("end", () => {',
        '  spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], {',
        '    stdio: ["ignore", process.stdout, process.stderr],',
        '  });',
        '  process.exit(0);',
        '});',
      ].join('\n'),
    );
    const tool = createAcpRunTool({
      cursor: {
        command: process.execPath,
        args: [serverPath],
        permissionMode: 'allow',
      },
    });
    const startedAt = Date.now();

    await tool.execute(
      { agent: 'cursor', prompt: 'hi' } as never,
      {
        sessionID: 's',
        messageID: 'm',
        agent: 'cursor',
        directory: dir,
        worktree: dir,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      } as never,
    );

    expect(Date.now() - startedAt).toBeLessThan(750);
  }, 15_000);
});
