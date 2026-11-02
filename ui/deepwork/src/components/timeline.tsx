import { FastForward, Pause, Play, Radio } from 'lucide-react';
import { useMemo, useState } from 'react';

import { AGENTS } from '../agents';
import { clock, type TimelineEvent, timelineEvents } from '../data/sample';
import type { RunDef } from '../data/types';

export function Timeline({
  run,
  t,
  head,
  playing,
  speed,
  controls = true,
  onScrub,
  onLive,
  onTogglePlay,
  onSpeed,
  onPick,
}: {
  run: RunDef;
  t: number;
  head: number;
  playing: boolean;
  speed: number;
  /** Play and speed only make sense for the sample run. */
  controls?: boolean;
  onScrub: (t: number) => void;
  onLive: () => void;
  onTogglePlay: () => void;
  onSpeed: () => void;
  onPick: (e: TimelineEvent) => void;
}) {
  const all = useMemo(() => timelineEvents(run), [run]);
  const events = all.filter((e) => e.at <= head);
  // The track only covers what has happened; the future is unknown.
  const span = Math.max(30, head * 1.04);
  const pct = (m: number) => `${(m / span) * 100}%`;
  const [hover, setHover] = useState<TimelineEvent>();
  const live = t >= head - 0.01;

  return (
    <footer className="flex h-[88px] shrink-0 items-center gap-4 border-t border-[var(--line)] bg-[var(--panel)] px-4">
      <div className="flex shrink-0 items-center gap-1.5">
        {controls && (
          <>
            <button
              type="button"
              onClick={onTogglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
              className="grid h-9 w-9 place-items-center rounded-full bg-[var(--fg)] text-[var(--bg)] transition-transform hover:scale-105 active:scale-95"
            >
              {playing ? (
                <Pause size={15} fill="currentColor" />
              ) : (
                <Play size={15} fill="currentColor" className="ml-0.5" />
              )}
            </button>
            <button
              type="button"
              onClick={onSpeed}
              aria-label="Change speed"
              className="flex h-9 items-center gap-1 rounded-full border border-[var(--line-2)] px-3 font-mono text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--fg)]"
            >
              <FastForward size={12} />
              {speed}×
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onLive}
          disabled={live}
          className="flex h-9 items-center gap-1.5 rounded-full border px-3 text-[11px] font-medium transition-colors disabled:cursor-default"
          style={{
            borderColor: live ? 'transparent' : 'var(--line-2)',
            color: live ? 'var(--faint)' : 'var(--fg)',
          }}
        >
          <Radio size={12} />
          {live ? 'Following' : 'Jump to live'}
        </button>
      </div>

      <div className="relative min-w-0 flex-1 self-stretch py-3">
        {/* pass bands */}
        <div className="absolute inset-x-0 top-3 h-4">
          {run.passes
            .filter((p) => p.startAt <= head)
            .map((p) => {
              const end = Math.min(p.endAt ?? head, head);
              return (
                <div
                  key={p.id}
                  className="absolute top-0 flex h-full items-center border-l border-[var(--line-2)] pl-1.5"
                  style={{
                    left: pct(p.startAt),
                    width: `calc(${pct(end - p.startAt)} - 2px)`,
                  }}
                >
                  <span className="truncate font-display text-[10px] tracking-[0.16em] text-[var(--faint)]">
                    {p.name.toUpperCase()}
                  </span>
                </div>
              );
            })}
        </div>

        {/* track */}
        <div className="absolute inset-x-0 top-[38px] h-7">
          <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--line-2)]" />
          <div
            className="absolute top-1/2 left-0 h-px bg-[var(--bronze)] opacity-60"
            style={{ width: pct(t) }}
          />
          {events.map((e) => (
            <button
              type="button"
              key={`${e.at}-${e.kind}-${e.label}`}
              onMouseEnter={() => setHover(e)}
              onMouseLeave={() => setHover(undefined)}
              onFocus={() => setHover(e)}
              onBlur={() => setHover(undefined)}
              onClick={() => onPick(e)}
              aria-label={`${clock(e.at)} ${e.label}`}
              className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 p-1"
              style={{ left: pct(e.at), opacity: e.at <= t ? 1 : 0.35 }}
            >
              <Tick e={e} />
            </button>
          ))}
          {/* playhead */}
          <div
            className="pointer-events-none absolute -top-2 -bottom-2 z-20 w-px bg-[var(--fg)]"
            style={{ left: pct(t) }}
          >
            <div className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-[var(--fg)]" />
          </div>
          <input
            type="range"
            aria-label="Scrub the run"
            className="scrubber absolute inset-0"
            min={0}
            max={head}
            step={0.1}
            value={t}
            onChange={(e) => onScrub(Number(e.target.value))}
          />
        </div>

        {hover && (
          <div
            className="pointer-events-none absolute bottom-[54px] z-30 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[var(--line-2)] bg-[var(--raise)] px-2.5 py-1.5 text-[11.5px] shadow-xl"
            style={{ left: pct(hover.at) }}
          >
            <span className="tabular mr-2 font-mono text-[var(--faint)]">
              {clock(hover.at)}
            </span>
            {hover.label}
          </div>
        )}
      </div>

      <div className="hidden w-20 shrink-0 text-right sm:block">
        <div className="tabular font-mono text-[13px]">{clock(t)}</div>
        <div className="tabular font-mono text-[10.5px] text-[var(--faint)]">
          of {clock(head)}
        </div>
      </div>
    </footer>
  );
}

function Tick({ e }: { e: TimelineEvent }) {
  const color = AGENTS[e.agent].color;
  if (e.kind === 'verdict')
    return (
      <span
        className="block h-2.5 w-2.5 rotate-45 rounded-[2px]"
        style={{ background: color }}
      />
    );
  if (e.kind === 'commit')
    return (
      <span className="block h-4 w-[3px] rounded-full bg-[var(--bronze)]" />
    );
  if (e.kind === 'replan')
    return (
      <span
        className="block h-2.5 w-2.5 rounded-full border-2"
        style={{ borderColor: color }}
      />
    );
  if (e.kind === 'end')
    return (
      <span
        className="block h-1.5 w-1.5 rounded-full"
        style={{ background: color, opacity: 0.6 }}
      />
    );
  return (
    <span
      className="block h-2 w-2 rounded-full"
      style={{ background: color }}
    />
  );
}
