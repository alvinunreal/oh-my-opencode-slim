import {
  Check,
  FilePen,
  FileSearch,
  MessageSquareText,
  NotebookPen,
  SquareTerminal,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { AGENTS } from '../agents';
import { clock, statusOf, verdictLabel } from '../data/sample';
import type {
  Activity,
  Finding,
  PassDef,
  RunDef,
  WorkNode,
} from '../data/types';
import { Avatar, elapsed, StatusPill } from './ui';

export function Inspector({
  run,
  t,
  selectedId,
  onClose,
}: {
  run: RunDef;
  t: number;
  selectedId?: string;
  onClose: () => void;
}) {
  const work = run.nodes.find((n) => n.id === selectedId);
  const pass = run.passes.find((p) => `pass-${p.id}` === selectedId);

  return (
    <AnimatePresence>
      {(work || pass) && (
        <motion.aside
          key="inspector"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="scroll-thin absolute inset-y-0 right-0 z-20 flex w-full max-w-[400px] shrink-0 flex-col lg:relative lg:w-[400px] overflow-y-auto border-l border-[var(--line)] bg-[color-mix(in_oklab,var(--panel)_94%,transparent)] backdrop-blur-xl"
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="absolute top-4 right-4 z-10 grid h-7 w-7 place-items-center rounded-full text-[var(--muted)] transition-colors hover:bg-[var(--raise)] hover:text-[var(--fg)]"
          >
            <X size={15} />
          </button>
          {work && <WorkDetail work={work} t={t} />}
          {pass && <PassDetail run={run} pass={pass} />}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-[var(--line)] px-5 py-4">
      <div className="flex items-center justify-between">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function WorkDetail({ work, t }: { work: WorkNode; t: number }) {
  const meta = AGENTS[work.agent];
  const status = statusOf(work, t);
  const activity = (work.activity ?? []).filter((a) => a.at <= t);
  const decided = work.verdict && t >= work.verdict.at;
  const showReport = work.report && status === 'done';

  return (
    <div className="flex flex-col">
      <header
        className="flex flex-col gap-4 px-5 pt-5 pb-5"
        style={{
          background: `radial-gradient(120% 100% at 0% 0%, ${meta.color}1c, transparent 60%)`,
        }}
      >
        <div className="flex items-center gap-3.5">
          <Avatar
            agent={work.agent}
            size={56}
            status={status === 'blocked' ? 'done' : status}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="font-medium" style={{ color: meta.color }}>
                {meta.name}
              </span>
              {work.alias && (
                <span className="font-mono text-[var(--faint)]">
                  {work.alias}
                </span>
              )}
            </div>
            <div className="text-[11.5px] text-[var(--faint)]">{meta.role}</div>
          </div>
        </div>
        <div>
          <h2 className="text-[17px] leading-snug font-semibold text-balance">
            {work.title}
          </h2>
          {work.attempt && (
            <div className="mt-1 font-mono text-[11.5px] text-[var(--muted)]">
              Pass {work.passId.slice(1)} gate · attempt {work.attempt.n} of{' '}
              {work.attempt.max}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={status} color={meta.color} />
          {status !== 'upcoming' && (
            <span className="tabular rounded-full border border-[var(--line-2)] px-2 py-0.5 font-mono text-[11px] text-[var(--muted)]">
              {clock(elapsed(work.startAt, work.endAt, t))}
            </span>
          )}
          {work.model && (
            <span className="rounded-full border border-[var(--line-2)] px-2 py-0.5 font-mono text-[11px] text-[var(--muted)]">
              {work.model}
            </span>
          )}
        </div>
      </header>

      {work.verdict && (
        <Section
          title={work.kind === 'review' ? 'Design review' : 'Gate verdict'}
        >
          {decided ? (
            <Verdict verdict={work.verdict} />
          ) : status === 'running' ? (
            <p className="shimmer-text text-[13px]">
              Reading the pass plan, lane reports and the diff…
            </p>
          ) : (
            <p className="text-[12.5px] text-[var(--faint)]">
              Opens once the pass is integrated and the broad suite has run.
            </p>
          )}
        </Section>
      )}

      {work.steps && (
        <Section
          title="Steps"
          aside={
            <span className="tabular font-mono text-[11px] text-[var(--faint)]">
              {work.steps.filter((s) => s.at <= t).length}/{work.steps.length}
            </span>
          }
        >
          <ol className="flex flex-col gap-0.5">
            {work.steps.map((s, i) => {
              const done = s.at <= t;
              const current =
                !done &&
                (i === 0 || (work.steps?.[i - 1].at ?? 0) <= t) &&
                status === 'running';
              return (
                <li
                  key={s.label}
                  className="flex items-center gap-2.5 py-1 text-[12.5px]"
                >
                  <span
                    className="grid h-4 w-4 shrink-0 place-items-center rounded-full"
                    style={{
                      background: done ? meta.color : 'transparent',
                      border: done
                        ? 'none'
                        : `1px solid ${current ? meta.color : 'var(--line-2)'}`,
                    }}
                  >
                    {done && (
                      <Check
                        size={10}
                        strokeWidth={3}
                        className="text-[var(--bg)]"
                      />
                    )}
                    {current && (
                      <span
                        className="pulse-dot h-1.5 w-1.5 rounded-full"
                        style={{ background: meta.color }}
                      />
                    )}
                  </span>
                  <span
                    className={
                      done
                        ? 'text-[var(--fg)]'
                        : current
                          ? 'shimmer-text'
                          : 'text-[var(--faint)]'
                    }
                  >
                    {s.label}
                  </span>
                </li>
              );
            })}
          </ol>
        </Section>
      )}

      {activity.length > 0 && (
        <Section title="Activity">
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {activity.map((a) => (
                <motion.li
                  key={`${a.at}-${a.text}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <ActivityRow a={a} color={meta.color} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </Section>
      )}

      {(work.scope || work.interfaces || work.acceptance) && (
        <Section title="Delegation">
          <dl className="flex flex-col gap-3 text-[12.5px]">
            {work.scope && (
              <div>
                <dt className="mb-1 text-[11px] text-[var(--faint)]">
                  Write scope
                </dt>
                <dd className="flex flex-wrap gap-1.5">
                  {work.scope.map((s) => (
                    <code
                      key={s}
                      className="rounded-md bg-[var(--raise)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--muted)]"
                    >
                      {s}
                    </code>
                  ))}
                </dd>
              </div>
            )}
            {work.interfaces && (
              <div>
                <dt className="mb-1 text-[11px] text-[var(--faint)]">
                  Relies on
                </dt>
                <dd className="flex flex-col gap-1">
                  {work.interfaces.map((s) => (
                    <code
                      key={s}
                      className="font-mono text-[11.5px] text-[var(--muted)]"
                    >
                      {s}
                    </code>
                  ))}
                </dd>
              </div>
            )}
            {work.acceptance && (
              <div>
                <dt className="mb-1 text-[11px] text-[var(--faint)]">
                  Acceptance evidence
                </dt>
                <dd className="leading-relaxed text-[var(--muted)]">
                  {work.acceptance}
                </dd>
              </div>
            )}
          </dl>
        </Section>
      )}

      {work.resultText && status !== 'running' && (
        <Section
          title={work.agent === 'oracle' ? 'Full review' : 'Lane report'}
        >
          <div className="scroll-thin max-h-[420px] overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--panel-2)] px-3.5 py-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-[var(--muted)]">
            {work.resultText}
          </div>
        </Section>
      )}

      {showReport && work.report && (
        <Section title="Lane report">
          <div className="flex flex-col gap-3 text-[12.5px]">
            <div>
              <div className="mb-1 text-[11px] text-[var(--faint)]">
                Changed files
              </div>
              <ul className="flex flex-col gap-0.5 font-mono text-[11.5px] text-[var(--muted)]">
                {work.report.changed.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-[11px] text-[var(--faint)]">
                Commands
              </div>
              <ul className="flex flex-col gap-1">
                {work.report.commands.map((c) => (
                  <li
                    key={c.cmd}
                    className="flex items-center gap-2 font-mono text-[11.5px]"
                  >
                    <ExitBadge exit={c.exit} />
                    <span className="min-w-0 flex-1 truncate text-[var(--muted)]">
                      {c.cmd}
                    </span>
                    {c.note && (
                      <span className="text-[var(--faint)]">{c.note}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-[11px] text-[var(--faint)]">
                Unverified
              </div>
              {work.report.unverified.length ? (
                <ul className="flex flex-col gap-1">
                  {work.report.unverified.map((u) => (
                    <li
                      key={u}
                      className="flex items-start gap-2 text-[var(--warn)]"
                    >
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current" />
                      {u}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-[var(--ok)]">
                  Nothing left unverified
                </span>
              )}
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

const SEV_STYLE: Record<Finding['sev'], { label: string; color: string }> = {
  blocker: { label: 'Blocker', color: 'var(--bad)' },
  change: { label: 'Change', color: 'var(--warn)' },
  later: { label: 'Later pass', color: 'var(--faint)' },
  nit: { label: 'Nit', color: 'var(--faint)' },
};

function Verdict({ verdict }: { verdict: NonNullable<WorkNode['verdict']> }) {
  const tone =
    verdict.outcome === 'approved'
      ? 'var(--ok)'
      : verdict.outcome === 'changes'
        ? 'var(--warn)'
        : 'var(--bad)';
  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-xl px-3.5 py-3"
        style={{
          background: `color-mix(in oklab, ${tone} 10%, transparent)`,
          border: `1px solid color-mix(in oklab, ${tone} 30%, transparent)`,
        }}
      >
        <div
          className="mb-1 flex items-center gap-2 text-[12px] font-semibold"
          style={{ color: tone }}
        >
          <span
            className="h-2 w-2 rotate-45 rounded-[2px]"
            style={{ background: tone }}
          />
          {verdictLabel(verdict.outcome)}
        </div>
        <p className="text-[13px] leading-relaxed">{verdict.summary}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {verdict.findings.map((f) => {
          const s = SEV_STYLE[f.sev];
          return (
            <li
              key={f.title}
              className="rounded-xl border border-[var(--line)] bg-[var(--panel-2)] px-3.5 py-3"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{f.title}</span>
                <span
                  className="shrink-0 text-[10.5px] font-semibold tracking-[0.06em] uppercase"
                  style={{ color: s.color }}
                >
                  {s.label}
                </span>
              </div>
              <p className="text-[12.5px] leading-relaxed text-[var(--muted)]">
                {f.detail}
              </p>
              {f.ref && (
                <code className="mt-1.5 block font-mono text-[11px] text-[var(--faint)]">
                  {f.ref}
                </code>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const ACTIVITY_ICON = {
  read: FileSearch,
  edit: FilePen,
  bash: SquareTerminal,
  note: NotebookPen,
  msg: MessageSquareText,
};

function ActivityRow({ a, color }: { a: Activity; color: string }) {
  const Icon = ACTIVITY_ICON[a.kind];
  const prose = a.kind === 'note' || a.kind === 'msg';
  return (
    <div className="flex items-start gap-2.5">
      <span
        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-[var(--raise)]"
        style={{ color: prose ? color : 'var(--muted)' }}
      >
        <Icon size={12} />
      </span>
      <div className="min-w-0 flex-1">
        {prose ? (
          <p className="text-[12.5px] leading-relaxed">{a.text}</p>
        ) : (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--muted)]">
              {a.text}
            </code>
            {a.exit !== undefined && <ExitBadge exit={a.exit} />}
          </div>
        )}
      </div>
    </div>
  );
}

function ExitBadge({ exit }: { exit: number }) {
  const ok = exit === 0;
  return (
    <span
      className="tabular shrink-0 rounded px-1.5 py-px font-mono text-[10px]"
      style={{
        color: ok ? 'var(--ok)' : 'var(--bad)',
        background: `color-mix(in oklab, ${ok ? 'var(--ok)' : 'var(--bad)'} 14%, transparent)`,
      }}
    >
      exit {exit}
    </span>
  );
}

function PassDetail({ run, pass }: { run: RunDef; pass: PassDef }) {
  const nodes = run.nodes.filter((n) => n.passId === pass.id);
  const gates = nodes.filter((n) => n.kind === 'gate');
  return (
    <div className="flex flex-col">
      <header
        className="flex flex-col gap-2 px-5 pt-6 pb-5"
        style={{
          background:
            'radial-gradient(120% 100% at 0% 0%, rgba(217,166,96,0.12), transparent 60%)',
        }}
      >
        <span className="font-display text-[12px] tracking-[0.2em] text-[var(--bronze)]">
          PASS {pass.index}
        </span>
        <h2 className="font-display text-[24px] font-semibold">{pass.name}</h2>
        <p className="text-[13px] leading-relaxed text-[var(--muted)]">
          {pass.goal}
        </p>
        {pass.commit && (
          <code className="mt-1 font-mono text-[11.5px] text-[var(--bronze)]">
            {pass.commit.sha} · {pass.commit.message}
          </code>
        )}
      </header>
      <Section title="Who worked">
        <ul className="flex flex-col gap-2">
          {nodes
            .filter((n) => n.kind !== 'step')
            .map((n) => (
              <li
                key={n.id}
                className="flex items-center gap-2.5 text-[12.5px]"
              >
                <Avatar agent={n.agent} size={24} />
                <span className="font-mono text-[11px] text-[var(--faint)]">
                  {n.alias}
                </span>
                <span className="min-w-0 flex-1 truncate">{n.title}</span>
                <span className="tabular font-mono text-[11px] text-[var(--faint)]">
                  {clock(n.endAt - n.startAt)}
                </span>
              </li>
            ))}
        </ul>
      </Section>
      {gates.map(
        (g) =>
          g.verdict && (
            <Section
              key={g.id}
              title={`Gate · attempt ${g.attempt?.n} of ${g.attempt?.max}`}
            >
              <Verdict verdict={g.verdict} />
            </Section>
          ),
      )}
    </div>
  );
}
