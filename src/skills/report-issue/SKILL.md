---
name: report-issue
description: >
  File a GitHub issue for oh-my-opencode-slim, collecting environment info and
  recent plugin logs, scrubbing secrets, and drafting the body for confirmation
  before submitting. Use when the user says "report an issue", "file a bug",
  "open a GitHub issue for omos", or wants to submit a bug report or feature
  request for this plugin — even if they don't name the skill explicitly.
---

# Report an Issue (oh-my-opencode-slim)

Help the user open a well-formed GitHub issue for oh-my-opencode-slim. The point
is a good bug report: environment + recent plugin logs + a clear description,
with secrets scrubbed and the user confirming before anything is submitted.

`gh issue create` is **never** run without the user explicitly approving the
draft. That confirm step is the safety net — do not skip it.

## When to Use

- "report an issue", "file a bug", "open a GitHub issue for omos"
- User describes a problem with the plugin and wants to submit it upstream
- User wants to propose an enhancement to oh-my-opencode-slim

## Workflow

Get the issue clear first, then pull the supporting context. This keeps the
log relevant to what the user is actually reporting, and still reaches a draft
in a single shot (the user's first message is usually the description).

### 1. Finalize the issue details (do this first)

Get these four fields settled **before** moving on to logs — they shape the
whole draft and tell you which log lines matter:

- **Description** — what happened and reproduction steps. For a `bug`, also ask
  for expected vs actual behavior; for an `enhancement`, ask what behavior the
  user wants. This is the core of the report.
- **Title** — short, specific, actionable summary (under ~72 chars). No need
  for a `[Bug]`/`[Feature]` prefix; the type label carries that.
- **Type** — `bug` or `enhancement`.
- **Skill/command** — which omos agent, skill, or command was in use when it
  broke (helps triage; optional).

Do not proceed to log collection until these are finalized. **Never assume any
of the four** — if a field is missing or ambiguous, ask for that one field
specifically (one question at a time), and wait for the answer before asking the
next. Do not invent a title, guess a type, or infer a description from context.
Only once all four are explicitly confirmed by the user do you move to logs.

Tell the user up front: **do not paste API keys, tokens, or passwords into the
description.** The scrubber only protects the plugin log, not free text. Also
warn that the issue is filed on a **public** repo, so review the draft for
secrets before approving. Likewise avoid absolute file paths (e.g.
`/Users/john/...`) in the description — use relative paths or `~`.

### 2. Collect environment and the relevant plugin log

Now that you know what broke, gather the supporting context:

Gather the environment yourself — OS, OpenCode version, this plugin's version,
Node/Bun versions, and the shell. Run whatever command fits the platform; if a
value is unavailable, record `unknown` rather than failing.

Locate the most recent plugin log. The directory is `$OPENCODE_LOG_DIR` if set,
otherwise `~/.local/share/opencode/log` (macOS/Linux) or
`%USERPROFILE%\.local\share\opencode\log` (Windows). Pick the newest
`oh-my-opencode-slim.*.log`. If none exists, that's fine — note
`[no plugin log found]` and continue; the issue can still be filed without it.
Prefer the log segment around when the reported problem occurred; if the user
named a skill/command (step 1), scan for that in the log to pull the relevant
lines rather than dumping the whole file.

### 3. Scrub the log

You are an AI model — redact secrets by reading the log and applying judgment.
Do **not** run a regex script; redact inline as you prepare the draft. This
avoids brittle escaping and lets you catch shapes regex misses.

**PEM tripwire (check first):** If the log contains
`-----BEGIN ... PRIVATE KEY-----` (any variant: RSA, EC, DSA, OPENSSH,
ENCRYPTED), do **not** embed the log. Tell the user a private key was detected,
refuse to include it, and use `Logs: [skipped — private key detected in log]`.

Otherwise, redact credential-shaped content before embedding: API keys
(`sk-…`, `xai-…`, `exaApiKey=…`), bearer/session tokens and `?token=` /
`?access_token=` / `?auth=` URL params, JWTs, DB connection strings, explicit
secret env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`,
`GITHUB_TOKEN`, `AWS_*`), home-directory paths (→ `~`), and anything else that
looks like a secret. Replace each value with a `<REDACTED:…>` marker. Never
paraphrase or summarize the log — embed it verbatim after redaction
(paraphrasing bypasses redaction). When in doubt, redact; the user reviews the
draft before submit, but you are the first line of defense.

### 4. Draft the issue body

Write the draft to a unique temp file (e.g. `/tmp/omos-issue-$(date +%s).md`)
to avoid clobbering a prior draft, using this template:

```markdown
## Description

<user description / repro steps>

## Skill / Command

<skill or command in use when it broke, or N/A>

## Environment

- OS: <os>
- OpenCode: <opencode version>
- Plugin: <plugin version>
- Node: <node version>
- Bun: <bun version>
- Shell: <shell>

## Plugin Logs (scrubbed)

<details>
<summary>Click to expand — scrubbed plugin log</summary>

```log
<scrubbed log, or [no plugin log found] / [skipped — private key detected in log] / [skipped by user]>
```

</details>

---
🤖 This issue was created using the /report-issue skill.
```

If the log is very long, keep it readable: trim to a sensible tail (a few
hundred lines is plenty for a bug report) and append
`... [truncated — review may be incomplete; attach raw log manually]`. Always
cut at line boundaries — never split a line in half, since that can split a
secret mid-token.

### 5. The Iron Rule gate (approve / revise / deny)

This is the **only** point where the user decides. Everything above is
automatic — you fill in env, logs, and the draft. Then present the **raw**
draft (verbatim markdown, not a rendered preview) and offer exactly three
choices:

- **Approve** — publish the issue to GitHub.
- **Revise** — tell you what to change (or edit inline); you re-draft and show
  the gate again.
- **Deny** — discard; nothing is sent.

Rules for this gate:

- State explicitly if truncation happened, and remind them the issue is filed on
  a **public** repo — review for any secrets before approving.
- **`gh` is never run unless the user picks Approve.** No exceptions, no
  "just creating it now", no silent submit.
- If the user approves, only then proceed to Submit.

### 6. Submit (only after explicit Approve)

This repo uses GitHub **issue forms** (`.github/ISSUE_TEMPLATE/bug-report.yml`
and `feature-request.yml`), and blank issues are disabled. So file through the
form template, not a free-form body — a plain `--body` is rejected.

Check `gh auth status` first. If not authenticated, do **not** attempt the
create — tell the user to run `gh auth login` (or paste the draft manually at
the URL below).

**Bug** → use `bug-report.yml` and map fields:

```bash
gh issue create \
  --repo alvinunreal/oh-my-opencode-slim \
  --template bug-report.yml \
  --title "<title>" \
  --field "What happened, and what did you expect?"="<description + expected/actual>" \
  --field "Steps to reproduce"="<repro steps>" \
  --field "oh-my-opencode.json"="<config or 'omitted'>" \
  --field "OpenCode version"="<version>" \
  --field "oh-my-opencode-slim version"="<plugin version>" \
  --field "Operating system"="<os>" \
  --field "Logs, screenshots, or extra context"="<scrubbed plugin log>"
```

**Enhancement** → use `feature-request.yml`:

```bash
gh issue create \
  --repo alvinunreal/oh-my-opencode-slim \
  --template feature-request.yml \
  --title "<title>" \
  --field "Description"="<what you want and why>" \
  --field "Extra context"="<optional examples/links>"
```

- The `--title` should be prefix-free (no `[Bug]`/`[Feature]`); the form's
  `title:` prefix and `labels:` are applied by the template automatically.
- If `gh` is not installed or not authenticated, do **not** fail silently: print
  the full draft and tell the user to paste it at
  `https://github.com/alvinunreal/oh-my-opencode-slim/issues/new?template=bug-report.yml`
  (or `feature-request.yml`).

## Skipping logs

Logs are included by default, but they are optional. If the user says not to
include logs (or you judge them irrelevant for the report), put
`Logs: [skipped by user]` in the details block instead of log content. No flag
is needed — just ask or note it.

## Safety Rules

- **Iron rule: `gh` is never called unless the user explicitly picks Approve at
  the gate.** No publish, no draft creation, no silent submit — ever.
- Embed the log **verbatim** after scrubbing — never paraphrase it (paraphrasing
  bypasses the scrubber).
- The PEM tripwire refuses embedding; it does not try to scrub a key.
- Secrets in the user's free-text description are not scrubbed — warn upfront.
