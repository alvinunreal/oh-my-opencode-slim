import type { KnownIssue, PassDef, RunDef, Status, WorkNode } from './types';

export function statusOf(node: WorkNode, t: number): Status {
  if (t < node.visibleAt) return 'hidden';
  if (t < node.startAt) return 'upcoming';
  if (t < node.endAt) return 'running';
  if (node.verdict?.outcome === 'blockers') return 'blocked';
  return 'done';
}

export function activePass(run: RunDef, t: number): PassDef {
  let current = run.passes[0];
  for (const pass of run.passes) if (pass.startAt <= t) current = pass;
  return current;
}

export type PassPhase = 'done' | 'active' | 'planned';

export function passPhase(run: RunDef, pass: PassDef, t: number): PassPhase {
  const active = activePass(run, t);
  if (pass.id === active.id) return 'active';
  return pass.index < active.index ? 'done' : 'planned';
}

export function passProgress(run: RunDef, pass: PassDef, t: number): number {
  const nodes = run.nodes.filter((n) => n.passId === pass.id);
  if (t < pass.startAt) return 0;
  if (pass.endAt !== undefined && t >= pass.endAt) return 1;
  if (pass.endAt === undefined) {
    // Open-ended pass: share of its known work that has finished, with
    // partial credit for running nodes.
    const score = nodes.reduce((acc, n) => {
      if (t >= n.endAt) return acc + 1;
      if (t >= n.startAt) return acc + (t - n.startAt) / (n.endAt - n.startAt);
      return acc;
    }, 0);
    return nodes.length ? score / nodes.length : 0;
  }
  return Math.min(
    1,
    Math.max(0, (t - pass.startAt) / (pass.endAt - pass.startAt)),
  );
}

export function openIssues(run: RunDef, t: number): KnownIssue[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return run.issues
    .filter((i) => i.addedAt <= t && (i.resolvedAt ?? Infinity) > t)
    .sort((a, b) => rank[a.sev] - rank[b.sev] || b.addedAt - a.addedAt);
}

export function progressAt(run: RunDef, t: number) {
  let latest = run.progress[0];
  let decision: string | undefined;
  for (const entry of run.progress) {
    if (entry.at > t) break;
    latest = entry;
    if (entry.decision) decision = entry.decision;
  }
  return { ...latest, decision };
}

export function stepsDone(node: WorkNode, t: number): number {
  return node.steps?.filter((s) => s.at <= t).length ?? 0;
}

export function currentStep(node: WorkNode, t: number): string | undefined {
  return node.steps?.find((s) => s.at > t)?.label;
}

export type TimelineKind = 'start' | 'end' | 'verdict' | 'replan' | 'commit';

export interface TimelineEvent {
  at: number;
  kind: TimelineKind;
  nodeId?: string;
  agent: WorkNode['agent'];
  label: string;
}

export function timelineEvents(run: RunDef): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const planEnd = new Map<string, number>();
  for (const n of run.nodes)
    if (n.kind === 'step' && n.id.endsWith('-plan'))
      planEnd.set(n.passId, n.endAt);

  for (const n of run.nodes) {
    const who = n.alias ?? n.title;
    if (n.startAt <= run.endAt)
      events.push({
        at: n.startAt,
        kind: 'start',
        nodeId: n.id,
        agent: n.agent,
        label: `${who} started · ${n.title}`,
      });
    if (n.verdict) {
      events.push({
        at: n.verdict.at,
        kind: 'verdict',
        nodeId: n.id,
        agent: n.agent,
        label: `${n.title}: ${verdictLabel(n.verdict.outcome)}`,
      });
    } else if (n.endAt <= run.endAt) {
      events.push({
        at: n.endAt,
        kind: 'end',
        nodeId: n.id,
        agent: n.agent,
        label: `${who} finished`,
      });
    }
    const pe = planEnd.get(n.passId);
    if (pe !== undefined && n.visibleAt > pe && n.kind === 'lane')
      events.push({
        at: n.visibleAt,
        kind: 'replan',
        nodeId: n.id,
        agent: 'orchestrator',
        label: `Plan changed · ${n.alias} added`,
      });
  }
  for (const p of run.passes)
    if (p.commit)
      events.push({
        at: p.commit.at,
        kind: 'commit',
        agent: 'orchestrator',
        label: `Pass ${p.index} committed · ${p.commit.sha}`,
      });
  return events.sort((a, b) => a.at - b.at);
}

export function verdictLabel(outcome: 'approved' | 'changes' | 'blockers') {
  return outcome === 'approved'
    ? 'Approved'
    : outcome === 'changes'
      ? 'Approved with changes'
      : 'Blockers';
}

export function clock(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  return h > 0 ? `${h}h ${mm}m` : `${m % 60}m`;
}
