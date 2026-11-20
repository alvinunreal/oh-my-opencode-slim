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
  test('["*"] allows every name, including an unreadable one', () => {
    for (const name of ['oracle', 'explorer', 'fixer', undefined]) {
      expect(matchesListFilter(name, ['*'])).toBe(true);
    }
  });

  test('["*", "!explorer"] denies the excluded name only', () => {
    expect(matchesListFilter('explorer', ['*', '!explorer'])).toBe(false);
    expect(matchesListFilter('oracle', ['*', '!explorer'])).toBe(true);
    expect(matchesListFilter(undefined, ['*', '!explorer'])).toBe(true);
  });

  test('["oracle", "fixer"] allows only the listed names', () => {
    expect(matchesListFilter('oracle', ['oracle', 'fixer'])).toBe(true);
    expect(matchesListFilter('fixer', ['oracle', 'fixer'])).toBe(true);
    expect(matchesListFilter('explorer', ['oracle', 'fixer'])).toBe(false);
    // An unreadable name never passes an explicit allow list.
    expect(matchesListFilter(undefined, ['oracle', 'fixer'])).toBe(false);
  });

  test('deny wins over allow and "!*" denies everything', () => {
    expect(matchesListFilter('oracle', ['oracle', '!oracle'])).toBe(false);
    expect(matchesListFilter('oracle', ['!*'])).toBe(false);
    expect(matchesListFilter(undefined, ['!*'])).toBe(false);
  });

  test('an empty list allows nothing', () => {
    expect(matchesListFilter('oracle', [])).toBe(false);
  });
});
