# src/hooks/council-seats/

## Responsibility

Council Mode host-side seat-result assembly as a standalone seam: the
`tool.execute.before` hook that rewrites a council synthesis prompt, plus
the two seat-result resolvers it can be built with — the managed job
board (`managed.ts`) and native host sessions (`native.ts`). Council
works identically with the managed lifecycle ON or OFF; neither resolver
knows about the other.

## Design

- **types.ts** — the resolver contract: `SeatRequest` (`seat` ref, plus
  `childID` when the ref is a literal `ses_` session ID), `SeatResult`
  (`completed` + verbatim text, or a placeholder kind with a short
  `reason` and optional display `label`), `SeatResultResolver`
  `(parentSessionID, seats) => Promise<SeatResult[]>`.
- **assemble.ts** — pure assembly over the prompt: parse the FINAL
  `Seats: <ref, ref>` line (`findLastIndex`, no /g), strip it, trim
  trailing newlines, append one `## Seat: <label>` section per seat.
  Placeholder bodies render as `[no response — <reason>]`; `SEAT_REASONS`
  holds the canonical tails (`still running`, `unresolved ref`,
  `unverified result`, `empty result`, `failed`). Empty
  refs report themselves (`[no seat references were provided]`). Fail-open:
  a resolver rejection or malformed result becomes one placeholder per ref
  (`[no response — resolver error]`); assembly never throws.
- **index.ts** — `createCouncilSeatHook({ resolveSeats })`: acts only on a
  delegation call whose agent is exactly `council` (v1
  `subagent_type` or raw v2 `agent`, trimmed) with a string prompt that
  carries a Seats line; everything else passes through byte-identically.
  Logs one line without prompt content. No timers, no polling, no
  persistence.
- **managed.ts** — `createManagedSeatResolver(board)`: resolves refs
  read-only against the parent-scoped background job board
  (`board.resolve(parentSessionID, ref)`). Reproduces the historical
  semantics byte-for-byte: missing → unresolved, running → still running,
  completed-with-text → verbatim, terminal otherwise → the historical
  `[no response — no output (<terminal>)]` shape carried through the
  reason tail (`reconciled` falls back to its recorded terminal state).
  No markUsed, no reconcile, no wait.
- **native.ts** — `createNativeSeatResolver(input)`: no board, no
  lifecycle. Only exact `ses_` child IDs resolve. One bounded deadline
  covers the whole call (default 5 s, injectable `timeoutMs` + `timers` +
  `now` for tests): per seat, one latest round read. One `session.get` verifies
  `parentID === parentSessionID` (mismatch → missing, never a leak); then one child transcript read classifies
  that child's trailing round only — text from before the latest input
  boundary is never replayed, so a re-prompted seat can only surface the
  answer to its latest prompt. A seat whose latest prompt arrives at or
  after the resolver's invocation stamp (`synthesisStartedAt`, captured once
  before any read) is `ambiguous`: its answer cannot be attributed to this
  synthesis call. v2 classifies the round via
  `hostRoundStateOf` + `attributeHostRoundToTranscript` + `composeHostRound`
  (incomplete → running, unreadable → ambiguous, completed requires
  non-empty `terminalTextOf` else empty, error/interrupted → error); v1
  uses `classifyTerminalEvidence` (textless → empty, retry/pending →
  running). Unreadable evidence is ambiguous, never a guess; the resolver
  never throws.

## Tests

- `assemble.test.ts` — trigger parse, body vocabulary, section build,
  resolver-rejection fail-open, empty-refs, malformed results.
- `index.test.ts` — gating (tool/agent/prompt/session shapes), raw v2
  `agent` path, byte-identical passthroughs, resolver-rejection
  containment.
- `managed.test.ts` — ported historical coverage including the v2
  execute.before bridge end-to-end, final-vs-quoted Seats line, lifecycle
  diagnostics, cross-parent isolation, 50KB verbatim inline.
- `native.test.ts` — v2/v1 classification paths, same-turn dispatch,
  cross-parent missing, unreadable sessions, whole-call budget with the
  deterministic timer harness.
