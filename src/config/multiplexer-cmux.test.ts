import { describe, expect, spyOn, test } from 'bun:test';
import {
  MultiplexerConfigSchema,
  MultiplexerTypeSchema,
  resetMultiplexerDiagnostics,
} from './schema';

describe('cmux multiplexer schema', () => {
  test('accepts cmux as a multiplexer type and config', () => {
    expect(MultiplexerTypeSchema.parse('cmux')).toBe('cmux');
    expect(MultiplexerConfigSchema.parse({ type: 'cmux' }).type).toBe('cmux');
  });

  test('keeps the cmux type when the removed zellij_pane_mode key is present', () => {
    resetMultiplexerDiagnostics();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    // Spies on console.warn can be shared across test files in one process;
    // clear call history so the assertion counts only this test's warning.
    warn.mockClear();

    try {
      const parsed = MultiplexerConfigSchema.parse({
        type: 'cmux',
        zellij_pane_mode: 'current-tab',
      });

      expect(parsed.type).toBe('cmux');
      expect(parsed).not.toHaveProperty('zellij_pane_mode');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
