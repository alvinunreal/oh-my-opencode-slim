# Council Fallback Overlap Validation

The plugin does not validate, warn about, or reject council presets whose
councillors declare overlapping model fallback chains.

Two seats in the same preset may both list the same model in their
fallback chain. If both fail over to it, the council silently degrades to
fewer distinct models than the preset appears to specify. This is allowed
and produces no warning.

## Why this is out of scope

Councillor lineups are the user's configuration, and so is model
availability. Overlapping fallback chains are a legitimate availability
tradeoff: a user may deliberately prefer that two seats degrade to the
same model during a provider outage rather than have one seat fail
outright and shrink the council. The plugin has no basis to judge which
tradeoff a given user wants, and a warning that fires on a deliberate
choice trains people to ignore it.

More fundamentally, the plugin does not control which models users have
access to, what they cost, or how they compare in quality. Any rule about
overlap would encode the maintainer's assumptions about lineup quality
into a tool that cannot verify them.

## What the evidence does and does not support

There is a real finding behind the intuition that prompted this request:
reviewer capability matters more than reviewer diversity. In the study
below, the F1 spread between the best and worst reviewer model was 8.3
percentage points, larger than the entire spread across all same-model
conditions (6.9pp), and the lowest-capability cross-model reviewer scored
*below* the baseline self-review condition.

That finding argues for **documenting how to build a good lineup**. It
does not argue for config-time enforcement, because "weak" and
"duplicated" are not facts the config can express — there is no
capability ranking available at load time, and the useful comparison is
relative to the user's own lineup, which only exists at dispatch.

## Where this guidance lives instead

The actionable form of this finding is user-facing documentation rather
than a config check:

- [`docs/council.md`](../docs/council.md) tells users that seat quality
  outranks seat count, and that a seat failing over to a weak model
  dilutes the council rather than adding to it.
- [`docs/adr/002-council-seat-independence.md`](../docs/adr/002-council-seat-independence.md)
  records the decision and the evidence behind it.

If a future release grows the ability to express capability tiers or cost
ceilings in config, validation becomes expressible at that point. Until
then it is not.

## Evidence

From *When Does a Second Model Help? Cross-Model Review in LLM
Verification* (arXiv:2610.01471, 2026). Single-author preprint, not peer
reviewed; one reviewer model per capability tier, so reviewer quality and
model identity are confounded. Directional support only.
