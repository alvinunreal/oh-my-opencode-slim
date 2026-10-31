/**
 * Council seat-result assembly hook (`tool.execute.before`).
 *
 * Acts only on a delegation call whose target agent is exactly `council`
 * (v1 `task` + `subagent_type`, or the raw v2 `subagent` + `agent`), and
 * only when the prompt carries a final `Seats: <ref, ref>` line. Anything
 * else passes through byte-identically. The seat results themselves come
 * from the injected {@link SeatResultResolver} — the managed job board
 * (`managed.ts`) or native host sessions (`native.ts`) — so council works
 * with the managed lifecycle ON or OFF.
 *
 * Unconditional and fail-open: the resolver only acts on the final Seats
 * line and never refuses — a shape check that failed closed (rejecting
 * prompts whose quoted content mentions a Seats line) would DoS
 * legitimate council calls. No timers, no polling, no persistence.
 */
import { log } from '../../utils/logger';
import { assembleCouncilPrompt, parseSeatRefs } from './assemble';
import type { SeatResultResolver } from './types';

const COUNCIL_AGENT = 'council';
const DELEGATION_TOOLS = new Set(['task', 'subagent']);

/** v1/v2 tool.execute.before input shapes (see src/hooks/index.ts wiring
 * and the v2→v1 bridge in src/v2/setup.ts). */
interface ToolExecuteBeforeInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface ToolExecuteBeforeOutput {
  args?: unknown;
}

export interface CouncilSeatHook {
  'tool.execute.before': (
    input: ToolExecuteBeforeInput,
    output: ToolExecuteBeforeOutput,
  ) => Promise<void>;
}

export interface CouncilSeatHookDeps {
  resolveSeats: SeatResultResolver;
}

export function createCouncilSeatHook(
  deps: CouncilSeatHookDeps,
): CouncilSeatHook {
  return {
    'tool.execute.before': async (input, output) => {
      if (!input || typeof input.tool !== 'string') return;
      if (!DELEGATION_TOOLS.has(input.tool.toLowerCase())) return;
      const sessionID = input.sessionID;
      if (typeof sessionID !== 'string' || sessionID.trim() === '') return;
      const args = output?.args;
      if (!args || typeof args !== 'object' || Array.isArray(args)) return;
      const record = args as Record<string, unknown>;
      // v1 carries `subagent_type`; a raw v2 subagent call carries `agent`.
      // The v2→v1 bridge normalizes before this hook runs, so on a managed
      // v2 host only the v1 name arrives — both are accepted for the
      // boardless native path that sees raw v2 args.
      const agent = record.subagent_type ?? record.agent;
      if (typeof agent !== 'string' || agent.trim() !== COUNCIL_AGENT) {
        return;
      }
      if (typeof record.prompt !== 'string') return;
      const parsed = parseSeatRefs(record.prompt);
      if (!parsed) return;
      const seats = parsed.refs.map((ref) => ({
        seat: ref,
        ...(ref.startsWith('ses_') ? { childID: ref } : {}),
      }));
      const assembled = await assembleCouncilPrompt({
        prompt: record.prompt,
        parentSessionID: sessionID,
        seats,
        resolveSeats: deps.resolveSeats,
      });
      if (assembled === record.prompt) return;
      record.prompt = assembled;
      // One line, no prompt content: the orchestrator's prompt is
      // untrusted text and the log is a diagnostics surface.
      log('[council-seats] seat assembly applied', {
        parentSessionID: sessionID,
        seats: parsed.refs.length,
        promptLength: assembled.length,
      });
    },
  };
}
