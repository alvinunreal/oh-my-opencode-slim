---
name: loop-engineering
description: Bounded delivery protocol for a prepared unit. The parent/orchestrator owns lifecycle and final acceptance; Fixer implements, planned proof runs against the candidate, one implementation Reviewer review covers spec/diff/proof, and the parent arbitrates findings with up to two repairs.
---

# Loop Engineering

`loop-engineering` is the bounded delivery protocol for a prepared delivery
unit. The parent/orchestrator owns the lifecycle and final acceptance.
`/loop` is only a user-entry adapter that directs the parent to load this
protocol; it is never a callable procedure or an independent controller.

## Input: Delivery Unit Packet

The protocol accepts a prepared delivery unit packet. It does not run an
interactive intake or interview. The packet contains:

- **Identity:** initiative ID, delivery unit ID, plan version, and plan/
  review-log artifact paths.
- **Authority:** tier classification (Tier 0/1/2) and Tier-2 authority if
  applicable.
- **Scope:** goal, scope, exclusions, interfaces, and dependencies.
- **Proof:** acceptance claims, proof commands, prerequisites, and
  interpretation criteria.
- **Evidence brief:** Local Code Facts, External Doc Facts (URL + ref +
  retrieval time), and Unresolved Uncertainties.
- **Budget:** attempt budget, attempts used, prior failure summary, and next
  action.

## Pre-Dispatch Checks

Block dispatch if any of these hold:

- the proof command is missing or not executable;
- a declared dependency is unmet;
- Tier-2 authority is missing or the plan approval / user authorisation is
  stale or absent.

Record the blocking reason and stop. Do not proceed with a substitute proof,
a weakened gate, or an unauthorised Tier-2 unit.

## Delivery Order

1. **Fixer delivery:** Fixer implements within the unit scope. Fixer does not
   redefine the scope, redesign the architecture, or approve its own output.
2. **Planned proof:** the parent runs the planned proof tied to the exact
   candidate revision. The proof runs before the implementation review.
3. **Implementation review:** exactly one `@reviewer` review with
   `review_mode=implementation` evaluates the candidate spec, diff, and
   executed evidence after the proof runs, alongside the factual evidence
   brief. The review is a prompt-level protocol enforced by the parent; there
   is no runtime enforcement. The packet must not contain author
   self-assessment, persuasive rationale, or prior reviewer conclusions.
4. **Arbitration:** the parent arbitrates review findings. Accepted repairs
   require affected validation to pass.
5. **Repairs:** up to two repair attempts, each with affected proof. After
   exhaustion, fail closed and replan.
6. **Parent acceptance:** the parent accepts or rejects the unit. A pass
   completes the prepared unit; it does not complete the initiative.

## Prohibitions

- No optional or manual verification. The proof is deterministic and
  planned; there is no human pass/fail callback.
- No callback API (`onLoopComplete`, `onEscalated`, `resolveManualReview`,
  `cancel`, or similar). The protocol is coordinated by the parent, not by
  runtime callbacks.
- No separate history directory (`.opencode/loop-history/` or similar).
- No random or per-run paths for delivery records.
- No treating a pass as initiative completion.
- No resettable attempt budget. The budget is a non-resettable ceiling; a
  stricter user-supplied limit is honoured as the ceiling.
- No substitute proof or waived gate.
- No architecture redesign, plan approval, or final initiative completion
  inside this protocol. Those belong to the coordinator (`/deepwork` or the
  parent).
- No invoking `/loop` as a callable subprocedure.

## Replan and Resumption

Replan when: a material scope or architecture change is needed, the proof
command itself must change, or repair attempts are exhausted. Resumption
preserves the attempt count and reads durable initiative records
(`.slim/plans/<initiative>/`) for context. Do not reset attempts on
resumption.

## Delivery Result

Record the delivery result for the coordinator:

- candidate and diff identity (commit SHA or working-tree state);
- proof results (pass/fail, commands run, output summary);
- review verdict, findings, and dispositions;
- repairs applied (if any) and their affected validation results;
- blockers (if any);
- parent acceptance outcome;
- next action (accept and continue, replan, or escalate).
