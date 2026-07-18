/**
 * Golden snapshots of the prompt surfaces this plugin injects into the
 * provider payload prefix.
 *
 * Any byte change to these surfaces invalidates the provider prompt cache
 * for every existing session the next time it sends a request — the change
 * may still be worth it, but it must be deliberate, not incidental. When one
 * of these tests fails:
 *
 *   1. Confirm the payload change is intentional and worth a one-time,
 *      fleet-wide cache re-warm (cost + latency on the first request of
 *      every active session).
 *   2. Update the snapshot with `bun test --update-snapshots` and let the
 *      snapshot diff document the cache impact in the PR.
 *
 * Never update these snapshots to silence a failure you can't explain.
 */

import { describe, expect, test } from 'bun:test';
import { buildOrchestratorPrompt } from '../agents/orchestrator';
import { PHASE_REMINDER } from '../config/constants';
import {
  buildHistory,
  createPipeline,
  FIXTURE_NOW,
  renderTurn,
  SESSION_ID,
} from './cache-safety-harness.test';

describe('cache-impact snapshots (update deliberately — see file header)', () => {
  test('phase reminder text', () => {
    expect(PHASE_REMINDER).toMatchSnapshot();
  });

  test('orchestrator system prompt', () => {
    const prompt = buildOrchestratorPrompt(new Set());
    // Deterministic across invocations — a mismatch here means something
    // volatile (time, randomness, environment) leaked into the prompt.
    expect(buildOrchestratorPrompt(new Set())).toBe(prompt);
    expect(prompt).toMatchSnapshot();
  });

  test('transformed payload for the canonical conversation fixture', async () => {
    const pipeline = createPipeline();
    pipeline.board.registerLaunch({
      taskID: 'task-snapshot',
      parentSessionID: SESSION_ID,
      agent: 'explorer',
      description: 'snapshot fixture job',
      now: FIXTURE_NOW,
    });

    const history = buildHistory();
    const output = await renderTurn(pipeline, history, history.length - 1);

    expect(output.messages).toMatchSnapshot();
  });
});
