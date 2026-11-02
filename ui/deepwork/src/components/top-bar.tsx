import { Check, GitBranch } from 'lucide-react';

import logo from '../assets/logo.png';
import { clock, passPhase, passProgress } from '../data/sample';
import type { RunDef } from '../data/types';

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

export function TopBar({
  run,
  t,
  live,
}: {
  run: RunDef;
  t: number;
  live: boolean;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-5 border-b border-[var(--line)] bg-[var(--panel)] px-5">
      <div className="flex min-w-0 items-center gap-3">
        <img
          src={logo}
          alt="oh-my-opencode-slim"
          className="h-9 w-9 shrink-0 object-contain drop-shadow-[0_6px_18px_rgba(217,166,96,0.25)]"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-display text-[13px] font-semibold tracking-[0.18em] text-[var(--bronze)]">
              DEEPWORK
            </span>
            <span className="text-[var(--faint)]">/</span>
            <span className="truncate text-[14px] font-medium">{run.task}</span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[10.5px] text-[var(--faint)]">
            <span>.slim/deepwork/{run.slug}/</span>
            <span className="hidden items-center gap-1 sm:flex">
              <GitBranch size={11} />
              {run.branch}
            </span>
          </div>
        </div>
      </div>

      <nav
        aria-label="Passes"
        className="mx-auto hidden items-center gap-2 lg:flex"
      >
        {run.passes.map((pass, i) => {
          const phase = passPhase(run, pass, t);
          const progress = passProgress(run, pass, t);
          return (
            <div key={pass.id} className="flex items-center gap-2">
              {i > 0 && <div className="h-px w-6 bg-[var(--line-2)]" />}
              <div
                className="flex w-[172px] flex-col gap-1.5 rounded-xl px-3 py-2"
                style={{
                  background:
                    phase === 'active'
                      ? 'linear-gradient(180deg, rgba(217,166,96,0.16), rgba(217,166,96,0.05))'
                      : 'transparent',
                  border: '1px solid var(--line)',
                  boxShadow:
                    phase === 'active'
                      ? 'inset 0 1px 0 rgba(255,236,214,0.08), 0 10px 30px -14px rgba(217,166,96,0.45)'
                      : undefined,
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-baseline gap-1.5">
                    <span
                      className="font-display text-[10px] tracking-[0.18em]"
                      style={{
                        color:
                          phase === 'planned'
                            ? 'var(--faint)'
                            : 'var(--bronze)',
                      }}
                    >
                      {ROMAN[pass.index]}
                    </span>
                    <span
                      className="font-display text-[13px] font-semibold"
                      style={{
                        color:
                          phase === 'planned' ? 'var(--muted)' : 'var(--fg)',
                      }}
                    >
                      {pass.name}
                    </span>
                  </span>
                  {phase === 'done' ? (
                    <Check
                      size={13}
                      className="text-[var(--ok)]"
                      strokeWidth={2.6}
                    />
                  ) : phase === 'active' ? (
                    <span className="tabular font-mono text-[10.5px] text-[var(--bronze)]">
                      {Math.round(progress * 100)}%
                    </span>
                  ) : (
                    <span className="text-[10.5px] text-[var(--faint)]">
                      next
                    </span>
                  )}
                </div>
                <div className="h-[3px] overflow-hidden rounded-full bg-[var(--line-2)]">
                  <div
                    className="h-full rounded-full transition-[width] duration-700"
                    style={{
                      width: `${progress * 100}%`,
                      background:
                        phase === 'done'
                          ? 'rgba(217,166,96,0.55)'
                          : 'var(--bronze)',
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-3">
        <div className="hidden text-right md:block">
          <div className="eyebrow">Elapsed</div>
          <div className="tabular font-mono text-[13px]">{clock(t)}</div>
        </div>
        {live ? (
          <span className="flex items-center gap-2 rounded-full border border-[color-mix(in_oklab,var(--bad)_40%,transparent)] px-3 py-1 text-[11px] font-semibold tracking-[0.08em] text-[var(--bad)]">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-[var(--bad)]" />
            LIVE
          </span>
        ) : (
          <span className="rounded-full border border-[var(--line-2)] px-3 py-1 text-[11px] font-semibold tracking-[0.08em] text-[var(--muted)]">
            REPLAY
          </span>
        )}
      </div>
    </header>
  );
}
