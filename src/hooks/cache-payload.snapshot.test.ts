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
import { collapseSystemInPlace } from '../utils/system-collapse';
import { createSessionGenerateHandler } from '../v2/setup';
import type { V2SessionGenerateEvent } from '../v2/types';
import {
  buildHistory,
  createPipeline,
  renderTurn,
} from './cache-safety-harness.test';
import { appendRefusalCorrections } from './refusal-corrections';

describe('cache-impact snapshots (update deliberately — see file header)', () => {
  test('phase reminder text', () => {
    expect(PHASE_REMINDER).toMatchSnapshot();
  });

  test('orchestrator system prompt', () => {
    const prompt = buildOrchestratorPrompt();
    expect(buildOrchestratorPrompt()).toBe(prompt);
    expect(prompt).toMatchSnapshot();
  });

  test('transformed payload for the canonical conversation fixture', async () => {
    // No job-board fixture: the board is never rendered (issue #1647), so
    // the canonical payload carries no board bytes at all.
    const pipeline = createPipeline({ goalPointer: true });

    const history = buildHistory();
    const output = await renderTurn(pipeline, history, history.length - 1);

    expect(output.messages).toMatchSnapshot();
  });

  test('generate-path shaped system for an orchestrator request', async () => {
    // Pins the system bytes an auxiliary `session.generate` request leaves
    // with after the v2 generate bridge runs the v1 system transform — the
    // same shaped prefix as the primary loop (issue #1934). The composition
    // below mirrors the orchestrator branch of
    // src/index.ts (`experimental.chat.system.transform`); the v2 suite
    // `setup-generate-shaping.test.ts` proves the bridge wiring itself, this
    // snapshot makes any byte drift a reviewed diff.
    const orchestratorPrompt = buildOrchestratorPrompt();
    const handler = createSessionGenerateHandler({
      systemTransform: async (input, output) => {
        const agent = (input as { agent?: unknown }).agent;
        if (agent === 'orchestrator') {
          output.system[0] = `${output.system[0] || ''}\n\n${orchestratorPrompt}`;
        }
        collapseSystemInPlace(output.system);
      },
    });
    const event = {
      sessionID: 'ses_generate_fixture',
      agent: 'orchestrator',
      model: { id: 'claude-sonnet-4.6', providerID: 'github-copilot' },
      options: {},
      system: [{ type: 'text' as const, text: '<env>fixture</env>' }],
      messages: [],
      tools: {},
    };
    await handler(event as unknown as V2SessionGenerateEvent);
    expect(event.system).toMatchSnapshot();
  });

  test('fallback continuation is a trailing volatile notice', () => {
    const history = buildHistory();
    const prefix = JSON.stringify(history);
    appendRefusalCorrections(history, 'ses_parent', 'orchestrator', [
      { taskID: 'ses_refused_child', model: 'test/fallback' },
    ]);
    expect(JSON.stringify(history.slice(0, -1))).toBe(prefix);
    expect(
      (history.at(-1) as { parts: Array<{ text: string }> }).parts[0]?.text,
    ).toMatchSnapshot();
  });
});
