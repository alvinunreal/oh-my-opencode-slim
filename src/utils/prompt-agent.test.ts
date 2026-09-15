import { describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  FALLBACK_TOP_LEVEL_AGENT,
  normalizeAgentHint,
  resolveHelperSessionAgent,
  resolveSessionAgent,
  SYSTEM_AGENTS,
  withAgent,
} from './prompt-agent';

type AnyClient = Parameters<typeof resolveSessionAgent>[0];

function createClient(session: Record<string, unknown>): AnyClient {
  return { session } as unknown as AnyClient;
}

describe('withAgent', () => {
  test('attaches a resolved agent to the body', () => {
    expect(withAgent({ parts: [] }, 'explorer')).toEqual({
      parts: [],
      agent: 'explorer',
    });
  });

  test('rejects an unresolvable agent before constructing a prompt body', () => {
    expect(() => withAgent({ parts: [] }, undefined as never)).toThrow(
      'Cannot create a prompt without a valid agent',
    );
  });

  test('ignores blank and malformed agent names', () => {
    expect(() => withAgent({ parts: [] }, '   ')).toThrow();
    expect(() => withAgent({ parts: [] }, 'not a valid agent')).toThrow();
  });

  test('trims a padded agent name', () => {
    expect(withAgent({ parts: [] }, ' fixer ')).toEqual({
      parts: [],
      agent: 'fixer',
    });
  });

  test('does not mutate the original body', () => {
    const body = { parts: [] };
    withAgent(body, 'orchestrator');
    expect(body).toEqual({ parts: [] });
  });
});

describe('normalizeAgentHint', () => {
  test('rejects every core internal primary', () => {
    expect([...SYSTEM_AGENTS].sort()).toEqual([
      'compaction',
      'summary',
      'title',
    ]);
    for (const systemAgent of SYSTEM_AGENTS) {
      expect(normalizeAgentHint(systemAgent)).toBeUndefined();
      expect(normalizeAgentHint(` ${systemAgent} `)).toBeUndefined();
    }
  });

  test('accepts normal agent names and rejects junk', () => {
    expect(normalizeAgentHint(' orchestrator ')).toBe('orchestrator');
    expect(normalizeAgentHint('test-auditor')).toBe('test-auditor');
    expect(normalizeAgentHint('not valid')).toBeUndefined();
    expect(normalizeAgentHint(42)).toBeUndefined();
    expect(normalizeAgentHint(undefined)).toBeUndefined();
  });

  test('does not denylist system names inside withAgent', () => {
    // Omitting the field is worse than any valid name: OpenCode would resolve
    // its default primary and rewrite the session agent regardless.
    expect(withAgent({ parts: [] }, 'compaction')).toEqual({
      parts: [],
      agent: 'compaction',
    });
  });
});

describe('resolveHelperSessionAgent', () => {
  test('selects the first available registered helper agent', () => {
    expect(
      resolveHelperSessionAgent(['orchestrator', 'explorer', 'councillor']),
    ).toBe('explorer');
  });

  test('selects another registered agent when earlier ones are absent', () => {
    expect(
      resolveHelperSessionAgent(['orchestrator', 'librarian', 'councillor']),
    ).toBe('librarian');
  });

  test('skips registered agents disabled in the final host config', () => {
    expect(
      resolveHelperSessionAgent(['orchestrator', 'explorer', 'librarian'], {
        explorer: { disable: true },
      }),
    ).toBe('librarian');
  });

  test('skips the disabled build agent for v1 helper sessions', () => {
    expect(
      resolveHelperSessionAgent(['orchestrator', 'build', 'explorer'], {
        build: { disable: true },
      }),
    ).toBe('explorer');
  });

  test('returns no helper when every registered agent is disabled', () => {
    expect(
      resolveHelperSessionAgent(['orchestrator', 'explorer', 'librarian'], {
        explorer: { disable: true },
        librarian: { disable: true },
      }),
    ).toBeUndefined();
  });

  test('returns no helper when every registered agent is unsafe', () => {
    expect(
      resolveHelperSessionAgent(['orchestrator', 'compaction', 'summary']),
    ).toBeUndefined();
  });
});

describe('resolveSessionAgent', () => {
  test('prefers the caller hint without any SDK round trip', async () => {
    const get = mock(async () => ({ data: { agent: 'build' } }));
    const client = createClient({ get });

    const agent = await resolveSessionAgent(client, 's1', { hint: 'designer' });

    expect(agent).toBe('designer');
    expect(get).not.toHaveBeenCalled();
  });

  test('reads the agent off the session record', async () => {
    const client = createClient({
      get: mock(async () => ({ data: { agent: 'oracle', parentID: 'p1' } })),
    });

    expect(await resolveSessionAgent(client, 's1')).toBe('oracle');
  });

  test('accepts an unwrapped session response', async () => {
    const client = createClient({
      get: mock(async () => ({ agent: 'librarian' })),
    });

    expect(await resolveSessionAgent(client, 's1')).toBe('librarian');
  });

  test('falls back to the newest user message agent', async () => {
    const client = createClient({
      get: mock(async () => ({ data: { id: 's1' } })),
      messages: mock(async () => ({
        data: [
          { info: { role: 'user', agent: 'orchestrator' } },
          { info: { role: 'user', agent: 'explorer' } },
        ],
      })),
    });

    expect(await resolveSessionAgent(client, 's1')).toBe('explorer');
  });

  test('accepts the legacy `mode` field as an agent name', async () => {
    const client = createClient({
      messages: mock(async () => ({
        data: [{ info: { role: 'user', mode: 'fixer' } }],
      })),
    });

    expect(await resolveSessionAgent(client, 's1')).toBe('fixer');
  });

  // M6a (role filter): assistant messages report whichever agent SERVED a
  // turn. `build` here is what a session already re-homed by bug P3 reports -
  // deriving from it would propagate the corruption instead of restoring the
  // agent the user actually addressed.
  test('ignores assistant messages and uses the last user-requested agent', async () => {
    const client = createClient({
      messages: mock(async () => ({
        data: [
          { info: { role: 'user', agent: 'orchestrator' } },
          { info: { role: 'assistant', agent: 'build' } },
        ],
      })),
    });

    expect(await resolveSessionAgent(client, 's1')).toBe('orchestrator');
  });

  // M6b (denylist): a native compaction lands an assistant message tagged
  // `compaction` in the user's own live session.
  test('ignores a compaction assistant message', async () => {
    const client = createClient({
      messages: mock(async () => ({
        data: [
          { info: { role: 'user', agent: 'orchestrator' } },
          { info: { role: 'assistant', agent: 'compaction' } },
        ],
      })),
    });

    expect(await resolveSessionAgent(client, 's1')).toBe('orchestrator');
  });

  test('never resolves core internal primaries from message history', async () => {
    for (const systemAgent of ['compaction', 'summary', 'title']) {
      const client = createClient({
        messages: mock(async () => ({
          data: [{ info: { role: 'user', agent: systemAgent } }],
        })),
      });

      expect(await resolveSessionAgent(client, 's1')).toBeUndefined();
    }
  });

  test('skips a system agent on the session record', async () => {
    const client = createClient({
      get: mock(async () => ({ data: { agent: 'summary', parentID: '' } })),
      messages: mock(async () => ({
        data: [{ info: { role: 'user', agent: 'designer' } }],
      })),
    });

    expect(await resolveSessionAgent(client, 's1')).toBe('designer');
  });

  test('falls back when a system agent is the only candidate', async () => {
    const client = createClient({
      get: mock(async () => ({ data: { agent: 'title' } })),
      messages: mock(async () => ({ data: [] })),
    });

    expect(
      await resolveSessionAgent(client, 's1', { assumeTopLevel: true }),
    ).toBeUndefined();
  });

  test('rejects a system agent passed as a hint', async () => {
    const client = createClient({
      messages: mock(async () => ({
        data: [{ info: { role: 'user', agent: 'fixer' } }],
      })),
    });

    expect(
      await resolveSessionAgent(client, 's1', { hint: 'compaction' }),
    ).toBe('fixer');
  });

  test('returns the top-level fallback for a parentless session', async () => {
    const client = createClient({
      get: mock(async () => ({ data: { id: 's1' } })),
      messages: mock(async () => ({ data: [] })),
    });

    expect(await resolveSessionAgent(client, 's1')).toBe(
      FALLBACK_TOP_LEVEL_AGENT,
    );
  });

  test('never guesses an agent for a child session', async () => {
    const client = createClient({
      get: mock(async () => ({ data: { id: 's2', parentID: 's1' } })),
      messages: mock(async () => ({ data: [] })),
    });

    expect(await resolveSessionAgent(client, 's2')).toBeUndefined();
  });

  test('ignores assumeTopLevel when the session really has a parent', async () => {
    const client = createClient({
      get: mock(async () => ({ data: { id: 's2', parentID: 's1' } })),
    });

    expect(
      await resolveSessionAgent(client, 's2', { assumeTopLevel: true }),
    ).toBeUndefined();
  });

  test('uses assumeTopLevel only when probing is explicitly disabled', async () => {
    const client = createClient({});

    expect(await resolveSessionAgent(client, 's1')).toBeUndefined();
    expect(
      await resolveSessionAgent(client, 's1', {
        assumeTopLevel: true,
        probe: false,
      }),
    ).toBe(FALLBACK_TOP_LEVEL_AGENT);
  });

  test('probe: false skips every SDK call', async () => {
    const get = mock(async () => ({ data: { agent: 'build' } }));
    const messages = mock(async () => ({ data: [] }));
    const client = createClient({ get, messages });

    const agent = await resolveSessionAgent(client, 's1', {
      assumeTopLevel: true,
      probe: false,
    });

    expect(agent).toBe(FALLBACK_TOP_LEVEL_AGENT);
    expect(get).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
  });

  test('honors a custom fallback agent', async () => {
    const client = createClient({});

    expect(
      await resolveSessionAgent(client, 's1', {
        assumeTopLevel: true,
        probe: false,
        fallbackAgent: 'librarian',
      }),
    ).toBe('librarian');
  });

  // M7: plugin-created helper sessions must not be tagged `orchestrator`,
  // which would make src/index.ts adopt them as managed orchestrator
  // sessions (reminders, nudges, board injection, companion status).
  test('helper sessions can use a non-orchestrator fallback', async () => {
    const client = createClient({});

    const agent = await resolveSessionAgent(client, 'helper-1', {
      assumeTopLevel: true,
      probe: false,
      fallbackAgent: 'councillor',
    });

    expect(agent).toBe('councillor');
    expect(agent).not.toBe(FALLBACK_TOP_LEVEL_AGENT);
  });

  test('suppresses fallback after SDK failures leave the session unverified', async () => {
    const client = createClient({
      get: mock(async () => {
        throw new Error('offline');
      }),
      messages: mock(async () => {
        throw new Error('offline');
      }),
    });

    expect(await resolveSessionAgent(client, 's1')).toBeUndefined();
  });

  test('does not treat failed SDK envelopes as parentless session records', async () => {
    const client = createClient({
      get: mock(async () => ({
        data: undefined,
        error: { message: 'session lookup failed' },
      })),
      messages: mock(async () => ({
        data: undefined,
        error: { message: 'message lookup failed' },
      })),
    });

    expect(
      await resolveSessionAgent(client, 'child-like', {
        assumeTopLevel: true,
      }),
    ).toBeUndefined();
  });

  test('ignores an agent on a message with no role', async () => {
    const client = createClient({
      messages: mock(async () => ({ data: [{ info: { agent: 'explorer' } }] })),
    });

    expect(await resolveSessionAgent(client, 's1')).toBeUndefined();
  });

  test('rejects malformed agent values from the SDK', async () => {
    const client = createClient({
      get: mock(async () => ({ data: { agent: 42, parentID: '' } })),
      messages: mock(async () => ({
        data: [{ info: { agent: 'not valid' } }],
      })),
    });

    expect(await resolveSessionAgent(client, 's1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regression guard: no agent-less session prompt may re-enter the codebase.
//
// An agent-less `session.prompt` / `session.promptAsync` body makes OpenCode
// resolve the default (`build`) agent and permanently rewrite the target
// session's agent — see docs/agents/build-agent-empty-input-diagnosis.md
// ("Empirical confirmation", probe A2). This scan fails with
// file:line for every prompt call site that neither passes `agent:` inline nor
// routes its body through `withAgent()`.
// ---------------------------------------------------------------------------

const SRC_DIR = path.resolve(import.meta.dir, '..');

/**
 * Files whose prompt call is a pass-through wrapper: the args object comes
 * from the caller, so the agent decision belongs to the call sites — which
 * this same scan checks (see `WRAPPER_CALL_PATTERN`).
 */
const PASS_THROUGH_WRAPPERS = new Map<string, string>([
  [
    'utils/session.ts',
    'promptWithTimeout(client, args, timeoutMs) forwards a caller-provided args object; its call sites are scanned through WRAPPER_CALL_PATTERN',
  ],
]);

/**
 * Files that prompt the **v2 host** session API rather than the v1 OpenCode
 * SDK. The v2 `PromptInput` is flat (`{ sessionID, text, files?, ... }`) and
 * carries no `agent` field at all (`src/v2/types.ts`): on v2 the agent is
 * selected by a separate `session.switchAgent({ sessionID, agent })` call
 * (`src/v2/interview-bridge.ts`). Bug P3's agent-less-body shape therefore
 * cannot be expressed here, and a `withAgent` field would just be dropped by
 * the host.
 */
const V2_FLAT_HOST_PROMPTS = new Map<string, string>([
  [
    'v2/session-submit.ts',
    'v2 flat host PromptInput ({ sessionID, text }) has no agent field; v2 agent selection goes through session.switchAgent',
  ],
  [
    'v2/client-shim.ts',
    'adapter that translates v1 SDK calls into the v2 flat host API: its `s.prompt({ sessionID, text, delivery })` calls target v2 PromptInput, which has no agent field. FOLLOW-UP (docs/opencode-v2-compatibility.md): the shim currently DROPS body.agent when adapting v1 prompt/promptAsync and should call s.switchAgent when one is present.',
  ],
]);

/**
 * Type-only files: they never issue a runtime prompt, so an agent-less body is
 * not a bug there — it is the assertion. The call-shape contract deliberately
 * holds malformed bodies behind `@ts-expect-error` to prove the client type
 * rejects them.
 */
const TYPE_ONLY_PROMPT_FILES = new Map<string, string>([
  [
    'utils/session-calls.contract.ts',
    'type-only compile-time contract against a no-op client; its @ts-expect-error blocks intentionally hold rejected prompt bodies',
  ],
]);

/** `x.session.prompt(`, `client.session.promptAsync(`, and casted calls. */
const PROMPT_MEMBER_PATTERN =
  /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*(?:prompt|promptAsync)\b/g;

/** Wrappers that take a full prompt args object and must name the agent too. */
const WRAPPER_CALL_PATTERN = /\b(promptWithTimeout)\s*\(/g;

/**
 * `const prompt = session.prompt.bind(session)` (src/tools/task-message.ts)
 * hides the call behind a local identifier that `PROMPT_CALL_PATTERN` cannot
 * see. Collect those aliases so calls through them are scanned too.
 */
const BOUND_ALIAS_PATTERN =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*(?:prompt|promptAsync)\s*\.\s*bind\s*\(/g;
const CONDITIONAL_BOUND_ALIAS_PATTERN =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*\?\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*(?:prompt|promptAsync)\s*\.\s*bind\s*\(/g;

function boundPromptAliasPattern(source: string): RegExp | undefined {
  const aliases = new Set<string>();
  for (const declarationPattern of [
    BOUND_ALIAS_PATTERN,
    CONDITIONAL_BOUND_ALIAS_PATTERN,
  ]) {
    declarationPattern.lastIndex = 0;
    let match = declarationPattern.exec(source);
    while (match) {
      if (match[1]) aliases.add(match[1]);
      match = declarationPattern.exec(source);
    }
  }
  if (aliases.size === 0) return undefined;
  // The negative lookbehind keeps `session.prompt(` out of this matcher so a
  // member call is not reported twice. Include casted alias invocations too.
  const names = [...aliases]
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(
    `(?<![.\\w$])(?:(${names})\\s*\\(|\\(\\s*(${names})\\s+as[\\s\\S]*?\\)\\s*\\()`,
    'g',
  );
}

function promptInvocationOpening(
  source: string,
  memberEnd: number,
): number | undefined {
  let index = memberEnd;
  while (/\s/.test(source[index] ?? '')) index++;
  if (source[index] === '(') return index;
  if (!/^as\b/.test(source.slice(index))) return undefined;

  index += 2;
  let depth = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '(') depth++;
    if (ch === ')') {
      if (depth > 0) depth--;
      if (depth === 0) {
        index++;
        while (/\s/.test(source[index] ?? '')) index++;
        return source[index] === '(' ? index : undefined;
      }
    }
    index++;
  }
  return undefined;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      files.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
    files.push(full);
  }
  return files;
}

/**
 * Blank out comment bodies and string/template contents (preserving offsets
 * and newlines) so the scan never trips over prose that merely mentions
 * `client.session.promptAsync()`.
 */
function maskNonCode(source: string): string {
  const chars = source.split('');
  const blank = (at: number): void => {
    if (at < chars.length && chars[at] !== '\n') chars[at] = ' ';
  };
  let index = 0;

  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1] ?? '';

    if (ch === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        blank(index);
        index++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      while (index < end) {
        blank(index);
        index++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      index++;
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          blank(index);
          blank(index + 1);
          index += 2;
          continue;
        }
        if (current === quote) {
          index++;
          break;
        }
        blank(index);
        index++;
      }
      continue;
    }
    index++;
  }

  return chars.join('');
}

/**
 * Extract the text between an opening delimiter at `openerIndex` and its
 * matching closing delimiter, skipping over strings, template literals, and
 * comments.
 */
function extractCallArgs(source: string, openerIndex: number): string {
  const opener = source[openerIndex];
  const stack: string[] = [opener];
  let quote: string | null = null;
  let index = openerIndex + 1;

  while (index < source.length) {
    const ch = source[index] as string;
    const next = source[index + 1] ?? '';

    if (quote) {
      if (ch === '\\') {
        index += 2;
        continue;
      }
      if (quote === '`' && ch === '$' && next === '{') {
        stack.push('$');
        quote = null;
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
      index++;
      continue;
    }

    if (ch === '/' && next === '/') {
      const newline = source.indexOf('\n', index);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', index);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      index++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
      index++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack.pop();
      if (top === '$') {
        quote = '`';
        index++;
        continue;
      }
      if (stack.length === 0) return source.slice(openerIndex + 1, index);
      index++;
      continue;
    }
    index++;
  }

  return source.slice(openerIndex + 1);
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  const stack: string[] = [];
  let quote: string | null = null;

  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (quote) {
      if (ch === '\\') {
        index++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      stack.pop();
      continue;
    }
    if (ch === ',' && stack.length === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

const STATICALLY_ABSENT_AGENT_VALUE =
  /^(?:undefined|null|void\s+0)(?:\s+as\b[\s\S]*)?$/;

function unwrapParenthesizedExpression(text: string): string {
  let expression = text.trim();
  while (expression.startsWith('(') && expression.endsWith(')')) {
    expression = expression.slice(1, -1).trim();
  }
  return expression;
}

function splitTopLevelConditional(
  text: string,
): { whenTrue: string; whenFalse: string } | undefined {
  const stack: string[] = [];
  let questionIndex = -1;
  let nestedQuestions = 0;

  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    const next = text[index + 1] ?? '';
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      stack.pop();
      continue;
    }
    if (stack.length > 0) continue;

    if (ch === '?' && next !== '?' && next !== '.' && questionIndex === -1) {
      questionIndex = index;
      continue;
    }
    if (questionIndex === -1) continue;
    if (ch === '?') {
      nestedQuestions++;
      continue;
    }
    if (ch === ':' && nestedQuestions > 0) {
      nestedQuestions--;
      continue;
    }
    if (ch === ':') {
      return {
        whenTrue: text.slice(questionIndex + 1, index),
        whenFalse: text.slice(index + 1),
      };
    }
  }

  return undefined;
}

function isStaticallyAbsentAgentValue(value: string): boolean {
  const expression = unwrapParenthesizedExpression(
    splitTopLevel(value)[0]?.replace(/^\s*:\s*/, '') ?? value,
  );
  if (STATICALLY_ABSENT_AGENT_VALUE.test(expression)) return true;

  const conditional = splitTopLevelConditional(expression);
  return conditional
    ? isStaticallyAbsentAgentValue(conditional.whenTrue) ||
        isStaticallyAbsentAgentValue(conditional.whenFalse)
    : false;
}

function hasTopLevelAgentProperty(text: string): boolean {
  const stack: string[] = [];
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quoteEnd = text.indexOf(ch, index + 1);
      index = quoteEnd === -1 ? text.length : quoteEnd;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      stack.pop();
      continue;
    }
    if (
      stack.length === 0 &&
      text.startsWith('agent', index) &&
      !/[\w$]/.test(text[index - 1] ?? '') &&
      !/[\w$]/.test(text[index + 5] ?? '') &&
      /^\s*:/.test(text.slice(index + 5))
    ) {
      const value = text.slice(index + 5);
      if (isStaticallyAbsentAgentValue(value)) {
        return false;
      }
      return true;
    }
  }
  return false;
}

function withAgentCallNamesAgent(text: string, start: number): boolean {
  const withAgentIndex = text.indexOf('(', start);
  if (withAgentIndex === -1) return false;
  const args = extractCallArgs(text, withAgentIndex);
  const secondArgument = splitTopLevel(args)[1]?.trim();
  return Boolean(
    secondArgument && !isStaticallyAbsentAgentValue(secondArgument),
  );
}

function namesAgent(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('withAgent')) {
    return withAgentCallNamesAgent(text, text.indexOf('withAgent'));
  }

  const body = /\bbody\s*:\s*/.exec(text);
  if (body) {
    let valueStart = body.index + body[0].length;
    while (/\s/.test(text[valueStart] ?? '')) valueStart++;
    if (text[valueStart] === '{') {
      return hasTopLevelAgentProperty(extractCallArgs(text, valueStart));
    }
    if (text.startsWith('withAgent', valueStart)) {
      return withAgentCallNamesAgent(text, valueStart);
    }
  }

  return hasTopLevelAgentProperty(text);
}

/**
 * Resolve `body: promptBody`, shorthand `body,`, and bare-identifier args
 * (`promptAsync(promptBody)`) indirection: find the local declaration of
 * `identifier` and inspect its initializer.
 */
function declaredValueNamesAgent(source: string, identifier: string): boolean {
  const declaration = new RegExp(
    `(?:const|let|var)\\s+${identifier}\\s*(?::[^=]+)?=\\s*`,
  ).exec(source);
  if (!declaration) return false;

  const valueStart = declaration.index + declaration[0].length;
  const opener = source[valueStart];
  if (opener === '{') {
    return namesAgent(extractCallArgs(source, valueStart));
  }
  // Non-literal initializer: inspect the rest of the statement.
  const end = source.indexOf(';', valueStart);
  return namesAgent(source.slice(valueStart, end === -1 ? undefined : end));
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * The identifier a prompt call routes its body through, if any:
 * `body: promptBody` → `promptBody`, shorthand `body,` → `body`, and a bare
 * `promptAsync(promptBody)` → `promptBody`.
 */
function indirectBodyIdentifier(args: string): string | undefined {
  const explicit = /body\s*:\s*([A-Za-z_$][\w$]*)\s*(?:[,}]|$)/.exec(args);
  if (explicit?.[1]) return explicit[1];
  if (/(?:^|[\s{,])body\s*(?:[,}]|$)/.test(args)) return 'body';
  const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(args);
  return bare?.[1];
}

function findViolations(relativePath: string, rawSource: string): string[] {
  if (
    TYPE_ONLY_PROMPT_FILES.has(relativePath) ||
    V2_FLAT_HOST_PROMPTS.has(relativePath)
  ) {
    return [];
  }

  const source = maskNonCode(rawSource);
  const violations: string[] = [];
  const boundAliases = boundPromptAliasPattern(source);
  // No receiver filter. A `/session/i.test(receiver)` guard used to live here
  // and it hid a real prompt site: `src/v2/client-shim.ts` calls `s.prompt(`
  // on a destructured host handle whose name says nothing about sessions.
  // Any `<receiver>.prompt(` / `.promptAsync(` is scanned; files that legitimately
  // cannot carry an agent are named in the allowlists above.
  const matchers: RegExp[] = [
    PROMPT_MEMBER_PATTERN,
    WRAPPER_CALL_PATTERN,
    ...(boundAliases ? [boundAliases] : []),
  ];

  for (const pattern of matchers) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      const parenIndex =
        pattern === PROMPT_MEMBER_PATTERN
          ? promptInvocationOpening(source, match.index + match[0].length)
          : match.index + match[0].length - 1;
      if (parenIndex === undefined) {
        match = pattern.exec(source);
        continue;
      }
      const isDeclaration = /\bfunction\s*$/.test(source.slice(0, match.index));
      if (!isDeclaration) {
        const args = extractCallArgs(source, parenIndex);
        const indirect = indirectBodyIdentifier(args);
        const isBareIdentifier = /^\s*[A-Za-z_$][\w$]*\s*$/.test(args);
        const compliant =
          namesAgent(args) ||
          (indirect ? declaredValueNamesAgent(source, indirect) : false) ||
          ((isBareIdentifier || !/\bbody\s*[:,}]/.test(args)) &&
            PASS_THROUGH_WRAPPERS.has(relativePath));

        if (!compliant) {
          violations.push(
            `${relativePath}:${lineOf(source, match.index)} - ${
              pattern === PROMPT_MEMBER_PATTERN
                ? `${match[0].trim()}(`
                : match[0].trim()
            }`,
          );
        }
      }
      match = pattern.exec(source);
    }
  }

  return violations;
}

describe('agent-less prompt regression guard', () => {
  const files = listSourceFiles(SRC_DIR);

  test('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test('every session prompt call site names its agent', () => {
    const violations: string[] = [];
    for (const file of files) {
      const relativePath = path
        .relative(SRC_DIR, file)
        .split(path.sep)
        .join('/');
      violations.push(
        ...findViolations(relativePath, readFileSync(file, 'utf8')),
      );
    }

    expect(
      violations,
      violations.length
        ? `session.prompt/promptAsync bodies must pass 'agent' (use withAgent/resolveSessionAgent from src/utils/prompt-agent.ts):\n${violations.join('\n')}`
        : undefined,
    ).toEqual([]);
  });

  test('scanner detects an agent-less prompt body', () => {
    const source = [
      'await client.session.promptAsync({',
      '  path: { id: sessionID },',
      `  body: { parts: [{ type: 'text', text: \`hi \${name}\` }] },`,
      '});',
    ].join('\n');

    expect(findViolations('fixture.ts', source)).toEqual([
      'fixture.ts:1 - client.session.promptAsync(',
    ]);
  });

  test('scanner accepts an inline agent field', () => {
    const source = [
      'await client.session.prompt({',
      '  path: { id: sessionID },',
      "  body: { agent: 'orchestrator', parts: [] },",
      '});',
    ].join('\n');

    expect(findViolations('fixture.ts', source)).toEqual([]);
  });

  test('scanner handles a casted prompt member call', () => {
    const violating = [
      'await (sessionClient.promptAsync as PromptFn)({',
      '  path: { id }, body: { parts: [] },',
      '});',
    ].join('\n');
    const compliant = [
      'await (sessionClient.promptAsync as PromptFn)({',
      "  path: { id }, body: { agent: 'fixer', parts: [] },",
      '});',
    ].join('\n');

    expect(findViolations('fixture.ts', violating)).toEqual([
      'fixture.ts:1 - sessionClient.promptAsync(',
    ]);
    expect(findViolations('fixture.ts', compliant)).toEqual([]);
  });

  test('scanner accepts a withAgent-wrapped body', () => {
    const source = [
      'await client.session.prompt({',
      '  path: { id: sessionID },',
      '  body: withAgent({ parts: [] }, agent),',
      '});',
    ].join('\n');

    expect(findViolations('fixture.ts', source)).toEqual([]);
  });

  test('scanner rejects an agent field nested under another body field', () => {
    const source = [
      'await client.session.prompt({',
      '  path: { id: sessionID },',
      "  body: { parts: [], metadata: { agent: 'fixer' } },",
      '});',
    ].join('\n');

    expect(findViolations('fixture.ts', source)).toEqual([
      'fixture.ts:1 - client.session.prompt(',
    ]);
  });

  test('scanner does not treat a later nested agent as a spread agent', () => {
    const source = [
      'await client.session.prompt({',
      '  path: { id: sessionID },',
      "  body: { parts: [], ...defaults, metadata: { agent: 'fixer' } },",
      '});',
    ].join('\n');

    expect(findViolations('fixture.ts', source)).toEqual([
      'fixture.ts:1 - client.session.prompt(',
    ]);
  });

  test('scanner rejects withAgent when its agent argument is undefined', () => {
    const source = [
      'await client.session.prompt({',
      '  path: { id: sessionID },',
      '  body: withAgent({ parts: [] }, undefined),',
      '});',
    ].join('\n');

    expect(findViolations('fixture.ts', source)).toEqual([
      'fixture.ts:1 - client.session.prompt(',
    ]);
  });

  test.each(['undefined', 'null', 'void 0'])(
    'scanner rejects a statically absent agent field: %s',
    (value) => {
      const source = [
        'await client.session.prompt({',
        '  path: { id: sessionID },',
        `  body: { agent: ${value}, parts: [] },`,
        '});',
      ].join('\n');

      expect(findViolations('fixture.ts', source)).toEqual([
        'fixture.ts:1 - client.session.prompt(',
      ]);
    },
  );

  test.each(['undefined', 'null', 'void 0'])(
    'scanner rejects withAgent with a statically absent agent: %s',
    (value) => {
      const source = [
        'await client.session.prompt({',
        '  path: { id: sessionID },',
        `  body: withAgent({ parts: [] }, ${value}),`,
        '});',
      ].join('\n');

      expect(findViolations('fixture.ts', source)).toEqual([
        'fixture.ts:1 - client.session.prompt(',
      ]);
    },
  );

  test.each(['undefined', 'null', 'void 0'])(
    'scanner rejects a conditional agent field ending in %s',
    (value) => {
      const source = [
        'await client.session.prompt({',
        '  path: { id: sessionID },',
        `  body: { agent: condition ? agentName : ${value}, parts: [] },`,
        '});',
      ].join('\n');

      expect(findViolations('fixture.ts', source)).toEqual([
        'fixture.ts:1 - client.session.prompt(',
      ]);
    },
  );

  test.each(['undefined', 'null', 'void 0'])(
    'scanner rejects withAgent with a conditional agent ending in %s',
    (value) => {
      const source = [
        'await client.session.prompt({',
        '  path: { id: sessionID },',
        `  body: withAgent({ parts: [] }, condition ? agentName : ${value}),`,
        '});',
      ].join('\n');

      expect(findViolations('fixture.ts', source)).toEqual([
        'fixture.ts:1 - client.session.prompt(',
      ]);
    },
  );

  test('scanner resolves a body declared as a local variable', () => {
    const compliant = [
      'const promptBody = {',
      '  agent: agentName,',
      '  parts: [],',
      '};',
      'await sessionClient.promptAsync({ path: { id }, body: promptBody });',
    ].join('\n');
    const violating = [
      'const promptBody = { parts: [] };',
      'await sessionClient.promptAsync({ path: { id }, body: promptBody });',
    ].join('\n');

    expect(findViolations('fixture.ts', compliant)).toEqual([]);
    expect(findViolations('fixture.ts', violating)).toEqual([
      'fixture.ts:2 - sessionClient.promptAsync(',
    ]);
  });

  test('scanner rejects a conditional agent spread', () => {
    const source = [
      'const promptBody = {',
      '  parts: [],',
      '  ...(agentName ? { agent: agentName } : {}),',
      '};',
      'await sessionClient.promptAsync({ path: { id }, body: promptBody });',
    ].join('\n');

    expect(findViolations('fixture.ts', source)).toEqual([
      'fixture.ts:5 - sessionClient.promptAsync(',
    ]);
  });

  // src/hooks/foreground-fallback passes the whole args object as one bare
  // identifier, so the scan has to follow the declaration instead of falling
  // back to the pass-through allowlist.
  test('scanner resolves a bare args identifier', () => {
    const compliant = [
      'const promptBody = {',
      '  path: { id: sessionID },',
      '  body: { agent: agentName, parts },',
      '};',
      'await sessionClient.promptAsync(promptBody);',
    ].join('\n');
    const violating = [
      'const promptBody = { path: { id: sessionID }, body: { parts } };',
      'await sessionClient.promptAsync(promptBody);',
    ].join('\n');

    expect(findViolations('fixture.ts', compliant)).toEqual([]);
    expect(findViolations('fixture.ts', violating)).toEqual([
      'fixture.ts:2 - sessionClient.promptAsync(',
    ]);
  });

  // src/tools/task-message.ts builds `const body = {...}` and passes it as a
  // shorthand property.
  test('scanner resolves a shorthand body property', () => {
    const compliant = [
      'const body = { agent: job.agent, parts: [] };',
      'await sessionClient.prompt({ path: { id }, body, throwOnError: true });',
    ].join('\n');
    const violating = [
      'const body = { parts: [] };',
      'await sessionClient.prompt({ path: { id }, body, throwOnError: true });',
    ].join('\n');

    expect(findViolations('fixture.ts', compliant)).toEqual([]);
    expect(findViolations('fixture.ts', violating)).toEqual([
      'fixture.ts:2 - sessionClient.prompt(',
    ]);
  });

  // src/tools/task-message.ts calls through `session.prompt.bind(session)`,
  // which no member-expression pattern can see.
  test('scanner follows a bound prompt alias', () => {
    const violating = [
      'const prompt = session.prompt.bind(session);',
      'await prompt({ path: { id }, body: { parts: [] } });',
    ].join('\n');
    const compliant = [
      'const prompt = session.prompt.bind(session);',
      "await prompt({ path: { id }, body: { agent: 'fixer', parts: [] } });",
    ].join('\n');

    expect(findViolations('fixture.ts', violating)).toEqual([
      'fixture.ts:2 - prompt(',
    ]);
    expect(findViolations('fixture.ts', compliant)).toEqual([]);
  });

  test('scanner follows a casted bound prompt alias', () => {
    const violating = [
      'const prompt = session.prompt.bind(session);',
      'await (prompt as PromptFn)({ body: { parts: [] } });',
    ].join('\n');
    const compliant = [
      'const prompt = session.prompt.bind(session);',
      "await (prompt as PromptFn)({ body: { agent: 'fixer', parts: [] } });",
    ].join('\n');

    expect(findViolations('fixture.ts', violating)).toEqual([
      'fixture.ts:2 - (prompt as PromptFn)(',
    ]);
    expect(findViolations('fixture.ts', compliant)).toEqual([]);
  });

  test('scanner follows a conditional casted bound prompt alias', () => {
    const violating = [
      "const promptAsync = typeof session.promptAsync === 'function'",
      '  ? session.promptAsync.bind(session)',
      '  : undefined;',
      'await (promptAsync as PromptFn)({ body: { parts: [] } });',
    ].join('\n');
    const compliant = [
      "const promptAsync = typeof session.promptAsync === 'function'",
      '  ? session.promptAsync.bind(session)',
      '  : undefined;',
      "await (promptAsync as PromptFn)({ body: { agent: 'fixer', parts: [] } });",
    ].join('\n');

    expect(findViolations('fixture.ts', violating)).toEqual([
      'fixture.ts:4 - (promptAsync as PromptFn)(',
    ]);
    expect(findViolations('fixture.ts', compliant)).toEqual([]);
  });

  test('scanner reports a bound alias call exactly once', () => {
    const source = [
      'const prompt = session.prompt.bind(session);',
      'await prompt({ body: { parts: [] } });',
      'await client.session.prompt({ body: { parts: [] } });',
    ].join('\n');

    expect(findViolations('fixture.ts', source)).toEqual([
      'fixture.ts:3 - client.session.prompt(',
      'fixture.ts:2 - prompt(',
    ]);
  });

  test('scanner scans every receiver, not only session-shaped ones', () => {
    // The receiver name is not evidence. A /session/i heuristic used to skip
    // these and it hid src/v2/client-shim.ts's own prompt call site. Over-
    // reporting an unrelated .prompt( is a loud, allowlistable failure;
    // under-reporting a real one is a silent agent rewrite.
    expect(findViolations('fixture.ts', 'await ui.dialog.prompt({});')).toEqual(
      ['fixture.ts:1 - ui.dialog.prompt('],
    );
  });

  test('the v2 flat-host shim is allowlisted rather than filtered out', () => {
    // Regression pin for the removed receiver filter: if client-shim.ts ever
    // leaves the allowlist, the repo-wide scan above must report it instead
    // of silently skipping it.
    expect(V2_FLAT_HOST_PROMPTS.has('v2/client-shim.ts')).toBe(true);
    const shimCall = 'return s.prompt({ sessionID, text });';
    expect(findViolations('v2/client-shim.ts', shimCall)).toEqual([]);
    expect(findViolations('somewhere-else.ts', shimCall)).toEqual([
      'somewhere-else.ts:1 - s.prompt(',
    ]);
  });

  test('every allowlisted file exists and carries a substantive reason', () => {
    const allowlists = [
      PASS_THROUGH_WRAPPERS,
      V2_FLAT_HOST_PROMPTS,
      TYPE_ONLY_PROMPT_FILES,
    ];
    for (const allowlist of allowlists) {
      expect(allowlist.size).toBeGreaterThan(0);
      for (const [file, reason] of allowlist) {
        expect(reason.length).toBeGreaterThan(20);
        expect(files.some((f) => f.endsWith(file))).toBe(true);
      }
    }
  });

  // The exemptions must stay narrow: an exempt file is unscanned, so it may
  // not also be a v1 SDK prompt site.
  test('exemptions do not overlap', () => {
    const seen = new Set<string>();
    for (const allowlist of [
      PASS_THROUGH_WRAPPERS,
      V2_FLAT_HOST_PROMPTS,
      TYPE_ONLY_PROMPT_FILES,
    ]) {
      for (const file of allowlist.keys()) {
        expect(seen.has(file)).toBe(false);
        seen.add(file);
      }
    }
  });
});
