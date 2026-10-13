import { expect, test } from 'bun:test';
import {
  checkPublishedCompanionRelease,
  classifyCompanionRelease,
} from './check-companion-release.mjs';

const tag = 'companion-v0.1.5';
const targets = [
  'aarch64-apple-darwin',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
];

function publishedRelease() {
  return {
    draft: false,
    assets: targets.map((target) => ({
      name: `oh-my-opencode-slim-companion-v0.1.5-${target}.${target.includes('windows') ? 'zip' : 'tar.gz'}`,
      state: 'uploaded',
      size: 100,
    })),
  };
}

function mockResponse(status, data) {
  return { status, json: async () => data };
}

function options(request) {
  return {
    repository: 'alvinunreal/oh-my-opencode-slim',
    token: 'test-token',
    request,
    pause: async () => {},
  };
}

test('published complete release has five uploaded native archives', () => {
  expect(classifyCompanionRelease(publishedRelease(), tag)).toBe('complete');
  const extra = publishedRelease();
  extra.assets.push({ name: 'checksums.txt', state: 'uploaded', size: 123 });
  expect(classifyCompanionRelease(extra, tag)).toBe('complete');
});

test('missing, draft, zero-size and not-yet-uploaded assets are incomplete', () => {
  const partial = publishedRelease();
  partial.assets.pop();
  expect(classifyCompanionRelease(partial, tag)).toBe('incomplete');

  const draft = publishedRelease();
  draft.draft = true;
  expect(classifyCompanionRelease(draft, tag)).toBe('incomplete');

  const empty = publishedRelease();
  empty.assets[0].size = 0;
  expect(classifyCompanionRelease(empty, tag)).toBe('incomplete');

  const queued = publishedRelease();
  queued.assets[0].state = 'new';
  expect(classifyCompanionRelease(queued, tag)).toBe('incomplete');

  const malformed = publishedRelease();
  malformed.assets[0].size = undefined;
  expect(classifyCompanionRelease(malformed, tag)).toBe('incomplete');
});

test('successful GitHub API lookup returns complete without a rebuild', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return mockResponse(200, publishedRelease());
  };
  expect(await checkPublishedCompanionRelease(tag, options(request))).toBe(
    'complete',
  );
  expect(calls).toBe(1);
});

test('temporary server failure retries instead of returning missing', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return calls === 1
      ? mockResponse(503)
      : mockResponse(200, publishedRelease());
  };
  expect(await checkPublishedCompanionRelease(tag, options(request))).toBe(
    'complete',
  );
  expect(calls).toBe(2);
});

test('transient lookup transport error retries rather than bumping', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    if (calls < 3) throw new Error('Connection reset');
    return mockResponse(200, publishedRelease());
  };
  expect(await checkPublishedCompanionRelease(tag, options(request))).toBe(
    'complete',
  );
  expect(calls).toBe(3);
});

test('persistently missing release returns missing after retries', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return mockResponse(404);
  };
  expect(await checkPublishedCompanionRelease(tag, options(request))).toBe(
    'missing',
  );
  expect(calls).toBe(3);
});

test('persistent server error fails closed, never returns missing', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return mockResponse(502);
  };
  await expect(
    checkPublishedCompanionRelease(tag, options(request)),
  ).rejects.toThrow('HTTP 502');
  expect(calls).toBe(3);
});

test('GitHub authorization error fails closed without retrying', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return mockResponse(403);
  };
  await expect(
    checkPublishedCompanionRelease(tag, options(request)),
  ).rejects.toThrow('HTTP 403');
  expect(calls).toBe(1);
});

test('malformed successful API response fails closed', async () => {
  const request = async () => mockResponse(200, { assets: [] });
  await expect(
    checkPublishedCompanionRelease(tag, options(request)),
  ).rejects.toThrow('Malformed GitHub Companion release response.');
});
