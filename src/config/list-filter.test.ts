import { describe, expect, test } from 'bun:test';
import { matchesListFilter, splitListFilter } from './list-filter';

describe('splitListFilter', () => {
  test('separates allow entries from `!`-prefixed deny entries', () => {
    expect(splitListFilter(['*', '!explorer', 'oracle', '!librarian'])).toEqual(
      { allow: ['*', 'oracle'], deny: ['explorer', 'librarian'] },
    );
  });
});

describe('matchesListFilter', () => {
  function matches(name: string | undefined, items: string[]): boolean {
    return matchesListFilter(name, splitListFilter(items));
  }

  test('["*"] allows every name, including an unreadable one', () => {
    for (const name of ['oracle', 'explorer', 'fixer', undefined]) {
      expect(matches(name, ['*'])).toBe(true);
    }
  });

  test('["*", "!explorer"] denies the excluded name only', () => {
    expect(matches('explorer', ['*', '!explorer'])).toBe(false);
    expect(matches('oracle', ['*', '!explorer'])).toBe(true);
    expect(matches(undefined, ['*', '!explorer'])).toBe(true);
  });

  test('["oracle", "fixer"] allows only the listed names', () => {
    expect(matches('oracle', ['oracle', 'fixer'])).toBe(true);
    expect(matches('fixer', ['oracle', 'fixer'])).toBe(true);
    expect(matches('explorer', ['oracle', 'fixer'])).toBe(false);
    // An unreadable name never passes an explicit allow list.
    expect(matches(undefined, ['oracle', 'fixer'])).toBe(false);
  });

  test('deny wins over allow and "!*" denies everything', () => {
    expect(matches('oracle', ['oracle', '!oracle'])).toBe(false);
    expect(matches('oracle', ['!*'])).toBe(false);
    expect(matches(undefined, ['!*'])).toBe(false);
  });

  test('an empty list allows nothing', () => {
    expect(matches('oracle', [])).toBe(false);
  });
});
