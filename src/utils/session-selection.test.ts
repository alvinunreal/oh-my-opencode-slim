import { describe, expect, test } from 'bun:test';
import {
  createSessionSelectionReader,
  resolveCurrentSelection,
} from './session-selection';

describe('resolveCurrentSelection', () => {
  test('prefers a host-persisted agent and model over slim metadata', async () => {
    const selection = await resolveCurrentSelection(
      'ses_1',
      {
        readHostSelection: async () => ({
          agent: 'plan',
          model: { providerID: 'test', id: 'plan-model', variant: 'max' },
        }),
      },
      {
        getAgent: () => 'orchestrator',
        getModel: () => 'test/stale-model',
      },
    );

    expect(selection).toEqual({
      agent: 'plan',
      model: { providerID: 'test', modelID: 'plan-model' },
      variant: 'max',
      provenance: 'host-persisted',
    });
  });

  test('falls back to slim metadata when the host has no agent', async () => {
    const selection = await resolveCurrentSelection(
      'ses_1',
      { readHostSelection: async () => undefined },
      {
        getAgent: () => 'build',
        getModel: () => 'openai/gpt-4o',
      },
    );

    expect(selection).toEqual({
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-4o' },
      provenance: 'observed-external',
    });
  });

  test('returns unknown when neither host nor metadata has a selection', async () => {
    const selection = await resolveCurrentSelection(
      'ses_1',
      { readHostSelection: async () => undefined },
      { getAgent: () => undefined, getModel: () => undefined },
    );

    expect(selection).toEqual({ provenance: 'unknown' });
  });

  test('swallows a host read failure and uses metadata', async () => {
    const selection = await resolveCurrentSelection(
      'ses_1',
      {
        readHostSelection: async () => {
          throw new Error('session.get failed');
        },
      },
      {
        getAgent: () => 'plan',
        getModel: () => undefined,
      },
    );

    expect(selection).toEqual({
      agent: 'plan',
      provenance: 'observed-external',
    });
  });

  test('host timeout still uses metadata instead of unknown', async () => {
    const selection = await resolveCurrentSelection(
      'ses_1',
      {
        readHostSelection: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ agent: 'build' }), 50);
          }),
      },
      {
        getAgent: () => 'plan',
        getModel: () => 'openai/gpt-4o',
      },
      10,
    );

    expect(selection).toEqual({
      agent: 'plan',
      model: { providerID: 'openai', modelID: 'gpt-4o' },
      provenance: 'observed-external',
    });
  });

  test('host timeout without metadata stays unknown', async () => {
    const selection = await resolveCurrentSelection(
      'ses_1',
      {
        readHostSelection: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ agent: 'build' }), 50);
          }),
      },
      { getAgent: () => undefined, getModel: () => undefined },
      10,
    );

    expect(selection).toEqual({ provenance: 'unknown' });
  });
});

describe('createSessionSelectionReader', () => {
  test('calls session.get with the v1 path/query shape', async () => {
    const get = async (args: Record<string, unknown>) => {
      expect(args).toEqual({
        path: { id: 'ses_1' },
        query: { directory: '/project' },
      });
      return {
        data: {
          agent: 'plan',
          model: { providerID: 'test', id: 'm1' },
        },
      };
    };
    const reader = createSessionSelectionReader(
      { session: { get } },
      '/project',
    );
    await expect(reader.readHostSelection('ses_1')).resolves.toEqual({
      agent: 'plan',
      model: { providerID: 'test', id: 'm1' },
    });
  });

  test('preserves the session.get receiver (v1 SDK this._client)', async () => {
    const session: {
      get: (args: Record<string, unknown>) => Promise<unknown>;
    } = {
      get(this: unknown, args: Record<string, unknown>) {
        expect(this).toBe(session);
        expect(args).toEqual({ path: { id: 'ses_1' } });
        return Promise.resolve({
          data: { agent: 'build', model: { providerID: 'x', id: 'y' } },
        });
      },
    };
    const reader = createSessionSelectionReader({ session });
    await expect(reader.readHostSelection('ses_1')).resolves.toEqual({
      agent: 'build',
      model: { providerID: 'x', id: 'y' },
    });
  });

  test('parses a host {info} envelope', async () => {
    const reader = createSessionSelectionReader({
      session: {
        get: async () => ({
          info: { agent: 'plan', model: { providerID: 'p', id: 'm' } },
        }),
      },
    });
    await expect(reader.readHostSelection('ses_1')).resolves.toEqual({
      agent: 'plan',
      model: { providerID: 'p', id: 'm' },
    });
  });
});
