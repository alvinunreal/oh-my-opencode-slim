# Deepwork Explorer (prototype)

Live visual explorer for a `/deepwork` run: passes, lanes, agents, oracle
reviews and gates, known issues, and a replayable timeline.

Served by the plugin (`src/deepwork-explorer/`) at `/s/<session-id>` when
`/deepwork` starts; the package build copies `dist/index.html` to
`dist/deepwork-explorer.html`. Opened without a session path (plain
`bun run dev`), it plays a sample run from `src/data/mock-run.ts`.

```bash
cd ui/deepwork
bun install
bun run dev        # http://localhost:5173/?t=133&sel=p2-gate1 opens a moment
bun run build      # dist/index.html, one self-contained file
```

Stack: React, React Flow (`@xyflow/react`), ELK layout, Motion, Tailwind.

The UI renders a `RunDef` (`src/data/types.ts`) sampled at time `t`. Live
runs poll `/api/s/<session-id>` every 2 s for a snapshot built from the router
head, `progress.md` (pass, goal, next step, decision, known issues) and the
background job board (lanes, agents, timing, result text including oracle
verdicts); `src/data/live.ts` maps it to a `RunDef`. Observation only: no
prompt bytes, no cache impact.
