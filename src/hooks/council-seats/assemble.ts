/**
 * Pure council seat assembly.
 *
 * The orchestrator emits only a `Seats: <ref, ref>` line on the council
 * synthesis call (the IDs the seat dispatches returned). This module
 * parses the FINAL such line — a `Seats:` roster quoted inside the
 * question must never shadow the orchestrator's refs — strips it from the
 * prompt, and appends one `## Seat: <label>` section per seat with the
 * resolved body, so the orchestrator never re-emits seat text as
 * output tokens (Mixture-of-Agents assembly with an independent judge).
 *
 * The assembly is a pure function of (prompt, seats, results): no host
 * reads, no timers, no state. Fail-open by contract — a resolver
 * rejection becomes one placeholder per seat and nothing throws.
 */
import { log } from '../../utils/logger';
import type { SeatRequest, SeatResult, SeatResultResolver } from './types';

/** Trigger line the orchestrator emits on a council synthesis call. No
 * /g flag: lastIndex state would skip matches across the
 * findLastIndex/exec passes. */
const SEATS_LINE_PATTERN = /^Seats:\s*(.+)$/;

/**
 * Canonical placeholder tails, one per non-completed kind. The managed
 * resolver uses these; the native resolver may use its own short tails.
 */
export const SEAT_REASONS = {
  running: 'still running',
  missing: 'unresolved ref',
  ambiguous: 'unverified result',
  empty: 'empty result',
  error: 'failed',
} as const;

/** Body the council sees for one seat result. */
export function seatBodyOf(result: SeatResult): string {
  if (result.kind === 'completed') return result.text;
  const reason = result.reason.trim();
  return `[no response — ${reason || SEAT_REASONS[result.kind]}]`;
}

/** Parse the seats of a synthesis prompt. Returns the refs (in order)
 * and the index of the FINAL `Seats:` line, or undefined when the prompt
 * carries no trigger line. Empty/whitespace refs are dropped, so an
 * empty-refs line yields `refs: []`. */
export function parseSeatRefs(
  prompt: string,
): { refs: string[]; triggerIndex: number } | undefined {
  const lines = prompt.split('\n');
  const triggerIndex = lines.findLastIndex((line) =>
    SEATS_LINE_PATTERN.test(line),
  );
  if (triggerIndex === -1) return undefined;
  const refs = (SEATS_LINE_PATTERN.exec(lines[triggerIndex])?.[1] ?? '')
    .split(',')
    .map((ref) => ref.trim())
    .filter((ref) => ref !== '');
  return { refs, triggerIndex };
}

/** Runtime shape guard for one resolver result (the resolver is a host
 * boundary — its output is untrusted). Malformed entries degrade to
 * ambiguity, never a throw. */
function seatResultOf(value: unknown): SeatResult | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (typeof kind !== 'string') return undefined;
  const label =
    typeof value.label === 'string' && value.label.trim() !== ''
      ? value.label
      : undefined;
  if (kind === 'completed') {
    if (typeof value.text !== 'string' || value.text.trim() === '')
      return undefined;
    return { kind, text: value.text, ...(label ? { label } : {}) };
  }
  if (
    kind !== 'running' &&
    kind !== 'missing' &&
    kind !== 'ambiguous' &&
    kind !== 'empty' &&
    kind !== 'error'
  ) {
    return undefined;
  }
  const reason = typeof value.reason === 'string' ? value.reason : '';
  return {
    kind,
    reason: reason || SEAT_REASONS[kind],
    ...(label ? { label } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Rewrite one synthesis prompt: strip the FINAL `Seats:` line, trim
 * trailing newlines, and append one `## Seat: <label>` section per seat,
 * separated by blank lines. Empty refs (a trigger line with no usable
 * reference) report themselves as a single section instead of passing
 * through silently — the council must see which seats are missing, never
 * a bare ID line it cannot use.
 *
 * A trigger line with refs always rewrites: unresolved refs (restart,
 * eviction, cross-conversation) become per-seat placeholders. Sections
 * are joined into the prompt as one string, so nothing can observe (or
 * throw out of) a half-rewritten prompt. `results` aligns with the
 * parsed refs in order; a missing entry degrades to ambiguity.
 */
export function buildSeatPrompt(prompt: string, results: SeatResult[]): string {
  const parsed = parseSeatRefs(prompt);
  if (!parsed) return prompt;
  const { refs, triggerIndex } = parsed;
  const lines = prompt.split('\n');
  const sections =
    refs.length === 0
      ? ['[no seat references were provided]']
      : refs.map((ref, index) => {
          const result = results[index];
          const label = result?.label?.trim() || ref;
          return `## Seat: ${label}\n${result ? seatBodyOf(result) : `[no response — ${SEAT_REASONS.ambiguous}]`}`;
        });
  const kept = [
    ...lines.slice(0, triggerIndex),
    ...lines.slice(triggerIndex + 1),
  ]
    .join('\n')
    .replace(/\n+$/, '');
  return `${kept}\n\n${sections.join('\n\n')}`;
}

/**
 * Resolve the seats of one synthesis prompt and assemble the result back
 * into it. Never throws: a resolver rejection (or a malformed result
 * array) yields one placeholder per ref — `[no response — resolver
 * error]` — and an empty-refs line is reported without calling the
 * resolver at all.
 */
export async function assembleCouncilPrompt(input: {
  prompt: string;
  parentSessionID: string;
  seats: SeatRequest[];
  resolveSeats: SeatResultResolver;
}): Promise<string> {
  const { prompt, parentSessionID, seats, resolveSeats } = input;
  const parsed = parseSeatRefs(prompt);
  if (!parsed) return prompt;
  const { refs } = parsed;
  let results: SeatResult[] = [];
  if (refs.length > 0) {
    try {
      const resolved = await resolveSeats(parentSessionID, seats);
      results = seats.map((_, index) => {
        const result = seatResultOf(
          Array.isArray(resolved) ? resolved[index] : undefined,
        );
        return (
          result ?? {
            kind: 'ambiguous',
            reason: 'resolver returned no result for this seat',
          }
        );
      });
    } catch (error) {
      log('[council-seats] seat resolver failed; using placeholders', {
        parentSessionID,
        seats: refs.length,
        error: error instanceof Error ? error.message : String(error),
      });
      results = refs.map(() => ({ kind: 'error', reason: 'resolver error' }));
    }
  }
  return buildSeatPrompt(prompt, results);
}
