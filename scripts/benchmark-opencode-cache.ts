#!/usr/bin/env bun
export {};

/**
 * Example: bun scripts/benchmark-opencode-cache.ts --server http://127.0.0.1:4096 --provider anthropic --model claude-sonnet-4-5 --runs 10 --output /tmp/cache.json --arm plugin-on --plugin-build $(git rev-parse HEAD)
 * Direct HTTP only: POST /session, POST/GET/DELETE /session/:id/message, GET /event, GET /global/health.
 */

type Json = Record<string, unknown>;
type Event = {
  at: number;
  type: string;
  sessionID?: string;
  messageID?: string;
  partID?: string;
  field?: string;
  partType?: string;
  status?: string;
  retryAttempt?: number;
};
type RequestObservation = {
  position: number;
  warmup: boolean;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  totalInput: number | null;
};
type PromptLoopObservation = {
  turn: number;
  warmup: boolean;
  promptLoopTtftMs: number | null;
  promptLoopLatencyMs: number | null;
};

const HELP = `Usage: bun scripts/benchmark-opencode-cache.ts [options]

Required:
  --server URL --provider ID --model ID --runs N --output PATH
  --arm ID              Comparison arm identifier (for example plugin-on)
  --plugin-build ID     Plugin build/commit identifier

Options:
  --timeout-ms N        Per-request timeout (default: 120000)
  --retries N           Retry transient GET/create/probe failures (default: 2)
  --retry-delay-ms N    Initial exponential-backoff delay (default: 500)
  --header NAME:VALUE   Extra HTTP header; repeatable, never persisted
  --overwrite           Replace an existing output file
  --help                Show this help

Each independent session explicitly targets agent "orchestrator" and the supplied
provider/model. It requests Read(package.json), TodoWrite, a final answer, then a
second user follow-up. Incomplete, retrying, compacted, or misrouted sessions are
recorded as discards, never resampled. Output contains only normalized/redacted
telemetry: no prompts, model text, tool I/O, workspace paths, headers, or event
properties. Prompt-loop TTFT/latency are one observation per submitted user
prompt, never copied to provider steps. SSE coverage must be established before
prompts; an unavailable, malformed, or closed stream discards the session. A
unique per-session nonce is kept only in live prompts.
Assistant and provider errors are retained only as safe error-code classifications
and always discard the session.
Sessions are deleted after collection.
`;

function fail(message: string): never {
  console.error(`Error: ${message}\n\n${HELP}`);
  process.exit(2);
}
function isRecord(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function string(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}
function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function errorCode(value: unknown) {
  if (!isRecord(value))
    return value === undefined || value === null ? null : 'unknown';
  const name = string(value.name) ?? string(value.code) ?? string(value.type);
  if (
    name === 'APIError' ||
    name === 'ProviderAuthError' ||
    name === 'MessageAbortedError' ||
    name === 'StructuredOutputError' ||
    name === 'ContextOverflowError' ||
    name === 'MessageOutputLengthError' ||
    name === 'Unknown'
  ) {
    return name;
  }
  return 'unknown';
}
function urlPath(base: string, route: string) {
  return `${base}${route.startsWith('/') ? route : `/${route}`}`;
}
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv: string[]) {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const names = [
    '--server',
    '--provider',
    '--model',
    '--runs',
    '--output',
    '--arm',
    '--plugin-build',
    '--timeout-ms',
    '--retries',
    '--retry-delay-ms',
    '--header',
  ];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--help') {
      console.log(HELP);
      process.exit(0);
    }
    if (argv[i] === '--overwrite') {
      flags.add(argv[i]);
      continue;
    }
    if (!names.includes(argv[i])) fail(`unknown argument ${argv[i]}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${argv[i]}`);
    values.set(argv[i], [...(values.get(argv[i]) ?? []), value]);
    i += 1;
  }
  const required = (name: string) => {
    const value = values.get(name)?.at(-1);
    if (!value) fail(`missing required ${name}`);
    return value;
  };
  const integer = (name: string, fallback?: number) => {
    const value = Number(values.get(name)?.at(-1) ?? fallback);
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (name === '--runs' && value === 0)
    )
      fail(
        `${name} must be a ${name === '--runs' ? 'positive' : 'non-negative'} integer`,
      );
    return value;
  };
  let server: URL;
  try {
    server = new URL(required('--server'));
  } catch {
    fail('--server must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(server.protocol))
    fail('--server must be an http(s) URL');
  const headers = new Headers();
  for (const value of values.get('--header') ?? []) {
    const split = value.indexOf(':');
    if (split < 1) fail('--header must be NAME:VALUE');
    headers.append(value.slice(0, split), value.slice(split + 1).trim());
  }
  return {
    server: server.toString().replace(/\/$/, ''),
    provider: required('--provider'),
    model: required('--model'),
    runs: integer('--runs'),
    output: required('--output'),
    arm: required('--arm'),
    pluginBuild: required('--plugin-build'),
    timeoutMs: integer('--timeout-ms', 120_000),
    retries: integer('--retries', 2),
    retryDelayMs: integer('--retry-delay-ms', 500),
    headers,
    overwrite: flags.has('--overwrite'),
  };
}

const args = parseArgs(process.argv.slice(2));
if ((await Bun.file(args.output).exists()) && !args.overwrite)
  fail(`output already exists: ${args.output} (use --overwrite)`);

async function request(
  method: string,
  route: string,
  body?: Json,
  retry = false,
) {
  let last = 'request failed';
  for (let attempt = 0; attempt <= args.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      const headers = new Headers(args.headers);
      if (body) headers.set('content-type', 'application/json');
      const response = await fetch(urlPath(args.server, route), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.ok)
        return text.trim() ? (JSON.parse(text) as unknown) : undefined;
      last = `${method} ${route} returned HTTP ${response.status}`;
      if (!retry || response.status < 500 || attempt === args.retries)
        throw new Error(last);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (!retry || attempt === args.retries) throw new Error(last);
    } finally {
      clearTimeout(timeout);
    }
    await sleep(args.retryDelayMs * 2 ** attempt);
  }
  throw new Error(last);
}

function normalizeEvent(value: unknown): Event | undefined {
  if (!isRecord(value) || !isRecord(value.properties)) return undefined;
  const properties = value.properties;
  const type = string(value.type);
  const sessionID = string(properties.sessionID);
  if (!type || !sessionID) return undefined;
  if (type === 'message.part.delta')
    return {
      at: now(),
      type,
      sessionID,
      messageID: string(properties.messageID),
      partID: string(properties.partID),
      field: string(properties.field),
    };
  if (type === 'message.part.updated' && isRecord(properties.part))
    return {
      at: now(),
      type,
      sessionID,
      messageID: string(properties.part.messageID),
      partID: string(properties.part.id),
      partType: string(properties.part.type),
      status: isRecord(properties.part.state)
        ? string(properties.part.state.status)
        : undefined,
    };
  if (type === 'message.updated' && isRecord(properties.info))
    return {
      at: now(),
      type,
      sessionID,
      messageID: string(properties.info.id),
    };
  if (type === 'session.status' && isRecord(properties.status))
    return {
      at: now(),
      type,
      sessionID,
      status: string(properties.status.type),
      retryAttempt: number(properties.status.attempt),
    };
  if (type.toLowerCase().includes('compaction'))
    return { at: now(), type, sessionID };
  return undefined;
}

type StreamCoverage = {
  ready: Promise<void>;
  readyResolve: () => void;
  issue: string | null;
};

function streamCoverage(): StreamCoverage {
  let readyResolve = () => {};
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  return { ready, readyResolve, issue: null };
}

async function awaitSseReadiness(coverage: StreamCoverage) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      coverage.ready,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('SSE subscription readiness timed out')),
          Math.min(args.timeoutMs, 10_000),
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (coverage.issue) throw new Error(coverage.issue);
}

async function eventStream(
  events: Event[],
  controller: AbortController,
  coverage: StreamCoverage,
) {
  try {
    const response = await fetch(urlPath(args.server, '/event'), {
      headers: args.headers,
      signal: controller.signal,
    });
    if (!response.ok || !response.body)
      throw new Error(`GET /event returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!controller.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
          .trim();
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as unknown;
          if (isRecord(parsed) && parsed.type === 'server.connected') {
            coverage.readyResolve();
            continue;
          }
          const event = normalizeEvent(parsed);
          if (event) events.push(event);
        } catch {
          coverage.issue ??= 'SSE delivered a malformed frame';
          coverage.readyResolve();
        }
      }
    }
    if (!controller.signal.aborted) {
      coverage.issue ??= 'SSE stream closed before collection completed';
      coverage.readyResolve();
    }
  } catch {
    if (!controller.signal.aborted) {
      coverage.issue ??= 'SSE stream connection failed';
      coverage.readyResolve();
    }
  }
}

function normalizeMessage(value: unknown) {
  if (!isRecord(value) || !isRecord(value.info)) return undefined;
  const info = value.info;
  const parts = Array.isArray(value.parts) ? value.parts : [];
  return {
    id: string(info.id),
    parentID: string(info.parentID),
    role: string(info.role),
    agent: string(info.agent),
    providerID: string(info.providerID),
    modelID: string(info.modelID),
    errorCode: errorCode(info.error),
    tokens: isRecord(info.tokens) ? info.tokens : undefined,
    parts: parts.filter(isRecord).map((part) => ({
      type: string(part.type),
      tool: string(part.tool),
      status: isRecord(part.state) ? string(part.state.status) : undefined,
      errorCode: part.type === 'retry' ? errorCode(part.error) : null,
      tokens: isRecord(part.tokens) ? part.tokens : undefined,
    })),
  };
}

function tokenObservation(
  tokens: unknown,
  position: number,
  warmup: boolean,
): RequestObservation {
  const tokenRecord = isRecord(tokens) ? tokens : {};
  const cache = isRecord(tokenRecord.cache) ? tokenRecord.cache : undefined;
  const input = number(tokenRecord.input) ?? null;
  const cacheRead = cache ? (number(cache.read) ?? null) : null;
  const cacheWrite = cache ? (number(cache.write) ?? null) : null;
  const totalInput =
    input === null || cacheRead === null || cacheWrite === null
      ? null
      : input + cacheRead + cacheWrite;
  return {
    position,
    warmup,
    input,
    output: number(tokenRecord.output) ?? null,
    cacheRead,
    cacheWrite,
    totalInput,
  };
}

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}
function boundedCoverage(observations: RequestObservation[]) {
  const measured = observations.filter(
    (item) => item.cacheRead !== null && item.totalInput !== null,
  );
  const total = measured.reduce((sum, item) => sum + (item.totalInput ?? 0), 0);
  return total > 0
    ? Math.min(
        1,
        Math.max(
          0,
          measured.reduce((sum, item) => sum + (item.cacheRead ?? 0), 0) /
            total,
        ),
      )
    : null;
}
function bootstrapCI<T>(
  sessions: T[][],
  metric: (items: T[]) => number | null,
) {
  const observed = metric(sessions.flat());
  if (!sessions.length || observed === null)
    return { estimate: observed, lower: null, upper: null, samples: 0 };
  let state = 0x9e3779b9;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const values: number[] = [];
  for (let i = 0; i < 2000; i += 1) {
    const sampled = Array.from(
      { length: sessions.length },
      () => sessions[Math.floor(random() * sessions.length)],
    ).flat();
    const value = metric(sampled);
    if (value !== null) values.push(value);
  }
  return {
    estimate: observed,
    lower: percentile(values, 2.5),
    upper: percentile(values, 97.5),
    samples: values.length,
  };
}

function firstPrompt(nonce: string) {
  return `Session marker: ${nonce}. Use the Read tool to inspect package.json. Then use the TodoWrite tool to create one completed, low-priority todo named "cache benchmark trace". Do not modify files. After both tools finish, reply with exactly: benchmark complete.`;
}

function followUp(nonce: string) {
  return `Session marker: ${nonce}. Without using tools, reply with exactly: follow-up complete.`;
}

async function run(index: number) {
  const events: Event[] = [];
  const controller = new AbortController();
  const coverage = streamCoverage();
  const stream = eventStream(events, controller, coverage);
  let sessionID: string | undefined;
  const record: Json = {
    runIndex: index,
    runOrder: index + 1,
    requestedRouting: {
      agent: 'orchestrator',
      providerID: args.provider,
      modelID: args.model,
    },
  };
  try {
    await awaitSseReadiness(coverage);
    const created = await request('POST', '/session', {}, true);
    sessionID = isRecord(created) ? string(created.id) : undefined;
    if (!sessionID) throw new Error('POST /session returned no session id');
    record.sessionID = sessionID;
    const nonce = crypto.randomUUID();
    const prompts: {
      parentMessageID?: string;
      startedAt: number;
      completedAt: number;
    }[] = [];
    for (const text of [firstPrompt(nonce), followUp(nonce)]) {
      const startedAt = now();
      const response = await request(
        'POST',
        `/session/${encodeURIComponent(sessionID)}/message`,
        {
          agent: 'orchestrator',
          model: { providerID: args.provider, modelID: args.model },
          parts: [{ type: 'text', text }],
        },
      );
      const normalized = normalizeMessage(response);
      prompts.push({
        // POST /message returns the assistant message; its parent is this turn's user message.
        parentMessageID: normalized?.parentID,
        startedAt,
        completedAt: now(),
      });
    }
    const [rawMessages, rawSession] = await Promise.all([
      request(
        'GET',
        `/session/${encodeURIComponent(sessionID)}/message`,
        undefined,
        true,
      ),
      request(
        'GET',
        `/session/${encodeURIComponent(sessionID)}`,
        undefined,
        true,
      ),
    ]);
    const messages = Array.isArray(rawMessages)
      ? rawMessages
          .map(normalizeMessage)
          .filter((item): item is NonNullable<typeof item> => !!item)
      : [];
    const session = isRecord(rawSession) ? rawSession : {};
    const sessionModel = isRecord(session.model) ? session.model : {};
    const sessionEvents = events.filter(
      (event) => event.sessionID === sessionID,
    );
    const assistants = messages.filter(
      (message) => message.role === 'assistant',
    );
    const tools = assistants.flatMap((message) =>
      message.parts
        .filter((part) => part.type === 'tool')
        .map((part) => ({ tool: part.tool, status: part.status })),
    );
    const observations: RequestObservation[] = [];
    const promptLoops: PromptLoopObservation[] = [];
    let position = 0;
    for (const prompt of prompts) {
      const assistantIDs = new Set(
        assistants
          .filter((message) => message.parentID === prompt.parentMessageID)
          .map((message) => message.id)
          .filter((id): id is string => !!id),
      );
      promptLoops.push({
        turn: promptLoops.length + 1,
        warmup: promptLoops.length === 0,
        promptLoopTtftMs: (() => {
          const event = sessionEvents.find(
            (item) =>
              item.at >= prompt.startedAt &&
              item.at <= prompt.completedAt &&
              item.messageID &&
              assistantIDs.has(item.messageID) &&
              item.type === 'message.part.delta' &&
              ['text', 'reasoning'].includes(item.field ?? ''),
          );
          return event ? event.at - prompt.startedAt : null;
        })(),
        promptLoopLatencyMs: prompt.completedAt - prompt.startedAt,
      });
      const perPrompt = assistants
        .filter((message) => message.parentID === prompt.parentMessageID)
        .flatMap((message) =>
          message.parts
            .filter((part) => part.type === 'step-finish')
            .map((part) => part.tokens),
        );
      const tokenSets = perPrompt.length
        ? perPrompt
        : assistants
            .filter((message) => message.parentID === prompt.parentMessageID)
            .map((message) => message.tokens);
      for (const tokens of tokenSets) {
        position += 1;
        observations.push(tokenObservation(tokens, position, position === 1));
      }
    }
    const retries = sessionEvents.filter(
      (event) => event.type === 'session.status' && event.status === 'retry',
    ).length;
    const assistantErrorCodes = assistants
      .map((message) => message.errorCode)
      .filter((code): code is string => code !== null);
    const providerErrorCodes = messages.flatMap((message) =>
      message.parts
        .filter((part) => part.type === 'retry')
        .map((part) => part.errorCode)
        .filter((code): code is string => code !== null),
    );
    const historyRetry = messages.some((message) =>
      message.parts.some((part) => part.type === 'retry'),
    );
    const historyCompaction =
      string(session.agent) === 'compaction' ||
      messages.some(
        (message) =>
          message.agent === 'compaction' ||
          message.parts.some((part) => part.type === 'compaction'),
      ) ||
      (isRecord(session.time) && number(session.time.compacting) !== undefined);
    const compaction =
      historyCompaction ||
      sessionEvents.some((event) =>
        event.type.toLowerCase().includes('compaction'),
      );
    const routingMatches =
      string(session.agent) === 'orchestrator' &&
      string(sessionModel.providerID) === args.provider &&
      string(sessionModel.id) === args.model &&
      assistants.length > 0 &&
      assistants.every(
        (message) =>
          message.agent === 'orchestrator' &&
          message.providerID === args.provider &&
          message.modelID === args.model,
      );
    const reasons = [
      ...(tools.some(
        (tool) =>
          tool.tool?.toLowerCase() === 'read' && tool.status === 'completed',
      )
        ? []
        : ['missing completed Read tool']),
      ...(tools.some(
        (tool) =>
          tool.tool?.toLowerCase() === 'todowrite' &&
          tool.status === 'completed',
      )
        ? []
        : ['missing completed harmless TodoWrite tool']),
      ...(assistants.some((message) =>
        message.parts.some((part) => part.type === 'text'),
      )
        ? []
        : ['missing assistant final response']),
      ...(messages.filter((message) => message.role === 'user').length >= 2
        ? []
        : ['missing second user follow-up']),
      ...(routingMatches
        ? []
        : [
            'observed session/assistant routing does not match orchestrator/provider/model',
          ]),
      ...assistantErrorCodes.map((code) =>
        ['APIError', 'ProviderAuthError'].includes(code)
          ? `provider_error:${code}`
          : `assistant_error:${code}`,
      ),
      ...providerErrorCodes.map((code) => `provider_error:${code}`),
      ...(coverage.issue ? [coverage.issue] : []),
      ...(retries || historyRetry ? ['session entered retry state'] : []),
      ...(compaction ? ['session compaction observed'] : []),
    ];
    record.observation = {
      routing: {
        sessionAgent: string(session.agent) ?? null,
        sessionProviderID: string(sessionModel.providerID) ?? null,
        sessionModelID: string(sessionModel.id) ?? null,
        assistantCount: assistants.length,
      },
      events: sessionEvents,
      tools,
      requests: observations,
      promptLoops,
      retries,
      compaction,
      historyRetry,
      historyCompaction,
      assistantErrorCodes,
      providerErrorCodes,
    };
    record.discarded = reasons.length > 0;
    if (reasons.length) record.discardReasons = reasons;
  } catch (error) {
    record.discarded = true;
    record.discardReasons = [
      error instanceof Error ? error.message : String(error),
    ];
    record.observation = { events };
  } finally {
    if (sessionID) {
      try {
        await request('DELETE', `/session/${encodeURIComponent(sessionID)}`);
      } catch {
        record.cleanupError = 'session deletion failed';
      }
    }
    controller.abort();
    await stream;
  }
  return record;
}

let hostVersion: string | null = null;
try {
  const health = await request('GET', '/global/health', undefined, true);
  hostVersion = isRecord(health) ? (string(health.version) ?? null) : null;
} catch {
  /* probe is optional */
}
const runs: Json[] = [];
for (let index = 0; index < args.runs; index += 1) {
  console.error(`Running session ${index + 1}/${args.runs}`);
  runs.push(await run(index));
}
const eligible = runs.filter((run) => !run.discarded);
const aggregateSessions = eligible.map((run) =>
  isRecord(run.observation) && Array.isArray(run.observation.requests)
    ? run.observation.requests
        .filter(isRecord)
        .map((item) => item as unknown as RequestObservation)
        .filter((item) => !item.warmup)
    : [],
);
const aggregate = aggregateSessions.flat();
const promptLoopSessions = eligible.map((run) =>
  isRecord(run.observation) && Array.isArray(run.observation.promptLoops)
    ? run.observation.promptLoops
        .filter(isRecord)
        .map((item) => item as unknown as PromptLoopObservation)
        .filter((item) => !item.warmup)
    : [],
);
const promptLoops = promptLoopSessions.flat();
const cacheMiss = (items: RequestObservation[]) => {
  const measured = items.filter((item) => item.cacheRead !== null);
  return measured.length
    ? measured.filter((item) => item.cacheRead === 0).length / measured.length
    : null;
};
const ttftP50 = (items: PromptLoopObservation[]) =>
  percentile(
    items
      .map((item) => item.promptLoopTtftMs)
      .filter((value): value is number => value !== null),
    50,
  );
const latencyP50 = (items: PromptLoopObservation[]) =>
  percentile(
    items
      .map((item) => item.promptLoopLatencyMs)
      .filter((value): value is number => value !== null),
    50,
  );
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  comparison: {
    arm: args.arm,
    pluginBuild: args.pluginBuild,
    hostOpenCodeVersion: hostVersion,
    runOrder: 'sequential independent sessions',
    routingFingerprint: {
      agent: 'orchestrator',
      providerID: args.provider,
      modelID: args.model,
    },
  },
  controls: {
    runs: args.runs,
    timeoutMs: args.timeoutMs,
    retries: args.retries,
    retryDelayMs: args.retryDelayMs,
    warmupRule:
      'exclude request position 1 in each eligible session from aggregates',
  },
  metrics: {
    sessionsRequested: args.runs,
    sessionsEligible: eligible.length,
    sessionsDiscarded: runs.length - eligible.length,
    requestObservationsRaw: eligible.flatMap((run) =>
      isRecord(run.observation) && Array.isArray(run.observation.requests)
        ? run.observation.requests
        : [],
    ).length,
    requestObservationsAggregated: aggregate.length,
    promptLoopObservationsRaw: eligible.flatMap((run) =>
      isRecord(run.observation) && Array.isArray(run.observation.promptLoops)
        ? run.observation.promptLoops
        : [],
    ).length,
    promptLoopObservationsAggregated: promptLoops.length,
    primaryMetricsSessionBootstrap95CI: {
      zeroCacheMissRate: bootstrapCI(aggregateSessions, cacheMiss),
      cacheCoverage: bootstrapCI(aggregateSessions, boundedCoverage),
      promptLoopTtftMsP50: bootstrapCI(promptLoopSessions, ttftP50),
      promptLoopLatencyMsP50: bootstrapCI(promptLoopSessions, latencyP50),
    },
  },
  runs,
};
await Bun.write(args.output, `${JSON.stringify(report, null, 2)}\n`);
console.error(
  `Wrote ${args.output}: ${eligible.length}/${args.runs} eligible sessions`,
);
