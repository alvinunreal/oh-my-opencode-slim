# Cache verification

This project has two complementary checks. They answer different questions and
should not be conflated.

- **Deterministic payload verification** proves that this plugin projects a
  stable provider payload under a controlled local capture server. It does not
  measure a provider cache.
- **Live cache benchmarking** records telemetry returned by an already-running
  provider-backed OpenCode server. It is opt-in, provider-specific, and useful
  for comparing explicitly controlled arms; it is not a CI check or a general
  cache guarantee.

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

For OpenCode Zen free routing, use provider `opencode` and model `hy3-free`.
Keep credentials outside the repository, in the environment of an isolated
server process. In the isolated OpenCode configuration, make model selection
explicit and disable title generation so its separate small-model request does
not confound the run:

```json
{
  "preset": "opencode-zen-free",
  "default_agent": "orchestrator",
  "model": "opencode/hy3-free",
  "small_model": "opencode/hy3-free",
  "agent": {
    "orchestrator": { "model": "opencode/hy3-free" },
    "title": { "disable": true }
  }
}
```

With that isolated server running, a live invocation is:

```bash
bun scripts/benchmark-opencode-cache.ts \
  --server http://127.0.0.1:4096 \
  --provider opencode \
  --model hy3-free \
  --runs 12 \
  --arm current \
  --plugin-build "$(git rev-parse HEAD)" \
  --output /tmp/opencode-zen-hy3-current.json
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
guarantee. It used isolated OpenCode `1.18.2` hosts, preset
`opencode-zen-free`, title generation disabled, `opencode/hy3-free` routing,
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
`orchestrator` / `opencode` / `hy3-free`. Repeat the controlled procedure
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
