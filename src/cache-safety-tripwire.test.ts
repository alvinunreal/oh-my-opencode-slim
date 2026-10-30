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
    'hooks/task-session-manager/task-context-tracker.ts',
    'Date.now() records lastReadAt for internal recency ordering; formatted prompt output (background job board) is confined to the volatile trailing message.',
  ],
  [
    'hooks/task-session-manager/event-router.ts',
    'Date.now() captures idleObservedAt to detect post-idle busy recovery from foreground-fallback re-prompts; never serialized into prompt content.',
  ],
  [
    'hooks/task-session-manager/revived-run-tracker.ts',
    'Date.now() captures immutable observation-attempt boundaries for terminal attribution; these timestamps are never serialized into notification prompts.',
  ],
  [
    'hooks/task-session-manager/runtime-status-reconciliation.ts',
    'Date.now() establishes in-memory request/observation ordering for generation-safe status reconciliation; board timestamps are never formatted into prompt content.',
  ],
  [
    'hooks/orchestrator-wake/index.ts',
    'Date.now() timestamps event-tracked child/status bookkeeping for wake decisions (staleness bound, busy-set); the wake prompt text — including the v2 anti-forgery and writer-lane suffix constants — is static and never derives from them.',
  ],
  [
    'hooks/task-session-manager/child-input-wait.ts',
    'Date.now() defaults the askedAt ordering key for pending child asks; timestamps are internal bookkeeping — the wake delta carries the ask content, never the timestamp.',
  ],
  [
    'hooks/task-session-manager/session-recovery.ts',
    'Date.now() stamps the persisted delivery marker and bounds v1 stop-confirmation polling; neither value is rendered into prompt content. Restored board timestamps come from host/transcript evidence, not this clock.',
  ],
  [
    'hooks/auto-update-checker/cache.ts',
    'Date.now() and process.pid name an on-disk quarantine directory during the atomic publish transaction; the path is filesystem bookkeeping, never serialized into prompt content.',
  ],
  [
    'hooks/auto-update-checker/checker.ts',
    'Date.now()/Math.random() compose a per-run temp token for install bookkeeping; it names local directories and never reaches the prompt prefix.',
  ],
  [
    'hooks/task-session-manager/tool-execute-hooks.ts',
    'Date.now() stamps the internal markReconciled acknowledgement before a native continuation; the value is board bookkeeping and is never formatted into prompt content (the hook writes tool args and board state only).',
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
