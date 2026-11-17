/**
 * Council seat-result resolution contract.
 *
 * Council Mode's synthesis call carries only a final `Seats: <ref, ref>`
 * line; the native host-session resolver implements
 * {@link SeatResultResolver}. The hook in `index.ts`
 * and the assembly in `assemble.ts` are resolver-agnostic: they only know
 * the prompt shape and the placeholder vocabulary, never where the seat
 * text comes from.
 */

/**
 * One seat reference parsed from the synthesis prompt's `Seats:` line.
 *
 * `seat` is the reference exactly as written; it also seeds the section
 * heading when a resolver supplies no display label. `childID` is set only
 * for a literal `ses_` child-session identifier, so the native resolver can
 * address the host session directly.
 */
export interface SeatRequest {
  seat: string;
  childID?: string;
}

/**
 * The outcome of resolving one seat. `completed` carries the seat's
 * terminal answer verbatim; every other kind carries a short `reason`
 * that the assembly renders as `[no response — <reason>]`. The canonical
 * reasons are exported from `assemble.ts` (`SEAT_REASONS`). A resolver may
 * supply its own tail, but the prefix is always the assembly's.
 *
 * `label` optionally names the seat for the `## Seat: <label>` heading;
 * it defaults to the request's `seat` reference.
 */
export type SeatResult =
  | { kind: 'completed'; text: string; label?: string }
  | {
      kind: 'running' | 'missing' | 'ambiguous' | 'empty' | 'error';
      reason: string;
      label?: string;
    };

/**
 * Resolve every seat of one synthesis call. Results align with the input
 * order (one result per request); a rejection is handled by the caller as
 * a per-seat placeholder, never propagated.
 */
export type SeatResultResolver = (
  parentSessionID: string,
  seats: SeatRequest[],
) => Promise<SeatResult[]>;
