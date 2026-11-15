# ADR-004: The survivor ledger is verified by the mutation gate, never hand-synced

**Date:** 2026-11-14
**Status:** Accepted
**Deciders:** User + Agent

## Context

The survivor ledger in `docs/mutation-testing.md` records the disposition of
each mutation survivor (killed by which test, or equivalent with a proof).
Its line ranges are the one part that must be restated by hand, because a
markdown table cannot derive them.

That hand-sync failed three times the same way (#1852 recorded ranges,
#1902's merge bumped them to lines that hold no mutant, #1906's correction
died unmerged). Each failure surfaced only in review, days after the merge
that caused it. The gate that produces the authoritative data — the Stryker
report, with per-mutant ranges, statuses, and `killedBy` attribution — runs
as a required CI check on every PR, and its target-check script already
verifies the config's own targets against that report.

## Decision

`scripts/check-mutation-targets.mjs` verifies every ledger row against the
run's own report, inside the required mutation gate:

1. each row's range must hold at least one mutant in the current run;
2. a `Killed` row must be killed by the `contract:` test the row names;
3. an `Equivalent (not killed)` row must still report `Survived` — a kill or
   a coverage change invalidates the documented proof and fails the gate.

Ledger ranges are treated as sweep-time snapshots. When a refactor shifts
the guarded lines, the follow-up PR re-derives the new ranges from the
report (which red-flagged the drift) rather than retyping them.

## Consequences

A merge that shifts the guarded code turns the gate red until the ledger is
re-derived — the cost of the drift surfaces in CI at merge time, not in
review days later. In exchange, the ledger can no longer silently claim
kills the tests no longer perform, and nobody hand-edits ranges as a
routine step.
