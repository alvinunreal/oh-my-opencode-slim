/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { parseArgs } from './index';

describe('cli index args', () => {
  test('parses --nanogpt=yes in install args', () => {
    const parsed = parseArgs(['--nanogpt=yes', '--no-tui']);
    expect(parsed.nanogpt).toBe('yes');
    expect(parsed.tui).toBe(false);
  });
});
