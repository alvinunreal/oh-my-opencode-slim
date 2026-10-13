/**
 * @deprecated as a prompt-rendering source. Neither orchestrator builder
 * reads this anymore (v1 and v2 both render `ROLE_ROUTING_SLIM_LINES`);
 * `roleHasWriteCapability` now reads a hand-written table, not this
 * object's prose. The sole remaining consumer is marketplace inheritance
 * (`src/marketplace/routing.ts`), which copies a `routingBlock` string
 * into package metadata/contract output — not into any prompt. New
 * internal consumers should read `ROLE_ROUTING_SLIM_LINES` or add a
 * hand-written table instead of parsing this prose. Not actually
 * removable: marketplace contract/test fixtures still depend on its full
 * text.
 */
export const ROLE_ROUTING_BLOCKS: Readonly<Record<string, string>> =
  Object.freeze({
    explorer: `@explorer
- Lane: Fast codebase recon that returns compressed context
- Permissions: read_files
- Stats: 2x faster codebase search than orchestrator, 1/2 cost of orchestrator
- Capabilities: Glob, grep, AST queries to locate files, symbols, patterns
- **Delegate when:** Need to discover what exists before planning • Parallel searches speed discovery • Need summarized map vs full contents • Broad/uncertain scope
- **Don't delegate when:** Know the path and need actual content • Need full file anyway • Single specific lookup`,

    librarian: `@librarian
- Lane: External knowledge and library research, fast web research
- Role: Authoritative source for current library docs, API references, examples, bug investigations, and web retrieval
- Stats: 2x faster web research than orchestrator, 1/2 cost of orchestrator
- **Delegate when:** Libraries with frequent API changes (React, Next.js, AI SDKs) • Complex APIs needing official examples (ORMs, auth) • Version-specific behavior matters • Unfamiliar library • Edge cases or advanced features • Nuanced best practices • Working on fixing tricky bug or problem and need latest web research information
- **Don't delegate when:** Standard usage you're confident • Simple stable APIs • General programming knowledge • Info already in conversation • Built-in language features
- **Rule of thumb:** "How does this library work?" → @librarian. "How does programming work?" → answer directly. "How do others solve or workaround this tricky issue?" → @librarian.`,

    oracle: `@oracle
- Lane: Architecture, risk, debugging strategy, and review
- Role: Strategic advisor for high-stakes decisions and persistent problems, code reviewer
- Permissions: read_files
- Stats: 5x better decision maker, problem solver, investigator than orchestrator, 0.8x speed of orchestrator, same cost.
- Capabilities: Deep architectural reasoning, system-level trade-offs, complex debugging, code review, simplification, maintainability review
- **Delegate when:** Major architectural decisions with long-term impact • Problems persisting after 2+ fix attempts • High-risk multi-system refactors • Costly trade-offs (performance vs maintainability) • Complex debugging with unclear root cause • Security/scalability/data integrity decisions • Genuinely uncertain and cost of wrong choice is high • Code needs simplification or YAGNI scrutiny
- **Review use:** @oracle is an escalation, not a default verification step. Request independent @oracle review only when its analysis is expected to materially reduce risk or uncertainty.
- **Don't delegate when:** Routine decisions you're confident about • First bug fix attempt • Straightforward trade-offs • Tactical "how" vs strategic "should" • Time-sensitive good-enough decisions • Quick research/testing can answer
- **Rule of thumb:** Architecture, code review, or simplification where independent analysis materially reduces risk or uncertainty? → @oracle. Routine coordination or final synthesis? → handle as orchestration.`,

    designer: `@designer
- Lane: UI/UX design, related edits, design polish and review
- Permissions: read_files, write_files
- Stats: 10x better UI/UX than orchestrator
- Capabilities: Good design taste, visual relevant edits, interactions, responsive layouts, design systems with aesthetic intent, deep UI/UX knowledge.
- Owns visual and interaction quality: layout, hierarchy, spacing, motion, affordances, responsive behavior, and overall feel.
- Weakness: copywriting. Ask @designer to use grounded, normal wording, then route copy fixes via @fixer for mechanical edits or back to @designer when visual judgment is needed, without changing visual or interaction intent.
- Avoid: "Let me ask @designer how it should look and implement yourself" → instead: "Let me ask @designer to design and implement the UI/UX changes for me"
- **Delegate when:** User-facing interfaces needing polish • Responsive layouts • UX-critical components (forms, nav, dashboards) • Visual consistency systems • Animations/micro-interactions • Landing/marketing pages • Refining functional→delightful • Reviewing existing UI/UX quality
- **Don't delegate when:** Backend/logic with no visual.
- **Rule of thumb:** Users see it and polish matters? → @designer. Headless/functional implementation? → schedule @fixer.`,

    fixer: `@fixer
- Lane: Bounded implementation and executioner
- Role: Fast execution specialist for well-defined tasks
- Permissions: read_files, write_files
- Stats: 2x faster code edits, 1/2 cost of orchestrator
- Weakness: design, taste
- Tools/Constraints: Execution-focused-no research, no architectural decisions
- **Delegate when:** For implementation work, think and triage first. If the change is non-trivial or multi-file, hand bounded execution to @fixer • Parallelization benefits: Task involves multiple folders and multiple files modification, scoping work per folder and spawning parallel @fixer instances for each folder.
- **Don't delegate when:** Needs discovery/research/decisions • Unclear requirements needing iteration • Requires design taste, visual hierarchy, interaction polish, responsive layout decisions, animation/motion, component feel, or UI copy/design trade-offs
- **Rule of thumb:** Headless/mechanical implementation → @fixer. User-visible design or polish → @designer. If @designer already set direction, @fixer may only do bounded mechanical follow-up that preserves that design exactly.`,

    council: `@council
- Lane: High-stakes multi-model decision support
- Role: Multi-LLM consensus engine that receives raw councillor responses and synthesizes them into a structured council report.
- Permissions: Synthesis only; no tools
- Stats: 3x slower than orchestrator, 3x or more cost of orchestrator
- Capabilities: Synthesizes responses from independently-dispatched councillors, compares their answers, resolves disagreements, and produces a final synthesized answer plus councillor details and consensus summary.
- **Delegate when:** Critical decisions need multiple independent perspectives • High-stakes architectural/security/data-integrity choices • Ambiguous problems where disagreement is useful signal • You want confidence beyond a single model • The user explicitly asks for council/consensus/multiple opinions.
- **Don't delegate when:** Straightforward tasks you're confident about • Speed matters more than confidence • Routine implementation/debugging • A single specialist is clearly the right tool • You only need current docs/search/code review rather than multi-model consensus.
- **How to call:** Send the full question/task and relevant context. Be explicit about what decision, trade-off, or answer the council should resolve. Do not ask council to do routine code edits.
- **Result handling:** Council returns a structured response that may include: synthesized Council Response, individual Per-Councillor Details, and Council Summary/confidence. Preserve that structure when the user asked for council output. Do not pretend the council only returned a final answer. If you need to act on the council result, first briefly state the council's recommendation, then proceed.
- **Rule of thumb:** Need second/third opinions from different models? → @council. Need one expert lane? → use the specialist. Need final synthesis? → handle directly.`,

    observer: `@observer
- Lane: Visual/media analysis isolated from orchestrator context
- Role: Visual analysis specialist for images, PDFs, and diagrams
- Permissions: Read files
- Stats: Saves main context tokens - @observer processes raw files, returns structured observations
- Capabilities: Interprets images, screenshots, PDFs, and diagrams via native read tool; extracts UI elements, layouts, text, relationships
- **Delegate when:** Need to analyze a multimedia file• Extract information
- **Don't delegate when:** Plain text files that Read can handle directly • Files that need editing afterward (need literal content from Read)
- **Rule of thumb:** Even if your model supports vision, delegate visual analysis to @observer - it isolates large image/PDF bytes from your context window, returning only concise structured text. Need exact file contents for routing? → Read only the minimal context yourself.
- **IMPORTANT:** When delegating to @observer, always include the **full file path** in the prompt so it can read the file. Example: "Analyze the screenshot at /path/to/file.png - describe the UI elements and error messages."`,
  });

export function renderRoleRoutingBlock(
  routingBlock: string,
  roleId: string,
  runtimeName: string,
): string {
  return routingBlock.replace(
    new RegExp(`@${roleId}\\b`, 'g'),
    `@${runtimeName}`,
  );
}

/**
 * v2 slim one-line routing verdicts (council-final §1), keyed by the same
 * agent ids as ROLE_ROUTING_BLOCKS: the slim <Agents> block keeps the
 * routing criteria, while the agents' `description` fields (consumed by
 * the native dynamic subagent list) stay non-duplicating one-liners. Not a
 * new name list — keys mirror the routing data, and the renderer iterates
 * ROLE_ROUTING_BLOCKS so a role added there is filtered identically and
 * only skipped from the slim block until its line lands here.
 */
export const ROLE_ROUTING_SLIM_LINES: Readonly<Record<string, string>> =
  Object.freeze({
    explorer: `@explorer — read-only codebase recon (glob/grep/AST). Delegate: discovery, parallel searches, summarized maps. Don't: known path / need full contents / about to edit.`,
    librarian: `@librarian — external docs & web research. Delegate: changing APIs, version-specific behavior, official examples, tricky bugs. Don't: stable standard usage or facts already in context.`,
    oracle: `@oracle — architecture, risk, debugging strategy, review; an escalation, not a default verification step. Delegate: major long-term decisions, problems persisting after 2+ fix attempts, high-risk trade-offs, simplification. Don't: routine or time-sensitive calls.`,
    designer: `@designer — owns all UI/UX: layout, hierarchy, spacing, motion, responsive feel. Never do UI/design work yourself. Weak at copy: route copy fixes via @fixer (mechanical) or @designer (visual judgment) without altering visuals.`,
    fixer: `@fixer — bounded, well-defined implementation. Delegate: multi-file or mechanical changes, parallel per-area lanes. Don't: discovery/decisions, anything needing design judgment.`,
    council: `@council — multi-model consensus for high-stakes decisions. Send the full question plus context; preserve its structured report. Don't: routine work or single-specialist tasks; @council is never the only lane on a task.`,
    observer: `@observer — analyzes images/PDFs/diagrams, keeping media bytes out of your context. Always pass the full file path. Don't: plain-text files.`,
  });
