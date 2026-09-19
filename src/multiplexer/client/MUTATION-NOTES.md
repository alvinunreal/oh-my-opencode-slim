# Mutation checks — client lifecycle core (tasks 2.3 / 2.6)

Date: 2026-09-20
Scope: `src/multiplexer/client/lifecycle.ts`
Runner: `bun test src/multiplexer/client/` (baseline and after each restore: 40 pass / 0 fail)

## 2.3 — per-client dedup (FR-6)

- **Mutation A**: removed the in-flight spawn guard in `handleEvent`
  (`if (this.spawnsInFlight.has(event.sessionId)) return;`), so a concurrent
  or replayed `created` delivery reaches `createPane` twice.
- **Expected**: duplicate `created` events spawn twice.
- **Observed failure (1)**:
  `dedup and stable-idle close (2.3) > spawns exactly one pane when the same
  created event arrives twice concurrently` — `spawnCalls` length 2, expected 1.
- **Restored**: guard re-added; suite green (40 pass / 0 fail).

## 2.6 — stable-idle debounce window (FR-10)

- **Mutation B**: collapsed the debounce window in `scheduleStableIdleClose`
  by replacing `this.config.stableIdleMs` with `0`, so the close fires on the
  first clock tick instead of after the configured window.
- **Expected**: window-boundary tests fail because idle panes close immediately.
- **Observed failures (2)**:
  `dedup and stable-idle close (2.3) > does not close the pane before the
  stable-idle window elapses`
  `dedup and stable-idle close (2.3) > keeps the pane when the child turns busy
  inside the debounce window`
- **Restored**: configured window restored; suite green (40 pass / 0 fail).

Conclusion: the dedup marker and the configurable debounce window are each
load-bearing for the corresponding tests; breaking either makes the suite fail.
