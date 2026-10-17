# Council Cross-Review Stage

Council Mode does not add a stage where councillors review each other's
responses, and does not add debate rounds between councillors.

## Why this is out of scope

The council's value comes from error decorrelation between seats, not
from seat count. Councillors are dispatched independently and each seat
session receives only the prompt it was dispatched with. A seat never
sees a peer seat's answer.

Measured finding-level overlap between reviewers:

| Reviewer pairing | Finding overlap (Jaccard) |
|---|---|
| Same model, different sessions | 52–62% |
| Same model, different context | ~60% |
| Different models | 37–46% |

Seats on different models are seeing materially different things. A
three-seat council is *already* the mix of differently-biased reviewers
that does the work. What has not been demonstrated is that feeding one
seat another seat's answer improves on that.

### Cross-review is not the intervention that was tested

The cross-model review literature compares independent reviews of a
fixed artifact. Reviewers look at the artifact in a fresh session and
never see the conversation that produced it. Nobody reviewed anybody's
output.

"Cross-review" as a Council Mode feature means something different: seat
beta receives seat alpha's answer as input and critiques it, with the
critique fed back into the loop. That is a structurally different
intervention, and the adjacent evidence points against it:

- Repeated review rounds in the same session raised false positives by
  62% without improving recall.
- A multi-stage pipeline whose later stages could see earlier stages'
  conclusions produced only sycophantic confirmation. The benefit
  observed in that work came from *information restriction*, not from
  structural complexity — a later stage conditioned on an earlier
  stage's answer is the pattern that failed.

Making seats see each other would trade away the independence the
council depends on, in exchange for a review stage with no measured
accuracy gain behind it.

### The synthesizer is the safe place for cross-visibility

The council agent already receives every seat response. That is fine,
because it is a separate tool-less role with no stake in any seat's
answer, and its report format requires it to surface disagreement rather
than smooth it away — consensus level (`unanimous | majority | split`),
agreed points, disagreements and their resolution, remaining uncertainty.

If seats are deliberately prevented from seeing each other, and the
synthesizer is the one role that sees everything, then the synthesizer is
the only place disagreement gets resolved. That is the intended
separation, not an oversight.

### What to use instead

Two existing mechanisms already cover the desire for seats to take
different angles:

- **Role prompts.** Each councillor accepts a `prompt` field appended to its
  system prompt, so seats can be specialized (reviewer / architect /
  optimizer) while still answering independently. The field is named
  `prompt`, not `role` — see [Role Prompts](../docs/council.md#role-prompts).
- **The synthesizer's disagreement report.** When seats diverge, the
  council report surfaces it explicitly instead of averaging it into a
  false consensus.

Reach for either of those before proposing a review stage.

## Evidence

From *When Does a Second Model Help? Cross-Model Review in LLM
Verification* (arXiv:2610.01471, 2026) — 900 review sessions, 30
artifacts, 150 planted errors, three reviewer models across two
developers.

The result that reached significance is the union comparison: two
reviews of *different kinds* (one same-model, one cross-model) matched
56.7% of planted errors against 42.7% for two same-model reviews at the
same call count (p=0.006). The result that did *not* reach significance
is "a cross-model reviewer is more accurate than same-context
self-review" — 32.3% vs 28.6% F1, Holm-adjusted p=1.00.

Treat the direction as solid and the exact percentages as indicative. The
source is a single-author preprint that is not peer reviewed, all
artifacts and ground truth are in Korean with a keyword-based matcher,
and one reviewer model per capability tier means reviewer quality and
model identity are confounded.

## Related design

See [`docs/adr/002-council-seat-independence.md`](../docs/adr/002-council-seat-independence.md)
for the positive form of this decision — what Council Mode does instead,
and the seat-quality guidance that goes with it.
