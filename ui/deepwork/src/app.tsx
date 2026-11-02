import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';

import { Floor } from './components/floor';
import { Inspector } from './components/inspector';
import { Timeline } from './components/timeline';
import { TopBar } from './components/top-bar';
import { RunContext, TimeContext } from './components/ui';
import {
  type ExplorerSnapshot,
  fromSnapshot,
  liveSessionId,
} from './data/live';
import { MOCK_RUN } from './data/mock-run';
import type { RunDef } from './data/types';
import { Canvas } from './graph/canvas';

/** Sample minutes advanced per real second at 1×. */
const RATE = 0.8;
const SPEEDS = [1, 4, 12];
const POLL_MS = 2000;

interface Clock {
  t: number;
  head: number;
  playing: boolean;
  speed: number;
  following: boolean;
  scrubTo: (v: number) => void;
  live: () => void;
  togglePlay: () => void;
  nextSpeed: () => void;
}

/** Scrubbing detaches `t` from the head for replay; "live" re-attaches. */
function useScrub(head: number) {
  const [scrub, setScrub] = useState<number>();
  return {
    t: scrub ?? head,
    following: scrub === undefined,
    scrubTo: (v: number) => setScrub(v >= head - 0.05 ? undefined : v),
    live: () => setScrub(undefined),
  };
}

/** Sample clock: the head advances through the mock run. */
function useSampleClock(run: RunDef, start: number): Clock {
  const [head, setHead] = useState(start);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const last = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = (now: number) => {
      const dt = last.current === undefined ? 0 : (now - last.current) / 1000;
      last.current = now;
      setHead((h) => Math.min(run.endAt, h + dt * RATE * speed));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      last.current = undefined;
    };
  }, [playing, speed, run.endAt]);

  return {
    ...useScrub(head),
    head,
    playing,
    speed,
    togglePlay: () => setPlaying((p) => !p),
    nextSpeed: () =>
      setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]),
  };
}

/** `?t=133&sel=p2-gate1` opens the sample at a given minute. */
function sampleParam(key: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

/** Live run: poll the plugin's snapshot; the head is wall-clock now. */
function useLiveRun(sessionID: string) {
  const [snapshot, setSnapshot] = useState<{ run: RunDef; at: number }>();
  const [error, setError] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/s/${encodeURIComponent(sessionID)}`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(String(res.status));
        const snap = (await res.json()) as ExplorerSnapshot;
        if (!stopped) {
          setSnapshot({ run: fromSnapshot(snap), at: performance.now() });
          setError(false);
        }
      } catch {
        if (!stopped) setError(true);
      }
    };
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      stopped = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [sessionID]);

  const head = snapshot
    ? snapshot.run.endAt + (performance.now() - snapshot.at) / 60000
    : 0;
  const clock: Clock = {
    ...useScrub(head),
    head,
    playing: true,
    speed: 1,
    togglePlay: () => {},
    nextSpeed: () => {},
  };
  return { run: snapshot?.run, clock, error };
}

export function App() {
  const sessionID = liveSessionId();
  return sessionID ? <LiveApp sessionID={sessionID} /> : <SampleApp />;
}

function SampleApp() {
  const start = Number(sampleParam('t'));
  const clock = useSampleClock(
    MOCK_RUN,
    Number.isFinite(start) && start > 0 ? Math.min(start, MOCK_RUN.endAt) : 104,
  );
  return (
    <Explorer
      run={MOCK_RUN}
      clock={clock}
      mode="sample"
      initialSelection={sampleParam('sel') ?? 'p2-stripe'}
    />
  );
}

function LiveApp({ sessionID }: { sessionID: string }) {
  const { run, clock, error } = useLiveRun(sessionID);
  if (!run) {
    return (
      <div className="grid h-full place-items-center px-4">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <span className="font-display text-[13px] font-semibold tracking-[0.18em] text-[var(--bronze)]">
            DEEPWORK
          </span>
          <p className="text-[14px]">
            {error
              ? 'Cannot reach this OpenCode session. Is it still running?'
              : 'Connecting to the deepwork session…'}
          </p>
          <code className="font-mono text-[11px] text-[var(--faint)]">
            {sessionID}
          </code>
        </div>
      </div>
    );
  }
  return <Explorer run={run} clock={clock} mode="live" stale={error} />;
}

function Explorer({
  run,
  clock,
  mode,
  stale = false,
  initialSelection,
}: {
  run: RunDef;
  clock: Clock;
  mode: 'live' | 'sample';
  stale?: boolean;
  initialSelection?: string;
}) {
  const [selected, setSelected] = useState<string | undefined>(
    initialSelection,
  );
  // Sample at quarter minutes so the map repaints a few times a second,
  // not every frame.
  const t = Math.floor(clock.t * 4) / 4;

  return (
    <RunContext.Provider value={run}>
      <TimeContext.Provider value={t}>
        <div className="flex h-full flex-col">
          <TopBar
            run={run}
            t={t}
            live={clock.following && clock.playing && !stale}
          />
          <div className="relative flex min-h-0 flex-1">
            <Floor
              run={run}
              t={t}
              selectedId={selected}
              onSelect={setSelected}
            />
            <main className="relative min-w-0 flex-1">
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    'radial-gradient(60% 50% at 50% 0%, rgba(217,166,96,0.06), transparent 70%)',
                }}
              />
              <ReactFlowProvider>
                <Canvas
                  run={run}
                  t={t}
                  selectedId={selected}
                  onSelect={setSelected}
                  follow={clock.following}
                />
              </ReactFlowProvider>
              {(mode === 'sample' || stale) && (
                <div className="pointer-events-none absolute bottom-3 left-4 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[10.5px] text-[var(--faint)]">
                  {stale
                    ? 'Connection lost · showing the last update'
                    : 'Sample run · mock data'}
                </div>
              )}
            </main>
            <Inspector
              run={run}
              t={t}
              selectedId={selected}
              onClose={() => setSelected(undefined)}
            />
          </div>
          <Timeline
            run={run}
            t={clock.t}
            head={clock.head}
            playing={clock.playing}
            speed={clock.speed}
            controls={mode === 'sample'}
            onScrub={clock.scrubTo}
            onLive={clock.live}
            onTogglePlay={clock.togglePlay}
            onSpeed={clock.nextSpeed}
            onPick={(e) => {
              clock.scrubTo(e.at + 0.01);
              if (e.nodeId) setSelected(e.nodeId);
            }}
          />
        </div>
      </TimeContext.Provider>
    </RunContext.Provider>
  );
}
