import type { PluginInput } from '@opencode-ai/plugin';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  readNativeSeats,
  type SeatEvidence,
  type SeatReadOptions,
} from './native';

const SEATS_LINE_PATTERN = /^Seats:\s*(.+)$/;

interface CouncilSeatHook {
  'tool.execute.before': (
    input: { tool: string; sessionID?: string; callID?: string },
    output: { args?: unknown },
  ) => Promise<void>;
}

/** Assemble only the council calls already normalized by the V2 bridge. */
export function createCouncilSeatHook(
  input: PluginInput,
  options?: SeatReadOptions,
): CouncilSeatHook {
  return {
    'tool.execute.before': async (call, output) => {
      if (typeof call?.tool !== 'string' || call.tool.toLowerCase() !== 'task')
        return;
      const sessionID = call.sessionID;
      if (typeof sessionID !== 'string' || sessionID.trim() === '') return;
      const args = output?.args;
      if (!isRecord(args) || Array.isArray(args)) return;
      const agent = args.subagent_type;
      if (typeof agent !== 'string' || agent.trim() !== 'council') return;
      if (typeof args.prompt !== 'string') return;

      // The last matching line wins over a roster quoted in the question.
      const lines = args.prompt.split('\n');
      for (let index = lines.length - 1; index >= 0; index--) {
        const match = SEATS_LINE_PATTERN.exec(lines[index]);
        if (!match) continue;
        const refs = match[1]
          .split(',')
          .map((ref) => ref.trim())
          .filter((ref) => ref !== '');
        let results: SeatEvidence[] = [];
        if (refs.length > 0) {
          try {
            results = await readNativeSeats(input, sessionID, refs, options);
          } catch (error) {
            log('[council-seats] seat resolver failed; using placeholders', {
              parentSessionID: sessionID,
              seats: refs.length,
              error: error instanceof Error ? error.message : String(error),
            });
            results = refs.map(() => ({ reason: 'resolver error' }));
          }
        }
        const sections = results.map((result, seatIndex) => {
          const label = result.label ?? refs[seatIndex];
          const body =
            'text' in result ? result.text : `[no response — ${result.reason}]`;
          return `## Seat: ${label}\n${body}`;
        });
        lines.splice(index, 1);
        const kept = lines.join('\n').replace(/\n+$/, '');
        const assembled = `${kept}\n\n${refs.length ? sections.join('\n\n') : '[no seat references were provided]'}`;
        if (assembled === args.prompt) return;
        args.prompt = assembled;
        log('[council-seats] seat assembly applied', {
          parentSessionID: sessionID,
          seats: refs.length,
          promptLength: assembled.length,
        });
        return;
      }
    },
  };
}
