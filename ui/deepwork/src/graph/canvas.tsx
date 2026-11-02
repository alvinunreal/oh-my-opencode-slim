import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Node,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { AGENTS } from '../agents';
import type { RunDef } from '../data/types';
import {
  applyLayout,
  buildGraph,
  layout,
  type Positions,
  type WorkData,
} from './build';
import { EDGE_TYPES } from './edges';
import { NODE_TYPES } from './nodes';

const COLORS = Object.fromEntries(
  Object.entries(AGENTS).map(([id, a]) => [id, a.color]),
);

export function Canvas({
  run,
  t,
  selectedId,
  onSelect,
  follow,
}: {
  run: RunDef;
  t: number;
  selectedId?: string;
  onSelect: (id?: string) => void;
  follow: boolean;
}) {
  const graph = useMemo(() => buildGraph(run, t, COLORS), [run, t]);
  const [positions, setPositions] = useState<Positions>();
  const [layoutKey, setLayoutKey] = useState('');
  const { fitView } = useReactFlow();
  const firstFit = useRef(true);

  // Re-run ELK only when the structure changes (nodes appear, re-plans);
  // status changes repaint in place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on structure
  useEffect(() => {
    let cancelled = false;
    layout(graph.structure.elk).then((p) => {
      if (cancelled) return;
      setPositions(p);
      setLayoutKey(graph.structure.key);
    });
    return () => {
      cancelled = true;
    };
  }, [graph.structure.key]);

  const wrap = useRef<HTMLDivElement>(null);
  const followRef = useRef(follow);
  followRef.current = follow;

  // Camera follows the action: frame what is running now plus its direct
  // neighbours at a readable zoom. Re-frames on re-plans and hand-offs.
  const focus = useMemo(() => focusSet(graph), [graph]);
  const focusKey = focus.join(',');
  const frameFocus = useRef<(duration: number) => Promise<boolean>>(
    async () => false,
  );
  frameFocus.current = (duration) =>
    fitView({
      nodes: focus.map((id) => ({ id })),
      padding: 0.18,
      maxZoom: 1,
      minZoom: 0.5,
      duration,
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey re-frames on hand-offs
  useEffect(() => {
    if (!layoutKey) return;
    if (!follow && !firstFit.current) return;
    let frame = 0;
    let tries = 0;
    const attempt = async () => {
      const ok = await frameFocus.current(firstFit.current ? 0 : 900);
      if (ok) firstFit.current = false;
      else if (tries++ < 60) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [layoutKey, focusKey, follow]);

  // Keep the picture framed when panels open or the window resizes.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (followRef.current) frameFocus.current(300);
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  const computed: Node[] = useMemo(() => {
    if (!positions) return [];
    return applyLayout(graph.nodes, positions)
      .filter((n) => positions.pos.has(n.id))
      .map((n) => ({ ...n, selected: n.id === selectedId }));
  }, [graph.nodes, positions, selectedId]);

  // React Flow measures nodes through onNodesChange; keep those
  // measurements when the computed nodes are replaced.
  const [nodes, setNodes] = useState<Node[]>([]);
  useEffect(() => {
    setNodes((prev) => {
      const measured = new Map(prev.map((n) => [n.id, n.measured]));
      return computed.map((n) => ({ ...n, measured: measured.get(n.id) }));
    });
  }, [computed]);

  const edges = useMemo(() => {
    if (!positions) return [];
    return graph.edges.filter(
      (e) => positions.pos.has(e.source) && positions.pos.has(e.target),
    );
  }, [graph.edges, positions]);

  return (
    <div ref={wrap} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        onNodesChange={(changes) =>
          setNodes((ns) =>
            applyNodeChanges(
              changes.filter((c) => c.type === 'dimensions'),
              ns,
            ),
          )
        }
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          if (node.type === 'passGroup') return;
          onSelect(node.id);
        }}
        onPaneClick={() => onSelect(undefined)}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.1}
          color="rgba(255,236,214,0.09)"
        />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          position="top-right"
          pannable
          zoomable
          maskColor="rgba(7,6,5,0.72)"
          nodeBorderRadius={8}
          nodeColor={(n) => {
            if (n.type === 'passGroup') return 'rgba(217,166,96,0.08)';
            const w = (n.data as WorkData).work;
            return w ? `${AGENTS[w.agent].color}aa` : 'rgba(255,236,214,0.18)';
          }}
          style={{ width: 168, height: 96 }}
        />
      </ReactFlow>
    </div>
  );
}

/** Running nodes and their visible neighbours; falls back to the newest
 * finished node and what comes next when nobody is working. */
function focusSet(graph: ReturnType<typeof buildGraph>): string[] {
  const status = new Map<string, string>();
  for (const n of graph.nodes) {
    const d = n.data as Partial<WorkData>;
    if (d.status) status.set(n.id, d.status);
  }
  let core = [...status].filter(([, s]) => s === 'running').map(([id]) => id);
  if (core.length === 0) {
    const order = [...status.keys()];
    const lastDone = order.filter((id) => status.get(id) !== 'upcoming').pop();
    core = lastDone ? [lastDone] : order.slice(0, 1);
  }
  const set = new Set(core);
  for (const e of graph.edges) {
    if (set.has(e.target) && status.has(e.source)) set.add(e.source);
    if (core.includes(e.source) && status.has(e.target)) set.add(e.target);
  }
  return [...set].sort();
}
