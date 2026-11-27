// Setup-fixed subset of the pinned host event union. The mirror guard checks
// each name; server.connected passes automatically through native filters.
const IDENTITY_TYPES = [
  'session.created',
  'session.deleted',
  'session.agent.selected',
  'session.moved',
] as const;

const LIFECYCLE_TYPES = [
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.status',
  'session.idle',
] as const;

const STEP_TYPES = [
  'session.step.started',
  'session.step.failed',
  'session.step.ended',
] as const;

const INPUT_TYPES = [
  'form.created',
  'form.replied',
  'form.cancelled',
  'permission.asked',
  'permission.replied',
] as const;

const INTERVIEW_TEXT_TYPES = ['session.text.ended'] as const;

export type V2EventSubscriptionType =
  | (typeof IDENTITY_TYPES)[number]
  | (typeof LIFECYCLE_TYPES)[number]
  | (typeof STEP_TYPES)[number]
  | (typeof INPUT_TYPES)[number]
  | (typeof INTERVIEW_TEXT_TYPES)[number];

export interface V2EventSubscriptionOptions {
  sidebar: boolean;
  fallback: boolean;
  companion: boolean;
  cacheMonitor: boolean;
  toolLoopGuard: boolean;
  interview: boolean;
}

export function buildV2EventSubscriptionTypes(
  options: V2EventSubscriptionOptions,
): ReadonlyArray<V2EventSubscriptionType> {
  const types = new Set<V2EventSubscriptionType>(IDENTITY_TYPES);
  if (
    options.sidebar ||
    options.fallback ||
    options.companion ||
    options.toolLoopGuard ||
    options.interview
  ) {
    for (const type of LIFECYCLE_TYPES) types.add(type);
  }
  if (options.fallback) {
    for (const type of STEP_TYPES) types.add(type);
  }
  if (options.cacheMonitor) {
    types.add('session.step.started');
    types.add('session.step.ended');
  }
  if (options.interview) {
    types.add('session.step.failed');
    for (const type of INTERVIEW_TEXT_TYPES) types.add(type);
  }
  if (options.companion) {
    for (const type of INPUT_TYPES) types.add(type);
  }
  return Object.freeze([...types]);
}
