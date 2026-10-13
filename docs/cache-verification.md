# Cache verification

This project has four complementary layers. They answer different questions
and should not be conflated.

- **Continuous cache-safety tests** run in `bun test` (and therefore CI) and
  enforce the payload invariants directly against the hook pipeline. This is
  the first line of defense against cache regressions.
- **Deterministic payload verification** proves that this plugin projects a
  stable provider payload under a controlled local capture server. It does not
  measure a provider cache.
- **Live cache benchmarking** records telemetry returned by an already-running
  provider-backed OpenCode server. It is opt-in, provider-specific, and useful
  for comparing explicitly controlled arms; it is not a CI check or a general
  cache guarantee.
- **Runtime cache monitoring** watches provider-reported cache telemetry
  during real sessions and logs a warning when a cache bust signature appears.
- **Live cache smoke** (`bun run cache:smoke`) is a one-command operational
  probe: it starts a real `opencode serve` with your normal config/auth/plugin,
  runs short scripted conversations, and reports per-request provider cache
  telemetry with a verdict.

## Continuous cache-safety tests (CI)

Provider prompt caches are exact byte-prefix matches over the rendered
request. Instead of enumerating known-good payload shapes, these suites
assert the properties every transform must uphold, so they also catch
mistakes that have not been made before:

- `src/hooks/cache-safety.property.test.ts` — re-renders a growing
  conversation through the real transform pipeline (mirroring the
  composition in `src/index.ts`) and asserts turn-over-turn byte-prefix
  stability, isolation of volatile content to the tagged trailing message,
  determinism under wall-clock/randomness changes, and pass-through of
  specialist payloads. A drift guard fails when `src/index.ts` gains, loses,
  or reorders transform steps without the suite being updated.
- `src/hooks/cache-payload.snapshot.test.ts` — golden snapshots of every
  prompt surface the plugin injects (phase reminder, orchestrator system
  prompt, canonical transformed payload). A failure means the change will
  invalidate provider caches for existing sessions once; update deliberately
  with `bun test --update-snapshots` so the PR diff documents the impact.
- `src/cache-safety-tripwire.test.ts` — scans prompt-assembly directories
  for volatile-input patterns (`Date.now`, `new Date`, `Math.random`,
  `randomUUID`, `performance.now`) outside a justified allowlist.
- `src/v2/setup-command.test.ts` — runs the checkpoint pipeline through the
  V2 context bridge across a completion notification and tool-result
  continuations, asserting retained boards and unchanged prior content.
  Real tool-call batches also verify that changed boards wait for all results
  and never separate calls from their results.

All hook injections must go through `src/hooks/cache-safe-injection.ts`; see
the Prompt Cache Safety section in `AGENTS.md` for the authoring rules.

Interview history collapse is a deliberate, gated rewrite: it runs only for a
session with an active interview and collapses the kickoff spec once, causing
one intentional cache miss per interview. The cache-safety harness covers the
composition and the property suite's drift guard pins the gating call.

## Live cache smoke (`bun run cache:smoke`)

Answers "is provider prompt caching working in my setup right now?" at the
cost of a handful of real requests. It starts an isolated `opencode serve`
(your global config, auth, and plugin apply), runs scripted scenarios in
fresh sessions, then reads `tokens.cache.read/write` from the stored
assistant messages — including the subagent child sessions that delegation
scenarios spawn.

Each scenario is designed to fire specific plugin payload machinery:

| Scenario | Triggers | Default |
|---|---|---|
| `plain` | phase reminder, skills filter, system transform | ✅ |
| `tools` | tool-result growth across steps | ✅ |
| `nudge` | direct file read, phase reminder across subsequent turns | extensive |
| `todos` | todowrite churn (create/update/complete across turns) | extensive |
| `long` | sliding cache breakpoints over a six-turn history | extensive |
| `board` | job-board trailing injection, injected completion, reconcile | extensive |
| `board-churn` | board strip/re-append across many turns; plateau detection (issue #874) | extensive |
| `running-lane` | running task tool_result mid-history across consecutive requests (PR #871) | extensive |
| `agents` | repeated delegation, task-session reuse, subagent caching | extensive |

```bash
bun run cache:smoke                          # plain + tools (fast, cheap)
bun run cache:smoke -- --scenario extensive  # full matrix, several minutes
bun run cache:smoke -- --scenario board,agents
bun run cache:smoke -- --provider anthropic --model claude-sonnet-5
bun run cache:smoke -- --server http://127.0.0.1:4096   # reuse a running server

# Issue #874 A/B: pin the board strategy via a scratch project config
bun run cache:smoke -- --scenario board-churn --board-strategy latest
bun run cache:smoke -- --scenario board-churn --board-strategy checkpoint-compatible
```

Two failure signatures are detected, plus an inconclusive case:

- A request is flagged **SUSPECT** when it is not the first request of its
  session, its input is ≥4096 tokens (above every provider's minimum
  cacheable prefix), and it read zero cached tokens — the bust signature.
- A session is flagged **plateau** when `cache-read` stays frozen at the
  same nonzero value for 3+ consecutive requests while ≥6144 uncached input
  tokens accumulate — the issue #874 signature, where the reusable prefix
  stops growing even though nothing reads zero.

Exit codes: `0` caching works, `1` bust or plateau detected, `2` inconclusive
(provider reported no cache telemetry), `3` setup error. Providers with
read-only telemetry (OpenAI-style `cached_tokens`) show `cache-write 0` —
normal, not a failure.

## Runtime cache monitoring

`src/hooks/cache-monitor/` observes `message.updated` events and the
provider-reported `tokens.cache.read` / `tokens.cache.write` counters. It
logs three warning shapes (observation only, to the plugin log):

- `possible prompt-cache bust` — a session that previously hit the cache
  reports zero cache-read tokens on a sizeable request (once per bust
  streak). The signature of a mid-session prompt-prefix change.
- `never hit the provider cache` — a session reports zero cached tokens on
  every sizeable request from its first turn, past both a consecutive-request
  and a cumulative-uncached-input threshold (once per session). The signature
  of a prefix that changes on *every* request — how the v2.2.5
  checkpoint-board regression looked in the field. OpenCode coalesces missing
  provider telemetry to zeros, so a cache-less provider is indistinguishable
  from this; the thresholds and hedged wording keep that ambiguity from
  becoming noise, and modest sessions on cache-less providers stay silent.
- `cache-read plateau` — reads frozen at the same nonzero value for 4+
  consecutive requests while ≥50K uncached input tokens accumulate (once per
  plateau; re-arms when the read value changes). The issue #874 signature:
  the reusable prefix has stopped growing even though nothing reads zero.
  The warning suggests trying `backgroundJobs.strategy`
  `"checkpoint-compatible"`.

This is the field safety net for provider-side behavior no offline test can
model.

## Prerequisites

Install dependencies and build the local plugin before either check:

```bash
bun install
bun run build
```

The deterministic harness requires a separately pre-provisioned absolute path
to **exactly** `opencode-ai@1.18.2`. It deliberately does not install the host
binary or dependencies itself.

## Offline deterministic payload verification

Run the harness with the pre-provisioned host binary:

```bash
OPENCODE_BIN=/absolute/path/to/node_modules/.bin/opencode \
  bun run verify:cache-stability
```

The script rejects a missing, non-absolute, nonexistent, or non-`1.18.2`
`OPENCODE_BIN`. It uses the built local plugin and a local capture provider,
disables Bun auto-install, and makes no external provider or dependency
resolution network calls.

It asserts the deterministic request shape, including:

- exactly four primary/orchestrator model requests;
- stable system, tool, and option projections across those requests;
- append-only, prefix-stable conversation input and historical transformed user
  prompts;
- exactly one phase reminder in each eligible user projection, with no reminder
  marker in system instructions;
- availability and transcript execution results for `read` and `todowrite`.

Passing this check demonstrates payload stability under the fixture. It does
not establish that any external model provider accepted or reused a cache
prefix.

## Opt-in live cache benchmark

The runner talks directly to an existing OpenCode HTTP server. It does not
start a server, load credentials, or use the SDK. The required CLI contract is:

```bash
bun scripts/benchmark-opencode-cache.ts \
  --server http://127.0.0.1:4096 \
  --provider PROVIDER_ID \
  --model MODEL_ID \
  --runs N \
  --output /safe/output.json \
  --arm ARM_ID \
  --plugin-build BUILD_ID
```

`--server`, `--provider`, `--model`, `--runs`, `--output`, `--arm`, and
`--plugin-build` are required. Harmless timing/retry controls have defaults:
`--timeout-ms` (120000), `--retries` (2), and `--retry-delay-ms` (500).
Use repeated `--header NAME:VALUE` only when the already-running server needs
an HTTP header; headers are not persisted. `--overwrite` permits replacing an
existing output file.

Each fresh session targets `orchestrator` and the requested provider/model. The
fixed sequence requires `Read(package.json)`, a completed `TodoWrite`, a final
answer, and a second user follow-up. The runner establishes SSE coverage before
prompting, deletes every created session, and records discards rather than
resampling. Retry, compaction, routing mismatch, incomplete trace, stream
coverage failure, and assistant/provider errors all invalidate a session.

### Zen free example

For OpenCode Zen free routing, use provider `opencode` and model
`nemotron-3.5-lightning-free` (or check `opencode models` for the current free model).
Keep credentials outside the repository, in the environment of an isolated
server process. In the isolated OpenCode configuration, make model selection
explicit and disable title generation so its separate small-model request does
not confound the run:

```json
{
  "default_agent": "orchestrator",
  "model": "opencode/nemotron-3.5-lightning-free",
  "small_model": "opencode/nemotron-3.5-lightning-free",
  "agent": {
    "orchestrator": { "model": "opencode/nemotron-3.5-lightning-free" },
    "title": { "disable": true }
  }
}
```

With that isolated server running, a live invocation is:

```bash
bun scripts/benchmark-opencode-cache.ts \
  --server http://127.0.0.1:4096 \
  --provider opencode \
  --model nemotron-3.5-lightning-free \
  --runs 12 \
  --arm current \
  --plugin-build "$(git rev-parse HEAD)" \
  --output /tmp/opencode-zen-nemotron-current.json
```

## Report interpretation

The JSON report is intentionally redacted. It excludes prompt and response
text, request bodies, tool inputs/outputs, workspace paths, headers, nonce
values, and raw event properties. It retains normalized routing, tool status,
safe assistant/provider error-code classifications, cache token telemetry,
timing observations, discard reasons, and comparison metadata.

Request observations preserve cache fields as `null` when the provider did not
report them; `null` is not a cache miss. `totalInput` is only defined when it
can be reconstructed as `input + cacheRead + cacheWrite`. Position one in each
eligible session is preserved as raw warm-up data but excluded from aggregate
cache and timing metrics.

The primary metric block contains session-clustered bootstrap 95% confidence
intervals for warm-up-excluded zero-cache miss rate, cache coverage,
prompt-loop TTFT p50, and prompt-loop latency p50. Prompt-loop timings are one
observation per submitted user turn, not duplicated over provider steps.
`eligiblePrefixCoverage` is only meaningful when the provider reports enough
telemetry to calculate it; otherwise treat it as unavailable.

## Methodology and limits

Use the same OpenCode host version, workspace fixture, provider configuration,
agent/model routing, and runner revision for every arm. Build or package each
plugin arm equivalently, run a one-session clean preflight per arm, then run
separate baseline and current arms. Compare the resulting redacted reports;
do not mix arms in one server or silently replace discarded sessions.

This is not CI. Provider cache semantics, free-route policy, cache TTL,
capacity, model revisions, entitlement, and routing can change independently
of this repository. A live result is evidence for its recorded environment,
not a portable performance claim.

## Observed #784 controlled Zen HY3 result

The following is an **environment-specific** controlled observation, not a
guarantee. The `hy3-free` model it routed through has since been retired from
the Zen free tier; the example command above uses the current free model. It
used isolated OpenCode `1.18.2` hosts, an all-agents-on-free-model config,
title generation disabled, `opencode/hy3-free` routing,
the fixed tool trace, and 12 independent eligible sessions per arm.

| Metric | Baseline `67e2a556` | Current `08e9fa5` |
| --- | ---: | ---: |
| Eligible / discarded sessions | 12 / 0 | 12 / 0 |
| Warm-up-excluded request observations | 24 | 24 |
| Zero-cache miss rate (95% CI) | 1.000 [1.000, 1.000] | 0.000 [0.000, 0.000] |
| Cache coverage (95% CI) | 0.000 [0.000, 0.000] | 0.941345 [0.940887, 0.942179] |
| Median eligible-prefix coverage | 0.000000 | 0.903893 |
| Cache read / write tokens | 0 / 0 | 397760 / 0 |
| Prompt-loop TTFT p50 ms (95% CI) | 2915.24 [2883.83, 2983.40] | 2115.54 [2033.55, 2326.98] |
| Prompt-loop latency p50 ms (95% CI) | 3216.77 [3072.35, 3255.93] | 2267.81 [2248.48, 3012.78] |

Every eligible session completed `read` and `todowrite`; observed routing was
`orchestrator` / `opencode` / `hy3-free` (now retired; the live model is
`nemotron-3.5-lightning-free`). Repeat the controlled procedure
before drawing conclusions under a different provider account, host, model
revision, or cache policy.

## Observed OpenAI manual verification

This single-session manual smoke result is **not** a baseline comparison. It
used an isolated host with existing local OpenAI authentication, the current
plugin build, and `openai/gpt-5.6-terra-fast`.

| Metric | Observed value |
| --- | ---: |
| Eligible sessions | 1 |
| Cache-read tokens after warm-up | 12288, 13824, 14336 |
| Warm-up-excluded cache coverage | 93.33% |
| Eligible-prefix coverage | 85.64% |
| Second-turn prompt-loop TTFT | 1983.02 ms |
| Second-turn prompt-loop latency | 2278.46 ms |

The required `read` and `todowrite` trace completed with no assistant or
provider error. Repeat a controlled baseline/current comparison before making
a provider-wide performance claim.
