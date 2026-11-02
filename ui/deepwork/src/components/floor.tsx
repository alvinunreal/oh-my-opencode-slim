import { AnimatePresence, motion } from 'motion/react';

import { AGENTS } from '../agents';
import {
  clock,
  currentStep,
  openIssues,
  progressAt,
  statusOf,
} from '../data/sample';
import type { RunDef } from '../data/types';
import { Avatar, elapsed } from './ui';

const SEV = {
  high: 'var(--bad)',
  medium: 'var(--warn)',
  low: 'var(--faint)',
} as const;

export function Floor({
  run,
  t,
  selectedId,
  onSelect,
}: {
  run: RunDef;
  t: number;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const working = run.nodes.filter((n) => statusOf(n, t) === 'running');
  const progress = progressAt(run, t);
  const issues = openIssues(run, t);
  const passName = (id?: string) => run.passes.find((p) => p.id === id)?.name;

  return (
    <aside className="scroll-thin hidden w-[300px] shrink-0 flex-col overflow-y-auto border-r border-[var(--line)] bg-[var(--panel)] xl:flex">
      <section className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">On the floor</h2>
          <span className="tabular text-[11px] text-[var(--faint)]">
            {working.length} working
          </span>
        </div>
        <ul className="flex flex-col gap-1.5">
          <AnimatePresence initial={false}>
            {working.map((n) => {
              const meta = AGENTS[n.agent];
              const step = currentStep(n, t);
              return (
                <motion.li
                  key={n.id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(n.id)}
                    className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--raise)]"
                    style={{
                      background:
                        selectedId === n.id ? 'var(--raise)' : undefined,
                    }}
                  >
                    <Avatar agent={n.agent} size={34} status="running" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-[11.5px]">
                        <span
                          className="font-medium"
                          style={{ color: meta.color }}
                        >
                          {meta.name}
                        </span>
                        {n.alias && (
                          <span className="font-mono text-[var(--faint)]">
                            {n.alias}
                          </span>
                        )}
                        <span className="tabular ml-auto font-mono text-[10.5px] text-[var(--faint)]">
                          {clock(elapsed(n.startAt, n.endAt, t))}
                        </span>
                      </span>
                      <span className="block truncate text-[12.5px]">
                        {n.title}
                      </span>
                      {step && (
                        <span className="block truncate text-[11.5px] text-[var(--muted)]">
                          {step}
                        </span>
                      )}
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
          {working.length === 0 && (
            <li className="rounded-xl border border-dashed border-[var(--line-2)] px-3 py-3 text-[12px] text-[var(--faint)]">
              Nobody is mid-task. The orchestrator is between steps.
            </li>
          )}
        </ul>
      </section>

      <section className="mx-4 flex flex-col gap-2.5 rounded-2xl border border-[var(--line)] bg-[var(--panel-2)] p-4">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">Next step</h2>
          <span className="font-mono text-[10px] text-[var(--faint)]">
            progress.md
          </span>
        </div>
        <AnimatePresence mode="wait">
          <motion.p
            key={progress.next}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.3 }}
            className="text-[13px] leading-relaxed"
          >
            {progress.next}
          </motion.p>
        </AnimatePresence>
        {progress.decision && (
          <div className="border-t border-[var(--line)] pt-2.5">
            <div className="eyebrow mb-1">Latest decision</div>
            <p className="text-[12px] leading-relaxed text-[var(--muted)]">
              {progress.decision}
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2.5 p-4">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">Known issues</h2>
          <span className="tabular text-[11px] text-[var(--faint)]">
            {issues.length} open
          </span>
        </div>
        <ol className="flex flex-col">
          <AnimatePresence initial={false}>
            {issues.map((issue, i) => (
              <motion.li
                key={issue.id}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.35 }}
                className="overflow-hidden"
              >
                <div className="flex items-start gap-2.5 border-b border-[var(--line)] py-2">
                  <span className="tabular w-4 pt-px font-mono text-[10.5px] text-[var(--faint)]">
                    {i + 1}
                  </span>
                  <span
                    className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: SEV[issue.sev] }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] leading-snug">
                      {issue.title}
                    </span>
                    <span className="text-[11px] text-[var(--faint)]">
                      from {issue.source}
                      {issue.deferredTo
                        ? ` · ${passName(issue.deferredTo)}`
                        : ''}
                    </span>
                  </span>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      </section>
    </aside>
  );
}
