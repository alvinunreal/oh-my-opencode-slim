# src/background-jobs/

## Responsibility

The single deep module owning the background job lifecycle: state, terminal
publication policy, wall-clock supervision, persistence, and the consumer
surface. Everything outside this package interacts through one seam — the
`backgroundJobs` object created by `createBackgroundJobLifecycle` and
re-exported from `index.ts`. No consumer imports board, gate, supervisor, or
persistence modules directly.

## Design

- **types.ts**: Record/lease/input contracts, `BackgroundJobLaunchConflictError`, alias and objective derivation, shared status constants.
- **board.ts** (`BackgroundJobBoard`): The state machine and sole writer of job state. Owns records (with the lifecycle ledger as a field), generations, live leases (cancellation / relaunch / message / terminal-notification), retention trims (`trimReusable`/`trimRetained`), alias resolution, prompt formatting, and the guarded `commitTerminal` that requires a gate-issued single-use `TerminalCommitToken`.
- **ledger.ts**: Process-local lifecycle memory (suppression tombstones, deletion epochs) stored on the board instance.
- **persistence.ts**: Write-through persistence of tombstones/epochs over the host storage domain; hydration at load.
- **terminal-gate.ts** (`createBackgroundJobTerminalGate`): The only authority for terminal publications. Captures observation tokens (generation/activity/episode identity), consumes runtime observations, retries bounded evidence reads with single-open dedupe, and issues commit authorizations. The commit token brand is unforgeable; `consumeTerminalCommitToken` is board-side only.
- **host-reads.ts**: The gate's host-capability ladder as named adapters — runtime status via `session.status` (`hostRuntimeStatus`, `runtimeObservationFromSnapshot`), host outcome via `session.get` (`readSessionInfoForObservation` + window attribution `attributableHostOutcome`), transcript evidence via `session.messages` (`readTranscriptEvidence`), plus capability probes. The gate's `readRuntime`/`readTerminalEvidence` options remain the injection seams in front of these adapters.
- **supervisor.ts** (`DefaultBackgroundJobSupervisor`): Opt-in one-shot wall-clock deadline per run generation: deadline timer → board claim → grace timer armed before abort → grace expiry marks status uncertain and asks the gate to reconcile with the deadline signal.
- **lifecycle.ts** (`BackgroundJobLifecycle` + `createBackgroundJobLifecycle`): The facade consumers hold. Composes board → lifecycle → gate (bound through the lifecycle) → supervisor; adds terminal-state/outcome subscriptions, deferred-close policy, launch identity events, and sole-writer delegation to the board.
- **fixture.ts**: Test-only seeding (`FixtureBoardProxy`, `boardFixture`) that bypasses evidence policy; never imported by production code.

## Flow

1. Launch: a task tool calls `registerLaunch` (generation fencing, alias numbering, optional relaunch lease) and `onLaunch` arms the supervisor.
2. Liveness: session events and `runtime-status-reconciliation` feed `observe`/`reconcile` on the gate; busy re-marks running, quiescence starts evidence reads.
3. Terminal: only an authorized gate commit can move a running record to `completed`/`error`/`cancelled`/`stopped`; the board notifies the lifecycle, which dispatches terminal listeners and clears supervisor timers.
4. Reconcile: `markReconciled` (generation- and revision-fenced) retires the result; retention trims evict per caps with tombstones.
5. Deadline: supervisor fires → board claims → abort → grace → uncertain → gate `deadline` reconcile publishes the timed-out error.

## Integration

- Consumers: `src/index.ts` (composition root), `src/tools/task-*.ts`, `src/hooks/task-session-manager/`, `src/v2/setup.ts`, TUI projection and eviction pruning in `src/utils/`.
- Injections: the factory accepts `readRuntime`, `readTerminalEvidence`, `abort`, `setTimeout`/`clearTimeout`, `now`, and prebuilt board/gate/supervisor instances for tests.
- Imports out: `../utils/child-transcript`, `../utils/session-runtime-status`, `../utils/opencode-client`, `../utils/logger`, `../utils/guards`, `@opencode-ai/plugin`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | The only import surface for outsiders; re-exports the seam and types |
| `types.ts` | Record/lease/input contracts and shared constants |
| `board.ts` | Job state machine, leases, generations, trims, guarded terminal commits |
| `ledger.ts` | Per-board lifecycle ledger (tombstones, deletion epochs) |
| `persistence.ts` | Tombstone/epoch persistence and hydration |
| `terminal-gate.ts` | Terminal evidence gate; issues single-use commit tokens |
| `host-reads.ts` | Host-capability ladder adapters (status / outcome / transcript) |
| `supervisor.ts` | Wall-clock deadline supervision (timer/generation/abort mechanics) |
| `lifecycle.ts` | Consumer facade + `createBackgroundJobLifecycle` factory |
| `fixture.ts` | Test-only board seeding (bypasses evidence policy) |
