import { BaseEdge, type EdgeProps, getBezierPath } from '@xyflow/react';

import type { FlowEdgeData } from './build';

export function FlowEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } =
    props;
  const data = props.data as FlowEdgeData;
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.35,
  });

  if (data.state === 'upcoming') {
    return (
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          stroke: 'var(--line-2)',
          strokeWidth: 1.25,
          strokeDasharray: '3 5',
        }}
      />
    );
  }

  if (data.state === 'done') {
    return (
      <BaseEdge
        id={props.id}
        path={path}
        style={{ stroke: 'rgba(243,237,228,0.22)', strokeWidth: 1.4 }}
      />
    );
  }

  // Active: work is flowing into a running node.
  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke={data.color}
        strokeOpacity={0.18}
        strokeWidth={6}
      />
      <path
        d={path}
        fill="none"
        stroke={data.color}
        strokeWidth={1.6}
        className="edge-flow"
      />
      <circle r={3.2} fill={data.color}>
        <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
      </circle>
    </g>
  );
}

export const EDGE_TYPES = { flow: FlowEdge };
