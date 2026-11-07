import { describe, expect, test } from 'bun:test';
import {
  compactJson,
  type DraftBaseline,
  diffDraft,
  draftConflicts,
  goCapForModel,
  groupModels,
  isExplicitBindingFor,
  type ModelShapeLike,
  sessionBinding,
  sessionStateKey,
  verifyAppliedState,
  verifyResetState,
  verifySessionState,
  workspaceKey,
} from './gui-domain';

const bound = (
  presetName: string | null,
  selection?: 'explicit' | 'default',
) => ({
  sessionID: 'session-1',
  status: 'bound' as const,
  presetName,
  affects: 'future-children-only' as const,
  ...(selection ? { selection } : {}),
});

describe('session preset state', () => {
  test('accepts a bound unnamed default team and displays it as default', () => {
    const state = verifySessionState(bound(null), 'session-1');
    expect(state.status).toBe('bound');
    expect(state.presetName).toBeNull();
    expect(state.selection).toBe('explicit');
    expect(sessionBinding(state)).toEqual({
      kind: 'default-team',
      presetName: null,
    });
    expect(isExplicitBindingFor(state, 'Default')).toBe(false);
  });

  test('legacy responses without selection are explicit', () => {
    const state = verifySessionState(bound('writer'), 'session-1');
    expect(state.selection).toBe('explicit');
    expect(sessionBinding(state)).toEqual({
      kind: 'preset',
      presetName: 'writer',
    });
    expect(isExplicitBindingFor(state, 'writer')).toBe(true);
  });

  test('bound default selection stays off even when the name matches', () => {
    const state = verifySessionState(bound('writer', 'default'), 'session-1');
    expect(sessionBinding(state)).toEqual({
      kind: 'default-team',
      presetName: 'writer',
    });
    expect(isExplicitBindingFor(state, 'writer')).toBe(false);
  });

  test('rejects inconsistent or unknown responses', () => {
    expect(() =>
      verifySessionState(bound('writer', 'legacy' as never), 'session-1'),
    ).toThrow();
    expect(() => verifySessionState(bound(''), 'session-1')).toThrow();
    expect(() =>
      verifySessionState(
        {
          sessionID: 'session-1',
          status: 'unbound',
          presetName: 'writer',
          affects: 'future-children-only',
        },
        'session-1',
      ),
    ).toThrow();
    expect(() =>
      verifySessionState(bound('writer'), 'another-session'),
    ).toThrow();
  });

  test('apply accepts explicit legacy responses and refuses defaults', () => {
    expect(
      verifyAppliedState(bound('writer'), 'session-1', 'writer').selection,
    ).toBe('explicit');
    expect(() =>
      verifyAppliedState(bound(null), 'session-1', 'writer'),
    ).toThrow();
    expect(() =>
      verifyAppliedState(bound('writer', 'default'), 'session-1', 'writer'),
    ).toThrow();
  });

  test('reset accepts unbound or bound default but not an explicit binding', () => {
    expect(
      verifyResetState(
        {
          sessionID: 'session-1',
          status: 'unbound',
          presetName: null,
          affects: 'future-children-only',
        },
        'session-1',
      ).status,
    ).toBe('unbound');
    expect(
      verifyResetState(bound(null, 'default'), 'session-1').selection,
    ).toBe('default');
    expect(
      verifyResetState(bound('writer', 'default'), 'session-1').presetName,
    ).toBe('writer');
    expect(() => verifyResetState(bound('writer'), 'session-1')).toThrow();
  });
});

describe('draft diff', () => {
  const baseline: DraftBaseline = {
    model: 'openai/gpt-5',
    variant: 'low',
    temperature: 0.2,
    optionsJson: '{"a":1}',
  };

  test('sends only the edited field against the immutable baseline', () => {
    const diff = diffDraft(baseline, {
      model: 'openai/gpt-5',
      variant: 'low',
      temperature: '0.7',
      options: '{"a":1}',
    });
    expect(diff.fields).toEqual(['temperature']);
    expect(diff.patch).toEqual({ temperature: 0.7 });
  });

  test('A -> external B -> temperature edit never reverts B', () => {
    // Baseline A is the editor's snapshot. The latest snapshot B has a newer
    // model, but the user only edited temperature.
    const draft = {
      model: 'openai/gpt-5',
      variant: 'low',
      temperature: '0.7',
      options: '{"a":1}',
    };
    const diff = diffDraft(baseline, draft);
    const conflict = draftConflicts(
      baseline,
      { ...baseline, model: 'anthropic/claude' },
      diff.fields,
    );
    expect(conflict).toEqual({
      hasConflict: false,
      removed: false,
      fields: [],
    });
    expect(diff.patch).toEqual({ temperature: 0.7 });
  });

  test('conflicts only when a dirty field changed externally', () => {
    const dirtyTemperature = diffDraft(baseline, {
      model: 'openai/gpt-5',
      variant: 'low',
      temperature: '0.7',
      options: '{"a":1}',
    });
    expect(
      draftConflicts(
        baseline,
        { ...baseline, temperature: 0.9 },
        dirtyTemperature.fields,
      ),
    ).toEqual({
      hasConflict: true,
      removed: false,
      fields: ['temperature'],
    });

    const dirtyModel = diffDraft(baseline, {
      model: 'anthropic/claude',
      variant: 'low',
      temperature: '0.2',
      options: '{"a":1}',
    });
    expect(
      draftConflicts(
        baseline,
        { ...baseline, temperature: 0.9 },
        dirtyModel.fields,
      ),
    ).toEqual({ hasConflict: false, removed: false, fields: [] });
    expect(dirtyModel.patch).toEqual({ model: 'anthropic/claude' });
  });

  test('reset from a fallback chain removes only the model', () => {
    const diff = diffDraft(baseline, {
      model: '',
      variant: 'low',
      temperature: '0.2',
      options: '{"a":1}',
      modelReset: true,
    });
    expect(diff.fields).toEqual(['model']);
    expect(diff.patch).toEqual({ model: '' });
  });

  test('compacts equivalent options and handles removal', () => {
    const same = diffDraft(baseline, {
      model: baseline.model,
      variant: baseline.variant,
      temperature: '0.2',
      options: '{ "a": 1 }',
    });
    expect(same.dirty).toBe(false);
    const cleared = diffDraft(baseline, {
      model: baseline.model,
      variant: baseline.variant,
      temperature: '',
      options: '',
    });
    expect(cleared.fields).toEqual(['temperature', 'options']);
    expect(cleared.patch).toEqual({
      clearTemperature: true,
      optionsJson: '',
    });
    expect(compactJson('{ "b": 2 }')).toBe('{"b":2}');
  });

  test('a removed persisted override refuses a dirty save', () => {
    const diff = diffDraft(baseline, {
      model: baseline.model,
      variant: baseline.variant,
      temperature: '0.7',
      options: '{"a":1}',
    });
    expect(draftConflicts(baseline, undefined, diff.fields)).toEqual({
      hasConflict: true,
      removed: true,
      fields: ['temperature'],
    });
    expect(draftConflicts(baseline, undefined, [])).toEqual({
      hasConflict: false,
      removed: false,
      fields: [],
    });
  });
});

describe('model grouping and caps', () => {
  const models: ModelShapeLike[] = [
    { id: 'gpt-5', providerID: 'openai', name: 'GPT-5' },
    { id: 'gpt-5-mini', providerID: 'openai', name: 'GPT-5 Mini' },
    { id: 'claude', providerID: 'anthropic', name: 'Claude' },
    { id: 'big-pickle', providerID: 'opencode-go', name: 'Big Pickle' },
  ];

  test('groups each model once with favorites then recents', () => {
    const groups = groupModels(models, {
      favorites: ['openai/gpt-5', 'openai/gpt-5', 'missing/model'],
      recent: ['openai/gpt-5', 'anthropic/claude', 'anthropic/claude'],
    });
    expect(
      groups.map((group) => [
        group.kind,
        group.provider,
        group.models.map((model) => model.id),
      ]),
    ).toEqual([
      ['favorites', 'favorites', ['gpt-5']],
      ['recent', 'recent', ['claude']],
      ['provider', 'openai', ['gpt-5-mini']],
      ['provider', 'opencode-go', ['big-pickle']],
    ]);
    const seen = groups.flatMap((group) =>
      group.models.map((model) => `${model.providerID}/${model.id}`),
    );
    expect(seen.length).toBe(new Set(seen).size);
  });

  test('deduplicates the model list and hides favorites while searching', () => {
    const duplicate = models[0];
    const groups = groupModels(duplicate ? [...models, duplicate] : models, {
      query: 'gpt',
      favorites: ['openai/gpt-5'],
      recent: ['anthropic/claude'],
    });
    expect(groups.map((group) => group.kind)).toEqual(['provider']);
    expect(groups[0]?.models.map((model) => model.id)).toEqual([
      'gpt-5',
      'gpt-5-mini',
    ]);
  });

  test('caps apply only to opencode-go model ids', () => {
    const rows = [
      { modelID: 'big-pickle', go: '$3', goPlus: '$6', goTeams: '$20' },
    ];
    expect(goCapForModel(rows, 'go', 'opencode-go/big-pickle')).toBe('$3');
    expect(goCapForModel(rows, 'goPlus', 'opencode-go/big-pickle')).toBe('$6');
    expect(goCapForModel(rows, 'go', 'openai/big-pickle')).toBe('');
    expect(goCapForModel(rows, 'go', 'opencode-go/missing')).toBe('');
    expect(goCapForModel(undefined, 'go', 'opencode-go/big-pickle')).toBe('');
  });
});

describe('workspace routing keys', () => {
  test('separates the same directory across servers', () => {
    expect(workspaceKey('sidecar', '/work')).not.toBe(
      workspaceKey('remote', '/work'),
    );
    expect(workspaceKey('sidecar', '/work')).toBe(
      workspaceKey('sidecar', '/work'),
    );
    expect(workspaceKey('', '')).not.toBe(workspaceKey('remote', ''));
  });

  test('session state keys include server, directory and session', () => {
    const key = sessionStateKey('sidecar', '/work', 'session-1');
    expect(key).toContain('sidecar');
    expect(key).toContain('/work');
    expect(key).toContain('session-1');
    expect(key).not.toBe(sessionStateKey('remote', '/work', 'session-1'));
    expect(key).not.toBe(sessionStateKey('sidecar', '/other', 'session-1'));
    expect(key).not.toBe(sessionStateKey('sidecar', '/work', 'session-2'));
  });
});
