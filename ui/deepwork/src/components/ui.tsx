import { Check, Circle, OctagonAlert } from 'lucide-react';
import { createContext, useContext } from 'react';

import { AGENTS } from '../agents';
import { MOCK_RUN } from '../data/mock-run';
import type { AgentId, RunDef, Status } from '../data/types';

/** Current sample time (minutes), shared by every node and panel. */
export const TimeContext = createContext(0);
export const useTime = () => useContext(TimeContext);

/** The run being shown (live snapshot or the sample run). */
export const RunContext = createContext<RunDef>(MOCK_RUN);
export const useRun = () => useContext(RunContext);

export function Avatar({
  agent,
  size = 36,
  status = 'done',
}: {
  agent: AgentId;
  size?: number;
  status?: Status;
}) {
  const meta = AGENTS[agent];
  const running = status === 'running';
  const upcoming = status === 'upcoming';
  const dot = Math.max(7, Math.round(size * 0.24));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {running && (
        <div
          className="breathe absolute rounded-[34%] blur-md"
          style={{ inset: -3, background: meta.color, opacity: 0.55 }}
        />
      )}
      <img
        src={meta.avatar}
        alt={meta.name}
        draggable={false}
        className="relative h-full w-full rounded-[30%] object-cover"
        style={{
          filter: upcoming ? 'grayscale(0.9) brightness(0.55)' : undefined,
        }}
      />
      <div className="pointer-events-none absolute inset-0 rounded-[30%] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.09),inset_0_1px_0_rgba(255,255,255,0.14)]" />
      {running && (
        <span
          className="absolute rounded-full"
          style={{
            width: dot,
            height: dot,
            right: -dot * 0.25,
            bottom: -dot * 0.25,
            background: meta.color,
            boxShadow: `0 0 0 2px var(--panel-2), 0 0 10px ${meta.color}`,
          }}
        >
          <span
            className="pulse-dot absolute inset-0 rounded-full"
            style={{ background: meta.color }}
          />
        </span>
      )}
    </div>
  );
}

const STATUS_COPY: Record<Status, string> = {
  hidden: '',
  upcoming: 'Up next',
  running: 'Working',
  done: 'Done',
  blocked: 'Blockers',
};

export function StatusPill({
  status,
  color,
  label,
}: {
  status: Status;
  color?: string;
  label?: string;
}) {
  const text = label ?? STATUS_COPY[status];
  if (status === 'running') {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
        style={{
          background: `${color ?? 'var(--info)'}1f`,
          color: color ?? 'var(--info)',
        }}
      >
        <span
          className="pulse-dot h-1.5 w-1.5 rounded-full"
          style={{ background: color ?? 'var(--info)' }}
        />
        {text}
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--ok)_14%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--ok)]">
        <Check size={11} strokeWidth={2.6} />
        {text}
      </span>
    );
  }
  if (status === 'blocked') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--bad)_16%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--bad)]">
        <OctagonAlert size={11} strokeWidth={2.4} />
        {text}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--line-2)] px-2 py-0.5 text-[11px] text-[var(--faint)]">
      <Circle size={8} />
      {text}
    </span>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] text-[var(--muted)]">
      {children}
    </span>
  );
}

export function elapsed(start: number, end: number, t: number): number {
  return Math.max(0, Math.min(t, end) - start);
}
