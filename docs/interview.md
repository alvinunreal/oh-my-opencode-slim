# Interview

`/interview` opens a local browser UI for refining a feature idea inside the same OpenCode session.

Use it when chat feels too loose and you want a cleaner question/answer flow plus a markdown spec saved in your repo.

> Tip: `/interview` usually works well with a fast model. If the flow feels slower than it should, switch models in OpenCode with `Ctrl+X`, then `m`, and pick a faster one.

## Quick start

Start a new interview:

```text
/interview build a kanban app for design teams
```

What happens:

1. OpenCode starts the interview in your current session
2. a localhost page opens in your browser by default
3. the UI shows the current questions and suggested answers
4. answers are submitted back into the same session
5. a markdown spec is updated in your repo

OpenCode posts a localhost URL like this:

![Interview URL](../img/interview-url.png)

And the browser UI looks like this:

![Interview website](../img/interview-website.png)

Resume an existing interview:

```text
/interview interview/kanban-design-tool.md
```

You can also resume by basename if it exists in the configured output folder:

```text
/interview kanban-design-tool
```

## What the browser UI gives you

- focused question flow instead of open-ended chat
- suggested answers, clearly marked as recommended
- keyboard-driven selection for the active question
- custom freeform answers when needed
- visible path to the markdown interview file
- larger, more readable interview UI

## Markdown output

By default, interview files are written to:

```text
interview/
```

Example:

```text
interview/kanban-design-tool.md
```

The file contains two sections:

- `Current spec` — rewritten as the interview becomes clearer
- `Q&A history` — append-only question/answer record

Example:

```md
# Kanban App For Design Teams

## Current spec

A collaborative kanban tool for design teams with shared boards, comments, and web-first workflows.

## Q&A history

Q: Who is this for?
A: Design teams

Q: Is this web only or mobile too?
A: Web first
```

### How filenames are chosen

For new interviews, the assistant can suggest a concise title for the markdown filename.

Example:

- user input: `build a kanban app for design teams with lightweight reviews`
- file: `interview/kanban-design-tool.md`

If the assistant does not provide a title, the original input is slugified as a fallback.

### Frontmatter

Interview files include YAML frontmatter for recovery after a crash or restart:

```yaml
---
sessionID: ses_abc123
baseMessageCount: 42
updatedAt: 2026-04-14T10:30:00.000Z
---
```

This allows the dashboard to rebuild state from disk without a live session.

## Keyboard shortcuts

Inside the interview page:

- `1`, `2`, `3`, ... select options for the active question
- the last number selects `Custom`
- `↑` / `↓` move the active question
- `Cmd+Enter` or `Ctrl+Enter` submits
- `Cmd+S` or `Ctrl+S` also submits

## Modes

The interview module has two modes: **per-session** (default) and **dashboard** (opt-in).

### Per-session mode (default)

When `port` is `0` (or unset) and `dashboard` is `false` (or unset), each OpenCode process runs its own interview server on a random port. This is the original behavior — no configuration needed.

```jsonc
{
  "oh-my-opencode-slim": {
    "interview": {}
    // or explicitly:
    // "interview": { "port": 0 }
  }
}
```

- one interview server per OpenCode process
- server starts lazily on first `/interview` command
- random port assigned by the OS
- all state is local to the session

### Dashboard mode

When `dashboard` is `true` or `port` is set to a value greater than `0`, interview switches to dashboard mode. A single dashboard server aggregates interviews from **all** OpenCode sessions on the same machine.

```jsonc
// Option A: dashboard on default port (43211)
"interview": { "dashboard": true }

// Option B: dashboard on custom port
"interview": { "dashboard": true, "port": 8888 }

// Option C: port > 0 implies dashboard mode
"interview": { "port": 43211 }
```

#### What the dashboard gives you

- **Single URL.** One dashboard page lists all active and past interviews across all sessions.
- **Multi-session coordination.** Each OpenCode process pushes interview state to the dashboard. The dashboard serves the web UI and relays answers back to the right session.
- **Failover recovery.** If the dashboard process dies, the next OpenCode process to start claims the port and rebuilds state from `.md` files on disk.
- **File browser.** Scans `interview/` (or your configured output folder) across all known project directories, including your home directory.

#### How it works

```
┌──────────────────────────────────────────────┐
│  Dashboard (dumb aggregator)                  │
│                                               │
│  • Receives state pushes from sessions        │
│  • Serves dashboard UI + interview pages      │
│  • Stores pending answers for session pickup  │
│  • Binds to 127.0.0.1, token-authenticated    │
└───────────▲───────────────────▲───────────────┘
            │ POST state        │ GET pending answers
┌───────────┴────────┐ ┌───────┴──────────────┐
│  Session Process A  │ │  Session Process B    │
│  (smart — drives    │ │  (smart — drives      │
│   LLM locally)      │ │   LLM locally)        │
└─────────────────────┘ └───────────────────────┘
```

Sessions are smart — they drive LLM interaction locally (parse state, inject prompts, write `.md` files). The dashboard is a dumb aggregator with a web UI. This means zero cross-process SDK dependency.

#### Auto-failover

Any OpenCode process can become the dashboard. The first process to bind the configured port wins. If it dies:

1. Other sessions detect the dead dashboard (failed state push or health probe)
2. The next process to start claims the port
3. The new dashboard rebuilds from `.md` files on disk using frontmatter

#### Session registration

Sessions register their project directory with the dashboard so it knows where to scan for interview files. This happens automatically on first `/interview` command or session event — no manual setup needed.

The dashboard also scans your home directory's output folder by default, so interviews created from a home-directory OpenCode session are always visible.

#### Dashboard settings

The dashboard page includes a settings panel for:

- **Scan days** — how far back to look for sessions (default: 30)
- **Add/remove folders** — manually add project directories to scan
- **Discover sessions** — re-scan the OpenCode session list for new directories

## Configuration

```jsonc
{
  "oh-my-opencode-slim": {
    "interview": {
      "maxQuestions": 2,
      "outputFolder": "interview",
      "autoOpenBrowser": true,
      "port": 0,
      "dashboard": false
    }
  }
}
```

### Options

- `maxQuestions` — max questions per round, `1-10`, default `2`
- `outputFolder` — where markdown files are written, default `interview`
- `autoOpenBrowser` — open the localhost UI in your default browser during interactive runs, default `true` (suppressed automatically in tests and CI)
- `port` — port for the interview server, `0-65535`, default `0` (OS-assigned in per-session mode). Set a fixed port to enable dashboard mode. Note: ports 1-1023 require elevated privileges on most systems.
- `dashboard` — enable dashboard mode on the default port (`43211`), default `false`. Setting `port` to a value greater than `0` also enables dashboard mode. If both are set, `port` takes precedence.

### Mode selection

| `port` | `dashboard` | Mode |
|--------|-------------|------|
| `0` (default) | `false` (default) | Per-session — each process runs its own server |
| `0` | `true` | Dashboard on default port 43211 |
| `> 0` | any | Dashboard on the specified port |

## Remote access

The interview UI binds to `127.0.0.1`. To access it from a remote machine:

### Tailscale Serve

```text
tailscale serve --bg --https=443 http://127.0.0.1:<port>
```

### Cloudflare Tunnel

```text
cloudflared tunnel --url http://127.0.0.1:<port>
```

### SSH tunnel

```text
ssh -L <port>:127.0.0.1:<port> your-server
```

## Good use cases

- feature planning
- requirement clarification before implementation
- turning a rough idea into a spec the agent can build from
- keeping a lightweight product brief in the repo while iterating

## Current limitations

- localhost UI only
- browser updates use polling, not realtime push
- runtime interview state is in-memory; the markdown file is the durable artifact
- the flow depends on the assistant returning valid `<interview_state>` blocks
- dashboard mode answer delivery has a few seconds of latency (session polls the dashboard)

## Related

- [README.md](../README.md)
- [tools.md](tools.md)
- [configuration.md](configuration.md)
