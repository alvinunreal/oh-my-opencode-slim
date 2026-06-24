# src/multiplexer/herdr/

## Responsibility

- Provide herdr-specific pane orchestration for attaching OpenCode child
  sessions to a split pane beside the current pane.
- Handle lifecycle of spawned panes (split, command injection, graceful close)
  via herdr's JSON-RPC Unix domain socket API.
- Resolve and cache herdr binary location for repeated operations, and verify
  socket reachability before declaring availability.

## Design

- `HerdrSocketClient` in `client.ts` is a persistent, reconnect-capable
  JSON-RPC client over AF_UNIX sockets (`node:net`), distinct from the
  process-spawn approach used by tmux.
- Requests use a monotonic counter (`req_1`, `req_2`, ...) for request IDs.
  A `Map<id, {resolve, reject, timer}>` dispatches responses to callers.
- Incoming data is buffered and split on newlines; each line is parsed as
  JSON and dispatched by `id`.
- Each call has a default 5-second timeout; on timeout the promise is
  rejected with a HerdrError-shaped error (`code: "timeout"`).
- The socket is opened lazily on the first `call()` and reused. On
  error/close the socket reference is cleared; the next `call()` reconnects
  transparently.
- `isHerdrError(e, code?)` is exported for callers (notably `closePane`) to
  discriminate error types like `pane_not_found` without parsing strings.

### Socket path resolution (priority order)

1. `$HERDR_SOCKET_PATH` — explicit override
2. `${HOME}/.config/herdr/sessions/<HERDR_SESSION>/herdr.sock` — session-scoped
3. `${HOME}/.config/herdr/herdr.sock` — default daemon socket

### 400ms shell-ready delay

Empirically, after `pane.split`, the new pane's shell is NOT immediately
ready to accept input.  Text sent within the first ~400ms is silently lost
(confirmed via probe: `send_text` immediately after `split` produced empty
reads; `send_text` after 400ms+ delay executed correctly).  `spawnPane`
waits 400ms before injecting the `opencode attach` command.

### Layout-aware split direction

`spawnPane` selects its split direction based on `storedLayout`:

| Configured layout | `spawnPane` split | `applyLayout` resize axis | Visual result |
|---|---|---|---|
| `main-vertical` (DEFAULT) | `right` | left/right (width) | Main LEFT, agents stacked RIGHT |
| `even-horizontal` | `right` | left/right (width) | All panes side-by-side |
| `main-horizontal` | `down` | up/down (height) | Main TOP, agents stacked BELOW |
| `even-vertical` | `down` | up/down (height) | All panes stacked in column |
| `tiled` | `down` | up/down (height) | Column (approximation) |

This ensures `pane.resize` always operates along the existing split axis:
split `RIGHT` → resize `LEFT`/`RIGHT` adjusts widths; split `DOWN` →
resize `UP`/`DOWN` adjusts heights.

### Layout rebalancing via `pane.resize`

`applyLayout` rebalances panes in-place using `pane.resize`.  All five
layout types have real implementations (no fallbacks in v2).

**Algorithm for `main-vertical` / `main-horizontal`** (single pane resize):
1. Query current layout via `pane.layout`
2. Identify main pane from `HERDR_PANE_ID` (or focused/topmost)
3. Compute target size = `totalSize * mainPaneSize / 100`
4. Resize main pane `RIGHT`/`LEFT` or `DOWN`/`UP` by `|target - current|`

**Algorithm for `even-vertical` / `even-horizontal` / `tiled`** (equal split):
1. Query layout, sort panes by rect.y (vertical) or rect.x (horizontal)
2. Compute equal size = `totalSize / paneCount`
3. For each pane except the last: resize in the correct axis to equal size
4. After each resize, re-read pane positions from the response

**Debounce** (mirrors tmux pattern, 150ms):
- `applyLayout()` cancels pending debounce and runs immediately
- `scheduleLayout()` debounces after `spawnPane`/`closePane` bursts
- A generation counter drops stale callbacks

## Flow

- `spawnPane(sessionId, description, serverUrl, directory)`:
  - ensure inside session and binary + socket are available
  - determine split direction from `storedLayout` via `splitDirectionForLayout`
    (right for side-by-side layouts, down for stacked layouts)
  - `pane.split {direction: <layout-aware>, cwd: <directory>, label: <description>}`
  - extract `pane_id` from response
  - wait 400ms for shell readiness
  - `pane.send_text {pane_id, text: "opencode attach ...\n"}`
  - return `{success: true, paneId}` or `{success: false}` on failure

- `closePane(paneId)`:
  - `pane.send_keys {pane_id, keys: ["ctrl+c"]}` — best-effort SIGINT
  - wait 250ms (matches tmux's graceful-shutdown window)
  - `pane.close {pane_id}` — remove the pane
  - if response is `pane_not_found`, treat as already-closed success
  - return `true` on success, `false` on other errors

- `applyLayout(layout, mainPaneSize)`:
  - cancels pending debounced layout
  - calls `applyLayoutNow` immediately (queries pane.layout, computes deltas,
    issues pane.resize calls)
  - `scheduleLayout` (150ms debounce) called from successful
    `spawnPane`/`closePane`; runs with generation counter to drop stale calls

## Integration

- Selected when `multiplexerConfig.type === 'herdr'` or auto mode resolves to
  herdr (`process.env.HERDR_ENV === '1'` and neither `TMUX` nor `ZELLIJ` is
  set).
- Consumed by `MultiplexerSessionManager` for `session.created` spawn and
  completion cleanup.
- Uses `ctx.directory` as working directory, OpenCode API URL as `serverUrl`,
  and session id as `opencode attach --session` target.
- The parent pane is identified by `process.env.HERDR_PANE_ID`; the socket
  API's `pane.split` operates on the currently focused pane (which is the
  plugin's pane during normal operation), so no explicit source pane_id is
  passed.
