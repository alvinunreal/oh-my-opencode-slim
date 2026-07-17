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

- If no log file exists, set logs to `[no plugin log found]` and continue.
- Tail the last 500 lines: `tail -n 500 "$LOG_FILE"`.

Windows path note: on Windows the default is
`%USERPROFILE%\.local\share\opencode\log`. This skill targets macOS/Linux; if
the user is on Windows and `OPENCODE_LOG_DIR` is unset, ask them for the path.

### 4. Scrub the log

Run the tail through a single-pass scrubber. Use `bun -e` so no extra file is
needed:

```bash
tail -n 500 "$LOG_FILE" | bun -e '
const lines = require("node:fs").readFileSync(0,"utf8").split("\n");
const home = require("node:os").homedir();
const rules = [
  [/(sk-[A-Za-z0-9]{20,})/g, "<REDACTED:OPENAI_KEY>"],
  [/(xai-[A-Za-z0-9]{20,})/g, "<REDACTED:XAI_KEY>"],
  [/(exa[A-Za-z0-9_-]*key[=:]\s*["'"'"']?[A-Za-z0-9_-]{12,})/gi, "exaApiKey=<REDACTED:EXA_KEY>"],
  [/(Bearer\s+[A-Za-z0-9._-]{12,})/g, "Bearer <REDACTED:TOKEN>"],
  [/(?:[\?&](?:token|access_token|auth)=)([A-Za-z0-9._-]{12,})/gi, "$1=<REDACTED:URL_TOKEN>"],
  [/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "<REDACTED:JWT>"],
  [/(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s"'"]+/gi, "<REDACTED:DB_CONNSTR>"],
  [/(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GITHUB_TOKEN|AWS_[A-Z_]+|[^A-Za-z]SECRET|[^A-Za-z]TOKEN|[^A-Za-z]KEY)\s*=\s*["'"'"']?[A-Za-z0-9\/+._-]{12,}/g, "$1=<REDACTED:SECRET>"],
  [/(?:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, "<REDACTED:EMAIL>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<REDACTED:IP>"],
  [/\b(?:(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4})\b/g, "<REDACTED:IPV6>"],
];
let out = lines.map(l => rules.reduce((s,[re,rep]) => s.replace(re,rep), l));
// home dir redaction (covers expanded paths the $HOME pattern misses)
if (home) out = out.map(l => l.split(home).join("~"));
process.stdout.write(out.join("\n"));
'
```

**PEM tripwire (run before scrubbing):** if the raw tail contains
`-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----`, do **not**
embed the log. Tell the user a private key was detected, refuse to include the
log, and continue with `Logs: [skipped — private key detected in log]`.

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

## Flags

- `--no-logs` — skip log collection; the details block shows
  `Logs: [skipped by user]`.

## Safety Rules

- Never run `gh issue create` without explicit user approval of the draft.
- Embed the log **verbatim** after scrubbing — never paraphrase it (paraphrasing
  bypasses the scrubber).
- The PEM tripwire refuses embedding; it does not try to scrub a key.
- Secrets in the user's free-text description are not scrubbed — warn upfront.
