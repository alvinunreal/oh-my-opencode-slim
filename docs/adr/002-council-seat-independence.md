# ADR-002: Council seats stay independent

**Date:** 2026-10-17
**Status:** Accepted
**Deciders:** User + Orchestrator

## Context

Council Mode dispatches every councillor seat in parallel, each seat
receiving only the prompt it was dispatched with, then hands all seat
responses to a separate council agent to synthesize. No seat ever sees
another seat's answer.

That is a design decision, and until now it was an undocumented one.
`docs/council.md` documented configuration and usage; nothing recorded
*why* the flow is independent-only. That leaves the most likely future
change to Council Mode — adding a cross-review stage where seat B
critiques seat A's response — looking like an obvious missing feature
rather than a regression.

This ADR records the decision and the evidence behind it, so the next
reader does not have to re-derive it.

The evidence is a single external study (below). It is directional
support, not proof, and its limits are recorded in [Evidence limits](#evidence-limits).

## Decisions

### 1. Seats stay independent

**Decision:** A councillor session receives only the prompt it was
dispatched with. It never receives a peer seat's response, and there is
no review or revision stage between the seat round and synthesis.

**Rationale:** The value of a multi-seat council comes from error
decorrelation between seats, not from seat count. The study measured
finding-level overlap between reviewers: same-model sessions share
52–62% of findings, cross-model pairs share 37–46%. Seats on different
models are therefore seeing materially different things, and a
three-seat council is already the "union of differently-biased reviewers"
configuration that the study found to be the thing worth paying for.

### 2. Synthesis stays a separate role, not a vote

**Decision:** The council agent synthesizes; seats do not vote and do not
resolve their own disagreement.

**Rationale:** Majority voting among seats that share a blind spot
returns the blind spot with a confidence label attached. A separate
synthesizer with no stake in any seat's answer is what surfaces
disagreement instead of averaging it away. The council agent already
reports `unanimous | majority | split` consensus plus disagreements and
their resolution, which is the decision this ADR is protecting.

### 3. A cross-review stage is not a missing feature

**Decision:** Not adding a stage where seats review each other's
responses.

**Rationale:** This is the change most likely to be proposed as an
improvement, so it is worth being explicit about what it would be and
what the evidence says.

"Cross-review" means seat B receives seat A's answer as input and
critiques it, with the critique fed back into the loop. That is a
different intervention from the one the study measured. The study's
reviewers looked at an artifact in a fresh session and never saw the
conversation that produced it. Nobody reviewed anybody's output.

The two findings that do bear on it both point away from it:

- Repeated review rounds in the same session raised false positives by
  62% without improving recall.
- A multi-stage pipeline whose later stages could see earlier stages'
  conclusions produced only sycophantic confirmation. The study
  attributes the benefit it observed to *information restriction*, not
  to structural complexity — a later stage conditioned on an earlier
  stage's answer is the pattern that failed, not one that succeeded.

Making seats see each other would trade the independence this ADR
depends on for a review stage with no measured accuracy gain behind it.

### 4. Seat quality outranks seat count

**Decision:** Document that the weakest seat can cost more than it
contributes, without adding config validation.

**Rationale:** The spread between the best and worst reviewer model in
the study was 8.3 percentage points, larger than the entire spread
among all same-model conditions (6.9pp). The lowest-capability
cross-model reviewer scored *below* the baseline self-review condition,
and cross-model review introduced a false-positive class of its own —
model-bias errors, where the reviewer flags something as nonexistent
based on its own training data, were 9.4% of cross-model false
positives.

So a weak seat is not neutral; it dilutes. The plugin's job is to let
users express lineup choices, not to second-guess them.

### 5. Council depth stays an orchestrator judgment

**Decision:** No config knob scales council depth. The orchestrator
decides per invocation how much machinery to spend.

**Rationale:** The injected Council Mode block
(`src/hooks/council-inject/index.ts`) is a construction-time constant,
pinned for prompt-cache safety — its own header forbids gating it on
session state, because a plugin restart that dropped the block would
rewrite already-cached prefix bytes. A stakes-driven gate is therefore
not available at that layer, and it is not needed: the orchestrator can
simply choose not to dispatch an optional stage. Encoding the full
procedure in the block and letting the orchestrator select depth costs
nothing at steady state, since the block is only injected once per
transcript and only on a council trigger.

## Rejected enhancements

Two enhancements considered and rejected during this decision are
recorded in the repository's triage knowledge base, which is read during
issue triage so a repeat proposal surfaces the prior decision instead of
re-litigating it:

- [`.out-of-scope/council-cross-review.md`](../../.out-of-scope/council-cross-review.md)
  — a cross-review stage where seats critique each other's responses,
  and debate rounds between seats. See decision 3.
- [`.out-of-scope/council-fallback-validation.md`](../../.out-of-scope/council-fallback-validation.md)
  — config-time validation of overlapping fallback chains across seats.
  See decision 4.

One further point is a design constraint rather than a rejected request:
majority vote among seats is not a substitute for synthesis. Three votes
cannot resolve a blind spot the seats share. The council agent's
mandated disagreement reporting (decision 2) is what surfaces it.

## Evidence

From *When Does a Second Model Help? Cross-Model Review in LLM
Verification* (arXiv:2610.01471, 2026) — 900 review sessions, 30
artifacts, 150 planted errors, 10 review conditions, three reviewer
models across two developers.

| Finding | Number |
|---|---|
| Top-tier cross-model reviewer vs fresh-session same-model, F1 | 32.3% vs 28.6%, Holm-adjusted p=1.00 — **not significant** |
| Finding overlap between same-model and cross-model reviewers (Jaccard) | 41.2% |
| Two reviews, one of each kind, vs two same-model (matched errors) | 56.7% vs 42.7%, p=0.006 |
| Best vs worst reviewer model, F1 spread | 8.3pp (vs 6.9pp spread across all same-model conditions) |
| Within-model vs cross-model finding overlap | 52–62% vs 37–46% |
| Code artifacts, same-model vs cross-model, F1 | 40.7% vs 37.2% |
| Documents, cross-model vs same-model, F1 | 42.1% vs 17.4–24.5% |

The headline result is the union comparison: mixing review kinds beat
repeating one kind at the same call count, and that comparison reached
significance. The result that *did not* reach significance is "a
cross-model reviewer is more accurate than same-context self-review" —
which is why this ADR frames the benefit as decorrelation, not as
reviewers being smarter.

### Evidence limits

Read the numbers as direction, not precision:

- Single-author preprint, not peer reviewed.
- All artifacts and ground truth in Korean; the finding matcher is
  keyword-based and may under-credit reviews produced in other
  languages.
- One reviewer model per capability tier, so reviewer quality and model
  identity are confounded.
- No equivalence test was run, so "not significantly different" does not
  establish that cross-model and same-model review are equally good.
- The code/document category reversal is descriptive and untested.

## Consequences

- The council's seat count and seat independence are now documented, so
  adding a review stage requires overturning this ADR rather than
  assuming the feature was forgotten.
- Users choosing a lineup should weight seat capability over seat
  count; the guide says so explicitly.
- Nothing about runtime behavior changes. This ADR is documentation.

## Amendment path

Revisit if a peer-reviewed study measures cross-member review (as
opposed to cross-model review of a fixed artifact) and finds it helps.
The distinguishing question for any future study is whether the reviewer
saw the generator's context, not whether it was a different model.
