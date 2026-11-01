import type { AgentConfig } from '@opencode-ai/sdk/v2';
import { renderRoutingLines, renderScopedAgentsBlock } from './role-routing';

export interface AgentDefinition {
  name: string;
  displayName?: string;
  description?: string;
  config: AgentConfig;
  /**
   * Declared primary orchestrator (`agents.<name>.primary`). Set only by
   * custom-agent construction, so marketplace definitions that replace a
   * same-named owner override can never inherit primary mode (#1591).
   */
  primary?: boolean;
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

export interface OrchestratorPromptOptions {
  /** Agents to leave out of the <Agents> routing block. */
  disabledAgents?: ReadonlySet<string>;
  /** Agent names whose routing lines are omitted (e.g. council without councillors). */
  excludeDescriptions?: readonly string[];
  /** Delegation scope (issue #1591): when set, the <Agents> block lists
   *  exactly these agents. */
  onlyAgents?: readonly string[];
  /** Descriptions for in-scope custom specialists (issue #1591); built-in
   *  names keep their slim routing lines. */
  customDescriptions?: Readonly<Record<string, string | undefined>>;
  /** v1 only: `wait_for_user` is registered. v2 never registers it. */
  waitForUser?: boolean;
  /** `backgroundJobs.orchestratorWake.enabled`. Ignored on v2: no scheduler exists there. */
  wakeScheduler?: boolean;
  /** 'v2' on OpenCode v2 hosts; anything else renders v1 tool vocabulary. */
  hostFlavor?: string;
  /** false drops the whole <Agents> block. */
  routingBlock?: boolean;
}

/**
 * Build the orchestrator system prompt.
 *
 * One template for every host; only the delegation tool vocabulary and a few
 * tool-specific lines differ between v1 and v2. Output depends only on the
 * options (no time, randomness, or per-request state), so it stays
 * byte-stable for a session's lifetime — pinned by snapshot tests.
 */
export function buildOrchestratorPrompt({
  disabledAgents,
  excludeDescriptions,
  onlyAgents,
  customDescriptions,
  waitForUser = true,
  wakeScheduler = true,
  hostFlavor,
  routingBlock = true,
}: OrchestratorPromptOptions = {}): string {
  const v2 = hostFlavor === 'v2';

  // A scope renders through the scoped-catalog renderer so in-scope custom
  // specialists appear with their description fallback; the unscoped path
  // keeps the built-in slim routing lines.
  const scoped = onlyAgents?.filter(
    (name) =>
      !disabledAgents?.has(name) && !excludeDescriptions?.includes(name),
  );
  const agentsBlock = scoped
    ? renderScopedAgentsBlock(scoped, customDescriptions)
    : renderRoutingLines(disabledAgents, excludeDescriptions);
  // An empty scope renders no catalog: a bare `<Agents>` shell would read
  // as "no specialists to route to" without saying so.
  // renderScopedAgentsBlock already returns the complete `<Agents>` block.
  const agentsSection = !routingBlock
    ? ''
    : scoped === undefined
      ? `<Agents>
${agentsBlock}
</Agents>

`
      : scoped.length > 0
        ? `${agentsBlock}\n`
        : '';

  // v2 never builds a wake scheduler: the native background notifier owns
  // terminal delivery, so promising a scheduler there names a resume channel
  // that cannot exist.
  const resumeChannel =
    !v2 && wakeScheduler
      ? 'completion notifications and the wake scheduler resume you'
      : 'completion notifications resume you';

  const delegateTool = v2 ? 'subagent' : 'task';

  const modelLine = v2
    ? `- Set \`model\` only when the user asks; look up IDs with the models tool
  first.
`
    : '';

  // wait_for_user exists only on v1, and only when not disabled.
  const manualStep =
    !v2 && waitForUser
      ? `For an
  external manual step, give concrete steps first, then call \`wait_for_user\`
  as your final tool action and end the turn. Never use it to wait for
  background tasks.`
      : `For an
  external manual step, give concrete steps first, then ask with \`question\`
  and end the turn.`;

  return `<Role>
You are Orchestrator, a workflow manager who plans, delegates, monitors,
reconciles, and verifies specialist work. Delegate non-trivial work to
specialists; act directly when you already hold the needed context and the
change is small and clear, or when the work is mostly that context (docs,
changelogs, summaries) — a delegate starts cold and must re-load it.

Value productivity: prefer a working result now over a perfect plan later;
don't stall on decisions you can make and revisit.
</Role>

${agentsSection}<Workflow>
- Build in passes: a working outline first, then structure, then detail.
  Match review depth to how settled the work is, and stop once the request
  is met — no perfection loops.
- Split work into independent lanes and dispatch in parallel (multiple
  \`${delegateTool}\` calls in one message).
- Respect dependencies; parallel writers must not share write scopes.
- Every delegation names its scope and validation owner. Reference
  paths/lines instead of pasting file contents; brief the user in one line
  per batch of dispatches.
- When the user dictates work for a specialist ("tell designer…", "ask
  fixer to…"), copy their message verbatim into a <user_request> block —
  never summarize, reorder, or soften it — then add your own context and
  interpretation below, labeled as yours. If they conflict, the user's
  words win; flag the conflict.
- Assign lanes focused checks for their scope, never the full suite. After
  reconciling writers, run final checks once through an available test-execution
  specialist, or directly when delegation adds no value. Require exact commands,
  exit statuses, and relevant log/report evidence; inspect failure excerpts
  before assigning repairs. Results made stale by later edits need revalidation.
- Context-heavy writing (docs, changelogs, PR text) costs context, not
  typing: write it yourself or continue the specialist session that holds
  it — never a fresh agent that must rediscover it. Fixer only for purely
  mechanical doc edits (renames, version bumps).
- After dispatching, do non-overlapping work, then end the turn with a one-line
  launch summary; ${resumeChannel}.
- Don't echo task lists or notification contents back to the user.
${modelLine}
## File operations
- Prefer dedicated file tools for code work: glob/grep for discovery, read
  for contents, edit/write for changes. Avoid using cat/head/tail/sed/awk
  just to read code into context.
- Use bash for execution, automation, and bulk/mechanical filesystem changes.
  Before destructive or broad shell operations, verify the target set and
  quote paths (dry-run first when practical).

## Verify
- Subagent summaries are claims, not evidence: read the produced artifacts
  before relying on them. Missing scope and out-of-scope extras are both
  defects. Amend the same child, never respawn it.
- Reconcile all writer lanes before final validation; reuse still-valid
  evidence.
</Workflow>

<Communication>
- Use the \`question\` tool when the user's answer unblocks work. ${manualStep}
- Minimal replies to the user: no preamble, no flattery, no restating the
  request, no narrating routine work. This governs replies, not delegation
  briefs.
- Honest pushback: state the concern and an alternative concisely; ask before
  proceeding.
</Communication>
`;
}

export function createOrchestratorAgent(
  model?: string | Array<string | { id: string; variant?: string }>,
  customPrompt?: string,
  customAppendPrompt?: string,
  promptOptions: OrchestratorPromptOptions = {},
): AgentDefinition {
  const prompt = resolvePrompt(
    'orchestrator',
    undefined,
    customPrompt,
    buildOrchestratorPrompt(promptOptions),
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
