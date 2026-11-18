import { afterEach, describe, expect, test } from 'bun:test';
import {
  createEventDirectoryScope,
  type EventDirectoryScope,
  liveDirectoryCountForTests,
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

  test('keeps a directory live until every claim is released', () => {
    resetLiveDirectoriesForTests();
    expect(liveDirectoryCountForTests()).toBe(0);
    const observer = makeScope('/proj/observer');
    const first = createEventDirectoryScope('/proj/x');
    const second = createEventDirectoryScope('/proj/x');
    const event = { location: { directory: '/proj/x' } };
    expect(liveDirectoryCountForTests()).toBe(2);

    first.release();
    first.release(); // idempotent
    expect(observer.isForeign(event)).toBe(true);
    expect(liveDirectoryCountForTests()).toBe(2);

    second.release();
    expect(observer.isForeign(event)).toBe(false);
    expect(liveDirectoryCountForTests()).toBe(1);
    observer.release();
    expect(liveDirectoryCountForTests()).toBe(0);
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
