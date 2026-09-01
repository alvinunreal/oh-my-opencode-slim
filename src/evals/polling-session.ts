/**
 * Polling session engine — runs a single agent session to completion.
 *
 * Extracted from auto-collect.ts's runViaServer loop to create a deep
 * module: complex polling logic (stalls, timeouts, background-task grace,
 * transcript building) behind a small interface.
 *
 * The engine accepts a narrow fetchMessages callback instead of the full
 * SDK client — the caller wraps the SDK's session.messages() call.
 */

import { assistantText, isTerminalSession } from '../utils/session';
import { withTimeout } from '../utils/with-timeout';
import type { Transcript } from './schema';

// ── Types ────────────────────────────────────────────────────────────

export interface PollSessionConfig {
  /** Callback to fetch messages for a session ID. SDK-specific wrapper
   *  provided by the caller. Returns the raw message array (or empty on
   *  error) — the engine validates via isTerminalSession. */
  fetchMessages: (sid: string) => Promise<unknown[]>;
  agent: string;
  prompt: string;
  label: string;
  attempt: number;
  directory: string;
  timeoutMs: number;
  stallMs: number;
  graceMs: number;
  ts?: () => string;
  onProgress?: (msg: string) => void;
}

export interface SessionResult {
  success: boolean;
  response: string;
  transcript: Transcript | undefined;
  error?: string;
  durationSecs: number;
}

// ── Polling engine ───────────────────────────────────────────────────

/**
 * Poll a running agent session until terminal, timed out, or stalled.
 * Handles stall detection (no activity for stallMs), background-task grace
 * window (graceMs after terminal + pending tasks), and timeout (timeoutMs
 * hard cap).
 */
export async function pollSession(
  config: PollSessionConfig,
  sid: string,
): Promise<SessionResult> {
  const {
    fetchMessages,
    timeoutMs,
    stallMs,
    graceMs,
    ts: tsFn,
    onProgress,
  } = config;
  const t0 = Date.now();
  const ts = tsFn ?? (() => '');
  const label = `${config.label} attempt ${config.attempt}`;
  const attemptLabel = `[${label}]`;
  const pollStart = Date.now();

  const heartbeat = setInterval(() => {
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`${ts()} ${attemptLabel} still running (${secs}s)`);
    onProgress?.(`still running (${secs}s)`);
  }, 30_000);

  let response = '';
  let transcript: Transcript = {
    messages: [
      { role: 'user', content: '' },
      { role: 'assistant', content: '', toolCalls: [] },
    ],
    toolCallCount: 0,
    turnCount: 0,
    agentInvocations: [],
    agentTokens: {},
    modelSwitches: [],
  };
  let msgs: Parameters<typeof isTerminalSession>[0] = [];
  let lastActivity = pollStart;
  let prevMsgCount = 0;
  let prevPartCount = 0;
  let graceStart: number | null = null;

  try {
    while (Date.now() - pollStart < timeoutMs) {
      await Bun.sleep(1000);
      const raw = await withTimeout(
        fetchMessages(sid).catch(() => null),
        30_000,
      );
      msgs = (raw as unknown as Parameters<typeof isTerminalSession>[0]) ?? [];

      // Track activity — reset stall timer when messages or parts change.
      const partCount = msgs.reduce((n, m) => n + (m.parts?.length ?? 0), 0);
      if (msgs.length !== prevMsgCount || partCount !== prevPartCount) {
        lastActivity = Date.now();
        prevMsgCount = msgs.length;
        prevPartCount = partCount;
      }

      // Verbose poll logging every 15s
      const elapsed = Math.round((Date.now() - pollStart) / 1000);
      if (elapsed % 15 === 0 && elapsed > 0) {
        console.log(
          `${ts()} ${attemptLabel} poll @ ${elapsed}s: ${msgs.length} msgs, ${partCount} parts, terminal=${isTerminalSession(msgs)}`,
        );
      }

      // Stall detector — if no activity for stallMs and not terminal, abort.
      if (!isTerminalSession(msgs) && Date.now() - lastActivity > stallMs) {
        const stallSecs = Math.round((Date.now() - lastActivity) / 1000);
        if (msgs.length > 0) {
          transcript = buildTranscript(msgs.map((m) => parseSdkMessage(m)));
        }
        return {
          success: false,
          response: '',
          transcript,
          error: `session stalled: no progress for ${stallSecs}s (last poll: ${msgs.length} msgs, ${partCount} parts, terminal=false)`,
          durationSecs: (Date.now() - t0) / 1000,
        };
      }

      if (isTerminalSession(msgs)) {
        const text = assistantText(msgs);
        if (text.trim().length > 0) {
          // Check for pending background task calls before finalizing.
          const lastAssistant = [...msgs]
            .reverse()
            .find((m) => m.info?.role === 'assistant');
          const hasPendingTask = (lastAssistant?.parts ?? []).some((p) => {
            if (p.type !== 'tool') return false;
            const pp = p as unknown as Record<string, unknown>;
            const toolName =
              typeof pp.tool === 'string' ? pp.tool.toLowerCase() : '';
            if (toolName !== 'task') return false;
            const st = pp.state as Record<string, unknown> | undefined;
            if (!st || typeof st !== 'object') return false;
            const status = typeof st.status === 'string' ? st.status : '';
            return status !== 'completed' && status !== 'error';
          });

          if (!hasPendingTask) {
            // No pending task — finalize immediately.
            response = text.trim();
            transcript = buildTranscript(msgs.map((m) => parseSdkMessage(m)));
            break;
          }

          // Pending task exists — start or extend the grace window.
          if (graceStart === null) {
            graceStart = Date.now();
            console.log(
              `${ts()} ${attemptLabel} terminal with pending task call — grace period ${graceMs / 1000}s`,
            );
          }

          // If the grace window expired, finalize.
          if (Date.now() - graceStart >= graceMs) {
            response = text.trim();
            transcript = buildTranscript(msgs.map((m) => parseSdkMessage(m)));
            break;
          }
        }
      }
      // Not terminal yet — keep polling.
    }

    if (response.trim().length === 0) {
      // Capture whatever the poll observed — last messages are evidence.
      if (msgs.length > 0) {
        transcript = buildTranscript(msgs.map((m) => parseSdkMessage(m)));
      }
      const partCount = msgs.reduce((n, m) => n + (m.parts?.length ?? 0), 0);
      return {
        success: false,
        response: '',
        transcript,
        error: `session produced no output (last poll: ${msgs.length} msgs, ${partCount} parts, terminal=${isTerminalSession(msgs)})`,
        durationSecs: (Date.now() - t0) / 1000,
      };
    }

    return {
      success: true,
      response,
      transcript,
      durationSecs: (Date.now() - t0) / 1000,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${attemptLabel} — error: ${msg}`);
    return {
      success: false,
      response: '',
      error: msg,
      transcript: undefined,
      durationSecs: 0,
    };
  } finally {
    clearInterval(heartbeat);
  }
}

// ── Message parsing ──────────────────────────────────────────────────

/** Normalize an SDK message into { role, text, toolCalls }. */
export function parseSdkMessage(msg: {
  info?: {
    role?: string;
    agent?: string;
    modelID?: string;
    cost?: number;
    tokens?: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    finish?: string;
  };
  parts?: Array<Record<string, unknown>>;
}): {
  role: string;
  text: string;
  toolCalls: Array<{ name: string; args: unknown; result?: unknown }>;
  agent?: string;
  modelID?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  finish?: string;
} {
  const role = msg.info?.role ?? 'unknown';
  const text = (msg.parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');

  const toolCalls: Array<{ name: string; args: unknown; result?: unknown }> =
    [];
  for (const p of msg.parts ?? []) {
    if (p.type === 'tool') {
      const state = p.state as Record<string, unknown> | undefined;
      toolCalls.push({
        name: (p.tool as string) ?? 'unknown',
        args: state?.input ?? {},
        result: state?.output,
      });
    }
  }
  return {
    role,
    text: text ?? '',
    toolCalls,
    agent: msg.info?.agent as string | undefined,
    modelID: msg.info?.modelID as string | undefined,
    cost: msg.info?.cost as number | undefined,
    tokens: msg.info?.tokens as
      | {
          input: number;
          output: number;
          reasoning: number;
          cache: { read: number; write: number };
        }
      | undefined,
    finish: msg.info?.finish as string | undefined,
  };
}

/** Build a Transcript from parsed SDK messages. */
export function buildTranscript(
  parsed: Array<{
    role: string;
    text: string;
    toolCalls: Array<{ name: string; args: unknown; result?: unknown }>;
    agent?: string;
    modelID?: string;
    cost?: number;
    tokens?: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    finish?: string;
  }>,
): Transcript {
  const messages = parsed.map((m) => ({
    role: m.role as 'assistant' | 'user',
    content: m.text,
    toolCalls: m.toolCalls,
  }));

  const agentInvocations = parsed.flatMap((m) =>
    m.toolCalls
      .filter((tc) => tc.name === 'task')
      .map((tc) => {
        const args = tc.args as Record<string, unknown> | undefined;
        return { agent: (args?.subagent_type as string) ?? 'unknown' };
      }),
  );

  const agentTokens: Record<
    string,
    { input: number; output: number; cost: number }
  > = {};
  for (const m of parsed) {
    if (m.role !== 'assistant' || !m.agent) continue;
    const entry = agentTokens[m.agent] ?? { input: 0, output: 0, cost: 0 };
    if (m.tokens) {
      entry.input += m.tokens.input ?? 0;
      entry.output += m.tokens.output ?? 0;
    }
    if (typeof m.cost === 'number') entry.cost += m.cost;
    agentTokens[m.agent] = entry;
  }

  const modelSwitches: Array<{ from: string; to: string; reason?: string }> =
    [];
  let lastModelID: string | undefined;
  for (const m of parsed) {
    if (m.role !== 'assistant' || !m.modelID) continue;
    if (lastModelID && m.modelID !== lastModelID) {
      modelSwitches.push({ from: lastModelID, to: m.modelID });
    }
    lastModelID = m.modelID;
  }

  return {
    messages,
    toolCallCount: parsed.reduce((n, m) => n + m.toolCalls.length, 0),
    turnCount: parsed.filter((m) => m.role === 'assistant').length,
    agentInvocations,
    agentTokens,
    modelSwitches,
  };
}
