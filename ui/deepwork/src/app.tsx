import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';

import { Floor } from './components/floor';
import { Inspector } from './components/inspector';
import { Timeline } from './components/timeline';
import { TopBar } from './components/top-bar';
import { TimeContext } from './components/ui';
import { MOCK_RUN } from './data/mock-run';
import { Canvas } from './graph/canvas';

const run = MOCK_RUN;
/** Sample minutes advanced per real second at 1×. */
const RATE = 0.8;
const SPEEDS = [1, 4, 12];

/**
 * Mock clock. `head` stands in for "now" in a live run and only moves
 * forward; `t` is what the map shows. Following live keeps t on the head;
 * scrubbing detaches it for replay.
 */
function useRunClock(start: number) {
  const [head, setHead] = useState(start);
  const [scrub, setScrub] = useState<number>();
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
  }, [playing, speed]);

  const t = scrub ?? head;
  return {
    t,
    head,
    playing,
    speed,
    following: scrub === undefined,
    scrubTo: (v: number) => setScrub(v >= head - 0.05 ? undefined : v),
    live: () => setScrub(undefined),
    togglePlay: () => setPlaying((p) => !p),
    nextSpeed: () =>
      setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]),
  };
}

/** `?t=133` opens the sample at a given minute (local previews only). */
function startTime(): number {
  try {
    const v = Number(new URLSearchParams(window.location.search).get('t'));
    return Number.isFinite(v) && v > 0 ? Math.min(v, run.endAt) : 104;
  } catch {
    return 104;
  }
}

export function App() {
  const clock = useRunClock(startTime());
  const [selected, setSelected] = useState<string | undefined>(() => {
    try {
      return (
        new URLSearchParams(window.location.search).get('sel') ?? 'p2-stripe'
      );
    } catch {
      return 'p2-stripe';
    }
  });
  // Sample at whole-ish minutes so the map repaints a few times a second,
  // not every frame.
  const t = Math.floor(clock.t * 4) / 4;

  return (
    <TimeContext.Provider value={t}>
      <div className="flex h-full flex-col">
        <TopBar run={run} t={t} live={clock.following && clock.playing} />
        <div className="relative flex min-h-0 flex-1">
          <Floor run={run} t={t} selectedId={selected} onSelect={setSelected} />
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
            <div className="pointer-events-none absolute bottom-3 left-4 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[10.5px] text-[var(--faint)]">
              Sample run · mock data
            </div>
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
  );
}
