import { withTimeout } from '../utils/session';
import type { EvalSessionClient } from './eval-client';
import { pollSession } from './polling-session';
import type { Transcript } from './schema';
import { EvalQuiescenceError, stopEvalSessionTree } from './session-quiescence';

const AGENT_NAME_RE = /^@([A-Za-z][A-Za-z0-9-]*)\s*/;

// Agent names for @-mention routing in eval prompts. Source of truth:
// src/agents/index.ts — update this list when agents are added/removed.
const KNOWN_AGENTS = new Set([
  'orchestrator',
  'explorer',
  'librarian',
  'oracle',
  'designer',
  'fixer',
  'observer',
  'council',
  'councillor',
  'councillor-alpha',
  'councillor-beta',
  'councillor-gamma',
  'skeptic',
]);

export type EvalSessionResult = {
  success: boolean;
  response: string;
  transcript?: Transcript;
  error?: string;
  durationSecs: number;
};

type RunViaServer = (
  agent: string,
  prompt: string,
  label: string,
  attempt: number,
) => Promise<EvalSessionResult>;

const sessionDependencies = { withTimeout, pollSession, stopEvalSessionTree };

/**
 * Run a session end-to-end: create, route @agent, prompt, poll.
 * Direct callable — not a factory. Testable with a mock client.
 */
export async function runWithSession(
  client: EvalSessionClient,
  agent: string,
  prompt: string,
  label: string,
  attempt: number,
  directory: string,
  timeoutMs: number,
  ts?: () => string,
  deps = sessionDependencies,
): Promise<EvalSessionResult> {
  const attemptLabel = attempt > 1 ? `${label} (attempt ${attempt})` : label;
  const t0 = Date.now();
  const tsFn = ts ?? (() => '');
  const heartbeat = setInterval(() => {
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`${tsFn()} ${attemptLabel} still running (${secs}s)`);
  }, 30_000);
  let sid: string | undefined;
  let dispatchAttempted = false;
  let dispatchAcknowledged = false;
  let result: EvalSessionResult;

  try {
    const created = await deps.withTimeout(
      client.session.create({
        body: { title: `eval: ${label.trim()}` },
        query: { directory },
      }),
      30_000,
      'Session creation timed out',
    );
    sid = created.data?.id;
    if (!sid) {
      throw new Error('session.create returned no id');
    }

    const mentionMatch = prompt.match(AGENT_NAME_RE);
    const parsedAgent = mentionMatch?.[1]?.toLowerCase();
    const hasMention = parsedAgent != null && KNOWN_AGENTS.has(parsedAgent);
    let promptBody: {
      parts: Array<
        { type: 'agent'; name: string } | { type: 'text'; text: string }
      >;
      agent: string;
    };
    if (hasMention && mentionMatch) {
      const rest = prompt.slice(mentionMatch[0].length);
      promptBody = {
        parts: [
          { type: 'agent', name: parsedAgent ?? '' },
          ...(rest.length > 0 ? [{ type: 'text' as const, text: rest }] : []),
        ],
        agent: parsedAgent ?? agent,
      };
    } else {
      promptBody = {
        parts: [{ type: 'text', text: prompt }],
        agent,
      };
    }

    dispatchAttempted = true;
    const dispatch = client.session.promptAsync({
      path: { id: sid },
      body: {
        parts: promptBody.parts,
        agent: promptBody.agent,
      },
      query: { directory },
    });
    const dispatched = await deps.withTimeout(
      dispatch,
      timeoutMs,
      'Session prompt timed out',
    );
    if (dispatched.error != null || dispatched.response?.ok !== true) {
      throw new Error('Session prompt was not positively acknowledged');
    }
    dispatchAcknowledged = true;

    result = await deps.pollSession(
      {
        fetchMessages: (id: string) =>
          client.session
            .messages({ path: { id }, query: { directory } })
            .then((r: unknown) => {
              const d = (r as { data?: unknown }).data;
              return Array.isArray(d) ? d : [];
            }),
        agent,
        prompt,
        label,
        attempt,
        directory,
        timeoutMs,
        stallMs: 120_000,
        graceMs: 90_000,
        ts: tsFn,
      },
      sid,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${attemptLabel} — error: ${msg}`);
    result = {
      success: false,
      response: '',
      error: msg,
      durationSecs: 0,
    };
  } finally {
    clearInterval(heartbeat);
  }
  if (sid) {
    await deps.stopEvalSessionTree(client, sid, directory);
    // Promise rejection/settlement does not prove the host discarded a prompt.
    // Without a positive HTTP acknowledgement, admission may still happen
    // after these aborts and idle scans. Keep user work stashed in that case.
    if (dispatchAttempted && !dispatchAcknowledged) {
      throw new EvalQuiescenceError(
        [sid],
        'Prompt dispatch was not positively acknowledged; late admission remains possible',
      );
    }
  }
  return result;
}
