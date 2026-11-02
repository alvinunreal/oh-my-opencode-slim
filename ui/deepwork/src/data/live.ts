import type {
  AgentId,
  KnownIssue,
  NodeKind,
  PassDef,
  RunDef,
  Verdict,
  WorkNode,
} from './types';

/** Mirror of the plugin's ExplorerSnapshot (src/deepwork-explorer/snapshot.ts). */
export interface ExplorerSnapshot {
  version: 1;
  sessionID: string;
  slug?: string;
  status: 'active' | 'completed' | 'unknown';
  now: number;
  startedAt: number;
  progress: {
    pass?: number;
    goal?: string;
    next?: string;
    decision?: string;
    issues: string[];
  };
  passStarts: { pass: number; at: number }[];
  jobs: {
    id: string;
    alias: string;
    agent: string;
    description: string;
    state: 'running' | 'completed' | 'error' | 'cancelled' | 'stopped';
    startedAt: number;
    endedAt?: number;
    result?: string;
  }[];
}

/** Far future: "not yet" for nodes and passes the run has not reached. */
export const NEVER = 1e9;

const KNOWN: AgentId[] = [
  'orchestrator',
  'oracle',
  'fixer',
  'designer',
  'explorer',
  'observer',
  'council',
];

function agentOf(name: string): AgentId {
  if ((KNOWN as string[]).includes(name)) return name as AgentId;
  if (name === 'librarian') return 'explorer';
  return 'fixer';
}

const PASS_NAME = (n: number): PassDef['name'] =>
  n === 1 ? 'Sketch' : n === 2 ? 'Structure' : 'Detail';

/** Session id from a `/s/<id>` page path, when served by the plugin. */
export function liveSessionId(): string | undefined {
  try {
    const match = window.location.pathname.match(/^\/s\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Oracle outcome from its answer text. Negated phrases ("no blockers",
 * "not approved") are removed first so they cannot flip the reading. */
export function outcomeOf(text: string): Verdict['outcome'] {
  const body = text
    .replace(
      /\b(?:no|zero|0|without|none of the)\s+(?:\w+\s+){0,2}block(?:er|ers|ing)\b/gi,
      '',
    )
    .replace(/\bnot\s+(?:yet\s+)?approv\w*/gi, ' blocker ');
  if (/\bblock(?:er|ers|ing)\b/i.test(body)) return 'blockers';
  if (
    /\b(?:changes requested|request(?:ed|s)? changes|with changes|needs? changes)\b/i.test(
      body,
    )
  )
    return 'changes';
  if (/\b(?:approv\w*|lgtm|pass(?:es|ed)?)\b/i.test(body)) return 'approved';
  return 'changes';
}

function verdictFrom(text: string | undefined, at: number): Verdict {
  const body = (text ?? '').trim();
  const outcome = outcomeOf(body);
  const firstParagraph =
    body
      .split(/\n\s*\n/)
      .map((p) => p.replace(/[#*_`>]/g, '').trim())
      .find((p) => p.length > 0) ?? 'Review finished.';
  return {
    at,
    outcome,
    summary:
      firstParagraph.length > 260
        ? `${firstParagraph.slice(0, 260)}…`
        : firstParagraph,
    findings: [],
  };
}

/**
 * Project a live snapshot onto the explorer's RunDef. Times become minutes
 * since the run started. Jobs fall into passes by when each pass was first
 * seen in progress.md; inside a pass, jobs that overlap in time run in the
 * same wave and each wave follows the previous one.
 */
export function fromSnapshot(s: ExplorerSnapshot): RunDef {
  const min = (ms: number) => Math.max(0, (ms - s.startedAt) / 60000);
  const head = min(s.now);
  const current = Math.max(1, s.progress.pass ?? 1);
  const done = s.status === 'completed';

  const seen = new Map(s.passStarts.map((p) => [p.pass, min(p.at)]));
  const passes: PassDef[] = [];
  for (let n = 1; n <= current + (done ? 0 : 1); n++) {
    const planned = n > current;
    const known = seen.get(n);
    const prev = passes[n - 2]?.startAt ?? 0;
    // Without a sighting of the previous pass there is no boundary to
    // split on: the current pass owns everything observed.
    const blind = n === current && n > 1 && !seen.has(n - 1);
    const startAt = planned
      ? NEVER
      : blind
        ? 0
        : (known ?? (n === 1 ? 0 : prev));
    passes.push({
      id: `p${n}`,
      index: n,
      name: PASS_NAME(n),
      goal:
        n === current
          ? (s.progress.goal ?? 'Goal not recorded in progress.md yet.')
          : planned
            ? ''
            : 'Shipped before this view opened.',
      goalAt: planned ? NEVER : startAt,
      startAt,
    });
  }
  for (let i = 0; i < passes.length - 1; i++)
    if (passes[i + 1].startAt !== NEVER)
      passes[i].endAt = passes[i + 1].startAt;
  if (done) passes[passes.length - 1].endAt = head;

  const passFor = (at: number) => {
    let id = passes[0].id;
    for (const p of passes) if (p.startAt <= at) id = p.id;
    return id;
  };

  const nodes: WorkNode[] = [];
  for (const pass of passes.filter((p) => p.startAt !== NEVER)) {
    const jobs = s.jobs.filter((j) => passFor(min(j.startedAt)) === pass.id);
    let wave: string[] = [];
    let prevWave: string[] = [];
    let waveEnd = -1;
    let gates = 0;

    for (const job of jobs) {
      const startAt = min(job.startedAt);
      const running = job.state === 'running';
      const endAt = running ? NEVER : min(job.endedAt ?? s.now);
      if (wave.length > 0 && startAt >= waveEnd) {
        prevWave = wave;
        wave = [];
        waveEnd = -1;
      }
      wave.push(job.id);
      waveEnd = Math.max(waveEnd, endAt);

      const agent = agentOf(job.agent);
      const isOracle = agent === 'oracle';
      const kind: NodeKind = isOracle
        ? /gate/i.test(job.description)
          ? 'gate'
          : 'review'
        : 'lane';
      if (kind === 'gate') gates++;
      nodes.push({
        id: job.id,
        passId: pass.id,
        kind,
        agent,
        alias: job.alias,
        title: job.description,
        subtitle:
          job.state === 'error' || job.state === 'cancelled'
            ? `Ended: ${job.state}`
            : undefined,
        visibleAt: startAt,
        startAt,
        endAt,
        after: [...prevWave],
        attempt: kind === 'gate' ? { n: gates, max: 3 } : undefined,
        verdict:
          isOracle && !running ? verdictFrom(job.result, endAt) : undefined,
        resultText: job.result,
      });
    }

    // What the pass still has ahead, from the skill's fixed shape.
    const isCurrent = pass.index === current && !done;
    if (isCurrent) {
      const ahead: [string, NodeKind, AgentId, string][] = gates
        ? [
            [
              `${pass.id}-commit`,
              'step',
              'orchestrator',
              `Commit pass ${pass.index}`,
            ],
          ]
        : [
            [
              `${pass.id}-validate`,
              'step',
              'orchestrator',
              'Integrate and validate',
            ],
            [`${pass.id}-gate`, 'gate', 'oracle', `Pass ${pass.index} gate`],
            [
              `${pass.id}-commit`,
              'step',
              'orchestrator',
              `Commit pass ${pass.index}`,
            ],
          ];
      let after = wave;
      for (const [id, kind, agent, title] of ahead) {
        nodes.push({
          id,
          passId: pass.id,
          kind,
          agent,
          title,
          subtitle:
            kind === 'step' && id.endsWith('validate')
              ? 'broad suite once'
              : undefined,
          visibleAt: pass.startAt,
          startAt: NEVER,
          endAt: NEVER,
          after,
          attempt: kind === 'gate' ? { n: 1, max: 3 } : undefined,
        });
        after = [id];
      }
    }
  }

  const issues: KnownIssue[] = s.progress.issues.map((title, i) => ({
    id: `ki-${i}`,
    title,
    sev: i < 2 ? 'high' : i < 5 ? 'medium' : 'low',
    addedAt: -i,
    source: 'progress.md',
  }));

  const slug = s.slug ?? s.sessionID;
  return {
    task: slug.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
    slug,
    sessionId: s.sessionID,
    endAt: head,
    passes,
    nodes,
    issues,
    progress: [
      {
        at: 0,
        next: s.progress.next ?? 'Waiting for the next progress.md update.',
        decision: s.progress.decision,
      },
    ],
  };
}
