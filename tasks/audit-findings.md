# Code Quality Audit — Findings Report

> Generated from plan: `tasks/plans/golden-anchoring-signal.md`

## Phase 1: Static Analysis Results

| Check | Result |
|-------|--------|
| `bun run type-check` | ✅ Zero errors |
| `bun test` | ✅ 37 tests pass across 9 files, 98 expect() calls |
| `bun run build` | ✅ `dist/index.js` produced (0.47 MB, 75 modules bundled) |

---

## Phase 2: Code Quality Findings

### Finding 1 — `extractSessionID` uses unsafe `as Record<string, unknown>` casts

| Field | Value |
|-------|-------|
| **Severity** | NIT |
| **File** | `src/index.ts` |
| **Lines** | 40, 47 |
| **Description** | `extractSessionID` casts `result` to `Record<string, unknown>` and later casts `data` the same way. While functionally safe (the function already guards with `typeof` checks before each access), this bypasses TypeScript's type narrowing. |
| **Risk** | Low. The runtime guards (`typeof result !== "object"`, `typeof value.id === "string"`) prevent actual bugs. The casts are a readability concern, not a safety concern. |
| **Suggested fix** | Replace with a Zod schema (`z.object({ id: z.string() }).or(z.object({ data: z.object({ id: z.string() }) }))`) for self-documenting validation. However, since `zod` is already a dependency, this is a nice-to-have, not a must-fix. Alternatively, use a type predicate function. |

### Finding 2 — `DisciplinePlugin` is a 240-line function

| Field | Value |
|-------|-------|
| **Severity** | WARNING |
| **File** | `src/index.ts` |
| **Lines** | 214–455 |
| **Description** | The exported `DisciplinePlugin` function is a single 240-line closure that defines all hook handlers and both tool implementations inline. This makes it hard to test individual hooks in isolation and increases cognitive load when reading. |
| **Risk** | Medium. As more hooks or tools are added, this function will grow further. The closure over `manager` and `todoNudges` makes extraction non-trivial but not impossible. |
| **Suggested fix** | Extract each hook handler into a named function that receives `manager`, `todoNudges`, `worktree`, `directory`, and `client` as parameters. For example: `function handleToolExecuteBefore(manager, worktree, input, output)`. The tool definitions (`advance_wave`, `accept_plan`) could also be extracted into separate files. |

### Finding 3 — `readSessionTodos` silently swallows all errors

| Field | Value |
|-------|-------|
| **Severity** | WARNING |
| **File** | `src/index.ts` |
| **Lines** | 209 |
| **Description** | The `catch {}` block on line 209 discards all errors from the `client.session.todo` API call. If the API returns a network error, auth error, or unexpected response shape, the plugin silently falls back to `undefined` with no diagnostic output. |
| **Risk** | Medium. In production, this makes debugging todo-seeding failures very difficult. The user would see no error, and the todo nudge would silently retry once then give up. |
| **Suggested fix** | Log the error at debug/warn level: `catch (error) { console.warn("[discipline] readSessionTodos failed:", error); return undefined; }`. Even a `console.debug` would help. |

### Finding 4 — `hasPlanKickoffTodo` substring matching could false-match

| Field | Value |
|-------|-------|
| **Severity** | NIT |
| **File** | `src/index.ts` |
| **Lines** | 183–189 |
| **Description** | `hasPlanKickoffTodo` checks `content.includes(planNameLower)` which could match if the plan name is a substring of another todo's content. For example, if plan name is `bold-forging-anchor` and a todo says `Rebold-forging-anchor-v2 review`, it would match. |
| **Risk** | Very low. Plan names are three-word kebab-case strings generated randomly (e.g., `resilient-weaving-compass`), making accidental substring collisions extremely unlikely in practice. The function also requires the word "plan" to be present, further reducing false matches. |
| **Suggested fix** | No action needed. If desired, could use word-boundary matching: `content.includes(\`plan kickoff: ${planNameLower}\`)` to match the exact seed format from `buildTodoSeedContent`. |

### Finding 5 — `tool.execute.before` safely handles missing `output.args`

| Field | Value |
|-------|-------|
| **Severity** | NIT (no issue found) |
| **File** | `src/index.ts` |
| **Lines** | 273–296 |
| **Description** | The plan asked to verify that `output.args?.filePath` uses optional chaining. Confirmed: line 274 reads `const filePath = output.args?.filePath;` — the `?.` operator is present. If `output.args` is `undefined`, `filePath` will be `undefined`, and the `typeof filePath === "string"` guard on line 275 will skip all blocking logic. |
| **Risk** | None. This is correctly implemented. |
| **Suggested fix** | None needed. |

---

## Phase 3: Test Coverage Gap Analysis

### Gap 1 — No test for `session.create` success + `session.prompt` failure in `accept_plan`

| Field | Value |
|-------|-------|
| **Severity** | WARNING |
| **File** | `src/__tests__/accept-plan.test.ts` |
| **Description** | The `accept_plan` tool has a code path (lines 394–428 in `src/index.ts`) where `session.create` succeeds and returns a valid session ID, but `session.prompt` throws. In this case, the outer `catch` on line 426 sets `fallback = true`, and the plan is still marked as accepted with the fallback message. No test exercises this specific path. |
| **Current coverage** | Tests cover: (1) both succeed → full handoff, (2) neither exists → fallback, (3) plan file missing → error. Missing: create succeeds, prompt throws. |
| **Recommended test** | ```typescript test("falls back gracefully when session.prompt throws after successful create", async () => { const fakeClient = { session: { async create() { return { id: "build-partial" }; }, async prompt() { throw new Error("prompt failed"); } } }; // ... advance to wave 4, create plan file, call accept const result = await acceptPlan.execute({ sessionID, action: "accept" }, context); expect(result).toContain("Direct session handoff is unavailable"); expect(result).toContain("accepted timestamp"); }); ``` |

### Gap 2 — No test for `loadStateFromDisk` with malformed JSON

| Field | Value |
|-------|-------|
| **Severity** | WARNING |
| **File** | `src/__tests__/wave-state.test.ts` |
| **Description** | `WaveStateManager.loadStateFromDisk` (line 117–136 in `src/wave-state.ts`) has a `catch { continue }` that handles corrupted JSON files. No test verifies this behavior — that a malformed `.json` file in the `.wave-state` directory is silently skipped and doesn't crash `getState`. |
| **Current coverage** | Tests cover: persist to disk, reload across instances. Missing: corrupted file resilience. |
| **Recommended test** | ```typescript test("skips malformed JSON files when loading state", () => { const { root, manager } = createManager(); const state = manager.startPlan("session-good"); // Write a corrupted file alongside the valid one const stateDir = join(root, "tasks", ".wave-state"); writeFileSync(join(stateDir, "corrupted.json"), "not valid json{{{", "utf8"); // Create a fresh manager to force disk reload const reloaded = new WaveStateManager(root); expect(reloaded.getState("session-good")).toBeDefined(); expect(reloaded.getState("session-good")?.planName).toBe(state.planName); }); ``` |

### Gap 3 — `Math.random() === 1.0` boundary in `pickWord`

| Field | Value |
|-------|-------|
| **Severity** | NIT |
| **File** | `src/__tests__/name-generator.test.ts` |
| **Description** | `pickWord` uses `Math.floor(Math.random() * words.length)`. Per the ECMAScript spec, `Math.random()` returns a value in `[0, 1)` — it never returns exactly `1.0`. Therefore `Math.floor(1.0 * 50) = 50` (out of bounds) can never occur. The code is correct by spec. |
| **Current coverage** | Tests mock `Math.random` with values in `(0, 1)` range. No test for the `1.0` boundary. |
| **Recommended action** | No test needed — `Math.random() === 1.0` is impossible per spec. However, a brief code comment in `pickWord` documenting this assumption would aid future readers: `// Math.random() returns [0, 1) per spec, so index is always in bounds`. |

### Gap 4 — `isBlockedEnvRead` case-sensitivity coverage

| Field | Value |
|-------|-------|
| **Severity** | NIT |
| **File** | `src/__tests__/write-blocking.test.ts` |
| **Description** | `isBlockedEnvRead` correctly uses `.toLowerCase()` on the filename before comparison. The test covers `.env.local` (blocked) and `.env.example` (allowed), but doesn't test case variants like `.ENV`, `.Env.Production`, or bare `.env`. |
| **Current coverage** | Two cases tested: `.env.local` → blocked, `.env.example` → allowed. Missing: `.env` (bare), `.ENV` (uppercase), `.env.production` (another dotenv variant). |
| **Recommended test** | ```typescript test("blocks case-insensitive .env variants", async () => { const worktree = createWorktree(); const { beforeHook } = await createPlugin(worktree); const cases = [ { file: ".env", blocked: true }, { file: ".ENV", blocked: true }, { file: ".Env.Production", blocked: true }, { file: ".env.development", blocked: true }, ]; for (const { file, blocked } of cases) { const error = await getErrorMessage(() => beforeHook( { tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: file } } ) ); if (blocked) { expect(error).toContain("Reading .env files is blocked"); } else { expect(error).toBeUndefined(); } } }); ``` |

---

## Summary

| Severity | Count | Items |
|----------|-------|-------|
| **CRITICAL** | 0 | — |
| **WARNING** | 4 | Finding 2 (large function), Finding 3 (silent catch), Gap 1 (prompt failure path), Gap 2 (malformed JSON) |
| **NIT** | 4 | Finding 1 (unsafe casts), Finding 4 (substring match), Gap 3 (Math.random boundary), Gap 4 (case-sensitivity tests) |

**Overall assessment**: The codebase is in good shape. No critical bugs or security issues found. The main areas for improvement are:
1. **Observability**: The silent `catch {}` in `readSessionTodos` should at minimum log a warning.
2. **Maintainability**: The 240-line `DisciplinePlugin` function would benefit from extraction into smaller named functions.
3. **Test coverage**: Two meaningful gaps exist (prompt failure fallback, malformed JSON resilience) that should be covered.
