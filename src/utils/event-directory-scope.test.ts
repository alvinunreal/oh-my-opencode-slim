import { afterEach, describe, expect, test } from 'bun:test';
import {
  createEventDirectoryScope,
  type EventDirectoryScope,
  hasLiveInstances,
  normalizeScopeDirectory,
  resetLiveDirectoriesForTests,
} from './event-directory-scope';

describe('event-directory-scope', () => {
  const scopes: EventDirectoryScope[] = [];
  const makeScope = (directory: string): EventDirectoryScope => {
    const scope = createEventDirectoryScope(directory);
    scopes.push(scope);
    return scope;
  };

  afterEach(() => {
    while (scopes.length > 0) scopes.pop()?.release();
  });

  test('normalizes trailing separators', () => {
    expect(normalizeScopeDirectory('/a/b/')).toBe('/a/b');
    expect(normalizeScopeDirectory('/a/b')).toBe('/a/b');
    expect(normalizeScopeDirectory('/')).toBe('/');
  });

  test('hasLiveInstances tracks claims and clears after release', () => {
    resetLiveDirectoriesForTests();
    expect(hasLiveInstances()).toBe(false);

    const scope = createEventDirectoryScope('/proj/x');
    expect(hasLiveInstances()).toBe(true);

    scope.release();
    scope.release(); // idempotent
    expect(hasLiveInstances()).toBe(false);
  });

  test('keeps a directory live until every claim is released', () => {
    resetLiveDirectoriesForTests();
    const first = createEventDirectoryScope('/proj/x');
    const second = createEventDirectoryScope('/proj/x');

    first.release();
    expect(hasLiveInstances()).toBe(true);

    second.release();
    expect(hasLiveInstances()).toBe(false);
  });

  test('processes its own directory and unresolved events', () => {
    const scope = makeScope('/proj/a');
    expect(
      scope.isForeign({
        type: 'session.status',
        properties: { sessionID: 's1' },
      }),
    ).toBe(false);

    scope.note({
      type: 'session.created',
      properties: { info: { id: 's1', directory: '/proj/a' } },
    });
    expect(
      scope.isForeign({
        type: 'session.status',
        properties: { sessionID: 's1' },
      }),
    ).toBe(false);
  });

  test('drops events for another directory that has a live instance', () => {
    const other = makeScope('/proj/b');
    const scope = makeScope('/proj/a');
    const created = {
      type: 'session.created',
      properties: { info: { id: 's2', directory: '/proj/b' } },
    };
    scope.note(created);
    other.note(created);

    expect(
      scope.isForeign({
        type: 'session.status',
        properties: { sessionID: 's2' },
      }),
    ).toBe(true);
    expect(
      other.isForeign({
        type: 'session.status',
        properties: { sessionID: 's2' },
      }),
    ).toBe(false);
    expect(
      scope.isForeign({
        type: 'session.status',
        properties: { sessionID: 'other' },
      }),
    ).toBe(false);
  });

  test('processes foreign events when no live instance owns the directory', () => {
    const other = createEventDirectoryScope('/proj/b');
    const scope = makeScope('/proj/a');
    scope.note({
      type: 'session.created',
      properties: { info: { id: 's2', directory: '/proj/b' } },
    });
    other.release();

    expect(
      scope.isForeign({
        type: 'session.status',
        properties: { sessionID: 's2' },
      }),
    ).toBe(false);
  });

  test('reads the v2 envelope and data location', () => {
    makeScope('/proj/b');
    const scope = makeScope('/proj/a');

    expect(
      scope.isForeign({ type: 'x', location: { directory: '/proj/b' } }),
    ).toBe(true);
    expect(
      scope.isForeign({
        type: 'session.created',
        data: { sessionID: 's3', location: { directory: '/proj/b' } },
      }),
    ).toBe(true);
    expect(
      scope.isForeign({ type: 'x', location: { directory: '/proj/a/' } }),
    ).toBe(false);
    expect(scope.isForeign({ type: 'x', data: {} })).toBe(false);
  });
});
