import { Handle, type NodeProps, Position } from '@xyflow/react';
import { GitCommitHorizontal, Lock, ScrollText } from 'lucide-react';

import { AGENTS } from '../agents';
import { Avatar, elapsed, StatusPill, useTime } from '../components/ui';
import { MOCK_RUN } from '../data/mock-run';
import {
  clock,
  currentStep,
  passProgress,
  stepsDone,
  verdictLabel,
} from '../data/sample';
import type { AgentId, Status } from '../data/types';
import { type PassData, SIZE, type WorkData } from './build';

function Ports() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

function cardStyle(status: Status, color: string, selected?: boolean) {
  const base: React.CSSProperties = {
    background:
      status === 'upcoming'
        ? 'color-mix(in oklab, var(--panel) 70%, transparent)'
        : 'var(--panel-2)',
    border: `1px ${status === 'upcoming' ? 'dashed' : 'solid'} var(--line-2)`,
  };
  if (status === 'running') {
    base.border = `1px solid ${color}88`;
    base.boxShadow = `0 0 0 1px ${color}22, 0 12px 40px -12px ${color}55`;
  }
  if (status === 'blocked') {
    base.border = '1px solid color-mix(in oklab, var(--bad) 55%, transparent)';
    base.boxShadow =
      '0 12px 40px -16px color-mix(in oklab, var(--bad) 60%, transparent)';
  }
  if (selected) {
    base.outline = '2px solid var(--bronze)';
    base.outlineOffset = '3px';
  }
  return base;
}

// ── Lane: one specialist working a scoped piece of the pass ─────────

export function LaneNode({ data, selected }: NodeProps) {
  const { work, status } = data as WorkData;
  const t = useTime();
  const meta = AGENTS[work.agent];
  const total = work.steps?.length ?? 0;
  const done = stepsDone(work, t);
  const step = currentStep(work, t);
  const scope = work.scope ?? [];

  return (
    <div
      className="flex flex-col gap-2.5 rounded-2xl p-3.5 transition-[box-shadow,border-color] duration-500"
      style={{
        width: SIZE.lane.w,
        height: SIZE.lane.h,
        ...cardStyle(status, meta.color, selected),
      }}
    >
      <Ports />
      <div className="flex items-center gap-2.5">
        <Avatar agent={work.agent} size={38} status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11.5px]">
            <span
              className="font-medium"
              style={{
                color: status === 'upcoming' ? 'var(--muted)' : meta.color,
              }}
            >
              {meta.name}
            </span>
            <span className="font-mono text-[var(--faint)]">{work.alias}</span>
          </div>
          <div className="truncate text-[13px] leading-snug font-medium text-[var(--fg)]">
            {work.title}
          </div>
        </div>
      </div>

      <div className="min-h-[18px] truncate text-[12px] text-[var(--muted)]">
        {status === 'running' ? (
          <span className="shimmer-text">
            {step ?? 'Writing the lane report'}
          </span>
        ) : status === 'done' ? (
          (work.report?.unverified.length ?? 0) > 0 ? (
            <span>
              {work.report?.unverified.length} unverified · see report
            </span>
          ) : (
            <span>Report accepted</span>
          )
        ) : (
          <span className="text-[var(--faint)]">
            {work.subtitle ?? 'Waiting for dispatch'}
          </span>
        )}
      </div>

      {total > 0 && (
        <div className="flex items-center gap-1">
          {work.steps?.map((s, i) => (
            <div
              key={s.label}
              className="h-1 flex-1 rounded-full transition-colors duration-500"
              style={{
                background:
                  i < done
                    ? meta.color
                    : i === done && status === 'running'
                      ? `${meta.color}55`
                      : 'var(--line-2)',
              }}
            />
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[10.5px] text-[var(--faint)]">
          {scope[0]}
          {scope.length > 1 ? ` +${scope.length - 1}` : ''}
        </span>
        <span className="flex items-center gap-2">
          {status !== 'upcoming' && (
            <span className="tabular font-mono text-[10.5px] text-[var(--faint)]">
              {clock(elapsed(work.startAt, work.endAt, t))}
            </span>
          )}
          <StatusPill status={status} color={meta.color} />
        </span>
      </div>
    </div>
  );
}

// ── Step: orchestrator's own work (plan, integrate, commit, step back) ─

export function StepNode({ data, selected }: NodeProps) {
  const { work, status } = data as WorkData;
  const t = useTime();
  const meta = AGENTS[work.agent];
  const isCommit = work.id.endsWith('-commit');
  return (
    <div
      className="flex items-center gap-3 rounded-2xl px-3.5"
      style={{
        width: SIZE.step.w,
        height: SIZE.step.h,
        ...cardStyle(status, meta.color, selected),
      }}
    >
      <Ports />
      {isCommit ? (
        <div
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full"
          style={{
            background: status === 'done' ? 'var(--bronze-dim)' : 'transparent',
            border: '1px solid var(--line-2)',
            color: status === 'done' ? 'var(--bronze)' : 'var(--faint)',
          }}
        >
          <GitCommitHorizontal size={16} />
        </div>
      ) : (
        <Avatar agent={work.agent} size={32} status={status} />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{work.title}</div>
        <div className="truncate text-[11.5px] text-[var(--faint)]">
          {isCommit && status === 'done' ? (
            <span className="font-mono text-[var(--bronze)]">
              {work.subtitle}
            </span>
          ) : status === 'running' && currentStep(work, t) ? (
            <span className="shimmer-text">{currentStep(work, t)}</span>
          ) : isCommit ? (
            'after the gate passes'
          ) : (
            work.subtitle
          )}
        </div>
      </div>
      {status === 'running' && (
        <span
          className="pulse-dot h-2 w-2 shrink-0 rounded-full"
          style={{ background: meta.color }}
        />
      )}
      {status === 'done' && !isCommit && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ok)]" />
      )}
    </div>
  );
}

// ── Gate / design review: the oracle's checkpoints ──────────────────

const OUTCOME_COLOR = {
  approved: 'var(--ok)',
  changes: 'var(--warn)',
  blockers: 'var(--bad)',
} as const;

export function GateNode({ data, selected }: NodeProps) {
  const { work, status } = data as WorkData;
  const meta = AGENTS[work.agent];
  const v = work.verdict;
  const decided = status === 'done' || status === 'blocked';
  const counts = v?.findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.sev] = (acc[f.sev] ?? 0) + 1;
    return acc;
  }, {});
  const tone = decided && v ? OUTCOME_COLOR[v.outcome] : meta.color;

  return (
    <div
      className="relative flex flex-col gap-2.5 overflow-hidden rounded-2xl p-3.5"
      style={{
        width: SIZE.gate.w,
        height: SIZE.gate.h,
        ...cardStyle(status, meta.color, selected),
      }}
    >
      <Ports />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{
          background: `linear-gradient(90deg, transparent, ${status === 'upcoming' ? 'var(--line-2)' : tone}, transparent)`,
        }}
      />
      <div className="flex items-center gap-2.5">
        <Avatar
          agent="oracle"
          size={34}
          status={status === 'blocked' ? 'done' : status}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11.5px]">
            <span
              className="h-2 w-2 rotate-45 rounded-[2px]"
              style={{
                background: status === 'upcoming' ? 'var(--line-2)' : tone,
              }}
            />
            <span
              style={{
                color: status === 'upcoming' ? 'var(--muted)' : meta.color,
              }}
              className="font-medium"
            >
              {work.kind === 'review' ? 'Design review' : 'Gate'}
            </span>
            {work.alias && status !== 'upcoming' && (
              <span className="font-mono text-[var(--faint)]">
                {work.alias}
              </span>
            )}
          </div>
          <div className="truncate text-[13px] font-medium">{work.title}</div>
        </div>
        {work.attempt && (
          <span className="tabular shrink-0 rounded-md border border-[var(--line-2)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--muted)]">
            {work.attempt.n}/{work.attempt.max}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 text-[12px] leading-snug text-[var(--muted)]">
        {decided && v ? (
          <span className="line-clamp-2">{v.summary}</span>
        ) : status === 'running' ? (
          <span className="shimmer-text">Reviewing the whole picture…</span>
        ) : (
          <span className="text-[var(--faint)]">
            {work.subtitle ?? 'Opens when the pass is integrated'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {decided && v ? (
          <>
            <span
              className="rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{
                color: tone,
                background: `color-mix(in oklab, ${tone} 15%, transparent)`,
              }}
            >
              {verdictLabel(v.outcome)}
            </span>
            {counts?.blocker ? (
              <Count n={counts.blocker} label="blocker" color="var(--bad)" />
            ) : null}
            {counts?.change ? (
              <Count n={counts.change} label="change" color="var(--warn)" />
            ) : null}
            {counts?.later ? (
              <Count n={counts.later} label="later" color="var(--faint)" />
            ) : null}
          </>
        ) : (
          <StatusPill
            status={status}
            color={meta.color}
            label={status === 'running' ? 'Reviewing' : undefined}
          />
        )}
      </div>
    </div>
  );
}

function Count({
  n,
  label,
  color,
}: {
  n: number;
  label: string;
  color: string;
}) {
  return (
    <span className="tabular text-[11px]" style={{ color }}>
      {n} {label}
      {n > 1 ? 's' : ''}
    </span>
  );
}

// ── Pass containers ─────────────────────────────────────────────────

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

export function PassGroupNode({ data }: NodeProps) {
  const { pass } = data as PassData;
  const t = useTime();
  const progress = passProgress(MOCK_RUN, pass, t);
  return (
    <div
      className="h-full w-full rounded-[28px]"
      style={{
        background:
          'radial-gradient(120% 80% at 0% 0%, rgba(217,166,96,0.07), transparent 55%), color-mix(in oklab, var(--panel) 55%, transparent)',
        border: '1px solid rgba(217,166,96,0.22)',
      }}
    >
      <div className="flex items-start justify-between gap-6 px-9 pt-6">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-[13px] tracking-[0.2em] text-[var(--bronze)]">
              PASS {ROMAN[pass.index]}
            </span>
            <span className="font-display text-[22px] font-semibold tracking-[0.04em]">
              {pass.name}
            </span>
          </div>
          <p className="mt-1 max-w-[640px] text-[13px] text-[var(--muted)]">
            {pass.goal}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-1">
          <span className="tabular font-mono text-[11px] text-[var(--faint)]">
            {clock(elapsed(pass.startAt, pass.endAt ?? Infinity, t))}
          </span>
          <div className="h-1 w-40 overflow-hidden rounded-full bg-[var(--line-2)]">
            <div
              className="h-full rounded-full bg-[var(--bronze)] transition-[width] duration-700"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function PassSummaryNode({ data, selected }: NodeProps) {
  const { pass } = data as PassData;
  const nodes = MOCK_RUN.nodes.filter((n) => n.passId === pass.id);
  const agents = [...new Set(nodes.map((n) => n.agent))] as AgentId[];
  const gate = [...nodes].reverse().find((n) => n.kind === 'gate');
  return (
    <div
      className="flex flex-col gap-3 rounded-[22px] p-4"
      style={{
        width: SIZE.passSummary.w,
        height: SIZE.passSummary.h,
        background: 'var(--panel-2)',
        border: '1px solid var(--line-2)',
        outline: selected ? '2px solid var(--bronze)' : undefined,
        outlineOffset: 3,
      }}
    >
      <Ports />
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-[11px] tracking-[0.2em] text-[var(--bronze)]">
            PASS {ROMAN[pass.index]}
          </span>
          <span className="font-display text-[16px] font-semibold">
            {pass.name}
          </span>
        </div>
        <StatusPill status="done" label="Shipped" />
      </div>
      <p className="line-clamp-2 text-[12px] leading-snug text-[var(--muted)]">
        {pass.goal}
      </p>
      <div className="flex -space-x-2">
        {agents.map((a) => (
          <div key={a} className="rounded-full ring-2 ring-[var(--panel-2)]">
            <Avatar agent={a} size={26} />
          </div>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-[var(--line)] pt-2.5 text-[11px]">
        <span className="flex items-center gap-1.5 text-[var(--muted)]">
          <span className="h-1.5 w-1.5 rotate-45 bg-[var(--ok)]" />
          Gate {gate?.attempt ? `${gate.attempt.n}/${gate.attempt.max}` : ''}
        </span>
        <span className="flex items-center gap-1 font-mono text-[var(--bronze)]">
          <GitCommitHorizontal size={13} />
          {pass.commit?.sha}
        </span>
        <span className="tabular font-mono text-[var(--faint)]">
          {clock((pass.endAt ?? 0) - pass.startAt)}
        </span>
      </div>
    </div>
  );
}

export function PassGhostNode({ data }: NodeProps) {
  const { pass } = data as PassData;
  const t = useTime();
  const known = t >= pass.goalAt;
  const lanes = pass.plannedLanes ?? [];
  return (
    <div
      className="flex flex-col gap-3 rounded-[22px] p-4"
      style={{
        width: SIZE.passGhost.w,
        height: SIZE.passGhost.h,
        background: 'color-mix(in oklab, var(--panel) 60%, transparent)',
        border: '1px dashed var(--line-2)',
      }}
    >
      <Ports />
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-[11px] tracking-[0.2em] text-[var(--faint)]">
            PASS {ROMAN[pass.index]}
          </span>
          <span className="font-display text-[16px] font-semibold text-[var(--muted)]">
            {pass.name}
          </span>
        </div>
        <Lock size={13} className="text-[var(--faint)]" />
      </div>
      {known ? (
        <>
          <p className="line-clamp-2 text-[12px] leading-snug text-[var(--muted)]">
            {pass.goal}
          </p>
          <ul className="flex flex-col gap-1.5">
            {lanes.slice(0, 4).map((l) => (
              <li
                key={l.title}
                className="flex items-center gap-2 text-[11.5px] text-[var(--faint)]"
              >
                <Avatar agent={l.agent} size={18} status="upcoming" />
                <span className="truncate">{l.title}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-start justify-center gap-2 text-[12px] text-[var(--faint)]">
          <ScrollText size={18} />
          Planned at the next step back, from what the running product shows.
        </div>
      )}
    </div>
  );
}

export const NODE_TYPES = {
  lane: LaneNode,
  step: StepNode,
  gate: GateNode,
  passGroup: PassGroupNode,
  passSummary: PassSummaryNode,
  passGhost: PassGhostNode,
};
