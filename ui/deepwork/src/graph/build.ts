import type { Edge, Node } from '@xyflow/react';
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';

import { passPhase, statusOf } from '../data/sample';
import type { PassDef, RunDef, Status, WorkNode } from '../data/types';

export const SIZE = {
  step: { w: 236, h: 92 },
  lane: { w: 280, h: 158 },
  review: { w: 268, h: 136 },
  gate: { w: 268, h: 136 },
  passSummary: { w: 284, h: 196 },
  passGhost: { w: 284, h: 236 },
} as const;

export interface WorkData extends Record<string, unknown> {
  work: WorkNode;
  status: Status;
}
export interface PassData extends Record<string, unknown> {
  pass: PassDef;
}
export interface FlowEdgeData extends Record<string, unknown> {
  state: 'done' | 'active' | 'upcoming';
  color: string;
}

interface Structure {
  key: string;
  elk: ElkNode;
}

const elk = new ELK();

const LAYOUT = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '76',
  'elk.spacing.nodeNode': '26',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.semiInteractive': 'true',
  'elk.edgeRouting': 'SPLINES',
};

/** Visible upstream ids of a node, skipping hidden ancestors. */
function visibleAfter(
  node: WorkNode,
  byId: Map<string, WorkNode>,
  visible: Set<string>,
): string[] {
  const out = new Set<string>();
  const walk = (ids: string[]) => {
    for (const id of ids) {
      if (visible.has(id)) out.add(id);
      else {
        const up = byId.get(id);
        if (up) walk(up.after);
      }
    }
  };
  walk(node.after);
  return [...out];
}

export interface GraphModel {
  structure: Structure;
  nodes: Node[];
  edges: Edge[];
}

export function buildGraph(
  run: RunDef,
  t: number,
  colors: Record<string, string>,
): GraphModel {
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const elkRoot: ElkNode = {
    id: 'root',
    layoutOptions: LAYOUT,
    children: [],
    edges: [],
  };
  const keyParts: string[] = [];

  let prevTail: string | undefined;
  let prevStatus: Status = 'done';

  for (const pass of run.passes) {
    const phase = passPhase(run, pass, t);

    if (phase !== 'active') {
      const id = `pass-${pass.id}`;
      const size = phase === 'done' ? SIZE.passSummary : SIZE.passGhost;
      nodes.push({
        id,
        type: phase === 'done' ? 'passSummary' : 'passGhost',
        position: { x: 0, y: 0 },
        data: { pass } satisfies PassData,
        draggable: false,
      });
      elkRoot.children?.push({ id, width: size.w, height: size.h });
      keyParts.push(id);
      if (prevTail) {
        pushEdge(
          prevTail,
          id,
          phase === 'done' ? 'done' : 'upcoming',
          colors.orchestrator,
        );
        elkRoot.edges?.push({
          id: `e-${prevTail}-${id}`,
          sources: [prevTail],
          targets: [id],
        });
      }
      prevTail = id;
      prevStatus = phase === 'done' ? 'done' : 'upcoming';
      continue;
    }

    // Active pass: an expanded group with its visible work nodes.
    const groupId = `group-${pass.id}`;
    nodes.push({
      id: groupId,
      type: 'passGroup',
      position: { x: 0, y: 0 },
      data: { pass } satisfies PassData,
      draggable: false,
      selectable: false,
      zIndex: -1,
    });
    const group: ElkNode = {
      id: groupId,
      layoutOptions: {
        ...LAYOUT,
        'elk.padding': '[top=108,left=36,bottom=36,right=36]',
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': '(820, 320)',
      },
      children: [],
      edges: [],
    };
    elkRoot.children?.push(group);

    const work = run.nodes.filter((n) => n.passId === pass.id);
    const visible = new Set(
      work.filter((n) => statusOf(n, t) !== 'hidden').map((n) => n.id),
    );
    const hasSuccessor = new Set<string>();

    for (const w of work) {
      if (!visible.has(w.id)) continue;
      const status = statusOf(w, t);
      const size = SIZE[w.kind];
      nodes.push({
        id: w.id,
        type: w.kind === 'review' ? 'gate' : w.kind,
        parentId: groupId,
        position: { x: 0, y: 0 },
        data: { work: w, status } satisfies WorkData,
        draggable: false,
      });
      group.children?.push({ id: w.id, width: size.w, height: size.h });
      keyParts.push(w.id);

      const ups = visibleAfter(w, byId, visible);
      for (const up of ups) {
        hasSuccessor.add(up);
        const upStatus = statusOf(byId.get(up) as WorkNode, t);
        pushEdge(up, w.id, edgeState(upStatus, status), colors[w.agent]);
        group.edges?.push({
          id: `e-${up}-${w.id}`,
          sources: [up],
          targets: [w.id],
        });
        keyParts.push(`${up}>${w.id}`);
      }
      if (ups.length === 0 && prevTail) {
        pushEdge(
          prevTail,
          w.id,
          edgeState(prevStatus, status),
          colors[w.agent],
        );
        elkRoot.edges?.push({
          id: `e-${prevTail}-${w.id}`,
          sources: [prevTail],
          targets: [w.id],
        });
      }
    }

    const tails = work.filter(
      (w) => visible.has(w.id) && !hasSuccessor.has(w.id),
    );
    const tail = tails[tails.length - 1];
    prevTail = tail?.id;
    prevStatus = tail ? statusOf(tail, t) : 'upcoming';
  }

  function pushEdge(
    source: string,
    target: string,
    state: FlowEdgeData['state'],
    color: string,
  ) {
    edges.push({
      id: `e-${source}-${target}`,
      source,
      target,
      type: 'flow',
      data: { state, color } satisfies FlowEdgeData,
    });
  }

  return {
    structure: { key: keyParts.join('|'), elk: elkRoot },
    nodes,
    edges,
  };
}

function edgeState(from: Status, to: Status): FlowEdgeData['state'] {
  if (to === 'running') return 'active';
  if (to === 'upcoming' || from === 'upcoming' || from === 'running')
    return 'upcoming';
  return 'done';
}

export interface Positions {
  pos: Map<string, { x: number; y: number }>;
  size: Map<string, { w: number; h: number }>;
}

export async function layout(elkRoot: ElkNode): Promise<Positions> {
  const result = await elk.layout(structuredClone(elkRoot));
  const pos = new Map<string, { x: number; y: number }>();
  const size = new Map<string, { w: number; h: number }>();
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
      size.set(c.id, { w: c.width ?? 0, h: c.height ?? 0 });
      walk(c);
    }
  };
  walk(result);
  return { pos, size };
}

export function applyLayout(nodes: Node[], positions: Positions): Node[] {
  return nodes.map((n) => {
    const p = positions.pos.get(n.id);
    if (!p) return n;
    if (n.type === 'passGroup') {
      const s = positions.size.get(n.id);
      return { ...n, position: p, style: { width: s?.w, height: s?.h } };
    }
    return { ...n, position: p };
  });
}
