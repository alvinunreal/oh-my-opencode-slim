// The explorer renders a RunDef sampled at time `t` (minutes since the run
// started). In the live plugin the RunDef is derived from host session events,
// the background job board and progress.md; here it comes from a mock run.

export type AgentId =
  | 'orchestrator'
  | 'oracle'
  | 'fixer'
  | 'designer'
  | 'explorer'
  | 'observer'
  | 'council';

export type NodeKind = 'step' | 'lane' | 'review' | 'gate';

export type Status = 'hidden' | 'upcoming' | 'running' | 'done' | 'blocked';

export interface Activity {
  at: number;
  kind: 'read' | 'edit' | 'bash' | 'note' | 'msg';
  text: string;
  exit?: number;
}

export interface Finding {
  sev: 'blocker' | 'change' | 'later' | 'nit';
  title: string;
  detail: string;
  ref?: string;
}

export interface Verdict {
  at: number;
  outcome: 'approved' | 'changes' | 'blockers';
  summary: string;
  findings: Finding[];
}

export interface WorkNode {
  id: string;
  passId: string;
  kind: NodeKind;
  agent: AgentId;
  alias?: string;
  title: string;
  subtitle?: string;
  /** When the node first appears on the map (as upcoming). */
  visibleAt: number;
  startAt: number;
  endAt: number;
  after: string[];
  model?: string;
  steps?: { label: string; at: number }[];
  activity?: Activity[];
  scope?: string[];
  interfaces?: string[];
  acceptance?: string;
  report?: {
    changed: string[];
    commands: { cmd: string; exit: number; note?: string }[];
    unverified: string[];
  };
  attempt?: { n: number; max: number };
  verdict?: Verdict;
}

export interface PassDef {
  id: string;
  index: number;
  name: 'Sketch' | 'Structure' | 'Detail';
  goal: string;
  /** When the goal was written (at the previous pass's step back). */
  goalAt: number;
  startAt: number;
  endAt?: number;
  commit?: { sha: string; at: number; message: string };
  plannedLanes?: { agent: AgentId; title: string }[];
}

export interface KnownIssue {
  id: string;
  title: string;
  sev: 'high' | 'medium' | 'low';
  addedAt: number;
  resolvedAt?: number;
  deferredTo?: string;
  source: string;
}

export interface RunDef {
  task: string;
  slug: string;
  sessionId: string;
  branch: string;
  endAt: number;
  passes: PassDef[];
  nodes: WorkNode[];
  issues: KnownIssue[];
  /** progress.md "next step" rewrites, newest wins. */
  progress: { at: number; next: string; decision?: string }[];
}
