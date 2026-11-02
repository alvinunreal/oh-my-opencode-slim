# Deepwork Explorer (prototype)

Live visual explorer for a `/deepwork` run: passes, lanes, agents, oracle
reviews and gates, known issues, and a replayable timeline.

Status: UI prototype on mock data (`src/data/mock-run.ts`). It is not wired to
the plugin yet and is not part of the published package.

```bash
cd ui/deepwork
bun install
bun run dev        # http://localhost:5173/?t=133&sel=p2-gate1 opens a moment
bun run build      # dist/index.html, one self-contained file
```

Stack: React, React Flow (`@xyflow/react`), ELK layout, Motion, Tailwind.

The UI renders a `RunDef` (`src/data/types.ts`) sampled at time `t`. Wiring
plan: derive it from host session events and the background job board (who,
status, timing), child session messages (oracle verdicts) and `progress.md`
(pass, next step, known issues), streamed over SSE from the interview
dashboard server. Observation only: no prompt bytes, no cache impact.
