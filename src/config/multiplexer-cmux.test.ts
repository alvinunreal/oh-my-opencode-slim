import { describe, expect, spyOn, test } from 'bun:test';
import {
  MULTIPLEXER_RENAMED_TYPE_MESSAGE,
  MultiplexerConfigSchema,
  MultiplexerTypeSchema,
  resetMultiplexerDiagnostics,
} from './schema';

describe('cmux multiplexer schema', () => {
  test('accepts cmux-tui as a multiplexer type and config', () => {
    expect(MultiplexerTypeSchema.parse('cmux-tui')).toBe('cmux-tui');
    expect(MultiplexerConfigSchema.parse({ type: 'cmux-tui' }).type).toBe(
      'cmux-tui',
    );
  });

  test('parses and preserves cmux_tui_binary', () => {
    const parsed = MultiplexerConfigSchema.parse({
      type: 'cmux-tui',
      cmux_tui_binary: '/opt/cmux-tui/bin/cmux',
    });

    expect(parsed.type).toBe('cmux-tui');
    expect(parsed.cmux_tui_binary).toBe('/opt/cmux-tui/bin/cmux');
  });

  test('drops an invalid cmux_tui_binary instead of failing the whole config', () => {
    const invalidValues: unknown[] = ['', 42, null];

    for (const value of invalidValues) {
      resetMultiplexerDiagnostics();
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      warn.mockClear();

      try {
        const result = MultiplexerConfigSchema.safeParse({
          type: 'cmux-tui',
          layout: 'tiled',
          main_pane_size: 40,
          cmux_tui_binary: value,
        });

        // Load-bearing: before the fix the strict schema rejected the whole
        // object, so the loader discarded the entire config layer.
        expect(result.success).toBe(true);
        if (!result.success) continue;

        expect(result.data).not.toHaveProperty('cmux_tui_binary');
        // Fail-closed: the bad key disables pane management...
        expect(result.data.type).toBe('none');
        // ...while sibling multiplexer keys survive.
        expect(result.data.layout).toBe('tiled');
        expect(result.data.main_pane_size).toBe(40);

        const invalidCalls = warn.mock.calls.filter((call) =>
          String(call[0]).includes('Invalid multiplexer config value'),
        );
        expect(invalidCalls).toHaveLength(1);
        expect(String(invalidCalls[0]?.[0])).toContain(
          'invalid: cmux_tui_binary',
        );
      } finally {
        warn.mockRestore();
      }
    }
  });

  test('treats an undefined cmux_tui_binary as absent, not invalid', () => {
    resetMultiplexerDiagnostics();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();

    try {
      const result = MultiplexerConfigSchema.safeParse({
        type: 'cmux-tui',
        cmux_tui_binary: undefined,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Mirrors the field's own `.optional()`: `undefined` means "unset", so
      // pane management stays enabled and no diagnostic fires. The sanitizer
      // check must stay aligned with the field declaration — drift between
      // the two is what caused the invalid-binary bug above.
      expect(result.data.type).toBe('cmux-tui');
      expect(
        warn.mock.calls.filter((call) =>
          String(call[0]).includes('Invalid multiplexer config value'),
        ),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test('drops the renamed cmux type with a specific once-per-process diagnostic', () => {
    resetMultiplexerDiagnostics();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();

    try {
      const parsed = MultiplexerConfigSchema.parse({
        type: 'cmux',
        main_pane_size: 40,
      });

      expect(parsed.type).toBe('none');
      // Other multiplexer keys keep working.
      expect(parsed.main_pane_size).toBe(40);
      const renameCalls = () =>
        warn.mock.calls.filter((call) =>
          String(call[0]).includes(MULTIPLEXER_RENAMED_TYPE_MESSAGE),
        );
      expect(renameCalls()).toHaveLength(1);

      // A second occurrence in the same process does not repeat the hint.
      expect(MultiplexerConfigSchema.parse({ type: 'cmux' }).type).toBe('none');
      expect(renameCalls()).toHaveLength(1);

      // The generic invalid-value path still works for genuinely invalid
      // values (the rename is an addition, not a replacement).
      const generic = MultiplexerConfigSchema.parse({ type: 'bogus' });
      expect(generic.type).toBe('none');
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes('Invalid multiplexer config value'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
