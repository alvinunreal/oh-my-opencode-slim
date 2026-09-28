import { describe, expect, test } from 'bun:test';
import { createJevModelInjectHook } from './jev-model-inject';
import { JevRouteStore } from '../routing/jev/store';
import type { JevRouteResult } from '../routing/jev/types';

function makeStore(result?: Partial<JevRouteResult>): JevRouteStore {
  const store = new JevRouteStore();
  store.record('ses_1', {
    status: 'ok',
    specialist: 'fixer',
    confidence: 0.9,
    modelTier: 'max',
    model: { id: 'provider/strong', variant: 'max' },
    recommendation: 'x',
    ...result,
  });
  return store;
}

describe('jev model inject hook', () => {
  test('injects model for matching specialist on task (v1 string + modelVariant)', async () => {
    const hook = createJevModelInjectHook({ store: makeStore() });
    const args: Record<string, unknown> = {
      subagent_type: 'fixer',
      prompt: 'do it',
      background: true,
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args },
    );
    expect(args.model).toBe('provider/strong');
    expect(args.modelVariant).toBe('max');
  });

  test('v2 injects Model.Ref { providerID, id, variant }', async () => {
    const hook = createJevModelInjectHook({
      store: makeStore(),
      hostFlavor: () => 'v2',
    });
    const args: Record<string, unknown> = { agent: 'fixer', prompt: 'x' };
    await hook['tool.execute.before'](
      { tool: 'subagent', sessionID: 'ses_1' },
      { args },
    );
    expect(args.model).toEqual({
      providerID: 'provider',
      id: 'strong',
      variant: 'max',
    });
  });

  test('v2 keeps string when id has no provider slash', async () => {
    const store = new JevRouteStore();
    store.record('ses_1', {
      status: 'ok',
      specialist: 'fixer',
      confidence: 0.9,
      modelTier: 'fast',
      model: { id: 'bare-model' },
      recommendation: 'x',
    });
    const hook = createJevModelInjectHook({
      store,
      hostFlavor: () => 'v2',
    });
    const args: Record<string, unknown> = { agent: 'fixer' };
    await hook['tool.execute.before'](
      { tool: 'subagent', sessionID: 'ses_1' },
      { args },
    );
    expect(args.model).toBe('bare-model');
  });

  test('still injects when session is not yet managed (first task)', async () => {
    let registered: string | undefined;
    const hook = createJevModelInjectHook({
      store: makeStore(),
      shouldManageSession: () => false,
      registerSessionAsOrchestrator: (id) => {
        registered = id;
      },
    });
    const args: Record<string, unknown> = { subagent_type: 'fixer' };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args },
    );
    expect(registered).toBe('ses_1');
    expect(args.model).toBe('provider/strong');
  });

  test('does not inject on low_confidence', async () => {
    const hook = createJevModelInjectHook({
      store: makeStore({ status: 'low_confidence' }),
    });
    const args: Record<string, unknown> = { subagent_type: 'fixer' };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args },
    );
    expect(args.model).toBeUndefined();
  });

  test('skips when specialist does not match', async () => {
    const hook = createJevModelInjectHook({ store: makeStore() });
    const args: Record<string, unknown> = {
      subagent_type: 'oracle',
      prompt: 'x',
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args },
    );
    expect(args.model).toBeUndefined();
  });

  test('skips when explicit model already set', async () => {
    const hook = createJevModelInjectHook({ store: makeStore() });
    const args: Record<string, unknown> = {
      subagent_type: 'fixer',
      model: 'other/model',
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args },
    );
    expect(args.model).toBe('other/model');
  });

  test('skips resume (task_id present)', async () => {
    const hook = createJevModelInjectHook({ store: makeStore() });
    const args: Record<string, unknown> = {
      subagent_type: 'fixer',
      task_id: 'fix-1',
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args },
    );
    expect(args.model).toBeUndefined();
  });

  test('ignores non-delegation tools', async () => {
    const hook = createJevModelInjectHook({ store: makeStore() });
    const args: Record<string, unknown> = { subagent_type: 'fixer' };
    await hook['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses_1' },
      { args },
    );
    expect(args.model).toBeUndefined();
  });
});
