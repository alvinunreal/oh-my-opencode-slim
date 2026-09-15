import { describe, expect, it } from 'bun:test';

import { convertSameProviderBackgroundTask } from './same-provider-policy';

const LM_NEXUS_MODEL = 'lm-nexus/Qwen3.8-27B';
const LM_NEXUS_OTHER_MODEL = 'lm-nexus/Qwen3.5-9B';
const OPENAI_MODEL = 'openai/gpt-5.2';
const POLICY: Record<string, 'foreground'> = { 'lm-nexus': 'foreground' };

interface RunInput {
  parentModel?: string;
  childModel?: string;
  policy?: Record<string, 'foreground'>;
}

function run(
  initial: { background?: unknown },
  input: RunInput,
): {
  result: ReturnType<typeof convertSameProviderBackgroundTask>;
  args: { background?: unknown };
} {
  const args: { background?: unknown } = { ...initial };
  const result = convertSameProviderBackgroundTask({
    agentType: 'oracle',
    parentSessionID: 'ses_parent',
    args,
    policy: input.policy,
    getParentModel: () => input.parentModel,
    getChildModel: () => input.childModel,
  });
  return { result, args };
}

describe('convertSameProviderBackgroundTask', () => {
  it('converts when parent and child share the opted-in provider', () => {
    const { result, args } = run(
      { background: true },
      {
        parentModel: LM_NEXUS_MODEL,
        childModel: LM_NEXUS_OTHER_MODEL,
        policy: POLICY,
      },
    );
    expect(result).toEqual({
      converted: true,
      parentProvider: 'lm-nexus',
      childProvider: 'lm-nexus',
    });
    expect(args.background).toBe(false);
  });

  it('converts when the child inherits the parent model (same model, shared KV state)', () => {
    // A child agent without a configured model resolves to the parent's
    // exact model string — providers are equal by construction, and it is
    // literally the same model sharing the same runtime.
    const { result, args } = run(
      { background: true },
      {
        parentModel: LM_NEXUS_MODEL,
        childModel: LM_NEXUS_MODEL,
        policy: POLICY,
      },
    );
    expect(result.converted).toBe(true);
    expect(args.background).toBe(false);
  });

  it('does not convert when the child resolves to a different provider', () => {
    const { result, args } = run(
      { background: true },
      {
        parentModel: LM_NEXUS_MODEL,
        childModel: OPENAI_MODEL,
        policy: POLICY,
      },
    );
    expect(result).toEqual({ converted: false });
    expect(args.background).toBe(true);
  });

  it('does not convert when the shared provider has no policy entry', () => {
    const { result, args } = run(
      { background: true },
      {
        parentModel: OPENAI_MODEL,
        childModel: OPENAI_MODEL,
        policy: POLICY,
      },
    );
    expect(result).toEqual({ converted: false });
    expect(args.background).toBe(true);
  });

  it('does not convert with an empty policy map', () => {
    const { result, args } = run(
      { background: true },
      {
        parentModel: LM_NEXUS_MODEL,
        childModel: LM_NEXUS_MODEL,
        policy: {},
      },
    );
    expect(result).toEqual({ converted: false });
    expect(args.background).toBe(true);
  });

  it('does not convert when the policy option is undefined', () => {
    const { result, args } = run(
      { background: true },
      {
        parentModel: LM_NEXUS_MODEL,
        childModel: LM_NEXUS_MODEL,
      },
    );
    expect(result).toEqual({ converted: false });
    expect(args.background).toBe(true);
  });

  it('does not convert an explicit foreground task (background: false)', () => {
    const { result, args } = run(
      { background: false },
      {
        parentModel: LM_NEXUS_MODEL,
        childModel: LM_NEXUS_MODEL,
        policy: POLICY,
      },
    );
    expect(result).toEqual({ converted: false });
    expect(args.background).toBe(false);
  });

  it('does not convert when the background flag is absent', () => {
    const { result, args } = run(
      {},
      {
        parentModel: LM_NEXUS_MODEL,
        childModel: LM_NEXUS_MODEL,
        policy: POLICY,
      },
    );
    expect(result).toEqual({ converted: false });
    expect(args.background).toBeUndefined();
  });

  it('fail-open: does not convert when the parent model is unknown', () => {
    const { result, args } = run(
      { background: true },
      {
        childModel: LM_NEXUS_MODEL,
        policy: POLICY,
      },
    );
    expect(result).toEqual({ converted: false });
    expect(args.background).toBe(true);
  });

  it('fail-open: does not convert when the child model is unknown', () => {
    const { result, args } = run(
      { background: true },
      {
        parentModel: LM_NEXUS_MODEL,
        policy: POLICY,
      },
    );
    expect(result).toEqual({ converted: false });
    expect(args.background).toBe(true);
  });

  it('fail-open: does not convert when a model string has no provider', () => {
    const { result, args } = run(
      { background: true },
      {
        parentModel: 'Qwen3.8-27B',
        childModel: 'Qwen3.8-27B',
        policy: POLICY,
      },
    );
    expect(result).toEqual({ converted: false });
    expect(args.background).toBe(true);
  });
});
