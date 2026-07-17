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

### 1. Gather user input

Ask for three things (one message, can be combined if the user volunteers them):

- **Title** — short, specific, actionable summary (under ~72 chars). No need
  for a `[Bug]`/`[Feature]` prefix; the type label carries that.
- **Type** — `bug` or `enhancement`.
- **Description** — what happened and reproduction steps. For a `bug`, also ask
  for expected vs actual behavior; for an `enhancement`, ask what behavior the
  user wants.
- **Skill/command** — which omos agent, skill, or command was in use when it
  broke (helps triage; optional).

Tell the user up front: **do not paste API keys, tokens, or passwords into the
description.** The scrubber only protects the plugin log, not free text. Also
warn that the issue is filed on a **public** repo, so review the draft for
secrets before approving.

### 2. Collect environment

Run these and capture the output:

```bash
echo "OS: $(uname -a 2>/dev/null || echo unknown)"
echo "OpenCode: $(opencode --version 2>/dev/null || echo unknown)"
echo "Plugin: $(bun -e 'import {readFileSync}from"node:fs";try{const p=JSON.parse(readFileSync("package.json","utf8"));console.log(p.version)}catch{console.log("unknown")}' 2>/dev/null || echo unknown)"
echo "Node: $(node --version 2>/dev/null || echo unknown)"
echo "Bun: $(bun --version 2>/dev/null || echo unknown)"
echo "Shell: $SHELL"
```

If a command is unavailable, record `unknown` rather than failing the whole step.

### 3. Collect plugin logs

Resolve the log directory, then take the most recent plugin log:

```bash
LOG_DIR="${OPENCODE_LOG_DIR:-$HOME/.local/share/opencode/log}"
LOG_FILE=$(ls -t "$LOG_DIR"/oh-my-opencode-slim.*.log 2>/dev/null | head -n1)
```

Windows path note: on Windows the default is
`%USERPROFILE%\.local\share\opencode\log`. This skill targets macOS/Linux; if
the user is on Windows and `OPENCODE_LOG_DIR` is unset, ask them for the path.

### 4. Scrub the log

You are an AI model — redact secrets by reading the tailed log and applying the
checklist below. Do **not** rely on a regex script; redact inline as you prepare
the draft. This avoids brittle escaping and lets you catch shapes regex misses.

First read the tail:

```bash
if [ -z "$LOG_FILE" ]; then
  echo "[no plugin log found]"
else
  tail -n 500 "$LOG_FILE"
fi
```

**PEM tripwire (check first):** If the log contains
`-----BEGIN ... PRIVATE KEY-----` (any variant: RSA, EC, DSA, OPENSSH,
ENCRYPTED), do **not** embed the log. Tell the user a private key was detected,
refuse to include it, and use `Logs: [skipped — private key detected in log]`.

Otherwise, redact these from the log before embedding. Replace the value with
the marker shown — never paraphrase or summarize the log (paraphrasing bypasses
redaction):

- API keys: `sk-…`, `xai-…`, `exaApiKey=…` → `<REDACTED:API_KEY>`
- Bearer / session tokens, and `?token=` / `?access_token=` / `?auth=` URL
  params → `<REDACTED:TOKEN>`
- JWTs (`eyJ… . … . …`) → `<REDACTED:JWT>`
- DB connection strings (`mongodb://`, `postgres://`, `redis://`, etc.) →
  `<REDACTED:DB_CONNSTR>`
- Explicit secret env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`,
  `GITHUB_TOKEN`, `AWS_*` → `<REDACTED:SECRET>`
- Absolute paths containing the user's home directory → replace with `~`
- Any other credential-shaped value you recognize (long base64/hex strings in
  auth contexts, passwords, tokens) → `<REDACTED:SECRET>`

When in doubt, redact. The user reviews the draft before submit, but the model
is the first line of defense.

### 5. Draft the issue body

Write the draft to a temp file (e.g. `/tmp/omos-issue.md`) using this template:

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

## Plugin Logs (last 500 lines, scrubbed)

<details>
<summary>Click to expand — scrubbed plugin log</summary>

```log
<scrubbed log, or [no plugin log found] / [skipped — private key detected in log]>
```

</details>

---
🤖 This issue was created using the /report-issue skill.
```

If `--no-logs` was requested, put `Logs: [skipped by user]` in the details block
instead of log content.

Truncate at **line boundaries only**: if the scrubbed log exceeds ~6000
characters, keep whole lines up to that limit and append
`\n... [truncated — review may be incomplete; attach raw log manually]`. Never
cut a line in half (that can split a secret mid-token).

### 6. Confirm

Show the **raw** draft to the user (verbatim markdown, not a rendered preview).
State explicitly if truncation happened, and remind them the issue is filed on
a **public** repo — review for any secrets before approving. Ask the user to
approve, edit, or cancel. Do not run `gh` until they approve.

### 7. Submit

If `gh` is available and the user approved:

```bash
gh issue create \
  --repo alvinunreal/oh-my-opencode-slim \
  --title "<title>" \
  --label "<type>" \
  --body-file /tmp/omos-issue.md
```

- `<type>` is `bug` or `enhancement` from step 1; the label carries the
  categorization, so the title stays prefix-free.
- If `gh` is not installed or not authenticated, do **not** fail silently: print
  the full draft and tell the user to paste it at
  `https://github.com/alvinunreal/oh-my-opencode-slim/issues/new`.

## Skipping logs

Logs are included by default, but they are optional. If the user says not to
include logs (or you judge them irrelevant for the report), put
`Logs: [skipped by user]` in the details block instead of log content. No flag
is needed — just ask or note it.

## Safety Rules

- Never run `gh issue create` without explicit user approval of the draft.
- Embed the log **verbatim** after scrubbing — never paraphrase it (paraphrasing
  bypasses the scrubber).
- The PEM tripwire refuses embedding; it does not try to scrub a key.
- Secrets in the user's free-text description are not scrubbed — warn upfront.
