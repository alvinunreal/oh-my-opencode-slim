import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  ABORTED_SESSION_ERROR_NAME,
  isAbortedSessionError,
  isTransportError,
  sessionErrorMessage,
  transportSessionErrorReason,
} from './session-error';

describe('isTransportError', () => {
  test('matches the recognized transport codes on structured fields', () => {
    expect(isTransportError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransportError({ cause: { code: 'ENOTFOUND' } })).toBe(true);
    expect(isTransportError({ data: { code: 'ETIMEDOUT' } })).toBe(true);
    expect(isTransportError({ code: 'EAI_AGAIN' })).toBe(true);
    expect(isTransportError({ code: 'ECONNREFUSED' })).toBe(true);
  });

  test('matches the socket codes beyond foreground-fallback\u2019s retry set', () => {
    // Lane classification is wider than retry eligibility: any broken wire
    // leaves the child's outcome unknown, not failed.
    for (const code of [
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENETDOWN',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ]) {
      expect(isTransportError({ code })).toBe(true);
      expect(
        isTransportError({ name: 'UnknownError', message: `write ${code}` }),
      ).toBe(true);
    }
  });

  test('matches a transport code embedded in a message or response body', () => {
    expect(
      isTransportError({ name: 'UnknownError', message: 'read ECONNRESET' }),
    ).toBe(true);
    expect(
      isTransportError({
        name: 'APIError',
        data: { message: 'getaddrinfo EAI_AGAIN api.example.com' },
      }),
    ).toBe(true);
    expect(
      isTransportError({ data: { responseBody: 'connect ECONNREFUSED' } }),
    ).toBe(true);
    expect(isTransportError('socket error: ETIMEDOUT')).toBe(true);
  });

  test('matches the bare transport phrasings OpenCode actually emits', () => {
    // Mirrors TRANSPORT_MESSAGE_PATTERNS in foreground-fallback: codes rarely
    // survive serialisation, so these strings are the common real signal.
    expect(
      isTransportError({
        name: 'UnknownError',
        data: { message: 'fetch failed' },
      }),
    ).toBe(true);
    expect(isTransportError({ message: 'fetch failed' })).toBe(true);
    expect(isTransportError('fetch failed')).toBe(true);
    expect(isTransportError({ message: 'socket hang up' })).toBe(true);
    expect(isTransportError({ message: 'Provider request timeout' })).toBe(
      true,
    );
    expect(isTransportError({ message: 'request timeout' })).toBe(true);
    expect(
      isTransportError({ message: 'connect ECONNREFUSED 127.0.0.1' }),
    ).toBe(true);
    expect(
      isTransportError({ message: 'getaddrinfo ENOTFOUND api.x.com' }),
    ).toBe(true);
    expect(
      isTransportError({ message: 'stream error: Cannot connect to API' }),
    ).toBe(true);
  });

  test('does not match prose that merely mentions failing to fetch', () => {
    // The patterns are anchored on purpose: an agent narrating "I could not
    // fetch failed dependencies" is not a transport fault.
    expect(
      isTransportError({ message: 'I could not fetch failed dependencies' }),
    ).toBe(false);
  });

  test('does not match rate limits or provider outages', () => {
    // Deliberately narrower than isFailoverError: a provider failure must
    // still surface as a hard `error`, not a recoverable lane.
    expect(
      isTransportError({ name: 'APIError', data: { message: 'rate limit' } }),
    ).toBe(false);
    expect(
      isTransportError({
        name: 'APIError',
        data: { message: 'Internal server error', statusCode: 500 },
      }),
    ).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError(42)).toBe(false);
  });

  test('an abort is never a transport fault, even if it mentions a code', () => {
    expect(
      isTransportError({
        name: 'MessageAbortedError',
        data: { message: 'aborted after ECONNRESET' },
      }),
    ).toBe(false);
  });
});

describe('isAbortedSessionError', () => {
  test('recognizes the SDK abort marker only', () => {
    expect(isAbortedSessionError({ name: ABORTED_SESSION_ERROR_NAME })).toBe(
      true,
    );
    expect(isAbortedSessionError({ name: 'UnknownError' })).toBe(false);
    expect(isAbortedSessionError('MessageAbortedError')).toBe(false);
    expect(isAbortedSessionError(undefined)).toBe(false);
  });
});

describe('transportSessionErrorReason', () => {
  test('names the fault and refuses to call the task failed', () => {
    expect(
      transportSessionErrorReason({
        name: 'UnknownError',
        data: { message: 'fetch failed' },
      }),
    ).toBe(
      'Child session lost its transport connection (fetch failed); the task outcome is unknown.',
    );
  });

  test('falls back to the transport code, then to bare text', () => {
    expect(transportSessionErrorReason({ code: 'ECONNRESET' })).toBe(
      'Child session lost its transport connection (ECONNRESET); the task outcome is unknown.',
    );
    expect(transportSessionErrorReason({})).toBe(
      'Child session lost its transport connection; the task outcome is unknown.',
    );
  });
});

describe('sessionErrorMessage', () => {
  test('prefers data.message, then message, then name, then fallback', () => {
    expect(
      sessionErrorMessage(
        { name: 'ProviderAuthError', data: { message: 'invalid api key' } },
        'fallback',
      ),
    ).toBe('invalid api key');
    expect(sessionErrorMessage({ message: 'boom' }, 'fallback')).toBe('boom');
    expect(sessionErrorMessage({ name: 'UnknownError' }, 'fallback')).toBe(
      'UnknownError',
    );
    expect(sessionErrorMessage({}, 'fallback')).toBe('fallback');
    expect(sessionErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(sessionErrorMessage('  spaced  ', 'fallback')).toBe('spaced');
  });
});

// ---------------------------------------------------------------------------
// Drift guard for the deliberate copy of foreground-fallback's transport sets.
//
// `src/utils` must not import from `src/hooks` (foreground-fallback already
// imports src/utils, so it would close a cycle), so the transport code list
// and message patterns are duplicated here. This scan compares the two source
// files textually: if foreground-fallback gains or loses a transport pattern,
// this test fails until the copy is updated.
// ---------------------------------------------------------------------------

const SRC_DIR = path.resolve(import.meta.dir, '..');
const FOREGROUND_FALLBACK = path.join(
  SRC_DIR,
  'hooks',
  'foreground-fallback',
  'index.ts',
);
const SESSION_ERROR = path.join(SRC_DIR, 'utils', 'session-error.ts');

/**
 * Entries of a multi-line array/set literal, minus comment and blank lines.
 * Stops at the first line that closes the literal (`]`, `];`, `]);`), so it
 * works for both `= [` and `= new Set([` declarations.
 */
function literalEntries(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration);
  if (start === -1) return [];
  const open = source.indexOf('[', start);
  if (open === -1) return [];

  const entries: string[] = [];
  for (const raw of source.slice(open + 1).split('\n')) {
    const line = raw.trim();
    if (line.startsWith(']')) break;
    const entry = line.replace(/,$/, '');
    if (entry.length === 0 || entry.startsWith('//')) continue;
    entries.push(entry);
  }
  return entries.sort();
}

describe('transport classifier copy', () => {
  const fallbackSource = readFileSync(FOREGROUND_FALLBACK, 'utf8');
  const ownSource = readFileSync(SESSION_ERROR, 'utf8');

  test('message patterns match foreground-fallback verbatim', () => {
    const upstream = literalEntries(
      fallbackSource,
      'const TRANSPORT_MESSAGE_PATTERNS = [',
    );
    const copy = literalEntries(
      ownSource,
      'const TRANSPORT_MESSAGE_PATTERNS = [',
    );

    expect(upstream.length).toBeGreaterThan(0);
    expect(copy).toEqual(upstream);
  });

  test('transport codes match foreground-fallback verbatim', () => {
    const upstream = literalEntries(
      fallbackSource,
      'const TRANSPORT_CODES = new Set([',
    ).map((entry) => entry.replace(/['"]/g, ''));
    const copy = literalEntries(
      ownSource,
      'const TRANSPORT_ERROR_CODES = [',
    ).map((entry) => entry.replace(/['"]/g, ''));

    expect(upstream.length).toBe(5);
    expect(copy).toEqual(upstream);
  });

  /**
   * The extra codes are ours, not a copy, so they are exempt from the verbatim
   * check — but they must never shadow it. If foreground-fallback later adopts
   * one of them, the mirrored list gains it and this assertion fails until the
   * duplicate is removed from the extras.
   */
  test('the additional codes stay disjoint from the mirrored set', () => {
    const mirrored = literalEntries(
      ownSource,
      'const TRANSPORT_ERROR_CODES = [',
    ).map((entry) => entry.replace(/['"]/g, ''));
    const additional = literalEntries(
      ownSource,
      'const ADDITIONAL_TRANSPORT_CODES = [',
    ).map((entry) => entry.replace(/['"]/g, ''));

    expect(additional.length).toBeGreaterThan(0);
    expect(additional.filter((code) => mirrored.includes(code))).toEqual([]);
  });
});
