import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BackgroundJobRecord } from '../utils/background-job-board';
import { createDeepworkExplorer, type DeepworkExplorer } from './index';
import { parseProgress, projectJobs } from './snapshot';

const PROGRESS = `status: active
Pass 2 (Structure). Goal: real seat model and Stripe subscriptions.
Next step: dispatch fix-2, fix-3 and des-2.
Decision: webhooks get their own lane.

Known issues:
1. Invite tokens never expire
2. Dunning emails missing

References: src/billing/webhooks.ts`;

function record(over: Partial<BackgroundJobRecord>): BackgroundJobRecord {
  return {
    taskID: 'ses_child',
    parentSessionID: 'ses_parent',
    agent: 'fixer',
    description: 'Seat model',
    state: 'running',
    background: true,
    timedOut: false,
    recoverableAfterLiveBusy: false,
    statusUncertain: false,
    cancellationRequested: false,
    terminalUnreconciled: false,
    launchedAt: 1000,
    lastLaunchedAt: 1000,
    generation: 1,
    terminalRevision: 0,
    activityRevision: 0,
    taskGeneration: 1,
    runStartedAt: 1000,
    alias: 'fix-1',
    lastUsedAt: 1000,
    contextFiles: [],
    ...over,
  } as BackgroundJobRecord;
}

describe('parseProgress', () => {
  test('reads pass, goal, next step, decision and ranked issues', () => {
    expect(parseProgress(PROGRESS)).toEqual({
      pass: 2,
      goal: 'real seat model and Stripe subscriptions.',
      next: 'dispatch fix-2, fix-3 and des-2.',
      decision: 'webhooks get their own lane.',
      issues: ['Invite tokens never expire', 'Dunning emails missing'],
    });
  });

  test('maps pass names and tolerates missing fields', () => {
    expect(parseProgress('Current pass: Detail').pass).toBe(3);
    expect(parseProgress('nothing structured here')).toEqual({
      pass: undefined,
      goal: undefined,
      next: undefined,
      decision: undefined,
      issues: [],
    });
  });
});

describe('projectJobs', () => {
  test('drops provisional rows, orders by start, resolves reconciled state', () => {
    const jobs = projectJobs([
      record({ taskID: 'b', runStartedAt: 3000, state: 'running' }),
      record({ taskID: 'p', provisional: true }),
      record({
        taskID: 'a',
        agent: 'oracle',
        runStartedAt: 2000,
        state: 'reconciled',
        terminalState: 'completed',
        completedAt: 2500,
        resultSummary: 'Approved.',
      }),
    ]);
    expect(jobs.map((j) => [j.id, j.state, j.endedAt, j.result])).toEqual([
      ['a', 'completed', 2500, 'Approved.'],
      ['b', 'running', undefined, undefined],
    ]);
  });
});

describe('deepwork explorer server', () => {
  let dir: string;
  let explorer: DeepworkExplorer | undefined;

  afterEach(() => {
    explorer?.close();
    explorer = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(path.join(tmpdir(), 'dw-explorer-'));
    const root = path.join(dir, '.slim', 'deepwork');
    mkdirSync(path.join(root, 'team-billing'), { recursive: true });
    writeFileSync(
      path.join(root, 'ses_parent.md'),
      'status: active\nslug: team-billing\n',
    );
    writeFileSync(path.join(root, 'team-billing', 'progress.md'), PROGRESS);
    const opened: string[] = [];
    explorer = createDeepworkExplorer({
      directory: dir,
      listJobs: (id) => (id === 'ses_parent' ? [record({})] : []),
      port: 0,
      open: (url) => opened.push(url),
      now: () => 5000,
      html: () => '<html>explorer</html>',
    });
    return opened;
  }

  function get(url: string, host?: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const target = new URL(url);
      const req = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          headers: host ? { host } : undefined,
        },
        (res) => {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  test('serves the page and a snapshot built from state files and the board', async () => {
    setup();
    const url = await explorer?.activate('ses_parent');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/ses_parent$/);
    const base = new URL(url as string).origin;

    const page = await get(url as string);
    expect(page).toEqual({ status: 200, body: '<html>explorer</html>' });

    const api = await get(`${base}/api/s/ses_parent`);
    expect(api.status).toBe(200);
    const snap = JSON.parse(api.body);
    expect(snap).toMatchObject({
      sessionID: 'ses_parent',
      slug: 'team-billing',
      status: 'active',
      now: 5000,
      progress: {
        pass: 2,
        issues: ['Invite tokens never expire', 'Dunning emails missing'],
      },
      passStarts: [{ pass: 2, at: 5000 }],
      jobs: [{ alias: 'fix-1', agent: 'fixer', state: 'running' }],
    });
  });

  test('rejects non-loopback Host headers and bad session ids', async () => {
    setup();
    const url = await explorer?.activate('ses_parent');
    const base = new URL(url as string).origin;
    expect((await get(`${base}/api/s/ses_parent`, 'evil.example')).status).toBe(
      403,
    );
    expect((await get(`${base}/api/s/..%2Fetc`)).status).toBe(400);
  });

  test('opens the browser once per session across repeated activations', async () => {
    const opened = setup();
    const url = await explorer?.activate('ses_parent');
    await explorer?.activate('ses_parent');
    expect(opened).toEqual([url as string]);
  });
});
