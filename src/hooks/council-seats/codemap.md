# src/hooks/council-seats/

Council seat assembly loads only when the council agent is present. OpenCode
owns dispatch, execution, and completion delivery.

- `index.ts` exposes `createCouncilSeatHook(input)`. The existing V2 bridge
  supplies normalized delegation arguments. The finalized Council identity
  predicate also accepts a renamed visible Council agent. The hook parses the last matching
  `Seats:` line once and replaces it with ordered, labeled seat results.
  Other calls and prompts without a matching line pass through unchanged.
- `native.ts` checks each exact `ses_` reference against the calling parent
  before reading its transcript. The parallel reads share one five-second
  deadline. Shared host evidence helpers attribute terminal text to the newest
  input before synthesis started. Failed or unverified reads produce
  placeholders, not historical answers.
- `index.test.ts` tests the hook with deterministic host and clock fixtures,
  including the V2 bridge's argument normalization and writeback.
