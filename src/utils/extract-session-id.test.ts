import { describe, expect, test } from 'bun:test';
import { extractSessionId } from './extract-session-id';

describe('extractSessionId', () => {
  test('prefers info.id over sessionID', () => {
    expect(extractSessionId({ id: 'i' }, 's')).toBe('i');
  });

  test('falls back to sessionID when info.id missing', () => {
    expect(extractSessionId({}, 's')).toBe('s');
    expect(extractSessionId({ id: undefined }, 's')).toBe('s');
  });

  test('returns undefined when both missing', () => {
    expect(extractSessionId(undefined, undefined)).toBeUndefined();
    expect(extractSessionId(null, null)).toBeUndefined();
    expect(extractSessionId({}, undefined)).toBeUndefined();
  });

  test('handles null info', () => {
    expect(extractSessionId(null, 's')).toBe('s');
  });
});
