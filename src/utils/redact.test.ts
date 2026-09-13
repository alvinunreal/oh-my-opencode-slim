import { describe, expect, test } from 'bun:test';
import { redactSecretsForLog } from './redact';

describe('redactSecretsForLog', () => {
  test('masks OpenAI-style sk- tokens (prefix/suffix kept, middle gone)', () => {
    const token = 'sk-proj-abcdef1234567890abcdef';
    const out = redactSecretsForLog(`call failed with ${token} in env`);
    expect(out).toContain('sk-p');
    expect(out.endsWith('ef') || out.includes('…ef')).toBe(true);
    expect(out).not.toContain(token);
    expect(out).toContain('…');
  });

  test('masks GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)', () => {
    for (const token of [
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
      'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
      'ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
      'ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
      'ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
    ]) {
      const out = redactSecretsForLog(`auth: ${token}`);
      expect(out.startsWith('auth: gh')).toBe(true);
      expect(out).not.toContain(token);
      expect(out.slice('auth: '.length)).toContain('…');
    }
  });

  test('masks Slack tokens (xox[baprs]-…)', () => {
    // Fixtures use letter segments (not the real digit-segment format) so
    // GitHub push protection does not classify them as live Slack tokens.
    for (const token of [
      'xoxb-testworkspac-testagentid-abcdefghijklmnop',
      'xoxa-testworkspac-testbotauthn-abcdefghijklmnop',
      'xoxp-testworkspac-testusertokn-abcdefghijklmnop',
      'xoxr-testworkspac-testrefresht-abcdefghijklmnop',
      'xoxs-testworkspac-testsessiont-abcdefghijklmnop',
    ]) {
      const out = redactSecretsForLog(`slack ${token}`);
      expect(out).not.toContain(token);
      expect(out).toContain('xox');
    }
  });

  test('masks AWS access key ids (AKIA…)', () => {
    const token = 'AKIAIOSFODNN7EXAMPLE';
    const out = redactSecretsForLog(`key=${token}`);
    expect(out).toContain('AKIA');
    expect(out).not.toContain(token);
  });

  test('masks Bearer tokens (scheme kept, token masked)', () => {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
    const out = redactSecretsForLog(`Authorization: Bearer ${token}`);
    expect(out).toContain('Bearer');
    expect(out).not.toContain(token);
  });

  test('masks generic long opaque runs (32+ chars)', () => {
    const token = 'Z9xQ1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7';
    const out = redactSecretsForLog(`api returned ${token} please check`);
    expect(out.startsWith('api returned Z9xQ')).toBe(true);
    expect(out).not.toContain(token);
  });

  test('masks every occurrence, not just the first', () => {
    const a = 'sk-aaaaaaaaaaaaaaaaaaaaaa';
    const b = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBB';
    const out = redactSecretsForLog(`${a} and ${b}`);
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
  });

  test('benign task-output structure passes through unchanged', () => {
    const text = [
      'task_id: ses_8db21a44fe0a97cf',
      'state: running',
      '',
      '<task_result>',
      'Background task started.',
      '</task_result>',
    ].join('\n');
    expect(redactSecretsForLog(text)).toBe(text);
  });

  test('short session ids, urls, and xml-ish content stay readable', () => {
    const text =
      '<task id="ses_abc123" state="completed">' +
      ' see https://api.example.com/v1 ' +
      'parent ses_deadbeef42';
    expect(redactSecretsForLog(text)).toBe(text);
  });

  test('empty and short strings pass through', () => {
    expect(redactSecretsForLog('')).toBe('');
    expect(redactSecretsForLog('plain text')).toBe('plain text');
  });
});
