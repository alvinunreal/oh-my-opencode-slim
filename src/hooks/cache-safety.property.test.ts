/**
 * Cache-safety property tests for the message-transform pipeline.
 *
 * Provider prompt caches are exact byte-prefix matches over the rendered
 * request. These tests do not enumerate known-good payload shapes; they
 * assert the two properties every transform must uphold for caching to
 * survive across turns:
 *
 * 1. Turn-over-turn prefix stability — re-rendering a growing conversation
 *    must reproduce byte-identical historical messages, with volatile
 *    content confined to the tagged trailing zone.
 * 2. Determinism — ambient inputs that should not matter (wall clock,
 *    randomness, background-job churn) must not change any stable byte.
 *
 * The pipeline below mirrors the composition in src/index.ts
 * ('experimental.chat.messages.transform'). A drift guard test fails when
 * src/index.ts gains, loses, or reorders transform steps so this suite can
 * never silently fall out of sync with production.
 */

import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isVolatileTaggedMessage } from './cache-safe-injection';
import {
  assistantTurn,
  buildHistory,
  createPipeline,
  FIXTURE_NOW,
  renderTurn,
  SESSION_ID,
  stableFingerprints,
  type TransformOutput,
  turnEndIndices,
} from './cache-safety-harness.test';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from './task-session-manager';

afterEach(() => {
  setSystemTime();
});

describe('cache-safety: turn-over-turn prefix stability', () => {
  test('re-rendering a growing conversation reproduces byte-identical history', async () => {
    const pipeline = createPipeline();
    const history = buildHistory();
    const turns = turnEndIndices(history);

    let previous: string[] | undefined;
    for (const [turnNumber, endIndex] of turns.entries()) {
      // Exercise cross-turn hook state: a file-tool nudge fires before the
      // second turn, and background jobs churn (launch, then drop) while
      // later turns render — none of it may touch stable bytes.
      if (turnNumber === 1) pipeline.markFileToolPending();
      if (turnNumber === 2) {
        pipeline.board.registerLaunch({
          taskID: 'task-alpha',
          parentSessionID: SESSION_ID,
          agent: 'explorer',
          description: 'churn fixture',
          now: FIXTURE_NOW,
        });
      }
      if (turnNumber === 3) pipeline.board.drop('task-alpha');

      const output = await renderTurn(pipeline, history, endIndex);
      const fingerprints = stableFingerprints(output.messages);

      if (previous) {
        if (fingerprints.length < previous.length) {
          throw new Error(
            'A transform removed stable messages between turns — this rewrites the cached prefix. Route the content through src/hooks/cache-safe-injection.ts instead.',
          );
        }
        expect(fingerprints.slice(0, previous.length)).toEqual(previous);
      }
      previous = fingerprints;
    }
  });

  test('a consumed file-tool nudge is reproduced by the phase reminder on the next turn', async () => {
    const pipeline = createPipeline();
    const history = buildHistory();

    // Register the session (turn 1), then mark a pending nudge and render
    // turn 2: the nudge injects into the latest user message.
    await renderTurn(pipeline, history, 0);
    pipeline.markFileToolPending();
    const turnWithNudge = await renderTurn(pipeline, history, 2);

    // Turn 3 renders the same message as history; the phase reminder must
    // reproduce the exact bytes the nudge produced a turn earlier.
    const nextTurn = await renderTurn(pipeline, history, 3);

    const nudgedMessage = JSON.stringify(turnWithNudge.messages[2]);
    const historicalMessage = JSON.stringify(nextTurn.messages[2]);
    expect(historicalMessage).toBe(nudgedMessage);
  });
});

describe('cache-safety: specialist sessions', () => {
  test('non-orchestrator payloads pass through byte-identical', async () => {
    const pipeline = createPipeline();
    const specialistSession = 'ses_specialist_fixture';
    const history = [
      {
        info: {
          role: 'user',
          agent: 'explorer',
          sessionID: specialistSession,
          id: 's01',
        },
        parts: [{ type: 'text', text: 'find the config loader' }],
      },
      assistantTurn('s02', 'Searching now.'),
      {
        info: {
          role: 'user',
          agent: 'explorer',
          sessionID: specialistSession,
          id: 's03',
        },
        parts: [{ type: 'text', text: 'summarize what you found' }],
      },
    ];
    const before = history.map((message) => JSON.stringify(message));

    const output: TransformOutput = { messages: structuredClone(history) };
    await pipeline.run(output);

    expect(output.messages.map((message) => JSON.stringify(message))).toEqual(
      before,
    );
  });
});

describe('cache-safety: volatile content isolation', () => {
  test('background-job state only ever changes the tagged trailing message', async () => {
    const history = buildHistory();
    const lastTurn = history.length - 1;

    const emptyBoard = createPipeline();
    const busyBoard = createPipeline();
    busyBoard.board.registerLaunch({
      taskID: 'task-beta',
      parentSessionID: SESSION_ID,
      agent: 'fixer',
      description: 'volatile isolation fixture',
      now: FIXTURE_NOW,
    });

    const withoutJobs = await renderTurn(emptyBoard, history, lastTurn);
    const withJobs = await renderTurn(busyBoard, history, lastTurn);

    expect(stableFingerprints(withJobs.messages)).toEqual(
      stableFingerprints(withoutJobs.messages),
    );

    // The volatile zone is exactly one tagged message, strictly trailing.
    const volatile = withJobs.messages.filter((message) =>
      isVolatileTaggedMessage(message, BACKGROUND_JOB_BOARD_METADATA_KEY),
    );
    expect(volatile).toHaveLength(1);
    expect(withJobs.messages.at(-1)).toBe(volatile[0]);
    expect(
      withoutJobs.messages.some((message) =>
        isVolatileTaggedMessage(message, BACKGROUND_JOB_BOARD_METADATA_KEY),
      ),
    ).toBe(false);
  });
});

describe('cache-safety: determinism under ambient inputs', () => {
  test('wall clock and randomness never leak into the payload', async () => {
    const history = buildHistory();
    const lastTurn = history.length - 1;
    const originalRandom = Math.random;

    const render = async (time: number, random: number): Promise<string[]> => {
      setSystemTime(new Date(time));
      Math.random = () => random;
      try {
        const pipeline = createPipeline();
        pipeline.board.registerLaunch({
          taskID: 'task-gamma',
          parentSessionID: SESSION_ID,
          agent: 'oracle',
          description: 'determinism fixture',
          now: FIXTURE_NOW,
        });
        const output = await renderTurn(pipeline, history, lastTurn);
        return output.messages.map((message) => JSON.stringify(message));
      } finally {
        Math.random = originalRandom;
        setSystemTime();
      }
    };

    const first = await render(FIXTURE_NOW, 0.1234);
    const second = await render(FIXTURE_NOW + 987_654_321, 0.9876);

    expect(second).toEqual(first);
  });
});

describe('cache-safety: pipeline drift guard', () => {
  const srcRoot = path.resolve(import.meta.dir, '..');

  test('src/index.ts transform order matches this suite', () => {
    const source = readFileSync(path.join(srcRoot, 'index.ts'), 'utf8');

    const orderedCalls = [
      ...source.matchAll(
        /await (\w+)\['experimental\.chat\.messages\.transform'\]\(/g,
      ),
    ].map((match) => match[1]);

    // If this fails, src/index.ts gained, lost, or reordered a transform
    // step. Update createPipeline() in this file to match, then update this
    // expectation — the property tests are only meaningful while the two
    // stay in lockstep.
    expect(orderedCalls).toEqual([
      'taskSessionManagerHook',
      'postFileToolNudge',
      'phaseReminder',
      'filterAvailableSkills',
    ]);
    expect(source).toContain(
      'await taskSessionManagerHook.injectBackgroundJobBoard(',
    );

    // One handler definition plus the four dispatch calls above.
    const literalCount = source.split(
      "'experimental.chat.messages.transform'",
    ).length;
    expect(literalCount - 1).toBe(5);
  });

  test('every hook module defining a message transform is covered here', async () => {
    const glob = new Bun.Glob('**/*.ts');
    const hookFilesWithTransforms: string[] = [];
    const hooksDir = path.join(srcRoot, 'hooks');

    for await (const file of glob.scan(hooksDir)) {
      if (file.endsWith('.test.ts')) continue;
      const content = readFileSync(path.join(hooksDir, file), 'utf8');
      if (content.includes("'experimental.chat.messages.transform'")) {
        hookFilesWithTransforms.push(file);
      }
    }

    // If a new file appears here, wire its transform into createPipeline()
    // above (in the same order as src/index.ts) so the cache-safety
    // properties cover it, then add it to this list.
    expect(hookFilesWithTransforms.sort()).toEqual([
      'filter-available-skills/index.ts',
      'phase-reminder/index.ts',
      'post-file-tool-nudge/index.ts',
      'task-session-manager/index.ts',
    ]);
  });
});
