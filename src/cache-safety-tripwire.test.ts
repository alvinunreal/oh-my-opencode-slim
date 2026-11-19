/**
 * Cache-safety tripwire — scans prompt-assembly source directories for
 * volatile-input patterns that silently invalidate provider prompt caches.
 *
 * Provider caches are exact byte-prefix matches over the rendered request.
 * A `Date.now()`, `new Date(...)`, `Math.random()`, or `randomUUID()` whose
 * value reaches the prompt prefix makes every request's prefix unique, so
 * nothing is ever served from cache — silently, with no error.
 *
 * When this test fails for a new file:
 *
 *   1. If the value can reach prompt content, keep it out of the stable
 *      prefix: route it through the trailing volatile zone via
 *      src/hooks/cache-safe-injection.ts, or drop it.
 *   2. If the value never feeds prompt content (timers, temp file names,
 *      internal bookkeeping), add an allowlist entry below with a
 *      justification that a reviewer can verify.
 *
 * See docs/cache-verification.md for the full invariant.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = import.meta.dir;

/** Directories that participate in prompt/payload assembly. */
const SCAN_DIRS = ['hooks', 'agents', 'config'];

const VOLATILE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'Date.now()', regex: /\bDate\.now\(/ },
  { name: 'new Date(...)', regex: /\bnew Date\(/ },
  { name: 'Math.random()', regex: /\bMath\.random\(/ },
  { name: 'randomUUID()', regex: /\brandomUUID\b/ },
  { name: 'randomBytes(...)', regex: /\brandomBytes\(/ },
  { name: 'performance.now()', regex: /\bperformance\.now\(/ },
];

/**
 * Files allowed to use volatile inputs, each with a reviewer-verifiable
 * reason why the value can never reach the prompt prefix. Adding an entry
 * is a code-review decision, not a formality.
 */
const ALLOWLIST = new Map<string, string>([
  [
    'config/json-file.ts',
    'Moved shared atomic config I/O from CLI: randomUUID names temporary backup/config files only; no value reaches prompt content or agent definitions.',
  ],
  [
    'hooks/foreground-fallback/index.ts',
    'Date.now() gates retry/dedup windows for model failover; no prompt content is derived from it.',
  ],
  [
    'hooks/foreground-fallback/quota-cooldown.ts',
    'Date.now() calculates and checks persisted quota reset deadlines only; timestamp values never enter prompt content.',
  ],
]);

async function scanForViolations(): Promise<string[]> {
  const violations: string[] = [];
  const glob = new Bun.Glob('**/*.ts');

  for (const dir of SCAN_DIRS) {
    const root = path.join(SRC_ROOT, dir);
    for await (const file of glob.scan(root)) {
      if (file.endsWith('.test.ts')) continue;
      const relative = `${dir}/${file}`;
      if (ALLOWLIST.has(relative)) continue;

      const content = readFileSync(path.join(root, file), 'utf8');
      for (const pattern of VOLATILE_PATTERNS) {
        if (pattern.regex.test(content)) {
          violations.push(`${relative} uses ${pattern.name}`);
        }
      }
    }
  }

  return violations;
}

describe('cache-safety tripwire', () => {
  test('prompt-assembly code introduces no unreviewed volatile inputs', async () => {
    const violations = await scanForViolations();
    expect(violations).toEqual([]);
  });

  test('allowlist contains no stale entries', async () => {
    const stale: string[] = [];

    for (const [relative] of ALLOWLIST) {
      const absolute = path.join(SRC_ROOT, relative);
      let content: string;
      try {
        content = readFileSync(absolute, 'utf8');
      } catch {
        stale.push(`${relative} (file no longer exists)`);
        continue;
      }
      const stillMatches = VOLATILE_PATTERNS.some((pattern) =>
        pattern.regex.test(content),
      );
      if (!stillMatches) {
        stale.push(`${relative} (no volatile patterns remain)`);
      }
    }

    expect(stale).toEqual([]);
  });
});
