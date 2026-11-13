import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTimerHarness } from '../../utils/test-timers';
import {
  createGoMonthlyLimitsService,
  GO_MONTHLY_LIMITS_URL,
  parseGoMonthlyLimits,
} from '../go-monthly-limits';

const START = Date.UTC(2026, 10, 7);
const DAY = 24 * 60 * 60 * 1000;
const RETRY = 6 * 60 * 60 * 1000;
const pricingHeader =
  '| Model | Input | Output | Cached Read | Cached Write | Monthly limit |\n| --- | --- | --- | --- | --- | --- |';
const price = (label: string, cap: string) =>
  `| ${label} | $0.15 | $0.50 | $0.03 | - | **${cap}** |`;
// Minimal MDX fixture: all supported suffixes, duplicate pricing tiers, and
// misleading request estimates outside the sole authoritative pricing block.
const fixture = `
<PlanTabs id="go-requests" label="Go plan" syncKey="go-plan">
<div slot="go">
${pricingHeader}
${price('Wrong Estimated Model', '$999999')}
</div>
</PlanTabs>
<PlanTabs id="go-pricing" label="Go plan" syncKey="go-plan">
${['go', 'go-plus', 'go-teams']
  .map(
    (plan, index) => `
<div slot="${plan}">
${pricingHeader}
${price('GLM-5.3-Flash', ['$60', '$180', '$65'][index]!)}
${price('DeepSeek V4.1 Flash (Off-Peak)', ['$100', '$200', '$105'][index]!)}
${price('DeepSeek V4.1 Flash (Peak)', ['$100', '$200', '$105'][index]!)}
${price('MiniMax M3 (≤ 512K tokens)', '$60')}
${price('MiniMax M3 (> 512K tokens)', '$60')}
${price('Gemini 4 Argon (50% off)', '$30')}
| Crouton Alpha Free | Free | Free | Free | - | **Unlimited**<br /><small>limited time</small> |
</div>`,
  )
  .join('\n')}
</PlanTabs>
## Endpoints
<div class="docs-table-scroll" role="region" aria-label="Go model endpoints" tabIndex={0}>
| Model | Model ID | Endpoint | AI SDK Package |
| --- | --- | --- | --- |
${[
  ['GLM-5.3-Flash', 'glm-5.3-flash'],
  ['DeepSeek V4.1 Flash', 'deepseek-v4.1-flash'],
  ['MiniMax M3', 'minimax-m3'],
  ['Gemini 4 Argon', 'gemini-4-argon'],
  ['Crouton Alpha Free', 'crouton-alpha-free'],
]
  .map(
    ([label, id]) =>
      `| ${label} | ${id} | \`https://opencode.ai/inference/go/openai/v1/chat/completions\` | \`@ai-sdk/openai-compatible\` |`,
  )
  .join('\n')}
</div>
## Something else
${pricingHeader}
${price('Another Wrong Model', '$12345')}
`;

const response = (body = fixture, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      etag: '"pricing-1"',
      ...headers,
    },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cacheDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    cacheDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 20,
      }),
    ),
  );
});
async function location() {
  const dir = await mkdtemp(join(tmpdir(), 'omos-go-limits-test-'));
  cacheDirs.push(dir);
  return join(dir, 'go-monthly-limits.json');
}
async function readCache(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('exact endpoint join, published plan caps, qualifiers and unlimited disclosure', () => {
  const rows = parseGoMonthlyLimits(fixture);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {
    modelID: 'glm-5.3-flash',
    go: '$60',
    goPlus: '$180',
    goTeams: '$65',
  });
  assert.deepEqual(rows[1], {
    modelID: 'deepseek-v4.1-flash',
    go: '$100',
    goPlus: '$200',
    goTeams: '$105',
  });
  assert.equal(rows[4]!.go, 'Unlimited limited time');
  assert.ok(!rows.some((row) => row.modelID.includes('wrong')));
  assert.equal(
    parseGoMonthlyLimits(fixture.replaceAll('(50% off)', '(25% off)')).length,
    5,
  );
  assert.equal(
    parseGoMonthlyLimits(
      fixture.replaceAll('GLM-5.3-Flash', 'GLM-5.3-Flash   '),
    ).length,
    5,
  );
});

test('reject conflicts, missing mapping/plan/header, unknown qualifiers and wrong model versions', () => {
  for (const malformed of [
    fixture.replace(
      price('DeepSeek V4.1 Flash (Peak)', '$100'),
      price('DeepSeek V4.1 Flash (Peak)', '$101'),
    ),
    fixture.replace('slot="go-teams"', 'slot="future-plan"'),
    fixture.replace(
      '| Model | Model ID | Endpoint | AI SDK Package |',
      '| Model | Guessed ID | Endpoint | AI SDK Package |',
    ),
    fixture.replace(
      price('GLM-5.3-Flash', '$60'),
      price('GLM-5.3-Flash (Preview)', '$60'),
    ),
    fixture.replace(
      price('GLM-5.3-Flash', '$60'),
      price('GLM-5.2-Flash', '$60'),
    ),
    fixture.replace(
      price('GLM-5.3-Flash', '$60'),
      price('glm-5.3-flash', '$60'),
    ),
    fixture.replace(
      '| GLM-5.3-Flash | glm-5.3-flash |',
      '| Unmapped Model | glm-5.3-flash |',
    ),
    fixture.replace('| **$65** |', '| |'),
    fixture.replace('id="go-pricing"', 'id="not-pricing"'),
    '',
  ])
    assert.throws(() => parseGoMonthlyLimits(malformed));
});

test('lazy first request coalesces, fresh reads have no requests, validated cache survives reload', async () => {
  const cachePath = await location();
  const pending = deferred<Response>();
  const started = deferred<void>();
  let calls = 0;
  const service = createGoMonthlyLimitsService({
    cachePath,
    now: () => START,
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, GO_MONTHLY_LIMITS_URL);
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('accept'), 'text/markdown');
      assert.match(headers.get('user-agent')!, /omos-gui/);
      assert.equal(headers.get('authorization'), null);
      started.resolve();
      return pending.promise;
    },
  });
  assert.equal(calls, 0);
  await assert.rejects(readFile(cachePath));
  const reads = Array.from({ length: 8 }, () => service.getGoMonthlyLimits());
  await started.promise;
  assert.equal(calls, 1);
  pending.resolve(response());
  const results = await Promise.all(reads);
  assert.ok(
    results.every(
      (result) => result.status === 'fresh' && result.rows.length === 5,
    ),
  );
  assert.equal(results[0]!.updatedAt, new Date(START).toISOString());
  results[0]!.rows[0]!.go = '$mutated';
  assert.equal((await service.getGoMonthlyLimits()).rows[0]!.go, '$60');
  assert.equal(calls, 1);
  const reloaded = createGoMonthlyLimitsService({
    cachePath,
    now: () => START + 1000,
    fetch: async () => {
      throw new Error('Must not fetch');
    },
  });
  assert.equal((await reloaded.getGoMonthlyLimits()).status, 'fresh');
});

test('24h TTL: stale returns immediately, coalesced background conditional GET 304 renews timestamp', async () => {
  const cachePath = await location();
  let now = START;
  let calls = 0;
  const pending = deferred<Response>();
  const service = createGoMonthlyLimitsService({
    cachePath,
    now: () => now,
    fetch: async (_url, init) => {
      if (++calls === 1)
        return response(fixture, {
          'last-modified': 'Fri, 06 Nov 2026 12:00:00 GMT',
        });
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('if-none-match'), '"pricing-1"');
      assert.equal(
        headers.get('if-modified-since'),
        'Fri, 06 Nov 2026 12:00:00 GMT',
      );
      return pending.promise;
    },
  });
  await service.getGoMonthlyLimits();
  now += DAY - 1;
  assert.equal((await service.getGoMonthlyLimits()).status, 'fresh');
  assert.equal(calls, 1);
  now++;
  const stale = await Promise.all(
    Array.from({ length: 8 }, () => service.getGoMonthlyLimits()),
  );
  assert.ok(
    stale.every(
      (result) =>
        result.status === 'stale' &&
        result.updatedAt === new Date(START).toISOString(),
    ),
  );
  assert.equal(calls, 2);
  pending.resolve(new Response(null, { status: 304 }));
  await service.waitForIdle();
  assert.equal((await readCache(cachePath)).updatedAt, now);
  assert.equal((await service.getGoMonthlyLimits()).status, 'fresh');
  assert.equal(calls, 2);
});

test('malformed refresh retains last-known-good, persists 6h retry backoff across reload', async () => {
  const cachePath = await location();
  let now = START;
  let calls = 0;
  const service = createGoMonthlyLimitsService({
    cachePath,
    now: () => now,
    fetch: async () => {
      calls++;
      return response(calls === 1 ? fixture : 'broken MDX');
    },
  });
  const original = await service.getGoMonthlyLimits();
  now += DAY;
  assert.equal((await service.getGoMonthlyLimits()).status, 'stale');
  await service.waitForIdle();
  assert.equal((await readCache(cachePath)).retryAt, now + RETRY);
  assert.deepEqual((await service.getGoMonthlyLimits()).rows, original.rows);
  assert.equal(
    (await service.getGoMonthlyLimits()).updatedAt,
    original.updatedAt,
  );
  assert.equal(calls, 2);
  let reloadCalls = 0;
  const reloaded = createGoMonthlyLimitsService({
    cachePath,
    now: () => now,
    fetch: async () => {
      reloadCalls++;
      return response();
    },
  });
  now += RETRY - 1;
  assert.equal((await reloaded.getGoMonthlyLimits()).status, 'stale');
  assert.equal(reloadCalls, 0);
  now++;
  assert.equal((await reloaded.getGoMonthlyLimits()).status, 'stale');
  await reloaded.waitForIdle();
  assert.equal((await readCache(cachePath)).updatedAt, now);
  assert.equal((await reloaded.getGoMonthlyLimits()).status, 'fresh');
  assert.equal(reloadCalls, 1);
});

test('HTTP/content type/empty/network failures and orphan 304 return unavailable with backoff', async () => {
  for (const fetcher of [
    async () => new Response('error', { status: 503 }),
    async () => response(fixture, { 'content-type': 'text/html' }),
    async () => response(''),
    async () => new Response(null, { status: 304 }),
    async () => {
      throw new Error('offline');
    },
  ]) {
    const cachePath = await location();
    let calls = 0;
    const service = createGoMonthlyLimitsService({
      cachePath,
      now: () => START,
      fetch: async () => {
        calls++;
        return fetcher();
      },
    });
    assert.deepEqual(await service.getGoMonthlyLimits(), {
      status: 'unavailable',
      sourceURL: GO_MONTHLY_LIMITS_URL,
      rows: [],
    });
    await service.getGoMonthlyLimits();
    assert.equal(calls, 1);
    const reloaded = createGoMonthlyLimitsService({
      cachePath,
      now: () => START,
      fetch: async () => {
        calls++;
        return response();
      },
    });
    assert.equal((await reloaded.getGoMonthlyLimits()).status, 'unavailable');
    assert.equal(calls, 1);
  }
});

test('streamed body limit cancels oversized response without retaining data', async () => {
  const cachePath = await location();
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const service = createGoMonthlyLimitsService({
    cachePath,
    now: () => START,
    fetch: async () =>
      new Response(stream, { headers: { 'content-type': 'text/plain' } }),
  });
  assert.equal((await service.getGoMonthlyLimits()).status, 'unavailable');
  assert.equal(cancelled, true);
  assert.ok(pulls <= 6);
  assert.throws(() => parseGoMonthlyLimits('x'.repeat(256 * 1024 + 1)));
});

test('5s timeout bounds first request and prevents retry per read', async () => {
  const cachePath = await location();
  const started = deferred<void>();
  const timers = createTimerHarness();
  let calls = 0;
  const service = createGoMonthlyLimitsService({
    cachePath,
    now: () => START,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: async (_url, init) => {
      calls++;
      started.resolve();
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        ),
      );
    },
  });
  const request = service.getGoMonthlyLimits();
  await started.promise;
  await timers.advance(5000);
  assert.equal((await request).status, 'unavailable');
  assert.equal((await service.getGoMonthlyLimits()).status, 'unavailable');
  assert.equal(calls, 1);
});

test('corrupt, oversized, invalid timestamps and duplicate-ID disk caches are ignored', async () => {
  const rows = parseGoMonthlyLimits(fixture);
  for (const body of [
    '{broken',
    'x'.repeat(256 * 1024 + 1),
    JSON.stringify({ version: 1, rows, updatedAt: START + 1, retryAt: 0 }),
    JSON.stringify({
      version: 1,
      rows,
      updatedAt: START,
      retryAt: START + RETRY + 1,
    }),
    JSON.stringify({
      version: 1,
      rows: [rows[0], rows[0]],
      updatedAt: START,
      retryAt: 0,
    }),
    JSON.stringify({
      version: 1,
      rows: [{ ...rows[0], go: 'not a cap' }],
      updatedAt: START,
      retryAt: 0,
    }),
    JSON.stringify({ version: 1, rows, updatedAt: -1, retryAt: 0 }),
  ]) {
    const cachePath = await location();
    await writeFile(cachePath, body);
    let calls = 0;
    const service = createGoMonthlyLimitsService({
      cachePath,
      now: () => START,
      fetch: async () => {
        calls++;
        return response();
      },
    });
    assert.equal((await service.getGoMonthlyLimits()).status, 'fresh');
    assert.equal(calls, 1);
  }
});

test('read-only/unwritable cache does not disable in-memory data', async () => {
  const cachePath = join(await location(), 'cannot-write-through-file.json');
  await writeFile(join(cachePath, '..'), 'not a directory');
  let calls = 0;
  const service = createGoMonthlyLimitsService({
    cachePath,
    now: () => START,
    fetch: async () => {
      calls++;
      return response();
    },
  });
  assert.equal((await service.getGoMonthlyLimits()).status, 'fresh');
  assert.equal((await service.getGoMonthlyLimits()).status, 'fresh');
  assert.equal(calls, 1);
});
