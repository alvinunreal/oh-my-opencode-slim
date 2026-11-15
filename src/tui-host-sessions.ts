import type {
  TuiReusableSession,
  TuiSessionDetails,
  TuiSnapshot,
} from './tui-state';
import { createTeamDisplayIdentity } from './v2/team-display';

export interface HostSessionInfo {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  time: { created: number; idle?: number; archived?: number };
}

export interface HostSessionViews {
  visibleSessionID?: string;
  session?: {
    get?: (id: string) => HostSessionInfo | undefined;
    family?: (id: string) => string[];
    status?: (id: string) => 'idle' | 'running';
  };
}

const AGENT_PREFIX: Record<string, string> = {
  council: 'cou',
  designer: 'des',
  explorer: 'exp',
  fixer: 'fix',
  observer: 'obs',
  oracle: 'ora',
};

export function overlayHostSessions(
  snapshot: TuiSnapshot,
  hostViews: HostSessionViews | undefined,
  cap: number,
): TuiSnapshot {
  const session = hostViews?.session;
  if (!session?.get || !session.family || !session.status) return snapshot;

  const activeSessions: Record<string, string> = {};
  const sessionDetails: Record<string, TuiSessionDetails> = {};
  const sessionParents: Record<string, string> = {};
  const reusable = new Map<string, Map<string, TuiReusableSession[]>>();
  const aliases = new Map<string, string>();
  const counts = new Map<string, number>();
  const { canonicalName } = createTeamDisplayIdentity(
    snapshot.agentDisplayNames,
  );
  const visible = hostViews?.visibleSessionID;
  const members = visible
    ? session
        .family(visible)
        .map((id) => session.get?.(id))
        .filter((info): info is HostSessionInfo => info !== undefined)
        .sort(
          (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
        )
    : [];

  for (const info of members) {
    if (info.parentID) sessionParents[info.id] = info.parentID;
    if (!info.agent) continue;
    const agent = canonicalName(info.agent);
    let alias: string | undefined;
    if (info.parentID) {
      const prefix = Object.hasOwn(AGENT_PREFIX, agent)
        ? AGENT_PREFIX[agent]
        : agent.slice(0, 3);
      const key = `${info.parentID}:${prefix}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      alias = `${prefix}-${count}`;
      aliases.set(info.id, alias);
    }
    if (info.time.archived !== undefined) continue;
    if (session.status(info.id) === 'running') {
      activeSessions[info.id] = agent;
      sessionDetails[info.id] = { ...(alias ? { alias } : {}), status: 'busy' };
      continue;
    }
    if (
      !info.parentID ||
      !alias ||
      (!info.outcome && info.time.idle === undefined)
    )
      continue;
    const byAgent = reusable.get(info.parentID) ?? new Map();
    const entries = byAgent.get(agent) ?? [];
    entries.push({
      taskID: info.id,
      alias,
      terminalState:
        info.outcome === 'interrupted'
          ? 'stopped'
          : info.outcome === 'failed'
            ? 'error'
            : 'completed',
      ...(info.time.idle === undefined ? {} : { completedAt: info.time.idle }),
      lastUsedAt: info.time.idle ?? info.time.created,
    });
    byAgent.set(agent, entries);
    reusable.set(info.parentID, byAgent);
  }

  const reusableByAgent = Object.fromEntries(
    [...reusable].map(([parent, byAgent]) => [
      parent,
      Object.fromEntries(
        [...byAgent].map(([agent, entries]) => [
          agent,
          entries
            .sort(
              (a, b) =>
                (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
                b.taskID.localeCompare(a.taskID),
            )
            .slice(0, cap),
        ]),
      ),
    ]),
  );
  // An idle parent can fall outside its own history cap but still label a child.
  for (const parent of Object.values(sessionParents)) {
    const alias = aliases.get(parent);
    if (alias && !sessionDetails[parent]) {
      sessionDetails[parent] = { alias };
    }
  }
  return {
    ...snapshot,
    activeSessions,
    activityPids: {},
    sessionParents,
    sessionDetails,
    reusableByAgent,
    reusableOwners: {},
  };
}
