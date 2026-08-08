import { describe, expect, test } from 'bun:test';
import { pickAgentModelRef, resolveSecondaryModels } from './secondary-model';

describe('smartfetch/resolveSecondaryModels', () => {
  test('dedicated webfetch models take highest priority, in order', () => {
    const models = resolveSecondaryModels({
      webfetchModels: [
        { id: 'openai/gpt-4o-mini' },
        { id: 'anthropic/claude-haiku', variant: 'cheap' },
      ],
      smallModel: 'openai/gpt-4o-mini',
      explorerModel: 'openai/gpt-4o-mini',
    });

    expect(models).toEqual([
      { providerID: 'openai', modelID: 'gpt-4o-mini' },
      {
        providerID: 'anthropic',
        modelID: 'claude-haiku',
        variant: 'cheap',
      },
    ]);
  });

  test('falls back to smallModel then agent models in priority order', () => {
    const models = resolveSecondaryModels({
      smallModel: 'openai/gpt-4o-mini',
      explorerModel: 'anthropic/claude-haiku',
      librarianModel: 'google/gemini-flash',
    });

    expect(models).toEqual([
      { providerID: 'openai', modelID: 'gpt-4o-mini' },
      { providerID: 'anthropic', modelID: 'claude-haiku' },
      { providerID: 'google', modelID: 'gemini-flash' },
    ]);
  });

  test('deduplicates identical provider/model across sources', () => {
    const models = resolveSecondaryModels({
      webfetchModels: [{ id: 'openai/gpt-4o-mini' }],
      smallModel: 'openai/gpt-4o-mini',
      explorerModel: 'openai/gpt-4o-mini',
      librarianModel: 'openai/gpt-4o-mini',
    });

    expect(models).toEqual([{ providerID: 'openai', modelID: 'gpt-4o-mini' }]);
  });

  test('skips malformed model references', () => {
    const models = resolveSecondaryModels({
      webfetchModels: [
        { id: 'openai/gpt-4o-mini' },
        { id: 'no-slash' },
        { id: '/missing-provider' },
        { id: '' },
      ],
      smallModel: 'no-slash',
      explorerModel: '/missing-provider',
    });

    expect(models).toEqual([{ providerID: 'openai', modelID: 'gpt-4o-mini' }]);
  });

  test('returns an empty list when nothing is configured', () => {
    expect(resolveSecondaryModels({})).toEqual([]);
    expect(resolveSecondaryModels()).toEqual([]);
  });

  test('variant distinguishes dedupe keys (parity with prior behavior)', () => {
    const models = resolveSecondaryModels({
      webfetchModels: [{ id: 'openai/gpt-4o-mini', variant: 'fast' }],
      smallModel: 'openai/gpt-4o-mini',
    });

    // The dedupe key includes the variant, so the variant-tagged dedicated
    // entry and the plain small_model ref are kept as separate candidates.
    expect(models).toEqual([
      {
        providerID: 'openai',
        modelID: 'gpt-4o-mini',
        variant: 'fast',
      },
      { providerID: 'openai', modelID: 'gpt-4o-mini' },
    ]);
  });
});

describe('smartfetch/pickAgentModelRef', () => {
  test('resolves a bare string', () => {
    expect(pickAgentModelRef('openai/gpt-4o-mini')).toBe('openai/gpt-4o-mini');
  });

  test('resolves the first usable entry in an array', () => {
    expect(
      pickAgentModelRef([
        { id: 'openai/gpt-4o-mini', variant: 'fast' },
        'anthropic/claude-haiku',
      ]),
    ).toBe('openai/gpt-4o-mini');
    expect(pickAgentModelRef(['anthropic/claude-haiku'])).toBe(
      'anthropic/claude-haiku',
    );
  });

  test('returns undefined for non-model values', () => {
    expect(pickAgentModelRef(undefined)).toBeUndefined();
    expect(pickAgentModelRef(null)).toBeUndefined();
    expect(pickAgentModelRef(42)).toBeUndefined();
  });
});
