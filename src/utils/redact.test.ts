import { describe, expect, test } from 'bun:test';
import { maskTaskOutputStructure, redactSecretsForLog } from './redact';

// Partner-pattern fixtures are runtime-joined rather than written as
// contiguous string literals so secret scanning / GitHub push protection
// (repo blob scanning) does not flag this repository for carrying
// live-shaped credentials. AKIAIOSFODNN7EXAMPLE below stays verbatim:
// it is AWS's canonical documented example access key id.
const SK_TOKEN = ['sk-', 'proj-', 'abcdef1234567890', 'abcdef'].join('');
const GH_TOKEN = (kind: 'ghp' | 'gho' | 'ghu' | 'ghs' | 'ghr') =>
  [`${kind}`, '_', 'ABCDEFGHIJKLMNOP', 'QRSTUVWXYZ1234'].join('');
const XOX_TOKEN = (kind: 'b' | 'a' | 'p' | 'r' | 's') =>
  ['xox', kind, '-123456789012-', '1234567890123-', 'abcdefghijklmnop'].join(
    '',
  );
const BEARER_TOKEN = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  '.payload.sig',
].join('');

describe('redactSecretsForLog', () => {
  test('masks OpenAI-style sk- tokens (prefix/suffix kept, middle gone)', () => {
    const out = redactSecretsForLog(`call failed with ${SK_TOKEN} in env`);
    expect(out).toContain('sk-p');
    expect(out.endsWith('ef') || out.includes('…ef')).toBe(true);
    expect(out).not.toContain(SK_TOKEN);
    expect(out).toContain('…');
  });

  test('masks GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)', () => {
    for (const kind of ['ghp', 'gho', 'ghu', 'ghs', 'ghr'] as const) {
      const token = GH_TOKEN(kind);
      const out = redactSecretsForLog(`auth: ${token}`);
      expect(out.startsWith('auth: gh')).toBe(true);
      expect(out).not.toContain(token);
      expect(out.slice('auth: '.length)).toContain('…');
    }
  });

  test('masks GitLab personal access tokens (glpat-…)', () => {
    const token = 'glpat-Abcdef1234567890123';
    const out = redactSecretsForLog(`gitlab ${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain('glpa…23');
  });

  test('masks Slack tokens (xox[baprs]-…)', () => {
    for (const kind of ['b', 'a', 'p', 'r', 's'] as const) {
      const token = XOX_TOKEN(kind);
      const out = redactSecretsForLog(`slack ${token}`);
      expect(out).not.toContain(token);
      expect(out).toContain('xox');
    }
  });

  test('masks AWS access key ids and STS temporary keys (AKIA/ASIA…)', () => {
    // Canonical AWS-documented example key id — intentionally verbatim.
    const akia = 'AKIAIOSFODNN7EXAMPLE';
    const asia = 'ASIAIOSFODNN7EXAMPLE';
    for (const token of [akia, asia]) {
      const out = redactSecretsForLog(`key=${token}`);
      expect(out).toContain(token.slice(0, 4));
      expect(out).not.toContain(token);
    }
  });

  test('masks Bearer tokens (scheme kept, credential masked)', () => {
    const out = redactSecretsForLog(`Authorization: Bearer ${BEARER_TOKEN}`);
    expect(out).toContain('Bearer');
    expect(out).not.toContain(BEARER_TOKEN);
  });

  test('masks Basic and token-scheme credentials', () => {
    const basic = 'dXNlcjpwYXNzd29yZA==';
    const out = redactSecretsForLog(`Authorization: Basic ${basic}`);
    expect(out).toContain('Basic');
    expect(out).not.toContain(basic);
    const tokenScheme = 'sup3r-s3cret-session-token_value';
    const out2 = redactSecretsForLog(`token ${tokenScheme}`);
    expect(out2).toContain('token');
    expect(out2).not.toContain(tokenScheme);
  });

  test('masks ONLY the password in URL credentials (user+host visible)', () => {
    const dsn = 'postgres://deploy:S3cr3tPass_w0rd@db.internal.io:5432/app';
    const out = redactSecretsForLog(`dsn: ${dsn}`);
    expect(out).toContain('postgres://deploy:');
    expect(out).toContain('@db.internal.io:5432/app');
    expect(out).not.toContain('S3cr3tPass_w0rd');
    expect(out).toContain('S3cr…rd');
    // scheme://user@ without a password is untouched.
    const plain = 'postgres://deploy@db.internal.io:5432/app';
    expect(redactSecretsForLog(`dsn: ${plain}`)).toBe(`dsn: ${plain}`);
  });

  test('masks generic long opaque runs (32+ chars)', () => {
    const token = 'Z9xQ1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7';
    const out = redactSecretsForLog(`api returned ${token} please check`);
    expect(out.startsWith('api returned Z9xQ')).toBe(true);
    expect(out).not.toContain(token);
  });

  test('masks every occurrence, not just the first', () => {
    const a = ['sk-', 'aaaaaaaaaaaaaaaa', 'aaaaaa'].join('');
    const b = GH_TOKEN('ghp');
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

  test('short session ids, short urls, and xml-ish content stay readable', () => {
    const text =
      '<task id="ses_abc123" state="completed">' +
      ' see https://api.example.com/v1 ' +
      'parent ses_deadbeef42';
    expect(redactSecretsForLog(text)).toBe(text);
  });

  test('long url paths are masked by the generic-run rule (accepted FP)', () => {
    // Honest assertion: a >32-char unbroken run inside a URL is masked.
    // Documented false-positive acceptance — the generic rule cannot
    // tell a long path from a secret.
    const long =
      'https://github.com/alvinunreal/oh-my-opencode-slim/pull/1174/files';
    const out = redactSecretsForLog(`see ${long} for review`);
    expect(out).not.toContain(long);
    expect(out).toContain('…');
  });

  test('empty and short strings pass through', () => {
    expect(redactSecretsForLog('')).toBe('');
    expect(redactSecretsForLog('plain text')).toBe('plain text');
  });

  test('straddle case: redact-then-slice shows the mask, not a raw prefix', () => {
    // Call-site ordering semantics: redact the FULL string, then slice
    // (here to 140, like the parse-miss preview). A 40-char opaque
    // secret starting at offset 100 must appear as its mask — slicing
    // first would leak the raw prefix of a boundary-straddling secret.
    const filler = 'a b '.repeat(25); // 100 chars, no long runs
    const secret = 'Q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0'; // 40 chars
    const tail = ' t u'.repeat(15); // 60 chars (leading space: exact run end)
    const input = `${filler}${secret}${tail}`;
    expect(input.length).toBe(200);

    const out = redactSecretsForLog(input).slice(0, 140);
    expect(out.length).toBe(140);
    expect(out).toContain('…');
    // The raw secret — and any 20-char raw prefix of it — is gone.
    expect(out).not.toContain(secret);
    expect(out).not.toContain(secret.slice(0, 20));
    // The mask marker sits right after the filler.
    expect(out.slice(100, 107)).toBe('Q1w2…z0');
  });

  test('accepted false positives: long paths, UUIDs, and hashes are masked', () => {
    // Documented as intended: the generic 32+ run rule masks long opaque
    // non-secrets too. Redaction errs toward masking.
    const filePath = '/mnt/d/GitRepos/oh-my-opencode-slim/dist/server/index.js';
    expect(redactSecretsForLog(filePath)).not.toContain(filePath);
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(redactSecretsForLog(`id ${uuid}`)).not.toContain(uuid);
    const sha256 =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(redactSecretsForLog(`sha ${sha256}`)).not.toContain(sha256);
  });
});

describe('maskTaskOutputStructure', () => {
  // Structure-only disclosure for untrusted-format previews: field/tag
  // names survive, every VALUE is fully masked as [masked].
  test('live v2 sample (a): subagent XML — attr names kept, values masked, inner text survives', () => {
    const input =
      '<subagent sessionID="ses_1a2b3c" state="completed" description="Fix login bug">done</subagent>';
    const out = maskTaskOutputStructure(input);
    expect(out).toContain('<subagent');
    expect(out).toContain('sessionID=');
    expect(out).toContain('state=');
    expect(out).toContain('description=');
    expect(out).toContain('"[masked]"');
    expect(out).not.toContain('ses_1a2b3c');
    expect(out).not.toContain('completed');
    expect(out).not.toContain('Fix login bug');
    expect(out).toContain('>done</subagent>');
  });

  test('live v2 sample (b): prose key-value — words intact, value masked', () => {
    const input =
      'The subagent is working in the background (sessionID: ses_9f8e7d).';
    const out = maskTaskOutputStructure(input);
    expect(out).toBe(
      'The subagent is working in the background (sessionID: [masked]).',
    );
  });

  test('live v2 sample (c): key-value masked AND prose pass redacts the DSN password', () => {
    const input =
      'Subagent failed (sessionID: ses_5d4c3b): connection refused for postgres://deploy:hunter2@db';
    const out = maskTaskOutputStructure(input);
    expect(out).toContain('(sessionID: [masked])');
    expect(out).toContain('connection refused');
    expect(out).not.toContain('ses_5d4c3b');
    expect(out).not.toContain('hunter2');
    // The prose pass kept user+host readable and masked only the password.
    expect(out).toContain('postgres://deploy:');
    expect(out).toContain('@db');
  });

  test('v1 task XML: names kept, values masked', () => {
    expect(maskTaskOutputStructure('<task id="abc" state="running">')).toBe(
      '<task id="[masked]" state="[masked]">',
    );
  });

  test('single-quoted, unquoted, and self-closing attribute forms', () => {
    expect(maskTaskOutputStructure("<task id='abc' />")).toBe(
      "<task id='[masked]' />",
    );
    expect(maskTaskOutputStructure('<task id=abc/>')).toBe(
      '<task id=[masked]/>',
    );
    expect(maskTaskOutputStructure('<task state=running>')).toBe(
      '<task state=[masked]>',
    );
  });

  test('unquoted prose key=value form masks the value', () => {
    expect(maskTaskOutputStructure('state=running task_id=abc123')).toBe(
      'state=[masked] task_id=[masked]',
    );
    expect(maskTaskOutputStructure('task_id: abc123')).toBe(
      'task_id: [masked]',
    );
  });

  test('malformed pseudo-tags are left to the prose pass unbroken', () => {
    const malformed = '<not xml';
    expect(maskTaskOutputStructure(malformed)).toBe(malformed);
    const mixed = 'a < b and 3 > 2';
    expect(maskTaskOutputStructure(mixed)).toBe(mixed);
  });

  test('a secret-looking attribute value never leaks (masked before prose)', () => {
    // Runtime-joined so secret scanning does not flag the fixture.
    const token = ['ghp_', 'ABCDEFGHIJKLMNOP', 'QRSTUVWXYZ1234'].join('');
    const out = maskTaskOutputStructure(
      `<subagent sessionID="${token}" state="completed">`,
    );
    expect(out).not.toContain(token);
    expect(out).toContain('sessionID="[masked]"');
  });

  test('URL schemes are not treated as key-value tokens', () => {
    const input = 'see https://api.example.com/v1 and postgres://deploy@db';
    // Schemes survive the key-value pass; the prose pass leaves the short
    // benign URL and the password-less DSN untouched.
    expect(maskTaskOutputStructure(input)).toBe(input);
  });

  test('deterministic: same input twice → identical output', () => {
    const input =
      '<task id="abc" state="running">text (sessionID: ses_9f8e7d) postgres://deploy:hunter2@db';
    expect(maskTaskOutputStructure(input)).toBe(maskTaskOutputStructure(input));
  });
});
