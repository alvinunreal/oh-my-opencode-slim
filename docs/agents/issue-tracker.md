# Issue tracker: GitHub

Issues and PRs for this repo live as GitHub issues. Use the `gh` CLI for all operations. The project repo is `alvinunreal/oh-my-opencode-slim`.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone. **Write operations (create / label / comment / close) must target the upstream tracker:** pass `--repo alvinunreal/oh-my-opencode-slim` (or set `GH_REPO=alvinunreal/oh-my-opencode-slim`). In a fork clone, a bare `gh` command would mutate your fork instead of the project tracker.

## Pull requests as a triage surface

**PRs as a request surface: yes.** This is an open-source repo; external PRs are feature requests with attached code. They enter the triage queue for **category labeling only**, not the full state machine. Collaborators' in-flight PRs are excluded by the `authorAssociation` filter below.

**Scope: category labels only.** External PRs get a `bug` or `enhancement` category label based on the PR description or linked issue. They do **not** enter the triage state transitions and are **never** auto-closed during triage.

Guardrails (per council review):
- Apply only `bug` or `enhancement` to PRs. Do not apply state labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`).
- Never apply `good-to-code` to PRs — they are already code; the label is noise.
- Never auto-close external PRs during triage. Closure stays in the review flow / maintainer decision.
- Filter on `authorAssociation`, not PR content: keep CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR / NONE (and any other non-collaborator association); drop OWNER / MEMBER / COLLABORATOR / FIRST_TIMER / MANNEQUIN.
- Keep PR triage out of issue metrics — don't mix PR counts into issue triage reporting.

When enabled, PRs are labeled using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,comments` to enumerate open PRs, then for each run `gh pr view <number> --json authorAssociation` and keep only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR` and any other non-collaborator association).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments` (or `gh pr view` for a PR).

