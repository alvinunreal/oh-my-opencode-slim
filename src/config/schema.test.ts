import { describe, expect, it } from 'bun:test';
import { PluginConfigSchema } from './schema';

describe('PluginConfigSchema image_routing', () => {
  it('accepts image_routing: direct with observer disabled', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_agents: ['observer'],
      image_routing: 'direct',
    });
    expect(result.success).toBe(true);
  });

  it('accepts image_routing: auto with observer enabled', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_agents: [],
      image_routing: 'auto',
    });
    expect(result.success).toBe(true);
  });

  it('accepts image_routing: auto with observer disabled until layers merge', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_agents: ['observer'],
      image_routing: 'auto',
    });
    expect(result.success).toBe(true);
  });

  it('leaves image_routing undefined when omitted (default applied downstream)', () => {
    const result = PluginConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.image_routing).toBeUndefined();
    }
  });

  it('accepts image_routing: auto when disabled_agents is omitted', () => {
    const result = PluginConfigSchema.safeParse({ image_routing: 'auto' });
    expect(result.success).toBe(true);
  });
});

describe('PluginConfigSchema backgroundJobs', () => {
  it('defaults board injection to the legacy latest strategy', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.strategy).toBe('latest');
      expect(result.data.backgroundJobs?.maxRetainedSnapshots).toBe(20);
    }
  });

  it('defaults continueOnIdle to false', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.continueOnIdle).toBe(false);
    }
  });

  it('accepts explicit continueOnIdle true', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { continueOnIdle: true },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.continueOnIdle).toBe(true);
    }
  });

  it('accepts explicit continueOnIdle false', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { continueOnIdle: false },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.continueOnIdle).toBe(false);
    }
  });

  it('accepts checkpoint-compatible board injection', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { strategy: 'checkpoint-compatible' },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a bounded checkpoint snapshot retention limit', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { maxRetainedSnapshots: 3 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.maxRetainedSnapshots).toBe(3);
    }
  });

  it('rejects checkpoint snapshot retention limits outside 1–100', () => {
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: { maxRetainedSnapshots: 0 },
      }).success,
    ).toBe(false);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: { maxRetainedSnapshots: 101 },
      }).success,
    ).toBe(false);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: { maxRetainedSnapshots: 20.5 },
      }).success,
    ).toBe(false);
  });

  it('defaults the wall-clock supervisor to disabled with a 10 second grace', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.wallClockTimeoutMs).toBe(0);
      expect(result.data.backgroundJobs?.abortGraceMs).toBe(10_000);
    }
  });

  it('accepts the documented wall-clock supervisor bounds', () => {
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 0,
          abortGraceMs: 1_000,
        },
      }).success,
    ).toBe(true);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 60_000,
          abortGraceMs: 60_000,
        },
      }).success,
    ).toBe(true);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 2_147_483_647,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects wall-clock supervisor values outside the safe integer bounds', () => {
    const invalid = [
      { wallClockTimeoutMs: -1 },
      { wallClockTimeoutMs: 1 },
      { wallClockTimeoutMs: 59_999 },
      { wallClockTimeoutMs: 2_147_483_648 },
      { wallClockTimeoutMs: 60_000.5 },
      { abortGraceMs: 999 },
      { abortGraceMs: 60_001 },
      { abortGraceMs: 1_000.5 },
    ];

    for (const backgroundJobs of invalid) {
      expect(PluginConfigSchema.safeParse({ backgroundJobs }).success).toBe(
        false,
      );
    }
  });
});
