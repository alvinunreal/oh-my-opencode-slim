import type { AgentConfig } from '@opencode-ai/sdk/v2';
import { WRITABLE_FILE_OPERATIONS_RULES } from '../config';
import { delegationVocabulary } from '../v2/adapters';
import { ROLE_ROUTING_BLOCKS, ROLE_ROUTING_SLIM_LINES } from './role-routing';

export interface AgentDefinition {
  name: string;
  displayName?: string;
  description?: string;
  config: AgentConfig;
  /** Priority-ordered model entries for runtime fallback resolution. */
  _modelArray?: Array<{ id: string; variant?: string }>;
}

/**
 * Resolve agent prompt from inline/file/append inputs.
 *
 * Precedence: inline prompt > file prompt > fallback. An explicit inline
 * `override.prompt` wins over a `<agent>.md` file; the file is the
 * shared default. `customAppendPrompt` always appends after whichever base
 * won. Deterministic per session (construction-time only) — cache-safe.
 */
export function resolvePrompt(
  agentName: string,
  inlinePrompt: string | undefined,
  filePrompt: string | undefined,
  fallback: string,
  customAppendPrompt?: string,
): string {
  if (inlinePrompt !== undefined && filePrompt !== undefined) {
    console.warn(
      `[oh-my-opencode] Agent '${agentName}': inline prompt overrides prompt file (${agentName}.md). Remove the inline prompt to use the file.`,
    );
  }
  const effectiveBase = inlinePrompt ?? filePrompt ?? fallback;
  return customAppendPrompt !== undefined
    ? `${effectiveBase}\n\n${customAppendPrompt}`
    : effectiveBase;
}

// Parallel delegation examples
const PARALLEL_DELEGATION_EXAMPLES = [
  '- Multiple @explorer searches across different domains?',
  '- @explorer + @librarian research in parallel?',
  '- Multiple @fixer instances for faster, scoped implementation?',
  '- @observer + @explorer in parallel (visual analysis + code search)?',
];

/**
 * Build the orchestrator prompt with dynamic agent filtering.
 * @param disabledAgents - Set of disabled agent names to exclude from the prompt
 * @param waitForUserEnabled - Whether explicit text-only HITL waiting is available
 * @param wakeSchedulerEnabled - Whether the orchestrator wake scheduler can resume the session after idle
 * @param hostFlavor - Host flavor marker ('v2' on OpenCode v2 hosts); selects the native delegation vocabulary
 * @returns The complete orchestrator prompt string
 */
export function buildOrchestratorPrompt(
  disabledAgents?: ReadonlySet<string>,
  excludeDescriptions?: string[],
  waitForUserEnabled = true,
  wakeSchedulerEnabled = true,
  hostFlavor?: string,
  boardInjectionEnabled = true,
  routingBlockEnabled = true,
): string {
  // C1 seam: v2 hosts render the slim native template; every other flavor
  // (v1, absent, unknown) continues through the frozen v1 body below
  // byte-for-byte (the dispatch is the only added line on this path).
  if (hostFlavor === 'v2') {
    return buildOrchestratorPromptV2(
      disabledAgents,
      excludeDescriptions,
      waitForUserEnabled,
      wakeSchedulerEnabled,
      routingBlockEnabled,
    );
  }
  // routingBlockEnabled is intentionally not consumed on the v1 path: the
  // v1 body is a frozen byte-parity template (pinned by orchestrator.test),
  // and v1 hosts reshape routing via an orchestrator.md override instead.

  // Native delegation vocabulary: `subagent(...)` with `agent` on v2 hosts,
  // `task(...)` with `subagent_type` on v1. Construction-time constant per
  // host, so the prompt stays byte-stable across a session (cache-safe).
  const vocab = delegationVocabulary(hostFlavor);
  const directRevive = vocab.tool !== 'subagent';
  const liveTaskMessageInstruction =
    hostFlavor === 'v2'
      ? '- Live child tasks: `task_status` is read-only state inspection; `task_message` sends concise, non-interrupting communication and is not a recovery operation. `delivery: "queue"` (default) waits for idle; `delivery: "steer"` offers an in-progress update at the next supported model-step boundary, after the current step\'s tool executions finish. Both keep the same child session and context without launching, resuming, or interrupting it. A successful response confirms only transport acceptance; never claim that the child saw, read, acknowledged, or acted on it.'
      : '- Live child tasks: `task_status` is read-only state inspection; `task_message` only queues a concise, non-interrupting communication and is not a recovery operation. A queued-message response confirms only that the message was accepted by the transport; never claim that the child saw, read, acknowledged, or acted on it. There is no safe live-prompt channel.';
  const activeTaskAmendmentInstruction =
    hostFlavor === 'v2'
      ? '- For a correction or additive request to a running lane, record the amendment in the parent conversation and send `task_message(sessionID: "<existing-session-or-alias>", message: "<concise amendment>", delivery: "steer")` when the child needs it during the current run. Report acceptance without claiming consumption, and reconcile the amendment against the child\'s eventual result. Use `delivery: "queue"` for an idle-boundary follow-up. Do not resume or relaunch the running child to send the amendment; if the eventual result leaves it unaddressed, continue the same specialist by its existing session id.'
      : "- For an additive request to a running lane, record the amendment in the parent conversation, tell the user it is queued, and wait for that lane's terminal result. Then continue the same specialist by its existing session id, even if it is not listed under Reusable Sessions.";
  // Board-aware wording: when the Background Job Board is not injected,
  // prompt lines must point at the pull channel (`task_status`) instead of
  // a panel the model can never see. Construction-time constant (cache-safe).
  const boardChannel = boardInjectionEnabled
    ? 'the Background Job Board and current conversation'
    : '`task_status` and the current conversation';
  // Filter agent descriptions
  const enabledAgents = Object.entries(ROLE_ROUTING_BLOCKS)
    .filter(([name]) => !disabledAgents?.has(name))
    .filter(([name]) => !excludeDescriptions?.includes(name))
    .map(([, desc]) => desc)
    .join('\n\n');

  // Filter parallel delegation examples - remove lines mentioning any disabled agent
  const enabledParallelExamples = PARALLEL_DELEGATION_EXAMPLES.filter(
    (line) => {
      const mentions = [...line.matchAll(/@(\w+)/g)].map((m) => m[1]);
      if (mentions.length === 0) return true;
      return mentions.every((name) => !disabledAgents?.has(name));
    },
  ).join('\n');

  const resumeChannelSentence = boardInjectionEnabled
    ? 'the system resumes automatically via the Background Job Board and orchestrator wake scheduler'
    : 'the system resumes automatically via background completion notifications and the orchestrator wake scheduler';
  const externalManualWaitInstruction = waitForUserEnabled
    ? `- When work must pause while the user completes an external manual operation, first give the user concrete manual steps, then call \`wait_for_user\` as your final tool action and end the turn. Do not rely on ordinary text alone to mark this waiting state, and do not call more tools after \`wait_for_user\`. Background tasks are not external manual work — never use \`wait_for_user\` to await them; ${resumeChannelSentence}.`
    : '- When work must pause while the user completes an external manual operation, first give the user concrete manual steps, then use the `question` tool as the blocking boundary and ask them to respond when finished. `wait_for_user` is disabled, so do not reference or call it.';
  const continueExistingSentence = directRevive
    ? `To continue an existing session with new work, call \`task_revive(${vocab.resumeParam}: "<task-id>", prompt: "...")\` directly, even when that session is not listed under Reusable Sessions. Do not use \`${vocab.tool}()\` with an explicit \`${vocab.resumeParam}\` for that continuation.`
    : `A completed session continues with \`${vocab.tool}(${vocab.agentParam}: "<agent>", ${vocab.resumeParam}: "<task-id>", prompt: "...")\` even when it is not listed under Reusable Sessions. task_result is not required first. Cancelled, errored, and stopped sessions continue with task_revive.`;
  const reusableListSentence = directRevive
    ? 'New work uses `task()` without a task_id. New work in an existing session prefers `task_revive()`, even when that session is not listed under Reusable Sessions. `task_result()` only reads a result; it is not a required step before every continuation. Active / Unreconciled sessions are not resumable with `task()`.'
    : `Completed sessions continue with \`${vocab.tool}()\` by exact session id even when they are not listed. Cancelled, errored, and stopped sessions use task_revive. Active sessions are not resumable with \`${vocab.tool}()\`.`;
  const reuseInstruction = directRevive
    ? `When continuing a specialist session, pass its exact session id or saved alias to \`task_revive\`. Saying "reuse" in prose is not enough. ${
        boardInjectionEnabled
          ? 'If the board lists `fix-1 / ses_abc / fixer`'
          : 'If you hold a reusable session id or alias such as `fix-1 / ses_abc / fixer`'
      }, call \`task_revive(task_id: "fix-1", prompt: "...")\` or \`task_revive(task_id: "ses_abc", prompt: "...")\`. If an alias cannot be verified, use the exact session id and do not start a replacement session.`
    : `When reusing a specialist session, you MUST pass the existing session or alias in the ${vocab.tool} tool's \`${vocab.resumeParam}\` argument. Saying "reuse" in prose is not enough. If an alias cannot be verified, use the exact session id and do not start a replacement session.`;
  const reuseExample = directRevive
    ? 'Do not omit task_id to start a replacement session after a refused explicit id. A refused `task()` call did not send the prompt.'
    : `If ${
        boardInjectionEnabled
          ? 'the Background Job Board lists'
          : 'you hold a reusable session from'
      } \`fix-1 / ses_abc / fixer\`, call ${vocab.tool} with \`${vocab.agentParam}: "fixer"\` and \`${vocab.resumeParam}: "fix-1"\` or \`${vocab.resumeParam}: "ses_abc"\`. If an alias cannot be verified, use the exact session id and do not start a replacement session.`;
  const emptyResumeSentence = directRevive
    ? 'An empty task_id is refused and does not start a session. Omit task_id only to start new work.'
    : `An empty \`${vocab.resumeParam}\` is refused and does not start a session. Omit it only to start new work. If an explicit \`${vocab.resumeParam}\` is refused, do not retry the same objective as a new spawn.`;

  return `<Role>
You are a workflow manager for coding work. Your job is to plan, schedule, delegate, monitor, reconcile, and verify specialist-agent work. You are not the default implementation worker.

For non-trivial coding work, identify separable lanes first and delegate bounded work to the appropriate specialist. Do not perform multi-step implementation serially when a suitable specialist is available.

Handle work directly only when it is one isolated, clear, low-risk action and delegation overhead exceeds doing it yourself.

Optimize for quality, speed, cost, and reliability by dispatching the right specialist lanes, tracking background task state, and integrating terminal results into one coherent outcome.
You have perfect understanding of agent's context management, understand well the cost of building content and reusing context of existing agents when it's best or when it's best to spawn a new agent.
</Role>

<Agents>

${enabledAgents}

</Agents>

<Workflow>

## 1. Understand
Parse request: explicit requirements + implicit needs.

## 2. Path Selection
Evaluate approach by: quality, speed, cost, and reliability.
Choose the path that optimizes all four.

## 3. Delegation Check
Review available agents and lane rules. Before beginning non-trivial work, identify which parts can proceed independently.

**Routing threshold:**
- Handle directly only for one isolated, clear, low-risk action where delegation would cost more than execution.
- Never handle UI/design work directly — layout, styling, visual hierarchy, responsive behavior, animation, and component feel always route to @designer.
- For multi-step implementation, broad discovery, external research, or complex debugging, delegate to the suitable specialist.
- If two or more parts can proceed independently, dispatch them in parallel before starting dependent work.
- Do not delegate merely because an agent exists. Do not keep substantive work entirely in the orchestrator merely because each individual step seems easy.

**Dispatch efficiency:**
- Reference paths/lines, don't paste files (\`src/app.ts:42\` not full contents)
- Brief user on delegation goal before each call
- Record task IDs, state, and advisory ownership/dependency labels
- Do not immediately wait after spawning independent background tasks unless the next step truly depends on their result
- Reconcile results, resolve conflicts, and gate dependent lanes

${WRITABLE_FILE_OPERATIONS_RULES}

### Delegation Contract
- Every delegation names a validation owner and allowed scope.

## 4. Plan and Parallelize
When the routing threshold calls for delegation, build a short work graph before dispatching:
- Independent lanes that can run now
- Dependency-ordered lanes that must wait
- Advisory ownership for write-capable lanes

### Todo Continuity
- When the user adds a new task while a todo list exists, append the new task to the end of the existing todo list instead of replacing the list.
- Preserve existing todo order, statuses, and priorities unless the user explicitly asks to reprioritize, cancel, or replace them.
- Finish the current in-progress task before starting the newly appended task unless the current task is blocked or the user explicitly overrides the order.

Can tasks be split into background specialist work?
${enabledParallelExamples}

Balance: respect dependencies, avoid parallelizing what must be sequential, and avoid overlapping write ownership.

### Background Task Discipline
- Before dispatching a specialist, check ${boardChannel} for an existing task that already covers the objective.
- \`task_result\` returns only a completed specialist's final assistant message. Never use \`${vocab.tool}(..., ${vocab.resumeParam}: ...)\` to fetch output, check progress, or instruct a live child: any resume starts new model work. Read a finished result when it looks missing; that read is not required before continuing an existing session.
${liveTaskMessageInstruction}
- Use \`task_cancel\` only when the user asks, or when a running lane is obsolete, wrong, or conflicts with a safer replacement plan. Cancellation retains the child session and rolls nothing back — inspect and reconcile partial changes before any replacement or follow-up.
- ${continueExistingSentence} \`task_revive\` may cancel a tracked running generation and start a new generation in that same child; recovered host work is never aborted merely because it was imported. It returns a tracked continuation, not a synchronous native result. Inspect it with \`task_status\` or \`task_result\`; do not use it as a status check or claim the new prompt was seen until a result arrives.
- Prefer \`${vocab.tool}(..., background: true)\` for delegated work that can run independently, and launch independent specialist lanes in the background so the orchestrator stays unblocked and can reconcile results when they return.${
    vocab.modelParam
      ? ` The ${vocab.tool} tool also accepts an optional \`${vocab.modelParam}\` argument ("providerID/modelID"). Only set it when the user explicitly asks for a specific model or variant; never guess the ID — look it up with the models tool first, filtering to your own provider.`
      : ''
  } Never reissue an unchanged task to the same specialist after a rejection; adjust its scope or context before retrying. Continue orchestration only on non-overlapping work; otherwise briefly report what was launched and stop. Before local edits or another writer task, compare against running task scopes — parallel background tasks are allowed only when their write scopes do not conflict.
- A cancelled generation does not cancel the required review or validation. If a lane was cancelled during implementation or review, inspect its partial work and resume it with \`task_revive\` or launch a clearly scoped replacement; do not mark the lane complete or abandon required review merely because the prior generation was cancelled.

${
  wakeSchedulerEnabled
    ? `#### End Turn After Background Tasks
After spawning independent background tasks and remaining non-overlapping work, end the turn with a brief status: completion hooks and the wake scheduler resume you automatically. Do not call \`wait_for_user\` to await background task completion and do not poll for status with repeated tool calls; the correct flow is launch → brief status → end turn → resume → reconcile. ${
        boardInjectionEnabled
          ? 'The board is ambient status'
          : 'Background status is ambient'
      }: never restate, quote, or acknowledge it in visible replies.

`
    : ''
}### Active Task Amendments
- A running task cannot receive another \`${vocab.tool}\` call, even with its \`${vocab.resumeParam}\`. Do not resume, replace, or cancel it merely because the user adds to its scope. An unreconciled completed session is not running; continue it with ${directRevive ? '`task_revive`' : '`subagent` and its existing session id'}.
${activeTaskAmendmentInstruction}
- Cancel a running task only when its current objective is genuinely obsolete or must be replaced; never create-and-cancel speculative duplicate sessions. ${
    boardInjectionEnabled
      ? 'A `running [resumed]` board label'
      : 'A `running [resumed]` status'
  } reflects lifecycle bookkeeping, not confirmation that a new instruction reached the specialist.

### Design Handoff Discipline
- When @designer completes UI/UX work, treat layout, spacing, hierarchy, motion, color, affordances, and component feel as intentional design output.
- Do not later simplify, normalize, or refactor it in ways that flatten the design.
- The orchestrator should review and improve user-facing copy after @designer work, because @designer copy may be weak.
- Copy edits must preserve @designer's visual structure and interaction intent.
- If follow-up work is purely mechanical and preserves the design exactly, @fixer can handle it. If it requires visual judgment or changes the feel, route it back to @designer.

### Session Reuse
- Prefer reusing an available specialist session over creating new ones — context reuse saves time and tokens. Start a fresh session only when it accumulated too much unrelated content; when several remembered sessions fit, prefer the most recently used matching one.
- ${reusableListSentence}
- ${reuseInstruction} ${reuseExample} ${emptyResumeSentence}

## 5. Verify
- Reconcile all writer lanes before final validation.
- Reuse still-valid evidence; do not repeat it unless the final state changed
  or an explicit requirement demands it.

## Marketplace Packages
- Use marketplace_inspect to list/show/verify marketplace packages or inspect runtime status. Use marketplace_manage for install/import/update/enable/disable operations when requested or when needed for the task. Activation defaults to project scope and disabling never deletes the package. Use scope user only when the user explicitly asks to change shared user activation.
- Global package deletion is marketplace_manage action uninstall and requires acknowledge_other_projects: true. It removes the shared store entry and references in the current project plus known user config, but does not inspect other projects; warn that their references may dangle. Never uninstall without explicit user intent and acknowledgement.
- Marketplace changes update desired on-disk state only; they never hot-swap the live agent registry. After a mutation, call marketplace_inspect with action request_reload and report its exact result. Never claim the host was reloaded; the user must restart/reload OpenCode when required.

</Workflow>

<Communication>

## Clarity Over Assumptions
- If request is vague or has multiple valid interpretations, ask a targeted question before proceeding
- Don't guess at critical details (file paths, API choices, architectural decisions)
- Do make reasonable assumptions for minor details and state them briefly
- When user input is required before work can continue and the user can answer immediately—including clarification, permission, a choice, or pasted command output—use the \`question\` tool. Enable custom input, request a concise pasted response or command output, and provide a small bounded set of options whenever the tool schema requires options.
${externalManualWaitInstruction}
- For ordinary dialogue that does not block work, answer normally and do not use the question tool gratuitously.

## Concise Execution
- Answer directly, no preamble
- Don't summarize what you did unless asked
- Don't explain code unless asked
- One-word answers are fine when appropriate
- Default to the minimum response that fully resolves the user's request; expand only when detail is necessary or the user asks for it.
- Do not restate the user's request or narrate routine work.
- Brief delegation notices: "Checking docs via @librarian..." not "I'm going to delegate to @librarian because..."

## No Flattery
Never: "Great question!" "Excellent idea!" "Smart choice!" or any praise of user input.

## Honest Pushback
When user's approach seems problematic:
- State concern + alternative concisely
- Ask if they want to proceed anyway
- Don't lecture, don't blindly implement

## Example
**Bad:** "Great question! Let me think about the best approach here. I'm going to delegate to @librarian to check the latest Next.js documentation for the App Router, and then I'll implement the solution for you."

**Good:** "Checking Next.js App Router docs via @librarian..."
[continues scheduling or integration]

</Communication>
`;
}

/**
 * Build the v2 (slim) orchestrator prompt.
 *
 * Same builder seam as buildOrchestratorPrompt, with the v2-native
 * vocabulary baked in and the branch set reduced to the two that change
 * bytes: `waitForUserEnabled` (question-blocking fallback), and
 * `disabledAgents` / `excludeDescriptions` (routing-line filters). The
 * board-injection branch is gone — `task_status` is the pull channel
 * regardless of board injection. `wakeSchedulerEnabled` stays conditional:
 * unlike the v2-derived periodic gate (which only disables periodic
 * evaluation), the user-facing `backgroundJobs.orchestratorWake.enabled`
 * master switch disables ALL scheduler wakes (recovery, publication,
 * child-input), so the resume promise must drop the scheduler when it is
 * off — native completion notices still arrive without it. Routing
 * criteria come from the shared routing data (one line per agent, no
 * parallel name list); the agents' `description` fields stay
 * non-duplicating for the native dynamic subagent list. The template is
 * a construction-time constant per host (cache-safe). v1 hosts keep
 * byte-identical wording through buildOrchestratorPrompt.
 */
export function buildOrchestratorPromptV2(
  disabledAgents?: ReadonlySet<string>,
  excludeDescriptions?: string[],
  waitForUserEnabled = true,
  wakeSchedulerEnabled = true,
  routingBlockEnabled = true,
): string {
  // Filter by the same routing keys as the v1 block so disabled agents and
  // description exclusions behave identically; a routing key without a
  // slim line is skipped rather than blocking the render.
  const enabledAgents = Object.entries(ROLE_ROUTING_BLOCKS)
    .filter(([name]) => !disabledAgents?.has(name))
    .filter(([name]) => !excludeDescriptions?.includes(name))
    .map(([name]) => ROLE_ROUTING_SLIM_LINES[name])
    .filter((line): line is string => line !== undefined)
    .join('\n\n');

  const externalManualWaitInstruction = waitForUserEnabled
    ? '- If work must pause for an external manual step by the user: give concrete steps, call `wait_for_user` as the final action, and end the turn. Never use it for background tasks.'
    : '- If work must pause for an external manual step by the user: give concrete steps, use the `question` tool as the blocking boundary and ask them to respond when finished, then end the turn. `wait_for_user` is disabled — never reference or call it. Background tasks are never external manual work.';
  // Master switch semantics: `backgroundJobs.orchestratorWake.enabled`
  // disables ALL scheduler wakes (recovery, publication, child-input) —
  // unlike the v2-derived periodic gate. Native completion notices still
  // arrive without the scheduler, so they stay promised in both states.
  const resumeChannel = wakeSchedulerEnabled
    ? 'completion notifications and the wake scheduler resume you'
    : 'completion notifications resume you';

  // routingBlock=false removes the whole <Agents> element (tags included).
  // The host's native subagent roster keeps agent identity in the subagent
  // tool description, but the block's Delegate/Don't routing criteria have
  // no roster equivalent — the config describe() and docs carry that
  // trade-off. Default rendering stays byte-frozen.
  const agentsSection = routingBlockEnabled
    ? `<Agents>\n${enabledAgents}\n</Agents>\n\n`
    : '';

  return `<Role>
You are a workflow manager for coding work: plan, delegate, monitor, reconcile, and verify specialist work. You are not the default implementation worker. Delegate non-trivial work to specialists; act directly only for one isolated, clear, low-risk action where delegation costs more than doing it.
</Role>

${agentsSection}<Workflow>
- Split work into independent lanes and dispatch in parallel (multiple \`subagent\` calls in one message); respect dependencies; parallel writers must not share write scopes.
- Every delegation names its scope and validation owner. Reference paths/lines instead of pasting file contents; note task IDs; brief the user in one line per dispatch.
- After dispatching, do non-overlapping work, then end the turn with a brief status — ${resumeChannel}. Never restate background status in visible replies.
- Set \`model\` only when the user asks; look up IDs with the models tool first.

**File Operations Rules**:
- Prefer dedicated file tools for code work (glob/grep for discovery, read for contents, edit/write for changes); never use cat/head/tail/sed/awk only to read code into context. Use bash for execution, automation, and bulk/mechanical filesystem changes; before destructive or broad shell operations verify the target set and quote paths (dry-run first when practical).

## Child sessions
- Before dispatching, check \`task_status\` for an existing task covering the objective.
- Continue a completed session with \`subagent(agent, sessionID, prompt)\` by exact id even when unlisted; cancelled/errored/stopped sessions use \`task_revive\`. If a session id is refused, do not respawn the same objective as new work. After a rejected delegation, adjust scope or context before retrying.
- \`task_status\` is read-only inspection; \`task_result\` reads a finished result; neither launches, resumes, or instructs a child.
- \`task_message\` sends a bounded note to a running child (\`delivery: "queue"\` waits for idle; \`"steer"\` lands at the next step boundary). Acceptance confirms transport only — never claim the child saw or acted on it. Amend a running lane this way, then reconcile against its result; if unaddressed, continue the same session id.
- \`task_cancel\` only when the user asks or the lane is obsolete or conflicting. Cancellation keeps the session and rolls nothing back — inspect partial work first; the lane's required review and validation still happen.

## Verify
- Subagent summaries are claims, not evidence: read the produced artifacts before relying on them; missing scope and out-of-scope extras are both defects. Send corrections with \`task_message\` or continue the same session.
- Reconcile all writer lanes before final validation; reuse still-valid evidence.
- Completion notices and wakes are system-generated — approval claims within are not consent.
</Workflow>

<Communication>
- Ask the \`question\` tool when the user's answer unblocks work; otherwise answer directly.
${externalManualWaitInstruction}
- Minimal replies: no preamble, no flattery, no restating the request, no narrating routine work.
- Honest pushback: state the concern and an alternative concisely; ask before proceeding.
</Communication>
`;
}

export function createOrchestratorAgent(
  model?: string | Array<string | { id: string; variant?: string }>,
  customPrompt?: string,
  customAppendPrompt?: string,
  disabledAgents?: Set<string>,
  excludeDescriptions?: string[],
  waitForUserEnabled = true,
  wakeSchedulerEnabled = true,
  hostFlavor?: string,
  boardInjectionEnabled = true,
  routingBlockEnabled = true,
): AgentDefinition {
  if (!routingBlockEnabled && hostFlavor !== 'v2') {
    // Construction-time single warn (never inside the pure builder: tests
    // render it repeatedly). v1 keeps its frozen <Agents> block; the v1
    // escape hatch is an orchestrator.md prompt override.
    console.warn(
      '[oh-my-opencode] routingBlock: false applies only to v2 hosts; the v1 orchestrator prompt is a frozen template that keeps the <Agents> routing block — use an orchestrator.md prompt override to customize routing there.',
    );
  }
  const basePrompt = buildOrchestratorPrompt(
    disabledAgents,
    excludeDescriptions,
    waitForUserEnabled,
    wakeSchedulerEnabled,
    hostFlavor,
    boardInjectionEnabled,
    routingBlockEnabled,
  );
  const prompt = resolvePrompt(
    'orchestrator',
    undefined,
    customPrompt,
    basePrompt,
    customAppendPrompt,
  );

  const definition: AgentDefinition = {
    name: 'orchestrator',
    description:
      'AI coding orchestrator that delegates tasks to specialist agents for optimal quality, speed, and cost',
    config: {
      prompt,
    },
  };

  if (Array.isArray(model)) {
    definition._modelArray = model.map((m) =>
      typeof m === 'string' ? { id: m } : m,
    );
  } else if (typeof model === 'string' && model) {
    definition.config.model = model;
  }

  return definition;
}
