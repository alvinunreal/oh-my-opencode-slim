# src/interview/

## Responsibility

- Implement the `/interview` command flow:
  - command registration and pre-exec interception,
  - interactive stateful interview prompts,
  - markdown document generation/persistence,
  - local HTTP UI server and shared dashboard mode.
- Keep interview lifecycle synchronized across:
  - in-memory session/interview maps,
  - markdown artifacts under `outputFolder`,
  - dashboard cache used for cross-process recovery and browser polling.
- Support two runtime modes:
  - **per-session mode** (local interview server)
  - **dashboard mode** (distributed cache + shared interview pages).

## Design

- `index.ts` exports `createInterviewManager`.

- `runtime.ts` defines the interview-only session boundary (`messages`,
  `notify`, `continue`, and `rename`). v1 uses nested SDK calls
  (`createV1InterviewSessionRuntime`); v2 supplies a context-backed
  implementation without expanding the global client shim.

- `manager.ts` (composition root)
  - Chooses mode via `interview.dashboard === true || interview.port > 0`:
    - per-session mode → `createPerSessionInterviewServer` (`session-server.ts`)
    - dashboard mode → `createDashboardManager` (`dashboard-manager.ts`)
  - Returns event hooks:
    `registerCommand`, `handleCommandExecuteBefore`, `handleEvent`, `dispose`.

- `session-server.ts`
  - Per-session composition: binds a lazy `createInterviewServer({ port: 0 })`
    to a single `createInterviewService`, wiring command/event hooks and
    cleanup.

- `dashboard-manager.ts`
  - Dashboard composition: creates the dashboard server and service, calls
    `tryBecomeDashboard(...)` to elect one process as dashboard,
    non-dashboard processes read auth token via `readDashboardAuthFile(port)`,
    registers/unregisters sessions over HTTP, and pushes state back via
    `/api/interviews/{id}/state`; 10-second fallback polling keeps
    answer/nudge delivery active if needed.

- `createInterviewService` (`service.ts`)
  - Manages interview domain maps:
    - `interviewsById`, `activeInterviewIds`, `sessionBusy`, `sessionModel`.
  - Creates and resumes interviews:
    - `resolveExistingInterviewPath`, `createInterview`, `resumeInterview`.
  - Syncs state from session messages:
    - loads messages,
    - extracts assistant state via `findLatestAssistantState`,
    - fallbacks through `buildFallbackState` when needed,
    - rewrites markdown with `rewriteInterviewDocument`.
  - Injects prompts:
    - kickoff (`buildKickoffPrompt`),
    - resume (`buildResumePrompt`),
    - answer/nudge handling (`buildAnswerPrompt`, `handleNudgeAction`).
  - Handles events:
    - `session.status` updates busy tracking,
    - `session.deleted` marks interview abandoned and drains maps.
  - Pushes updates:
    - `onStateChange` callback for dashboard mode,
    - `onInterviewCreated` callback for immediate registration,
    - optional `openBrowser` for initial UI open.

- `createInterviewServer` (`server.ts`)
  - Owns the per-session HTTP endpoints; HTML rendering lives in `ui.ts`.
  - Supports:
    - `GET /`, `GET /api/interviews`, `GET /interview/{id}`
    - `GET /api/interviews/{id}/state`
    - `POST /api/interviews/{id}/answers`
    - `POST /api/interviews/{id}/nudge`
  - Maps domain errors to HTTP status in `getSubmissionStatus`.

- `ui.ts`
  - HTML/JS renderers for interview pages (list/detail), shared
    client-side helpers (clipboard, polling), and the dashboard brand UI;
    uses `escapeHtml` from `src/utils/escape-html.ts`.

- `dashboard.ts`
  - Implements a shared dashboard server and state cache.
  - Auth path:
    - random token written to `${XDG_DATA_HOME}/opencode/.dashboard-<port>.json`,
    - validated via cookie, query token, or Bearer header.
  - In-memory state/cache contracts:
    - `sessions` registry,
    - `stateCache` keyed by interview ID,
    - pending answers and nudge actions with consume-on-read semantics.
  - Recovery/scan:
    - periodic `rebuildFromFiles()` from markdown frontmatter,
    - session directory discovery via SDK + manual folders,
    - file scanning in known directories and cached file lists.
  - TTL cleanup removes terminal states after 24h.

- Supporting modules:
  - `document.ts`: markdown/file helpers (`slugify`, path resolution, frontmatter,
    title/summary extraction).
  - `parser.ts`: assistant state parse pipeline (`parseAssistantState`,
    `findLatestAssistantState`, `buildFallbackState`).
  - `prompts.ts`: prompt templates for create/resume/answer/nudge.
  - `helpers.ts`: request parsing and HTML/JSON response helpers.
  - `types.ts`: domain schemas and interview contracts.

## Flow

- `src/index.ts` wires this folder through
  `createInterviewManager(ctx, config)`.

- **Per-session mode**
  - service created and bound to a lazy `createInterviewServer({ port: 0 })`,
  - command hook calls flow directly into service.

- **Dashboard mode**
  1. `createInterviewManager` invokes `tryBecomeDashboard`.
  2. Dashboard election succeeds:
     - dashboard keeps local cache callbacks (`setStatePushCallback`,
       `setOnInterviewCreated`),
     - self-registers session directory and rebuilds file-derived state.
  3. Election fails:
     - process becomes client session,
     - reads token file,
     - registers with dashboard,
     - pushes state + interview creation over HTTP,
     - polls `/pending` and `/nudge` on idle.
  4. If probe+fallback fails twice, manager falls back to per-session server.

- `handleCommandExecuteBefore`
  - blank input with no active interview starts ideation,
  - matching slug/path resumes an existing interview only for its durable
    frontmatter owner session,
  - otherwise creates a new interview and injects kickoff prompt.

- `handleEvent`
  - on `session.status: idle`:
    - consume dashboard pending answers/nudge first,
    - then refresh interview state so `sessionBusy` is reflected accurately.
  - on `session.deleted`:
    - unregisters session from the dashboard and local bookkeeping.

## Integration

- Used by `src/index.ts` as the interview plugin module.
- Uses OpenCode SDK session APIs for messages, prompts, and status events.
- Uses local HTTP server contracts for:
  - dashboard browsing,
  - browser ↔ session sync endpoints,
  - manual file/discovery settings.
- Existing tests cover service, parser, manager, server, dashboard, and helpers
  under `src/interview/*.test.ts`.

## Repaired lifecycle details

- The interview-only `runtime.ts` boundary owns message reads, notifications,
  orchestrator continuation, and session rename operations. The v2 bridge uses
  this boundary instead of expanding the global client shim.
- After `confirm-complete`, the next clean assistant response is persisted with
  `rewriteInterviewDocumentWithFinalSpec` only after an idle/text-ended
  completion event; a stream prefix cannot overwrite the final markdown.
- Dashboard clients register at `/api/register`, unregister at
  `/api/unregister`, and receive `202 {"status":"queued"}` for deferred
  browser submissions. Session polling claims each queued value and must
  acknowledge it after service delivery; rejected deliveries roll the claim
  back without clearing the answer, chat message, block comment, or nudge.
- Markdown documents persist their owning `sessionID` in frontmatter. A
  different session cannot resume or mutate an owned document, while the
  original session can resume it across plugin processes.
