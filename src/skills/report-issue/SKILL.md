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
- **Screenshots** — ask if the user has any screenshots (error UI, terminal
  output, behavior). `gh` cannot attach files, so if they have them, they drag
  them into the GitHub issue after it's created. Note `screenshots: <yes, drag
  into issue> / <none>` so the user knows to attach them.

Do not proceed to log collection until these are finalized. **Never assume any
of the five** — if a field is missing or ambiguous, ask for that one field
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

Locate the relevant plugin log. The directory is `$OPENCODE_LOG_DIR` if set,
otherwise `~/.local/share/opencode/log` (macOS/Linux) or
`%USERPROFILE%\.local\share\opencode\log` (Windows). Logs are named
`oh-my-opencode-slim.<timestamp>.log` and only the most recent 10 are kept.

**The newest log is not always the right one.** The bug usually happened in a
specific session, not the most recent startup. Ask the user which log is
relevant — list the available `oh-my-opencode-slim.*.log` files with
timestamps and let them pick, or accept "newest" if they don't care. If none
exists, that's fine — note `[no plugin log found]` and continue; the issue can
still be filed without it.

Once the log is chosen, **pull only the segment around the reported problem** —
not the whole file. If the user named a skill/command in step 1, grep the log
for that to find the relevant lines, then include a window of context around
them (e.g. ±30 lines). A raw init/health-check dump is noise and should not be
the default. If the relevant segment can't be found, say so and include the
tail of the log instead of the entire file.

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

Prepare the draft as markdown to show the user at the Iron Rule gate (step 5),
using this template:

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
- Screenshots: <yes — drag into the issue after it's created / none>

---
🤖 This issue was created using the /report-issue skill.
```

The scrubbed plugin log is **not** inlined here — it is posted as a separate
comment after the issue is created (see step 6), so the issue body stays
readable. If no log was found or the user skipped it, note
`[no plugin log found]` / `[skipped by user]` in the Environment section
instead.

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

**Bug** → use `bug-report.yml` and map fields. The log is **not** inlined
here — put a short pointer in the logs field and post the full log as a comment
after creation (see below):

**Important — `gh` version reality:** many `gh` builds reject `--field` and
reject `--template` together with `--body-file`. The reliable cross-version
pattern is to write a **plain markdown body** to a file and create with
`--body-file` (no `--template`, no `--field`), then apply the label manually.
`gh` does NOT parse YAML front matter from `--body-file` — it renders the whole
file verbatim — so do NOT include front matter. The body below is the full
issue body; the structured form fields are not populated, which is fine.

Write the body to a temp file, then:

**Bug** → `/tmp/omos-issue-<ts>.md`:

```markdown
## Description

<user description + expected vs actual>

## Repro Steps

<numbered repro steps>

## Skill / Command

<skill or command in use when it broke, or N/A>

## Environment

- OS: <os>
- OpenCode: <opencode version>
- Plugin: <plugin version>
- Node: <node version>
- Bun: <bun version>
- Shell: <shell>
- Screenshots: <yes — drag into the issue after it's created / none>

---
🤖 This issue was created using the /report-issue skill.
```

```bash
gh issue create \
  --repo alvinunreal/oh-my-opencode-slim \
  --title "<title>" \
  --body-file /tmp/omos-issue-<ts>.md \
  --label bug
```

**Enhancement** → `/tmp/omos-issue-<ts>.md`:

```markdown
## Description

<what you want and why>

## Skill / Command

<skill or command, or N/A>

## Environment

- OS: <os>
- OpenCode: <opencode version>
- Plugin: <plugin version>
- Node: <node version>
- Bun: <bun version>
- Shell: <shell>
- Screenshots: <yes — drag into the issue after it's created / none>

---
🤖 This issue was created using the /report-issue skill.
```

```bash
gh issue create \
  --repo alvinunreal/oh-my-opencode-slim \
  --title "<title>" \
  --body-file /tmp/omos-issue-<ts>.md \
  --label enhancement
```

After the issue is created, post the scrubbed plugin log as a **separate
comment** (this keeps the issue body clean and the log out of the form fields).
Format it with the first log row shown as a visible example, then the full log
in a collapsible block, and a clear note explaining what the comment is:

```bash
gh issue comment <issue-number> --repo alvinunreal/oh-my-opencode-slim --body-file /tmp/omos-issue-log-<ts>.md
```

Where `/tmp/omos-issue-log-<ts>.md` contains:

```markdown
> 📎 **Scrubbed plugin log** — posted as a separate comment so the issue body
> stays readable. Secrets were redacted by the /report-issue skill. The first
> row is shown as an example; expand below for the full log.

First row (example):
```
<first scrubbed log line>
```

<details>
<summary>Scrubbed plugin log segment (click to expand)</summary>

```log
<relevant scrubbed segment, or [no plugin log found] / [skipped — private key detected in log] / [skipped by user]>
```

</details>
```

If no log was found or the user skipped it, post a one-line comment
(`[no plugin log found]` / `[skipped by user]`) instead of the block above.

- The `--title` should be prefix-free (no `[Bug]`/`[Feature]`); the `--label`
  flag applies the categorization since we don't use `--template`.
- Both `gh` calls (create + comment) are gated by the Approve choice — neither
  runs without it.
- If `gh` is not installed or not authenticated, do **not** fail silently: print
  the full draft and tell the user to paste it at
  `https://github.com/alvinunreal/oh-my-opencode-slim/issues/new?template=bug-report.yml`
  (or `feature-request.yml`).

## Skipping logs

Logs are included by default, but they are optional. If the user says not to
include logs (or you judge them irrelevant for the report), skip the log comment
and note `[skipped by user]` in the Environment section. No flag is needed —
just ask or note it.

## Safety Rules

- **Iron rule: `gh` is never called unless the user explicitly picks Approve at
  the gate.** No publish, no draft creation, no silent submit — ever.
- Embed the log **verbatim** after scrubbing — never paraphrase it (paraphrasing
  bypasses the scrubber).
- The PEM tripwire refuses embedding; it does not try to scrub a key.
- Secrets in the user's free-text description are not scrubbed — warn upfront.
