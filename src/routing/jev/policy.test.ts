import { describe, expect, test } from 'bun:test';
import {
  applyRoutePolicy,
  escalateTier,
  resolveAgentModelLadder,
  resolveModelForRoute,
  toModelEntries,
} from './policy';
import { buildRouteQuestions } from './questions';
import type { JevSystemOneResponse } from './types';

const agents = {
  explorer: { model: 'cmd/fast-model' },
  librarian: { model: [{ id: 'cmd/fast-model' }] },
  // Multi-entry model arrays are failover chains (preferred head first),
  // not strength ladders — they resolve to the head at every tier.
  fixer: {
    model: [
      { id: 'cmd/fixer-preferred' },
      { id: 'cmd/fixer-fallback', variant: 'low' },
    ],
  },
  designer: { model: { id: 'cmd/ui-model', variant: 'high' } },
  oracle: { model: 'cmd/max-model' },
  orchestrator: { model: ['cmd/max-model'] },
};

function response(
  specialist: string,
  confidence: number,
  extra?: Partial<Record<string, unknown>>,
): JevSystemOneResponse {
  return {
    model: 'jev-1.13.0',
    answers: {
      specialist: {
        type: 'choice',
        choice: specialist,
        confidence,
        probabilities: { [specialist]: confidence, other: 1 - confidence },
      },
      complexity: {
        type: 'score',
        score: 1,
        legend: {},
        probabilities: {},
        confidence: 0.9,
      },
      risk: {
        type: 'score',
        score: 1,
        legend: {},
        probabilities: {},
        confidence: 0.9,
      },
      ...extra,
    },
  };
}

const policyOpts = {
  acceptConfidence: 0.75,
  escalateConfidence: 0.5,
  agents,
};

describe('toModelEntries', () => {
  test('normalizes string, array, and object forms', () => {
    expect(toModelEntries('a/b')).toEqual([{ id: 'a/b' }]);
    expect(toModelEntries(['a/b', { id: 'c/d', variant: 'low' }])).toEqual([
      { id: 'a/b' },
      { id: 'c/d', variant: 'low' },
    ]);
    expect(toModelEntries(undefined)).toEqual([]);
  });
});

describe('resolveAgentModelLadder', () => {
  test('failover chains keep only the preferred head', () => {
    const ladder = resolveAgentModelLadder('fixer', agents);
    expect(ladder.map((m) => m.id)).toEqual(['cmd/fixer-preferred']);
  });

  test('never pulls another agent model into the ladder', () => {
    const ladder = resolveAgentModelLadder('fixer', agents);
    expect(ladder.some((m) => m.id.includes('max-model'))).toBe(false);
  });

  test('explicit jev.modelLadders wins', () => {
    const ladder = resolveAgentModelLadder('fixer', agents, {
      fixer: [{ id: 'cmd/custom-a' }, { id: 'cmd/custom-b' }],
    });
    expect(ladder.map((m) => m.id)).toEqual(['cmd/custom-a', 'cmd/custom-b']);
  });
});

describe('resolveModelForRoute', () => {
  test('failover chain keeps the preferred head at every tier', () => {
    for (const tier of ['fast', 'balanced', 'max'] as const) {
      expect(resolveModelForRoute('fixer', tier, agents)?.id).toBe(
        'cmd/fixer-preferred',
      );
    }
  });

  test('explicit ladders step strength fast→max on the same agent', () => {
    const ladders = {
      fixer: [
        { id: 'cmd/fixer-light' },
        { id: 'cmd/fixer-mid' },
        { id: 'cmd/fixer-strong' },
      ],
    };
    expect(resolveModelForRoute('fixer', 'fast', agents, ladders)?.id).toBe(
      'cmd/fixer-light',
    );
    expect(
      resolveModelForRoute('fixer', 'balanced', agents, ladders)?.id,
    ).toBe('cmd/fixer-mid');
    expect(resolveModelForRoute('fixer', 'max', agents, ladders)?.id).toBe(
      'cmd/fixer-strong',
    );
  });

  test('single-model agent does not invent variants', () => {
    const fast = resolveModelForRoute('designer', 'fast', agents);
    const mid = resolveModelForRoute('designer', 'balanced', agents);
    const max = resolveModelForRoute('designer', 'max', agents);
    for (const m of [fast, mid, max]) {
      expect(m?.id).toBe('cmd/ui-model');
      expect(m?.variant).toBe('high'); // configured only, never low/max invented
    }
  });

  test('oracle stays oracle at every tier', () => {
    for (const tier of ['fast', 'balanced', 'max'] as const) {
      const model = resolveModelForRoute('oracle', tier, agents);
      expect(model?.id).toBe('cmd/max-model');
    }
  });
});

describe('escalateTier', () => {
  test('steps up and saturates at max', () => {
    expect(escalateTier('fast')).toBe('balanced');
    expect(escalateTier('balanced')).toBe('max');
    expect(escalateTier('max')).toBe('max');
  });
});

describe('applyRoutePolicy', () => {
  test('high complexity keeps specialist and preferred failover head', () => {
    const result = applyRoutePolicy(
      {
        model: 'j',
        answers: {
          specialist: {
            type: 'choice',
            choice: 'fixer',
            confidence: 0.9,
            probabilities: { fixer: 0.9 },
          },
          complexity: {
            type: 'score',
            score: 1.9,
            legend: {},
            probabilities: {},
            confidence: 0.9,
          },
          risk: {
            type: 'score',
            score: 1.8,
            legend: {},
            probabilities: {},
            confidence: 0.9,
          },
        },
      },
      { state: 'x' },
      policyOpts,
    );
    expect(result.status).toBe('ok');
    expect(result.specialist).toBe('fixer'); // NOT oracle, NOT fallback
    expect(result.modelTier).toBe('max');
    expect(result.model?.id).toBe('cmd/fixer-preferred');
  });

  test('explicit ladder escalates strength on the same agent', () => {
    const ladders = {
      fixer: [
        { id: 'cmd/fixer-light' },
        { id: 'cmd/fixer-mid' },
        { id: 'cmd/fixer-strong' },
      ],
    };
    const result = applyRoutePolicy(
      {
        model: 'j',
        answers: {
          specialist: {
            type: 'choice',
            choice: 'fixer',
            confidence: 0.9,
            probabilities: { fixer: 0.9 },
          },
          complexity: {
            type: 'score',
            score: 1.9,
            legend: {},
            probabilities: {},
            confidence: 0.9,
          },
          risk: {
            type: 'score',
            score: 1.9,
            legend: {},
            probabilities: {},
            confidence: 0.9,
          },
        },
      },
      { state: 'x' },
      { ...policyOpts, modelLadders: ladders },
    );
    expect(result.specialist).toBe('fixer');
    expect(result.modelTier).toBe('max');
    expect(result.model?.id).toBe('cmd/fixer-strong');
  });

  test('medium confidence escalates strength only', () => {
    const result = applyRoutePolicy(
      {
        model: 'j',
        answers: {
          specialist: {
            type: 'choice',
            choice: 'explorer',
            confidence: 0.6,
            probabilities: { explorer: 0.7 },
          },
          complexity: {
            type: 'score',
            score: 0.2,
            legend: {},
            probabilities: {},
            confidence: 0.9,
          },
          risk: {
            type: 'score',
            score: 0.2,
            legend: {},
            probabilities: {},
            confidence: 0.9,
          },
        },
      },
      { state: 'x' },
      policyOpts,
    );
    expect(result.status).toBe('ok');
    expect(result.specialist).toBe('explorer');
    expect(result.modelTier).toBe('balanced');
    expect(result.model?.id).toBe('cmd/fast-model'); // still explorer
  });

  test('low confidence is not applied as authority', () => {
    const result = applyRoutePolicy(
      response('oracle', 0.3),
      { state: 'x' },
      policyOpts,
    );
    expect(result.status).toBe('low_confidence');
  });

  test('missing specialist answer is an error', () => {
    const result = applyRoutePolicy(
      { model: 'j', answers: {} },
      { state: 'x' },
      policyOpts,
    );
    expect(result.status).toBe('error');
  });

  test('visual noul does not override a confident fixer', () => {
    const result = applyRoutePolicy(
      response('fixer', 0.9, {
        needs_visual: { type: 'noul', noul: 0.95 },
      }),
      { state: 'x' },
      policyOpts,
    );
    expect(result.specialist).toBe('fixer');
  });

  test('visual noul fills unassigned/direct specialist', () => {
    const result = applyRoutePolicy(
      response('direct', 0.9, {
        needs_visual: { type: 'noul', noul: 0.95 },
      }),
      { state: 'x' },
      policyOpts,
    );
    expect(result.specialist).toBe('designer');
    expect(result.model?.id).toBe('cmd/ui-model');
  });

  test('low_confidence resolves the preferred head for the same specialist', () => {
    const result = applyRoutePolicy(
      {
        model: 'j',
        answers: {
          specialist: {
            type: 'choice',
            choice: 'fixer',
            confidence: 0.3,
            probabilities: { fixer: 0.4 },
          },
          complexity: {
            type: 'score',
            score: 1.9,
            legend: {},
            probabilities: {},
            confidence: 0.9,
          },
          risk: {
            type: 'score',
            score: 1.9,
            legend: {},
            probabilities: {},
            confidence: 0.9,
          },
        },
      },
      { state: 'x' },
      policyOpts,
    );
    expect(result.status).toBe('low_confidence');
    expect(result.specialist).toBe('fixer');
    expect(result.model?.id).toBe('cmd/fixer-preferred');
    expect(result.modelTier).toBe('max');
  });

  test('respects allowedSpecialists', () => {
    const result = applyRoutePolicy(
      response('fixer', 0.9),
      { state: 'x' },
      { ...policyOpts, allowedSpecialists: ['explorer', 'direct'] },
    );
    expect(result.specialist === 'fixer').toBe(false);
    expect(result.status).toBe('low_confidence');
  });
});

describe('buildRouteQuestions', () => {
  test('builds all six questions', () => {
    const q = buildRouteQuestions();
    expect(Object.keys(q).sort()).toEqual([
      'complexity',
      'multi_lane',
      'needs_external',
      'needs_visual',
      'risk',
      'specialist',
    ]);
  });

  test('specialist instructions separate task type from strength', () => {
    const q = buildRouteQuestions();
    expect(q.specialist.instructions).toContain('TASK TYPE');
    expect(q.specialist.instructions).toContain('NOT pick by difficulty');
    expect(q.complexity.instructions).toContain('model STRENGTH');
  });
});
