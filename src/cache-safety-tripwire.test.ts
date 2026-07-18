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
  { name: 'performance.now()', regex: /\bperformance\.now\(/ },
];

/**
 * Files allowed to use volatile inputs, each with a reviewer-verifiable
 * reason why the value can never reach the prompt prefix. Adding an entry
 * is a code-review decision, not a formality.
 */
const ALLOWLIST = new Map<string, string>([
  [
    'hooks/auto-update-checker/skill-sync.ts',
    'Update scheduling and install bookkeeping; produces no prompt content.',
  ],
  [
    'hooks/loop-command/index.ts',
    'Timestamps/randomness name per-run loop-history directories; the path only appears inside a newly appended user turn (payload tail), never in earlier prefix bytes.',
  ],
  [
    'hooks/foreground-fallback/index.ts',
    'Date.now() gates retry/dedup windows for model failover; no prompt content is derived from it.',
  ],
  [
    'hooks/apply-patch/prepared-changes.ts',
    'randomUUID() names temp files during atomic writes; never serialized into messages.',
  ],
  [
    'hooks/task-session-manager/task-context-tracker.ts',
    'Date.now() records lastReadAt for internal recency ordering; formatted prompt output (background job board) is confined to the volatile trailing message.',
  ],
  [
    'hooks/image-hook.ts',
    'Date.now() throttles temp-image cleanup; extracted image paths are deterministic per part id.',
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

    if (violations.length > 0) {
      throw new Error(
        [
          'Volatile input detected in prompt-assembly code. If its value can',
          'reach the prompt, it will silently bust the provider cache on',
          'every request — keep it in the volatile tail via',
          'src/hooks/cache-safe-injection.ts, or add a justified allowlist',
          'entry in src/cache-safety-tripwire.test.ts (see file header).',
          '',
          ...violations,
        ].join('\n'),
      );
    }
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
