# src/interview/

## Responsibility

- Implement the `/interview` command with session prompt orchestration, interview markdown persistence, and a local HTTP interface.
- Run in one of two modes:
  - per-session server mode (default)
  - shared dashboard mode (for multi-process/session sharing).
- Keep interview lifecycle synchronized between:
  - in-memory interview/session maps,
  - markdown artifacts under `outputFolder`,
  - dashboard cache entries for resume/recovery.

## Design

- `manager.ts` is the composition root and returns:
  - `registerCommand`
  - `handleCommandExecuteBefore`
  - `handleEvent`
- It creates one `createInterviewService(ctx, interviewConfig)` and selects mode via:
  - `interview.dashboard === true || interview.port > 0`.

### `createInterviewService` (`service.ts`)

- Owns interview orchestration state:
  - `interviewsById`, `activeInterviewIds`, `sessionBusy`, `fileCache`.
- Creates/resumes interviews via:
  - `resolveExistingInterviewPath`, `createInterview`, `resumeInterview`.
- Ensures markdown and URLs are prepared with `document.ts` helpers, then notifies users with `notifyInterviewUrl`.
- Re-hydrates interview state from messages via `syncInterview`:
  - loads new messages,
  - parses latest `<interview_state>` using `parseAssistantState` / `findLatestAssistantState` (`parser.ts`) with zod-backed validation,
  - rebuilds fallback state when needed,
  - computes mode (`awaiting-agent`, `awaiting-user`, `completed`, `error`, `abandoned`).
- Handles UI-facing mutation:
  - `submitAnswers` validates active questions and injects answer prompts via `session.promptAsync`.
  - `handleNudgeAction` injects either continuation questions or finalization directives.
- Handles OpenCode events:
  - `session.status` updates `sessionBusy`,
  - `session.deleted` marks active interview as abandoned and cleans the maps.

### `createInterviewServer` (`server.ts`)

- Lightweight HTTP server used in per-session mode and for rendering UI views.
- Routes:
  - `GET /` and `GET /api/interviews` (dashboard list APIs)
  - `GET /interview/{id}` (interview page)
  - `GET /api/interviews/{id}/state`
  - `POST /api/interviews/{id}/answers`
  - `POST /api/interviews/{id}/nudge`
- Converts service errors into HTTP status (`400/404/409/500`) and delegates rendering to `ui.ts`.

### `dashboard.ts`

- Implements shared dashboard process behavior and transport contract.
- `createDashboardServer` maintains:
  - random auth token and local auth file (`.dashboard-<port>.json`),
  - session registry, manual/discovered folders, and TTL-scoped session state cache,
  - pending answers/nudge queues with consume-on-read semantics.
- Adds resilience:
  - `rebuildFromFiles()` reconstructs state from markdown when sessions rejoin,
  - session discovery via session client + folder scanners,
  - periodic cleanup of terminal interview states.
- Public endpoints include:
  - `GET /api/health`, `/api/settings`, `/api/sessions`, `/api/files`,
  - `POST /api/register`, `/api/interviews` (create), `/api/interviews/{id}/state`,
  - `/pending` and `/nudge` GET/POST paths for agent/browser sync.

### Supporting modules

- `document.ts`: path normalization, markdown creation/rewrite/read, and frontmatter/title/summary extraction.
- `parser.ts`: `parseInterviewState` + `findLatestAssistantState` state extraction pipeline.
- `prompts.ts`: command/answer/nudge prompt builders.
- `helpers.ts`: request parsing and HTTP response helpers.
- `types.ts`: domain contracts and zod schemas (`InterviewRecord`, `InterviewState`, `InterviewStateEntry`, `RawInterviewStateSchema`, `RawQuestionSchema`).

## Flow

- `src/index.ts` initializes interview plugin integration through `createInterviewManager(ctx, config)`.

- **Per-session mode** (`dashboard` false / port=0):
  - service built, output folder resolved from `interview.outputFolder`,
  - server started lazily through `createInterviewServer({ port: 0 })`,
  - manager forwards hooks directly to service callbacks.

- **Dashboard mode** (`dashboard` true or port > 0):
  1. `createInterviewManager` calls `tryBecomeDashboard`.
  2. If elected, process becomes dashboard:
     - keep in-process cache via `statePushCallback` and `setOnInterviewCreated`,
     - self-register and refresh directories with `discoverSessionDirectories` + `refreshFiles`,
     - expose auth token for sibling sessions.
  3. If not elected, process becomes session:
     - reads token via `readDashboardAuthFile`,
     - registers via `POST /api/register`,
     - pushes state to dashboard via `POST /api/interviews/{id}/state`,
     - sends newly created interview metadata via `POST /api/interviews`,
     - starts periodic poll timer (10s) for `/pending` and `/nudge`.
  4. If dashboard probe fails after retry, it falls back to local per-session server.

- `handleCommandExecuteBefore`:
  - blank argument with no active interview → asks user for idea,
  - matching slug/path → resume flow,
  - otherwise create new interview and inject kickoff prompt.

- `handleEvent`:
  - on `session.status.idle`: consume pending dashboard actions then refresh state,
  - on `session.deleted`: unregister session and remove linked dashboard entries.

## Integration

- All runtime calls remain through manager methods returned to `src/index.ts`.
- Integrates directly with OpenCode session client for message reads and prompt injection.
- Outputs are surfaced to users by sending interview URLs back through the same session prompt stream.
- Dashboard and server flows are validated in `src/interview/*test.ts`.
