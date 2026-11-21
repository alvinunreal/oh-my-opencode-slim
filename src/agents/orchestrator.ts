import type { AgentConfig } from '@opencode-ai/sdk/v2';
import {
  AGENT_SKILLS_NOTE,
  type AgentSkillGrants,
  renderRoutingLines,
  renderScopedAgentsBlock,
} from './role-routing';

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
  /** Per-agent skill grant summaries; when set, each routing line names the
   *  skills that agent can load and the block closes with a short note. */
  agentSkills?: AgentSkillGrants;
  /** Host flavor supplied by agent configuration. */
  hostFlavor?: string;
  /** false drops the whole <Agents> block. */
  routingBlock?: boolean;
}

/**
 * Build the orchestrator system prompt.
 *
 * Output depends only on the options (no time, randomness, or
 * per-request state), so it stays byte-stable for a session's lifetime —
 * pinned by snapshot tests.
 */
export function buildOrchestratorPrompt({
  disabledAgents,
  excludeDescriptions,
  onlyAgents,
  customDescriptions,
  agentSkills,
  routingBlock = true,
}: OrchestratorPromptOptions = {}): string {
  // A scope renders through the scoped-catalog renderer so in-scope custom
  // specialists appear with their description fallback; the unscoped path
  // keeps the built-in slim routing lines.
  const scoped = onlyAgents?.filter(
    (name) =>
      !disabledAgents?.has(name) && !excludeDescriptions?.includes(name),
  );
  const agentsBlock = scoped
    ? renderScopedAgentsBlock(
        scoped,
        customDescriptions,
        undefined,
        agentSkills,
      )
    : renderRoutingLines(disabledAgents, excludeDescriptions, agentSkills);
  // An empty scope renders no catalog: a bare `<Agents>` shell would read
  // as "no specialists to route to" without saying so.
  // renderScopedAgentsBlock already returns the complete `<Agents>` block.
  const agentsSection = !routingBlock
    ? ''
    : scoped === undefined
      ? `<Agents>
${agentsBlock}${agentSkills ? `\n\n${AGENT_SKILLS_NOTE}` : ''}
</Agents>

`
      : scoped.length > 0
        ? `${agentsBlock}\n`
        : '';

  // Tool descriptions own dispatch, continuation and completion mechanics.
  return `<Role>
Orchestrator plans, delegates, monitors, reconciles and verifies specialist work.
Delegate non-trivial work; do small, clear changes directly when context is held.
Keep context-heavy docs, changelogs and PR text with their current owner or the
same specialist session; Fixer handles only mechanical doc edits.
Prefer a working result over a perfect plan; make reversible decisions promptly.
</Role>

${agentsSection}<Workflow>
- Build in passes: outline → structure → detail. Review proportionately to risk
  and maturity; stop when the request is met.
- Respect dependencies; dispatch independent lanes in parallel with disjoint
  write scopes. Brief the user in one line per batch.
- Every delegation names scope and validation owner; reference paths/lines,
  not pasted file contents.
- User-directed specialist requests go verbatim in <user_request>: no
  summarizing, reordering or softening. Add caller context/interpretation
  separately, labeled; the user's words win and conflicts must be flagged.
- Lanes run focused checks, never the full suite. Reconcile every writer before
  final checks, once at the settled state through a test-execution specialist
  when useful, otherwise directly. Require exact commands, exit statuses and
  log/report evidence; inspect failures before repairs. Reuse valid evidence;
  revalidate after edits.
- Summaries are claims, not evidence: inspect artifacts for missing scope or
  extra changes. Repair through the same child, never a fresh lane.
</Workflow>

<Communication>
- Ask when the answer unblocks work. For an external manual step, give concrete
  instructions, then ask and end the turn.
- Minimal user replies: no preamble, flattery, restatement, routine narration,
  task-list echoes or notification recaps. Delegation briefs are exempt.
- Before a concerning course, state the concern and alternative concisely,
  then ask.
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
