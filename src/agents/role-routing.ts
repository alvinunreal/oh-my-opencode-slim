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
 * One-line routing verdicts — the single routing source for the
 * orchestrator's <Agents> block and marketplace package blocks. The
 * agents' `description` fields (shown in the host's subagent list) stay
 * short and don't repeat these criteria.
 */
export const ROLE_ROUTING_SLIM_LINES: Readonly<Record<string, string>> =
  Object.freeze({
    explorer: `@explorer — read-only codebase recon (glob/grep/AST) and external docs/web research (context7, gh_grep). Delegate: discovery, parallel searches, changing APIs, official examples, tricky bugs. Don't: known path / need full contents / stable facts already in context / library trivia you already know.`,
    oracle: `@oracle — architecture, risk, debugging strategy, review; an escalation, not a default verification step. Delegate: major long-term decisions, problems persisting after 2+ fix attempts, high-risk trade-offs, simplification. Don't: routine or time-sensitive calls.`,
    designer: `@designer — owns all UI/UX: layout, hierarchy, spacing, motion, responsive feel. Never do UI/design work yourself. Weak at copy: review and fix user-facing copy afterward without altering visuals; purely mechanical follow-ups go to @fixer.`,
    fixer: `@fixer — bounded, well-defined implementation. Delegate: multi-file or mechanical changes, parallel per-area lanes. Don't: discovery/decisions, one small (<20-line) change, anything needing design judgment, docs/prose built from context you already hold.`,
    council: `@council — multi-model consensus for high-stakes decisions. Send the full question plus context; preserve its structured report. Don't: routine work or single-specialist tasks; @council is never the only lane on a task.`,
    observer: `@observer — analyzes images/PDFs/diagrams, keeping media bytes out of your context. Always pass the full file path. Don't: plain-text files.`,
  });

/** Routing lines for every agent not disabled or excluded, blank-line
 * separated. */
export function renderRoutingLines(
  disabledAgents?: ReadonlySet<string>,
  excludeDescriptions?: readonly string[],
): string {
  return Object.entries(ROLE_ROUTING_SLIM_LINES)
    .filter(([name]) => !disabledAgents?.has(name))
    .filter(([name]) => !excludeDescriptions?.includes(name))
    .map(([, line]) => line)
    .join('\n\n');
}

const AGENT_MENTION_RE = /@([a-z][a-z0-9_-]*)/gi;

function mentionsOutOfScope(line: string, names: ReadonlySet<string>): boolean {
  for (const match of line.matchAll(AGENT_MENTION_RE)) {
    if (!names.has(match[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * One routing line for a scoped primary: a built-in line is reused verbatim
 * while every @mention in it is in scope. Sentences naming an out-of-scope
 * agent would advertise a delegate the stance denies, so they are dropped;
 * a line left with nothing falls back to the generic description.
 * shortcut: sentence split on '. ' only; the lines are hand-written prose.
 */
function scopedRoutingLine(
  name: string,
  description: string | undefined,
  names: ReadonlySet<string>,
): string {
  const fallback = `@${name} — ${description ?? 'specialist'}`;
  const line = ROLE_ROUTING_SLIM_LINES[name];
  if (line === undefined || !mentionsOutOfScope(line, names)) {
    return line ?? fallback;
  }
  const kept = line
    .split('. ')
    .filter((sentence) => !mentionsOutOfScope(sentence, names))
    .join('. ');
  if (!kept) return fallback;
  return kept.endsWith('.') ? kept : `${kept}.`;
}

/**
 * `<Agents>` catalog for a declared primary (issue #1591): exactly its
 * scoped specialists, one routing line each. Built-in roles reuse the slim
 * lines; custom specialists fall back to their configured description.
 * shortcut: no display-name rewriting here — the caller runs
 * injectDisplayNames over the assembled prompt afterwards.
 */
export function renderScopedAgentsBlock(
  names: readonly string[],
  customDescriptions?: Readonly<Record<string, string | undefined>>,
  disabledAgents?: ReadonlySet<string>,
): string {
  const inScope = new Set(names.map((name) => name.toLowerCase()));
  const lines = names
    .filter((name) => !disabledAgents?.has(name))
    .map((name) =>
      scopedRoutingLine(name, customDescriptions?.[name], inScope),
    );
  if (lines.length === 0) return '';
  return `<Agents>\n${lines.join('\n\n')}\n</Agents>\n`;
}
