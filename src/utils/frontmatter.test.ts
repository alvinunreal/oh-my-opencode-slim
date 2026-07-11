import { describe, expect, it } from 'bun:test';
import { parseFrontmatter } from './frontmatter';

describe('parseFrontmatter', () => {
  it('parses basic frontmatter block', () => {
    const input = '---\nkey: value\n---\nbody';
    expect(parseFrontmatter(input)).toEqual({ key: 'value' });
  });

  it('returns null for content without frontmatter', () => {
    expect(parseFrontmatter('just some text')).toBeNull();
  });

  it('strips surrounding quotes from values', () => {
    const input = '---\ntitle: "Hello World"\n---\nbody';
    expect(parseFrontmatter(input)).toEqual({ title: 'Hello World' });
  });

  it('handles single-quoted values', () => {
    const input = "---\nname: 'test'\n---\nbody";
    expect(parseFrontmatter(input)).toEqual({ name: 'test' });
  });

  it('handles multiple key-value pairs', () => {
    const input = '---\nurl: https://example.com\ntitle: Example\n---\nbody';
    expect(parseFrontmatter(input)).toEqual({
      url: 'https://example.com',
      title: 'Example',
    });
  });

  it('handles CRLF line endings', () => {
    const input = '---\r\nkey: value\r\n---\r\nbody';
    expect(parseFrontmatter(input)).toEqual({ key: 'value' });
  });

  it('skips lines without key-value pattern', () => {
    const input = '---\nkey: value\n# comment\nother: thing\n---\nbody';
    expect(parseFrontmatter(input)).toEqual({ key: 'value', other: 'thing' });
  });

  it('returns null for missing closing delimiter', () => {
    expect(parseFrontmatter('---\nkey: value')).toBeNull();
  });
});
