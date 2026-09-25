import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { resolvePrompt } from './orchestrator';

const FALLBACK = 'fallback prompt';
const FILE = 'file prompt';
const INLINE = 'inline prompt';
const APPEND = 'append prompt';

afterEach(() => {
  spyOn(console, 'warn').mockRestore();
});

describe('resolvePrompt precedence', () => {
  test('inline wins over file and fallback', () => {
    expect(resolvePrompt('a', INLINE, FILE, FALLBACK)).toBe(INLINE);
  });

  test('file wins over fallback when no inline', () => {
    expect(resolvePrompt('a', undefined, FILE, FALLBACK)).toBe(FILE);
  });

  test('fallback used when no inline and no file', () => {
    expect(resolvePrompt('a', undefined, undefined, FALLBACK)).toBe(FALLBACK);
  });

  test('append concatenated after whichever base won', () => {
    expect(resolvePrompt('a', INLINE, FILE, FALLBACK, APPEND)).toBe(
      `${INLINE}\n\n${APPEND}`,
    );
    expect(resolvePrompt('a', undefined, FILE, FALLBACK, APPEND)).toBe(
      `${FILE}\n\n${APPEND}`,
    );
    expect(resolvePrompt('a', undefined, undefined, FALLBACK, APPEND)).toBe(
      `${FALLBACK}\n\n${APPEND}`,
    );
  });

  test('required suffixes are always last and deterministic', () => {
    const result = resolvePrompt('a', INLINE, FILE, FALLBACK, APPEND, [
      'mandatory policy',
      'final gate',
    ]);
    expect(result).toBe(
      `${INLINE}\n\n${APPEND}\n\nmandatory policy\n\nfinal gate`,
    );
  });
});

describe('resolvePrompt conflict warning', () => {
  test('warns when both inline and file prompt present', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    resolvePrompt('skeptic', INLINE, FILE, FALLBACK);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("'skeptic'");
    expect(msg).toContain('skeptic.md');
    expect(msg).toContain('overrides');
  });

  test('does not warn when only inline prompt present', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    resolvePrompt('skeptic', INLINE, undefined, FALLBACK);
    expect(warn).not.toHaveBeenCalled();
  });

  test('does not warn when only file prompt present', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    resolvePrompt('skeptic', undefined, FILE, FALLBACK);
    expect(warn).not.toHaveBeenCalled();
  });

  test('does not warn when neither present', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    resolvePrompt('skeptic', undefined, undefined, FALLBACK);
    expect(warn).not.toHaveBeenCalled();
  });
});
