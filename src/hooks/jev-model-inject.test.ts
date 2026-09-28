import { describe, expect, test } from 'bun:test';
import { createJevModelInjectHook } from './jev-model-inject';
import { JevRouteStore } from '../routing/jev/store';
import type { JevRouteResult } from '../routing/jev/types';

function makeStore(result?: Partial<JevRouteResult>): JevRouteStore {
  const store = new JevRouteStore();
  store.record('ses_1', 'do the fix work', {
    status: 'ok',
    specialist: 'fixer',
    confidence: 0.9,
    modelTier: 'max',
    model: { id: 'provider/strong', variant: 'max' },
    recommendation: 'x',
    ...(result ?? {}),
  });
  return store;
}

describe('jev model inject hook', () => {
  test('injects model for matching specialist on task (v1 string + modelVariant)', async () => {
    const hook = createJevModelInjectHook({ store: makeStore() });
    const args: Record<string, unknown> = {
      subagent_type: 'fixer',
      prompt: 'do the fix work now',
      background: true,
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args },
    );
    expect(args.model).toBe('provider/strong');
    expect(args.modelVariant).toBe('max');
  });

  test('consume-once: second unrelated dispatch gets nothing', async () => {
    const store = makeStore();
    const hook = createJevModelInjectHook({ store });
    const args: Record<string, unknown> = {
      subagent_type: 'fixer',
      prompt: 'do the fix work now',
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args },
    );
    expect(args.model).toBe('provider/strong');

    // Same task text again: entry was consumed, no reuse for new work.
    const args2: Record<string, unknown> = {
      subagent_type: 'fixer',
      prompt: 'do the fix work now',
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args: args2 },
    );
    expect(args2.model).toBeUndefined();
  });

  test('parallel lanes keep independent task keys', async () => {
    const store = new JevRouteStore();
    store.record('ses_1', 'fix implementation', {
      status: 'ok',
      specialist: 'fixer',
      confidence: 0.9,
      modelTier: 'max',
      model: { id: 'provider/strong' },
      recommendation: 'x',
    });
    store.record('ses_1', 'research library docs', {
      status: 'ok',
      specialist: 'librarian',
      confidence: 0.9,
      modelTier: 'fast',
      model: { id: 'provider/fast' },
      recommendation: 'x',
    });
    const hook = createJevModelInjectHook({ store });
    const fixerArgs: Record<string, unknown> = {
      subagent_type: 'fixer',
      prompt: 'please fix implementation here',
    };
    const librarianArgs: Record<string, unknown> = {
      subagent_type: 'librarian',
      prompt: 'research library docs now',
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args: fixerArgs },
    );
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1' },
      { args: librarianArgs },
    );
    expect(fixerArgs.model).toBe('provider/strong');
    expect(librarianArgs.model).toBe('provider/fast');
  });

  test('v2 injects Model.Ref { providerID, id, variant }', async () => {
    const store = new JevRouteStore();
    store.record('ses_1', 'do x work', {
      status: 'ok',
      specialist: 'fixer',
      confidence: 0.9,
      modelTier: 'max',
      model: { id: 'provider/strong', variant: 'max' },
      recommendation: 'x',
    });
    const hook = createJevModelInjectHook({
      store,
      hostFlavor: () => 'v2',
    });
    const args: Record<string, unknown> = { agent: 'fixer', prompt: 'do x work' };
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
    store.record('ses_1', 'do y work', {
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
    const args: Record<string, unknown> = { agent: 'fixer', prompt: 'do y work please' };
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
    const args: Record<string, unknown> = {
      subagent_type: 'fixer',
      prompt: 'do the fix work today',
    };
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
    const args: Record<string, unknown> = {
      subagent_type: 'fixer',
      prompt: 'do the fix work today',
    };
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
      prompt: 'do the fix work today',
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
      prompt: 'do the fix work today',
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
