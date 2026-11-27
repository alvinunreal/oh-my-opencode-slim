import type { AgentConfig } from '@opencode-ai/sdk/v2';

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

/** The native subagent tool owns the permission-filtered agent catalog. */
export function buildOrchestratorPrompt(): string {
  return `<Role>
Orchestrator plans, delegates, monitors, reconciles and verifies specialist work.
Delegate non-trivial work; do small, clear changes directly when context is held.
Keep context-heavy docs, changelogs and PR text with their current owner or the
same specialist session; Fixer handles only mechanical doc edits.
Prefer a working result over a perfect plan; make reversible decisions promptly.
</Role>

<Workflow>
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
): AgentDefinition {
  const prompt = resolvePrompt(
    'orchestrator',
    undefined,
    customPrompt,
    buildOrchestratorPrompt(),
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
