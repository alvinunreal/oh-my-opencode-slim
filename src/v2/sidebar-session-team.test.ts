import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import {
  getSidebarAgentTargets,
  getSidebarReusableTargets,
  projectSidebarTeam,
  renderSidebar,
} from '../tui';
import { readTuiSnapshot } from '../tui-state';
import type { SessionPresetState } from './preset-rpc';
import { makeTestEnv } from './test-fixtures';

let env: ReturnType<typeof makeTestEnv>;
beforeEach(() => {
  env = makeTestEnv('omos-sidebar-team');
});
afterEach(() => env.restore());

function state(model = 'saved/team-model'): SessionPresetState {
  return {
    sessionID: 'ses_root',
    status: 'bound',
    presetName: 'same-name',
    affects: 'future-delegations',
    team: {
      agentModels: { oracle: model },
      agentVariants: {},
      inheritance: { explorer: 'session' },
    },
  };
}

describe('window-local sidebar team', () => {
  test('visible-only saved values and activity resolve through registry identity', () => {
    const snapshot = readTuiSnapshot(env.projectDir);
    snapshot.agentModels = { oracle: 'latest/model' };
    snapshot.agentDisplayNames = { oracle: 'Research Lead' };
    snapshot.activeSessions = { ses_task: 'Research Lead' };
    snapshot.reusableByAgent = {
      ses_root: {
        'Research Lead': [
          { taskID: 'ses_task', alias: 'lead-1', running: true },
        ],
      },
    };
    const saved: SessionPresetState = {
      ...state(),
      team: {
        agentModels: { 'Research Lead': 'saved/model' },
        agentVariants: { 'Research Lead': 'medium' },
        inheritance: {},
      },
    };
    const before = structuredClone({ snapshot, saved });
    const projected = projectSidebarTeam(snapshot, saved);
    expect(projected.agentModels).toEqual({ oracle: 'saved/model' });
    expect(projected.agentVariants).toEqual({ oracle: 'medium' });
    expect(projected.activeSessions).toEqual({ ses_task: 'oracle' });
    expect(projected.reusableByAgent.ses_root).toEqual({
      oracle: [{ taskID: 'ses_task', alias: 'lead-1', running: true }],
    });
    expect({ snapshot, saved }).toEqual(before);
  });

  test('saved team replaces directory defaults without mutating the shared snapshot', () => {
    const snapshot = readTuiSnapshot(env.projectDir);
    snapshot.agentModels = {
      oracle: 'latest/definition',
      explorer: 'latest/explorer',
    };
    snapshot.agentVariants = { oracle: 'latest-variant' };
    const before = structuredClone(snapshot);
    const first = projectSidebarTeam(snapshot, state());
    const second = projectSidebarTeam(
      snapshot,
      state('second/same-name-update'),
    );
    expect(first.agentModels).toEqual({
      oracle: 'saved/team-model',
      explorer: 'Inherits session',
    });
    expect(first.agentVariants).toEqual({});
    expect(second.agentModels.oracle).toBe('second/same-name-update');
    const legacy = projectSidebarTeam(snapshot, {
      ...state(),
      team: {
        agentModels: { librarian: 'saved/legacy-model' },
        agentVariants: { librarian: 'medium' },
        inheritance: { 'frontend-ui-ux-engineer': 'session' },
      },
    });
    expect(legacy.agentModels).toEqual({
      oracle: 'Unknown',
      explorer: 'saved/legacy-model',
      designer: 'Inherits session',
    });
    expect(legacy.agentVariants).toEqual({ explorer: 'medium' });
    expect(snapshot).toEqual(before);
    expect(readTuiSnapshot(env.projectDir).agentModels).toEqual({});
  });

  test('missing or unavailable binding never uses directory models as saved team', () => {
    const snapshot = readTuiSnapshot(env.projectDir);
    snapshot.agentModels = { oracle: 'latest/definition' };
    expect(projectSidebarTeam(snapshot).agentModels.oracle).toBe('Unknown');
    expect(
      projectSidebarTeam(snapshot, { ...state(), team: undefined }).agentModels
        .oracle,
    ).toBe('Unknown');
  });

  test('committed model, picker, future delegation and existing task keep separate labels', async () => {
    const snapshot = readTuiSnapshot(env.projectDir);
    snapshot.agentModels = {
      oracle: 'latest/definition',
      explorer: 'latest/explorer',
    };
    snapshot.agentDisplayNames = {
      oracle: 'Research Lead',
      explore: 'explorer',
      librarian: 'explorer',
      custom_a: 'custom reviewer',
      custom_b: 'custom reviewer',
    };
    snapshot.sessionParents = { ses_task: 'ses_root' };
    const saved: SessionPresetState = {
      ...state(),
      team: {
        agentModels: {
          orchestrator: 'capture/root',
          // Canonical entries win even when inserted after their aliases.
          explore: 'legacy/explore',
          librarian: 'legacy/librarian',
          explorer: 'capture/b',
          oracle: 'saved/team-model',
          'Research Lead': 'saved/team-model',
          custom_a: 'saved/custom-model',
          custom_b: 'saved/custom-model',
        },
        agentVariants: {
          designer: 'medium',
          fixer: 'low',
          oracle: 'high',
          explore: 'low',
          librarian: 'medium',
          explorer: 'high',
        },
        inheritance: { designer: 'session', fixer: 'orchestrator' },
      },
    };
    const savedBefore = structuredClone(saved);
    for (const taskAgent of ['explorer', 'explore', 'librarian']) {
      snapshot.activeSessions = { ses_task: taskAgent };
      snapshot.reusableByAgent = {
        ses_root: {
          explorer: [{ taskID: 'ses_task', alias: 'exp-1', running: true }],
          librarian: [{ taskID: 'ses_task', alias: 'exp-1', running: true }],
        },
      };
      const before = structuredClone(snapshot);
      const projected = projectSidebarTeam(snapshot, saved);
      expect(projected.agentModels).toEqual({
        oracle: 'saved/team-model',
        explorer: 'capture/b',
        orchestrator: 'capture/root',
        custom_a: 'saved/custom-model',
        custom_b: 'saved/custom-model',
        designer: 'Inherits session',
        fixer: 'Inherits orchestrator',
      });
      expect(projected.agentVariants).toEqual({
        explorer: 'high',
        designer: 'medium',
        fixer: 'low',
        oracle: 'high',
      });
      expect(getSidebarAgentTargets(projected, 'ses_root')).toMatchObject([
        {
          agentName: 'explorer',
          sessions: [{ sessionID: 'ses_task', agentName: 'explorer' }],
        },
      ]);
      expect(
        getSidebarReusableTargets(projected, 'ses_root').get('explorer'),
      ).toHaveLength(1);
      const rendered = await testRender(
        () =>
          renderSidebar(
            projected,
            'test',
            {
              accent: '#777777',
              background: '#111111',
              borderActive: '#555555',
              text: '#eeeeee',
              textMuted: '#aaaaaa',
            },
            false,
            false,
            () => 0,
            'ses_root',
            undefined,
            { name: 'global', sessionLabel: 'same-name' },
            undefined,
            {
              state: saved,
              nativeModel: 'native/main-model',
              selectedModel: 'picker/next-model #high',
              taskModel: () => 'actual/task-model',
            },
          ),
        { width: 80, height: 40 },
      );
      try {
        await rendered.renderOnce();
        const frame = rendered.captureCharFrame();
        expect(frame).toContain('Current model: native/main-model');
        expect(frame).toContain('Next prompt: picker/next-model #high');
        expect(frame).toContain('Team · next delegation');
        expect(frame.indexOf('Next prompt:')).toBeLessThan(
          frame.indexOf('Team · next delegation'),
        );
        expect(frame).toContain('team-model');
        expect(frame.match(/Research Lead/g)).toHaveLength(1);
        expect(frame).toMatch(/Inherits session\s+variant\s+medium/);
        expect(frame).toMatch(/Inherits orchestrator\s+variant\s+low/);
        expect(frame).toMatch(/team-model\s+variant\s+high/);
        expect(frame).toContain('Task: actual/task-model');
        expect(frame.match(/\bexplorer\b/g)).toHaveLength(1);
        expect(frame.match(/custom reviewer/g)).toHaveLength(2);
        expect(frame.match(/Task: actual\/task-model/g)).toHaveLength(1);
        expect(frame).not.toContain('legacy/');
        expect(frame).not.toContain('latest/definition');
        expect(snapshot).toEqual(before);
        expect(saved).toEqual(savedBefore);
      } finally {
        rendered.renderer.destroy();
      }
    }
  });
});
