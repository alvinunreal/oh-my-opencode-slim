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

## Keyboard shortcuts

Inside the interview page:

- `1`, `2`, `3`, ... select options for the active question
- the last number selects `Custom`
- `↑` / `↓` move the active question
- `Cmd+Enter` or `Ctrl+Enter` submits
- `Cmd+S` or `Ctrl+S` also submits

## Configuration

```jsonc
{
  "oh-my-opencode-slim": {
    "interview": {
      "maxQuestions": 2,
      "outputFolder": "interview",
      "autoOpenBrowser": true,
      "port": 0
    }
  }
}
```

### Options

- `maxQuestions` — max questions per round, `1-10`, default `2`
- `outputFolder` — where markdown files are written, default `interview`
- `autoOpenBrowser` — open the localhost UI in your default browser, default `true`
- `port` — fixed port for the interview UI server, `0-65535`, default `0` (OS-assigned). Set a fixed port for remote access via Tailscale Serve, Cloudflare Tunnel, or SSH tunneling. Note: ports 1-1023 require elevated privileges on most systems.

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

## Related

- [README.md](../README.md)
- [tools.md](tools.md)
- [configuration.md](configuration.md)
