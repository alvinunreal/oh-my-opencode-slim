import { describe, expect, it } from 'bun:test';
import { escapeHtml } from './escape-html';

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('a "b" c')).toBe('a &quot;b&quot; c');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("a 'b' c")).toBe('a &#39;b&#39; c');
  });

  it('escapes all entities in one string', () => {
    expect(escapeHtml('<div class="a" title=\'b\'>')).toBe(
      '&lt;div class=&quot;a&quot; title=&#39;b&#39;&gt;',
    );
  });

  it('returns unchanged string with no special chars', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});
