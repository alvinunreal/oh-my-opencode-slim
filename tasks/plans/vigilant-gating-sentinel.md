# opencode-discipline: Enforcement Plugin + Agent Suite

> **Done** = an npm-publishable TypeScript plugin (`opencode-discipline`) that enforces 4-wave planning discipline via custom tools and hooks, bundled with 7 agent markdown files, installable with one config line.

## Context

- **Current state**: Empty git repo at `/Users/halloweed/Coding/Projects/omoslim`. No code exists.
- **Target state**: A complete npm package containing:
  - `src/index.ts` — main plugin export with all hooks
  - `src/wave-state.ts` — wave state management (file-backed per plan name)
  - `src/name-generator.ts` — three-word evocative plan name generator
  - `agents/*.md` — 7 agent markdown files (plan, build, oracle, librarian, reviewer, designer, deep)
  - `package.json`, `tsconfig.json`, build config
  - Tests
  - README.md (already drafted by user)
- **Patterns to follow**: OpenCode plugin conventions from `@opencode-ai/plugin` package:
  - Export named `Plugin` functions (not default exports)
  - Use `tool()` helper with `tool.schema` (Zod) for custom tool args
  - Hooks are keys in the returned object: `"tool.execute.before"`, `"experimental.chat.system.transform"`, etc.
  - Plugin receives `{ client, project, directory, worktree, serverUrl, $ }` context
  - Agent markdown files use YAML frontmatter with `description`, `mode`, `model`, `permission` fields

## Decisions

- **In-memory + file-backed wave state**: Wave state is stored in `tasks/.wave-state/<plan-name>.json` where the plan name (three random evocative words) is generated at Wave 1 start. An in-memory Map provides fast lookups; file writes persist state.
- **Plan name generated at Wave 1**: The `advance_wave` tool generates the three-word plan name when transitioning to Wave 1, so the state file and eventual plan file share the same name.
- **`advance_wave` restricted to Plan agent**: The tool's `execute()` checks `context.agent === 'plan'` and returns an error for other agents.
- **Add `accept_plan` handoff tool**: Plan completion is explicit. `accept_plan` presents `accept`/`revise`; on `accept`, it performs a clean handoff to Build with only the plan file path.
- **Block `tasks/plans/*.md` writes until Wave 3**: `tool.execute.before` intercepts `edit`/`write` tools targeting `tasks/plans/*.md` and throws if the session's wave < 3.
- **Fresh-context handoff strategy**: Handoff uses a new Build session (or fork-at-plan message if API proves cleaner) so planning interview/research context does not leak into implementation.
- **System reminder injection in Plan mode**: Add a strict read-only reminder block in `experimental.chat.system.transform` while Plan wave state is active.
- **Skip auto-format**: OpenCode's native formatter system handles this. Document in README that users should configure `formatter` in `opencode.json`.
- **Skip lessons.md for v1**: Deferred to future version. Focus on wave enforcement.
- **npm distribution**: Published as `opencode-discipline`. Users add `"plugin": ["opencode-discipline"]` to `opencode.json`.
- **Agent files bundled but installed separately**: The npm package includes agent `.md` files. A postinstall script or CLI command copies them to `~/.config/opencode/agents/`. Alternatively, users manually copy.

## Phases

### Phase 1: Project scaffolding

- [x] Create `package.json` with:
  - `name`: `opencode-discipline`
  - `version`: `0.1.0`
  - `type`: `module`
  - `main`: `dist/index.js`
  - `types`: `dist/index.d.ts`
  - `files`: `["dist", "agents"]`
  - `exports`: `{ ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } }`
  - `dependencies`: `{ "@opencode-ai/plugin": "latest", "zod": "^3.23" }`
  - `devDependencies`: `{ "typescript": "^5.7", "bun-types": "latest", "@types/bun": "latest", "vitest": "^3.0" }`
  - `scripts`: `{ "build": "bun build src/index.ts --outdir dist --target bun --format esm && tsc --emitDeclarationOnly", "test": "vitest run", "prepublishOnly": "bun run build" }`
- [x] Create `tsconfig.json` with `target: ESNext`, `module: ESNext`, `moduleResolution: bundler`, `declaration: true`, `outDir: dist`, `strict: true`
- [x] Create `.gitignore` with `node_modules/`, `dist/`, `.wave-state/`
- [x] Run `bun install` to install dependencies
- **Verify**: `bun run build` — expected: compiles without errors, `dist/index.js` and `dist/index.d.ts` exist
- **Rollback**: `rm -rf package.json tsconfig.json node_modules dist .gitignore`

### Phase 2: Name generator module

- [x] Create `src/name-generator.ts`:
  - Export `generatePlanName(): string` that returns `{adjective}-{gerund}-{noun}`
  - Curated word lists (~50 adjectives, ~50 gerunds, ~50 nouns) — evocative, distinct, memorable
  - Adjectives: `resilient`, `luminous`, `patient`, `vigilant`, `serene`, `fierce`, `quiet`, `bold`, `steady`, `ancient`, etc.
  - Gerunds: `forging`, `weaving`, `tracing`, `binding`, `carving`, `drifting`, `kindling`, `mapping`, `shaping`, `threading`, etc.
  - Nouns: `compass`, `anchor`, `meridian`, `beacon`, `prism`, `sentinel`, `vessel`, `keystone`, `threshold`, `lattice`, etc.
  - Uses `Math.random()` for selection (no crypto needed)
- [x] Create `src/__tests__/name-generator.test.ts`:
  - Test that output matches `word-word-word` pattern
  - Test that 100 generated names are all unique (probabilistic but reliable with 125k combinations)
  - Test that each segment is lowercase alpha only
- **Verify**: `bun test src/__tests__/name-generator.test.ts` — expected: all tests pass
- **Rollback**: `rm src/name-generator.ts src/__tests__/name-generator.test.ts`

### Phase 3: Wave state manager

- [x] Create `src/wave-state.ts`:
  - Types: `Wave = 1 | 2 | 3 | 4`, `WaveState = { wave: Wave; planName: string; sessionID: string; startedAt: string; advancedAt: string[] }`
  - Class `WaveStateManager`:
    - `private states: Map<string, WaveState>` — keyed by sessionID
    - `private stateDir: string` — resolved to `{worktree}/tasks/.wave-state/`
    - `constructor(worktree: string)`
    - `startPlan(sessionID: string): WaveState` — generates plan name via `generatePlanName()`, creates state at wave 1, writes file `{stateDir}/{planName}.json`, returns state
    - `advanceWave(sessionID: string): WaveState` — increments wave (1→2→3→4), updates file, throws if no active plan or already at wave 4
    - `getState(sessionID: string): WaveState | undefined` — returns current state from memory
    - `getWave(sessionID: string): Wave | undefined` — shorthand
    - `getPlanName(sessionID: string): string | undefined` — shorthand
    - `isWaveAtLeast(sessionID: string, minWave: Wave): boolean` — for gate checks
    - `private persist(state: WaveState): void` — writes JSON to `{stateDir}/{planName}.json`
    - `private ensureDir(): void` — creates `tasks/.wave-state/` if missing
- [x] Create `src/__tests__/wave-state.test.ts`:
  - Test `startPlan` creates state at wave 1 with valid plan name
  - Test `advanceWave` increments 1→2→3→4
  - Test `advanceWave` throws at wave 4 (can't go beyond)
  - Test `advanceWave` throws for unknown session
  - Test `isWaveAtLeast` returns correct booleans
  - Test file persistence (write + read back)
  - Use temp directory for state files
- **Verify**: `bun test src/__tests__/wave-state.test.ts` — expected: all tests pass
- **Rollback**: `rm src/wave-state.ts src/__tests__/wave-state.test.ts`

### Phase 4: Core plugin — `advance_wave` custom tool

- [x] Create `src/index.ts` with the main plugin export:
  - `export const DisciplinePlugin: Plugin = async ({ worktree, $ }) => { ... }`
  - Instantiate `WaveStateManager` with `worktree`
  - Return hooks object with `tool.advance_wave`:
    ```
    tool: {
      advance_wave: tool({
        description: "Advance the planning wave. Call this to move from one wave to the next. Wave 1: Interview, Wave 2: Gap Analysis, Wave 3: Plan Generation, Wave 4: Review. You must call this before starting each wave. The first call starts a new plan and generates the plan filename.",
        args: {
          sessionID: tool.schema.string().describe("The current session ID"),
        },
        async execute(args, context) {
          if (context.agent !== "plan") {
            return "Error: advance_wave is only available to the Plan agent."
          }
          // If no active plan, start one (Wave 1)
          // Otherwise, advance to next wave
          // Return current wave state as formatted string
        },
      }),
    }
    ```
  - The tool should return a clear message: `"Wave {n} ({name}) started for plan '{planName}'. You may now proceed with {wave description}."`
- [x] Create `src/__tests__/advance-wave.test.ts`:
  - Test that calling advance_wave with non-plan agent returns error
  - Test first call creates plan at wave 1
  - Test subsequent calls advance waves
  - Test wave 4 → error on further advance
- **Verify**: `bun test src/__tests__/advance-wave.test.ts` — expected: all tests pass
- **Rollback**: Revert `src/index.ts` to empty plugin, `rm src/__tests__/advance-wave.test.ts`

### Phase 5: Core plugin — `accept_plan` custom tool and handoff

- [x] Add `tool.accept_plan` to `src/index.ts` with args:
  - `sessionID: string`
  - `action: "accept" | "revise"`
  - `planPath?: string` (optional override; default from wave state: `tasks/plans/{planName}.md`)
- [x] Implement `action: "revise"` behavior:
  - Return structured response that keeps current Plan session active
  - Include current wave, plan path, and explicit next step: continue in Wave 4 review/revision
- [x] Implement `action: "accept"` behavior:
  - Validate plan file exists and is readable
  - Create new Build session via SDK client (`client.session.create`) with `agent: "build"` when supported; otherwise create then update/route to Build through TUI command path
  - Seed first message in new Build session so first action is `Read tasks/plans/{filename}.md`
  - Add strict handoff system note in new Build session: "Use only this file as source of truth; do not rely on Plan context"
  - Mark original Plan session state as `accepted` in `tasks/.wave-state/{planName}.json` (include timestamp + build session id)
- [x] Add `src/__tests__/accept-plan.test.ts`:
  - `revise` keeps plan session and returns revise directive
  - `accept` creates build handoff payload with only plan file path
  - `accept` fails when plan file missing
  - Non-plan agent calls are rejected
- **Verify**: `bun test src/__tests__/accept-plan.test.ts` — expected: all tests pass
- **Rollback**: Remove `accept_plan` tool from `src/index.ts`, `rm src/__tests__/accept-plan.test.ts`

### Phase 6: Core plugin — `tool.execute.before` hook (write blocking)

- [x] Add `"tool.execute.before"` hook to `src/index.ts`:
  - Check if `input.tool` is `edit` or `write`
  - Check if `output.args.filePath` matches `tasks/plans/*.md` (use simple string check or path resolution against worktree)
  - Look up wave state for `input.sessionID`
  - If wave state exists AND wave < 3, throw `new Error("Cannot write plan files until Wave 3 (Plan Generation). Current wave: {n}. Call advance_wave to progress.")`
  - If no wave state (non-plan session or Build agent), allow through — don't block non-plan workflows
- [x] Add `.env` protection in the same hook:
  - If `input.tool` is `read` and `output.args.filePath` matches `*.env` or `*.env.*` (but not `*.env.example`), throw `new Error("Reading .env files is blocked by opencode-discipline.")`
- [x] Create `src/__tests__/write-blocking.test.ts`:
  - Test that write to `tasks/plans/foo.md` is blocked at wave 1 and 2
  - Test that write to `tasks/plans/foo.md` is allowed at wave 3 and 4
  - Test that write to other paths is always allowed
  - Test that `.env` reads are blocked
  - Test that `.env.example` reads are allowed
  - Test that non-plan sessions (no wave state) are not blocked
  - Test that Plan session becomes read-only after `accept_plan(action="accept")`
- **Verify**: `bun test src/__tests__/write-blocking.test.ts` — expected: all tests pass
- **Rollback**: Remove the `tool.execute.before` hook from `src/index.ts`, `rm src/__tests__/write-blocking.test.ts`

### Phase 7: Core plugin — `experimental.chat.system.transform` hook

- [x] Add `"experimental.chat.system.transform"` hook to `src/index.ts`:
  - Look up wave state for `input.sessionID`
  - If wave state exists, append to `output.system`:
    ```
    ## 🔒 Discipline Plugin — Wave State
    
    **Current wave**: {n} — {wave name}
    **Plan name**: {planName}
    **Plan file**: tasks/plans/{planName}.md
    
    ### Wave rules:
    - Wave 1 (Interview): Ask clarifying questions. Delegate to @explore and @librarian. Do NOT write the plan yet.
    - Wave 2 (Gap Analysis): Check for hidden intent, over-engineering, missing context, ambiguity, breaking changes. Do NOT write the plan yet.
    - Wave 3 (Plan Generation): NOW write the plan to tasks/plans/{planName}.md using the structured template.
    - Wave 4 (Review): Self-review the plan. Delegate to @oracle for high-stakes decisions. Edit the plan if needed.
    
    **You are in Wave {n}. Call `advance_wave` to move to the next wave.**
    **Writing to tasks/plans/*.md is BLOCKED until Wave 3.**
    ```
  - Append the Plan Mode read-only reminder block (verbatim from requirements) when current agent is Plan:
    - "CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase..."
    - "ANY file edits, modifications, or system changes are forbidden"
    - "Only read, analyze, delegate, and plan"
    - "Do not execute implementation"
  - If no wave state, append a shorter prompt:
    ```
    ## Discipline Plugin
    You are operating under the opencode-discipline plugin. To start a structured plan, call `advance_wave` to begin Wave 1 (Interview).
    ```
- [x] Create `src/__tests__/system-transform.test.ts`:
  - Test that system prompt includes wave state when active
  - Test that system prompt includes "call advance_wave" when no active plan
  - Test that wave number and plan name are correctly interpolated
  - Test that Plan mode reminder text is injected for Plan agent sessions
- **Verify**: `bun test src/__tests__/system-transform.test.ts` — expected: all tests pass
- **Rollback**: Remove the hook from `src/index.ts`, `rm src/__tests__/system-transform.test.ts`

### Phase 8: Core plugin — `experimental.session.compacting` hook

- [x] Add `"experimental.session.compacting"` hook to `src/index.ts`:
  - Look up wave state for `input.sessionID`
  - If wave state exists, push to `output.context`:
    ```
    ## Discipline Plugin — Compaction Context
    
    CRITICAL: Preserve the following state across compaction:
    - Current planning wave: {n} ({wave name})
    - Plan name: {planName}
    - Plan file target: tasks/plans/{planName}.md
    - The advance_wave tool must be called to progress between waves.
    - Writing to tasks/plans/*.md is blocked until Wave 3.
    - `accept_plan` controls handoff to Build; if accepted, preserve build session id and accepted timestamp.
    
    Resume from Wave {n} after compaction.
    ```
- [x] Create `src/__tests__/compaction.test.ts`:
  - Test that compaction context includes wave state
  - Test that compaction context is empty array when no active plan
- **Verify**: `bun test src/__tests__/compaction.test.ts` — expected: all tests pass
- **Rollback**: Remove the hook from `src/index.ts`, `rm src/__tests__/compaction.test.ts`

### Phase 9: Agent markdown files

- [x] Create `agents/plan.md` — Strategic planner (mode: primary, model: `anthropic/claude-opus-4-6`):
  - Frontmatter: `description`, `mode: primary`, `model: anthropic/claude-opus-4-6`, permissions (bash: `{ "*": "ask", "rtk *": "allow" }`, edit: `deny` except `tasks/**`)
  - System prompt: Full 4-wave planning workflow (interview → gaps → plan → review)
  - Instructions to call `advance_wave` at each transition
  - Instructions to call `accept_plan` only after Wave 4 review completes
  - Accept/revise UX contract:
    - Show final plan path
    - Call `accept_plan(action="revise")` if user requests changes
    - Call `accept_plan(action="accept")` only with explicit user acceptance
  - Instructions to delegate to `@explore`, `@librarian`, `@oracle`, `@reviewer`
  - Plan template with phases, verify steps, rollback, risks, acceptance criteria
- [x] Create `agents/build.md` — Implementation engine (mode: primary, model: `anthropic/claude-opus-4-6`):
  - Frontmatter: `mode: primary`, `model: anthropic/claude-opus-4-6`, permissions (bash: `{ "*": "allow", "rtk *": "allow" }`, edit: `allow`)
  - System prompt: Phase-by-phase execution, verification-gated, delegates to subagents
  - Instructions to always start by reading the injected plan path from handoff (`tasks/plans/{filename}.md`)
  - Instruction: treat plan file as sole handoff context; do not assume prior Plan conversation exists
  - Instructions to delegate to `@reviewer` before marking done
- [x] Create `agents/oracle.md` — Architecture consultant (mode: subagent, model: `openai/gpt-5.4`):
  - Frontmatter: `mode: subagent`, `model: openai/gpt-5.4`, permissions (edit: `deny`, bash: `{ "*": "ask", "rtk *": "allow" }`)
  - System prompt: Read-only architecture advisor, tradeoff analysis, never implements
- [x] Create `agents/librarian.md` — Research specialist (mode: subagent, model: `openai/gpt-4.1-mini`):
  - Frontmatter: `mode: subagent`, `model: openai/gpt-4.1-mini`, permissions (edit: `deny`, bash: `{ "*": "ask", "rtk *": "allow" }`)
  - System prompt: Gathers context from codebase and docs, returns structured findings, never implements
- [x] Create `agents/reviewer.md` — Ruthless critic (mode: subagent, model: `openai/gpt-5.4`):
  - Frontmatter: `mode: subagent`, `model: openai/gpt-5.4`, permissions (edit: `deny`, bash: `{ "*": "ask", "rtk *": "allow" }`)
  - System prompt: Validates plans and code, finds gaps, never edits, returns structured critique
- **Verify**: Validate each `.md` file has valid YAML frontmatter — `bun -e "const fs = require('fs'); const yaml = require('yaml'); for (const f of fs.readdirSync('agents').filter(f => f.endsWith('.md'))) { const content = fs.readFileSync('agents/' + f, 'utf8'); const match = content.match(/^---\n([\s\S]*?)\n---/); if (!match) throw new Error(f + ' missing frontmatter'); console.log(f + ': OK'); }"` — expected: all files print OK
- **Rollback**: `rm -rf agents/`

### Phase 10: Remaining agent files

- [x] Create `agents/designer.md` — UI/UX design specialist (mode: subagent, model: `anthropic/claude-sonnet-4-6`):
  - Frontmatter: `mode: subagent`, `model: anthropic/claude-sonnet-4-6`, permissions (edit: `deny`, bash: `{ "*": "ask", "rtk *": "allow" }`)
  - System prompt: Components, design tokens, accessibility, never implements backend
- [x] Create `agents/deep.md` — Deep coder (mode: subagent, model: `openai/gpt-5.3-codex`):
  - Frontmatter: `mode: subagent`, `model: openai/gpt-5.3-codex`, permissions (bash: `{ "*": "allow", "rtk *": "allow" }`, edit: `allow`)
  - System prompt: Long-horizon complex coding tasks, full tool access
- [x] Create `agents/README.md` — Documentation for the agent suite:
  - Table of agents with models and purposes
  - Installation instructions
  - Delegation flow diagram
- **Verify**: `ls agents/*.md | wc -l` — expected: 8 (7 agents + README)
- **Rollback**: `rm agents/designer.md agents/deep.md agents/README.md`

### Phase 11: Integration test + final build

- [x] Create `src/__tests__/integration.test.ts`:
  - Test full plugin lifecycle: init → advance_wave (1→2→3→4) → write blocking → system transform → accept_plan handoff
  - Mock the `PluginInput` context (`worktree` pointing to temp dir)
  - Verify state files are created in `tasks/.wave-state/`
  - Verify plan writes are blocked at waves 1-2 and allowed at waves 3-4
  - Verify `accept_plan(action="accept")` creates a Build session with clean context payload containing only plan path
  - Verify Plan session is marked accepted and no longer used for implementation steps
  - Verify fallback path when agent switching is unavailable: tool returns deterministic handoff instructions (`switch to Build`, `read tasks/plans/{filename}.md`)
- [x] Verify full test suite: `bun test` — expected: all tests pass
- [x] Verify build: `bun run build` — expected: `dist/index.js` and `dist/index.d.ts` exist, no errors
- [x] Verify package contents: `npm pack --dry-run` — expected: includes `dist/`, `agents/`, `package.json`, `README.md`
- **Verify**: `bun test && bun run build && npm pack --dry-run` — expected: all pass, package includes correct files
- **Rollback**: `rm -rf src/__tests__/integration.test.ts`

## Dependencies

- Phase 2 (name generator) is independent — can start immediately
- Phase 3 (wave state) depends on Phase 2 (imports `generatePlanName`)
- Phase 4 (advance_wave tool) depends on Phase 3 (imports `WaveStateManager`)
- Phase 5 (`accept_plan`) depends on Phase 3 and Phase 4 (needs wave state + plan filename)
- Phases 6, 7, 8 (hooks) depend on Phase 4 and are updated to respect Phase 5 accepted state
- Phases 6, 7, 8 can run in parallel after Phase 5 shape is defined
- Phases 9, 10 (agents) are independent of Phases 2-8 — can run in parallel
- Phase 11 (integration) depends on all previous phases

## Risks

- **`experimental.*` hooks may change**: likelihood medium, impact medium → mitigation: pin `@opencode-ai/plugin` version, document that these hooks are experimental
- **Agent switch APIs may vary by OpenCode version**: likelihood medium, impact high → mitigation: implement primary path (`session.create` with Build agent) plus deterministic fallback instructions when direct switch cannot be executed
- **True "clear context" is not mutation of old session history**: likelihood medium, impact medium → mitigation: model clean handoff as new Build session seeded only with plan path; never reuse Plan session for implementation
- **Agent model IDs may not exist for all users**: likelihood high, impact low → mitigation: document that users need the relevant provider API keys configured; models are configurable per-agent
- **Wave state file conflicts with multiple sessions**: likelihood low, impact low → mitigation: state is keyed by sessionID; plan names are random with 125k combinations
- **`context.agent` value may not match expected string**: likelihood low, impact medium → mitigation: test with actual OpenCode to verify the agent name string matches the markdown filename

## Out of scope

- **Auto-formatting**: OpenCode's native formatter system handles this. Users configure `formatter` in `opencode.json`.
- **Session-end lessons.md**: Deferred to v2. Would use `session.idle` event to append summaries.
- **CLI for agent installation**: v1 uses manual `cp agents/*.md ~/.config/opencode/agents/`. A `postinstall` script or `npx opencode-discipline install` could be added in v2.
- **RTK proxy integration**: The `"rtk *": "allow"` permission is set in agent frontmatter. No plugin code needed.
- **Plan template validation**: The plugin enforces *when* the plan can be written, not *what* it contains. Template enforcement is in the agent prompt.
- **Cross-client Accept/Revise UI parity**: clickable Accept/Revise may differ across TUI/CLI/Web; v1 guarantees tool-level `action: accept|revise` behavior and deterministic outputs.

## Acceptance criteria

- [x] `bun test` passes all unit and integration tests
- [x] `bun run build` produces `dist/index.js` and `dist/index.d.ts` without errors
- [x] `npm pack --dry-run` includes `dist/`, `agents/`, `package.json`, `README.md`
- [x] The `advance_wave` tool creates wave state at wave 1 with a valid three-word plan name
- [x] The `advance_wave` tool advances waves 1→2→3→4 and errors beyond 4
- [x] The `advance_wave` tool rejects non-plan agents
- [x] The `accept_plan` tool supports `action: "accept" | "revise"`
- [x] `accept_plan(action="revise")` keeps the plan session active for further edits
- [x] `accept_plan(action="accept")` creates a fresh Build handoff context with only `tasks/plans/{filename}.md`
- [x] Build handoff flow starts with reading the plan file as first action
- [x] Accepted plan state is persisted in `tasks/.wave-state/{planName}.json` with timestamp and build session id
- [x] Writes to `tasks/plans/*.md` are blocked at waves 1-2 and allowed at waves 3-4
- [x] `.env` file reads are blocked (except `.env.example`)
- [x] System prompt injection includes current wave state
- [x] Plan mode system reminder block is injected while Plan wave state is active
- [x] Compaction context preserves wave state
- [x] Wave state is persisted to `tasks/.wave-state/{planName}.json`
- [x] All 7 agent markdown files have valid YAML frontmatter
- [x] Agent files specify correct models per the README table
- [x] All agents with bash permissions include `"rtk *": "allow"`
