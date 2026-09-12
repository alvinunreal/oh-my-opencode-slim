/**
 * Compile-time contract for OpenCode session/tool client call shapes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The runtime OpenCode client (`input.client`, typed from the root
 * `@opencode-ai/sdk`) uses a NESTED `{ path, query, body }` request shape.
 * A premature v2 migration shipped FLAT shapes (`{ sessionID }`) against that
 * v1 runtime client. Unit tests mocked the client with `as never`/`as any`
 * and test files are excluded from `tsc` (the tsconfig excludes `*.test.ts`), so
 * the shape mismatch was never caught at compile time.
 *
 * This file is NOT a `.test.ts` — it lives in `src/` so `bun run typecheck`
 * compiles it. The valid calls pin the exact shapes the source produces; the
 * `@ts-expect-error` blocks assert the broken flat shapes are REJECTED. If a
 * revert re-introduces a flat call, `tsc --noEmit` fails.
 *
 * It is type-only: the no-op handle means nothing executes. It has no runtime
 * test and is intentionally not part of the bun test suite.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';

// A typed handle to the real runtime client. Methods are no-ops; this file
// only proves the TYPE contract, never real HTTP.
const noop = () => ({});
const client = {
  session: {
    abort: noop,
    messages: noop,
    message: noop,
    get: noop,
    status: noop,
    todo: noop,
    children: noop,
    delete: noop,
    create: noop,
    prompt: noop,
    promptAsync: noop,
  },
  tool: { ids: noop },
} as unknown as OpencodeClient;

// ---------------------------------------------------------------------------
// Valid: the nested { path, query, body } shapes the source uses today.
// Any of these failing means the source no longer matches the runtime type.
// ---------------------------------------------------------------------------

// abort (foreground-fallback, cancel-task, index.ts)
client.session.abort({ path: { id: 'ses_x' } });

// messages (foreground-fallback, session.ts extractSessionResult)
client.session.messages({
  path: { id: 'ses_x' },
  query: { directory: '/d' },
});

// message (chat-headers)
client.session.message({ path: { id: 'ses_x', messageID: 'msg_1' } });

// get (cancel-task getSessionParentID, orchestrator-wake)
client.session.get({ path: { id: 'ses_x' }, query: { directory: '/d' } });

// status (cancel-task getSessionStatus, orchestrator-wake)
client.session.status({ query: { directory: '/d' } });

// delete (cancel-task, secondary-model)
client.session.delete({
  path: { id: 'ses_x' },
  query: { directory: '/d' },
});

// create (secondary-model)
client.session.create({
  query: { directory: '/d' },
  body: { title: 'secondary' },
});

// prompt (secondary-model, session.ts promptWithTimeout)
// `agent` is mandatory in practice, not by type: an agent-less body makes the
// runtime resolve its default primary and durably rewrite the session's agent
// (see src/utils/prompt-agent.ts and
// docs/agents/build-agent-empty-input-diagnosis.md, probe A2). The type
// contract only pins the shape; the repo-wide scan in
// src/utils/prompt-agent.test.ts enforces the field.
client.session.prompt({
  path: { id: 'ses_x' },
  query: { directory: '/d' },
  body: {
    agent: 'build',
    model: { providerID: 'p', modelID: 'm' },
    system: 's',
    tools: { read: false },
    parts: [{ type: 'text', text: 'body' }],
  },
});

// promptAsync (foreground-fallback)
client.session.promptAsync({
  path: { id: 'ses_x' },
  body: {
    agent: 'orchestrator',
    parts: [{ type: 'text', text: 'nudge' }],
  },
});

// promptAsync with directory query (orchestrator-wake)
client.session.promptAsync({
  path: { id: 'ses_x' },
  query: { directory: '/d' },
  body: {
    agent: 'orchestrator',
    model: { providerID: 'p', modelID: 'm' },
    parts: [{ type: 'text', text: 'wake' }],
  },
});

// todo / children (orchestrator-wake)
client.session.todo({
  path: { id: 'ses_x' },
  query: { directory: '/d' },
});
client.session.children({
  path: { id: 'ses_x' },
  query: { directory: '/d' },
});

// tool.ids (secondary-model)
client.tool.ids({ query: { directory: '/d' } });

// ---------------------------------------------------------------------------
// Rejected: the v2-flat shapes the migration shipped. Each must be a type
// error. If one stops erroring, the client type drifted (or a flat call was
// re-introduced) — investigate before removing the @ts-expect-error.
// ---------------------------------------------------------------------------

// @ts-expect-error v2-flat sessionID is not a valid v1 runtime abort shape
client.session.abort({ sessionID: 'ses_x' });

// @ts-expect-error v2-flat directory is not a valid status shape
client.session.status({ directory: '/d' });

// @ts-expect-error v2-flat sessionID is not a valid get shape
client.session.get({ sessionID: 'ses_x', directory: '/d' });

// @ts-expect-error v2-flat sessionID/messageID is not a valid message shape
client.session.message({ sessionID: 'ses_x', messageID: 'm' });

// @ts-expect-error v2-flat sessionID is not a valid messages shape
client.session.messages({ sessionID: 'ses_x' });

// @ts-expect-error v2-flat sessionID is not a valid delete shape
client.session.delete({ sessionID: 'ses_x', directory: '/d' });

client.session.prompt({
  // @ts-expect-error v2-flat sessionID
  sessionID: 'ses_x',
  parts: [{ type: 'text', text: 'x' }],
});

client.session.promptAsync({
  // @ts-expect-error v2-flat sessionID
  sessionID: 'ses_x',
  parts: [{ type: 'text', text: 'x' }],
});

// v1 prompt body does not declare top-level variant
client.session.prompt({
  path: { id: 'ses_x' },
  body: { parts: [{ type: 'text', text: 'x' }] },
  // @ts-expect-error top-level variant is not part of the v1 prompt body
  variant: 'high',
});

// v1 promptAsync body does not declare variant
client.session.promptAsync({
  path: { id: 'ses_x' },
  query: { directory: '/d' },
  body: {
    parts: [{ type: 'text', text: 'x' }],
    // @ts-expect-error variant is not part of the v1 promptAsync body
    variant: 'high',
  },
});
