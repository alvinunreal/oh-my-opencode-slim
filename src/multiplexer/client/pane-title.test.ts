/**
 * Pane-title metadata tests (FR-8, NFR-5): strict parsing only — user titles
 * and malformed encodings must never be treated as ours.
 */

import { describe, expect, test } from 'bun:test';
import {
  encodePaneTitle,
  PANE_TITLE_PREFIX,
  parsePaneTitle,
} from './pane-title';

describe('pane title metadata (FR-8)', () => {
  test('round-trips owner pid + child session id', () => {
    expect(encodePaneTitle(4242, 'ses_abc123')).toBe('omosc:4242:ses_abc123');
    expect(parsePaneTitle('omosc:4242:ses_abc123')).toEqual({
      ownerPid: 4242,
      childSessionId: 'ses_abc123',
    });
  });

  test('exposes the fixed prefix', () => {
    expect(PANE_TITLE_PREFIX).toBe('omosc');
  });

  test('rejects user titles and malformed metadata (NFR-5)', () => {
    const rejected: Array<string | null | undefined> = [
      undefined,
      null,
      '',
      'bash',
      'user-title',
      'omosc',
      'omosc:',
      'omosc:12',
      'omosc:12:',
      'omosc::ses_abc',
      'omosc:abc:ses_abc',
      'omosc:0:ses_abc',
      'omosc:-1:ses_abc',
      'omosc:1.5:ses_abc',
      'omosc:12:ses abc',
      'omosc:12:ses/abc',
      'omosc:12:ses_abc:extra',
      'prefix omosc:12:ses_abc',
      'omosc:99999999999999:ses_abc',
      `omosc:12:${'a'.repeat(65)}`,
    ];
    for (const title of rejected) {
      expect(parsePaneTitle(title)).toBeNull();
    }
  });

  test('never treats parsed content as executable instructions', () => {
    // Shell metacharacters are outside the strict charset.
    expect(parsePaneTitle('omosc:12:ses_$(rm -rf /)')).toBeNull();
    expect(parsePaneTitle('omosc:12:ses_a;rm -rf /')).toBeNull();
    expect(parsePaneTitle('omosc:12:ses_a`id`')).toBeNull();
    expect(parsePaneTitle('omosc:12:ses_a && shutdown')).toBeNull();
  });
});
