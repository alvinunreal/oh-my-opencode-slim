import { describe, expect, test } from 'bun:test';
import {
  getActiveSidebarAgentNames,
  getSidebarAgentTargets,
  getSidebarReusableTargets,
} from './tui';
import { type HostSessionInfo, overlayHostSessions } from './tui-host-sessions';
import { snapshotSectionsEqual, type TuiSnapshot } from './tui-state';

function snapshot(): TuiSnapshot {
  return {
    version: 1,
    updatedAt: 0,
    agentModels: { explorer: 'local/model', oracle: 'local/model' },
    agentVariants: {},
    agentDisplayNames: {},
    activeSessions: {},
    activityPids: {},
    sessionParents: {},
    sessionDetails: {},
    reusableByAgent: {},
    reusableOwners: {},
  };
}

function host(...initial: HostSessionInfo[]) {
  const sessions = new Map(initial.map((entry) => [entry.id, entry]));
  const running = new Set<string>();
  const rootOf = (id: string) => {
    const seen = new Set<string>();
    while (sessions.get(id)?.parentID && !seen.has(id)) {
      seen.add(id);
      id = sessions.get(id)?.parentID as string;
    }
    return id;
  };
  const session = {
    get: (id: string) => sessions.get(id),
    family: (id: string) =>
      [...sessions.keys()].filter((key) => rootOf(key) === rootOf(id)),
    status: (id: string): 'idle' | 'running' =>
      running.has(id) ? 'running' : 'idle',
  };
  return { sessions, running, session };
}

const root: HostSessionInfo = {
  id: 'root',
  agent: 'orchestrator',
  time: { created: 1 },
};

describe('overlayHostSessions', () => {
  test('finished child becomes a reusable target without mutating the snapshot', () => {
    const original = snapshot();
    const data = host(root, {
      id: 'child',
      parentID: 'root',
      agent: 'explorer',
      outcome: 'succeeded',
      time: { created: 10, idle: 20 },
    });
    const projected = overlayHostSessions(
      original,
      { visibleSessionID: 'root', session: data.session },
      2,
    );
    expect(
      getSidebarReusableTargets(projected, 'root').get('explorer'),
    ).toEqual([
      { taskID: 'child', alias: 'exp-1', completedAt: 20, lastUsedAt: 20 },
    ]);
    expect(original.reusableByAgent).toEqual({});
  });

  test('running, interrupted, succeeded, failed and excluded sessions map to their states', () => {
    const data = host(
      root,
      { id: 'live', parentID: 'root', agent: 'explorer', time: { created: 1 } },
      {
        id: 'stopped',
        parentID: 'root',
        agent: 'oracle',
        outcome: 'interrupted',
        time: { created: 2, idle: 22 },
      },
      {
        id: 'ok',
        parentID: 'root',
        agent: 'oracle',
        outcome: 'succeeded',
        time: { created: 3, idle: 23 },
      },
      {
        id: 'failed',
        parentID: 'root',
        agent: 'oracle',
        outcome: 'failed',
        time: { created: 4, idle: 24 },
      },
      { id: 'never', parentID: 'root', agent: 'fixer', time: { created: 5 } },
      {
        id: 'archived',
        parentID: 'root',
        agent: 'fixer',
        outcome: 'succeeded',
        time: { created: 6, idle: 26, archived: 27 },
      },
    );
    data.running.add('root');
    data.running.add('live');
    const projected = overlayHostSessions(
      snapshot(),
      { visibleSessionID: 'root', session: data.session },
      3,
    );
    expect(projected.activeSessions).toEqual({
      root: 'orchestrator',
      live: 'explorer',
    });
    expect(projected.sessionDetails.live).toEqual({
      alias: 'exp-1',
      status: 'busy',
    });
    expect(projected.reusableByAgent.root.oracle).toEqual([
      {
        taskID: 'failed',
        alias: 'ora-3',
        terminalState: 'error',
        completedAt: 24,
        lastUsedAt: 24,
      },
      {
        taskID: 'ok',
        alias: 'ora-2',
        terminalState: 'completed',
        completedAt: 23,
        lastUsedAt: 23,
      },
      {
        taskID: 'stopped',
        alias: 'ora-1',
        terminalState: 'stopped',
        completedAt: 22,
        lastUsedAt: 22,
      },
    ]);
    expect(projected.reusableByAgent.root.fixer).toBeUndefined();
  });

  test('aliases rank by creation and prefix independently for each parent', () => {
    const data = host(
      root,
      {
        id: 'late',
        parentID: 'root',
        agent: 'explorer',
        time: { created: 30 },
      },
      {
        id: 'early',
        parentID: 'root',
        agent: 'explorer',
        time: { created: 10 },
      },
      {
        id: 'custom',
        parentID: 'root',
        agent: 'expedition',
        time: { created: 20 },
      },
      {
        id: 'nested',
        parentID: 'early',
        agent: 'explorer',
        time: { created: 40 },
      },
      {
        id: 'reserved',
        parentID: 'root',
        agent: 'constructor',
        time: { created: 50 },
      },
    );
    for (const id of ['late', 'early', 'custom', 'nested', 'reserved'])
      data.running.add(id);
    const projected = overlayHostSessions(
      snapshot(),
      { visibleSessionID: 'root', session: data.session },
      2,
    );
    expect(
      Object.fromEntries(
        Object.entries(projected.sessionDetails).map(([id, detail]) => [
          id,
          detail.alias,
        ]),
      ),
    ).toEqual({
      early: 'exp-1',
      custom: 'exp-2',
      late: 'exp-3',
      nested: 'exp-1',
      reserved: 'con-1',
    });
    expect(projected.sessionDetails.early).toEqual({
      alias: 'exp-1',
      status: 'busy',
    });
  });

  test('cap keeps the two most recently idle per parent and all running children', () => {
    const data = host(
      root,
      {
        id: 'one',
        parentID: 'root',
        agent: 'oracle',
        outcome: 'succeeded',
        time: { created: 1, idle: 300 },
      },
      {
        id: 'two',
        parentID: 'root',
        agent: 'oracle',
        outcome: 'succeeded',
        time: { created: 2, idle: 100 },
      },
      {
        id: 'three',
        parentID: 'root',
        agent: 'oracle',
        outcome: 'succeeded',
        time: { created: 3, idle: 200 },
      },
      {
        id: 'running-a',
        parentID: 'root',
        agent: 'oracle',
        time: { created: 4 },
      },
      {
        id: 'running-b',
        parentID: 'root',
        agent: 'oracle',
        time: { created: 5 },
      },
      {
        id: 'other-parent-child',
        parentID: 'one',
        agent: 'oracle',
        outcome: 'succeeded',
        time: { created: 6, idle: 50 },
      },
    );
    data.running.add('running-a');
    data.running.add('running-b');
    const projected = overlayHostSessions(
      snapshot(),
      { visibleSessionID: 'root', session: data.session },
      2,
    );
    expect(
      projected.reusableByAgent.root.oracle.map((entry) => entry.taskID),
    ).toEqual(['one', 'three']);
    expect(
      projected.reusableByAgent.one.oracle.map((entry) => entry.taskID),
    ).toEqual(['other-parent-child']);
    expect(Object.keys(projected.activeSessions)).toEqual([
      'running-a',
      'running-b',
    ]);

    data.sessions.set('two', {
      id: 'two',
      parentID: 'root',
      agent: 'oracle',
      time: { created: 2, busy: 400 },
    });
    const provisional = overlayHostSessions(
      snapshot(),
      { visibleSessionID: 'root', session: data.session },
      2,
    );
    expect(
      provisional.reusableByAgent.root.oracle.map((entry) => entry.taskID),
    ).toEqual(['two', 'one']);
  });

  test('root scoping ignores persisted activity from another conversation', () => {
    const original = snapshot();
    original.activeSessions = { alien: 'oracle' };
    original.sessionParents = { alien: 'other-root' };
    original.reusableByAgent = {
      'other-root': {
        oracle: [
          {
            taskID: 'alien-old',
            alias: 'ora-1',
            terminalState: 'completed',
            lastUsedAt: 2,
          },
        ],
      },
    };
    const data = host(
      root,
      {
        id: 'child',
        parentID: 'root',
        agent: 'explorer',
        outcome: 'succeeded',
        time: { created: 3, idle: 4 },
      },
      {
        id: 'live',
        parentID: 'root',
        agent: 'explorer',
        time: { created: 5 },
      },
      { id: 'other-root', time: { created: 1 } },
      {
        id: 'alien',
        parentID: 'other-root',
        agent: 'oracle',
        time: { created: 2 },
      },
    );
    data.running.add('alien');
    data.running.add('live');
    const projected = overlayHostSessions(
      original,
      { visibleSessionID: 'root', session: data.session },
      2,
    );
    expect([...getSidebarReusableTargets(projected, 'root').keys()]).toEqual([
      'explorer',
    ]);
    expect([...getActiveSidebarAgentNames(projected, 'child')]).toEqual([
      'explorer',
    ]);
    expect(
      getSidebarAgentTargets(projected, 'root')[0].sessions[0].sessionID,
    ).toBe('live');
  });

  test('legacy running projections are ignored, and missing capability preserves reference', () => {
    const original = snapshot();
    original.reusableByAgent = {
      root: { oracle: [{ taskID: 'stale', alias: 'ora-1', running: true }] },
    };
    original.activeSessions = { stale: 'oracle' };
    original.activityPids = { stale: 123 };
    original.reusableOwners = { root: 123 };
    original.sessionParents = { stale: 'root' };
    const data = host(root);
    const projected = overlayHostSessions(
      original,
      { visibleSessionID: 'root', session: data.session },
      2,
    );
    expect([...getActiveSidebarAgentNames(projected, 'root')]).toEqual([]);
    expect(projected.activeSessions).toEqual({});
    expect(projected.activityPids).toEqual({});
    expect(projected.reusableByAgent).toEqual({});
    expect(projected.reusableOwners).toEqual({});
    expect(overlayHostSessions(original, undefined, 2)).toBe(original);
    expect(
      overlayHostSessions(
        original,
        { visibleSessionID: 'root', session: {} },
        2,
      ),
    ).toBe(original);
  });

  test('the same host view produces stable snapshot sections on a second pass', () => {
    const data = host(root, {
      id: 'child',
      parentID: 'root',
      agent: 'explorer',
      outcome: 'succeeded',
      time: { created: 10, idle: 20 },
    });
    const views = { visibleSessionID: 'root', session: data.session };
    const first = overlayHostSessions(snapshot(), views, 2);
    const second = overlayHostSessions(first, views, 2);
    expect(snapshotSectionsEqual(first, second)).toBe(true);
  });

  test('depth-two targets use the derived parent alias for via attribution', () => {
    const data = host(
      root,
      {
        id: 'parent',
        parentID: 'root',
        agent: 'explorer',
        outcome: 'succeeded',
        time: { created: 10, idle: 20 },
      },
      {
        id: 'nested',
        parentID: 'parent',
        agent: 'oracle',
        time: { created: 30 },
      },
      {
        id: 'newer-a',
        parentID: 'root',
        agent: 'explorer',
        outcome: 'succeeded',
        time: { created: 40, idle: 50 },
      },
      {
        id: 'newer-b',
        parentID: 'root',
        agent: 'explorer',
        outcome: 'succeeded',
        time: { created: 60, idle: 70 },
      },
    );
    data.running.add('nested');
    const projected = overlayHostSessions(
      snapshot(),
      { visibleSessionID: 'root', session: data.session },
      2,
    );
    expect(
      projected.reusableByAgent.root.explorer.map((entry) => entry.taskID),
    ).toEqual(['newer-b', 'newer-a']);
    const target = getSidebarAgentTargets(projected, 'root').find(
      (group) => group.agentName === 'oracle',
    )?.sessions[0];
    expect(target?.viaParent).toBe('exp-1');
  });

  test('display names are canonicalized before grouping and alias creation', () => {
    const original = snapshot();
    original.agentDisplayNames = { explorer: 'Scout' };
    const data = host(root, {
      id: 'child',
      parentID: 'root',
      agent: 'Scout',
      outcome: 'succeeded',
      time: { created: 10, idle: 20 },
    });
    const projected = overlayHostSessions(
      original,
      { visibleSessionID: 'root', session: data.session },
      2,
    );
    expect(
      getSidebarReusableTargets(projected, 'root').get('explorer')?.[0].alias,
    ).toBe('exp-1');
    expect(getSidebarReusableTargets(projected, 'root').has('Scout')).toBe(
      false,
    );
  });

  test('deleted host sessions disappear on the next overlay', () => {
    const data = host(root, {
      id: 'child',
      parentID: 'root',
      agent: 'explorer',
      outcome: 'succeeded',
      time: { created: 10, idle: 20 },
    });
    const views = { visibleSessionID: 'root', session: data.session };
    const first = overlayHostSessions(snapshot(), views, 2);
    expect(
      getSidebarReusableTargets(first, 'root').get('explorer')?.[0].taskID,
    ).toBe('child');
    data.sessions.delete('child');
    const afterDelete = overlayHostSessions(first, views, 2);
    expect(getSidebarReusableTargets(afterDelete, 'root').has('explorer')).toBe(
      false,
    );
    expect(afterDelete.sessionParents.child).toBeUndefined();
  });
});
