// Setup-fixed subset of the pinned host event union. The mirror guard checks
// each name; server.connected passes automatically through native filters.
const BASE_TYPES = [
  'session.created',
  'session.deleted',
  'session.agent.selected',
  'session.moved',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.status',
  'session.idle',
  'session.usage.updated',
  'session.step.started',
  'session.step.failed',
  'session.step.ended',
  'form.created',
  'form.replied',
  'form.cancelled',
  'permission.asked',
  'permission.replied',
] as const;

const INTERVIEW_TEXT_TYPES = [
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
] as const;

export type V2EventSubscriptionType =
  | (typeof BASE_TYPES)[number]
  | (typeof INTERVIEW_TEXT_TYPES)[number];

export interface V2EventSubscriptionOptions {
  interview?: boolean;
}

export function buildV2EventSubscriptionTypes(
  options?: V2EventSubscriptionOptions,
): ReadonlyArray<V2EventSubscriptionType> {
  return Object.freeze(
    options?.interview
      ? [...BASE_TYPES, ...INTERVIEW_TEXT_TYPES]
      : [...BASE_TYPES],
  );
}

// Other token streams have no consumer in the plugin. Text deltas bypass
// permission/profile handling; Interview scopes them to its managed sessions.
export function isV2StreamDeltaType(type: string): boolean {
  return type === 'session.text.delta';
}
