import { describe, expect, test } from 'bun:test';
import { joinTextParts, textFromContent } from './session-submit';

describe('joinTextParts', () => {
  test('joins kept text parts with the separator', () => {
    expect(
      joinTextParts(
        [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        '\n',
      ),
    ).toBe('a\nb');
  });

  test('empty array yields the empty string for any separator', () => {
    expect(joinTextParts([], '\n')).toBe('');
    expect(joinTextParts([], '')).toBe('');
  });

  test('single part is returned without separator bytes', () => {
    expect(joinTextParts([{ type: 'text', text: 'only' }], '\n')).toBe('only');
  });

  test('drops non-text parts, nulls, and non-string text parts', () => {
    expect(
      joinTextParts(
        [
          { type: 'text', text: 'a' },
          { type: 'image', uri: 'x' },
          { type: 'text' },
          { type: 'text', text: 42 },
          null,
          'str',
          7,
        ],
        '\n',
      ),
    ).toBe('a');
  });

  test('empty separator collapses non-string text parts invisibly', () => {
    // Byte-identity contract for the '' separators: dropping a text part
    // whose text is not a string contributes no bytes, exactly like the
    // previous keep-as-empty-string implementations.
    expect(
      joinTextParts(
        [
          { type: 'text', text: 'a' },
          { type: 'text', text: undefined },
          { type: 'text', text: 'b' },
        ],
        '',
      ),
    ).toBe('ab');
  });

  test('preserves empty-string text parts as separator-separated slots', () => {
    expect(
      joinTextParts(
        [
          { type: 'text', text: '' },
          { type: 'text', text: 'x' },
        ],
        '\n',
      ),
    ).toBe('\nx');
  });
});

describe('textFromContent', () => {
  test('joins v2 content text parts with no separator', () => {
    expect(
      textFromContent([
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
        { type: 'file', uri: 'f' },
      ]),
    ).toBe('hello world');
  });

  test('empty content yields empty string', () => {
    expect(textFromContent([])).toBe('');
  });
});
