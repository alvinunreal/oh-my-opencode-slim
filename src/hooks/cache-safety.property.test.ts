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
import { BackgroundJobsConfigSchema } from '../config';
import { isTaggedPart, isVolatileTaggedMessage } from './cache-safe-injection';
import {
  assistantTurn,
  type BoardStrategy,
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
import type { MessageWithParts } from './types';

afterEach(() => {
  setSystemTime();
});

/**
 * Per-strategy definition of "the bytes that must never be rewritten".
 *
 * - `latest`: board state lives in a single volatile trailing message that
 *   is stripped and re-appended every request, so the stable prefix is
 *   every non-volatile message.
 * - `checkpoint-compatible`: board snapshots are append-only stable bytes
 *   by design — that is the strategy's entire purpose — so the stable
 *   prefix is the WHOLE provider-visible payload. Filtering tagged messages
 *   here would hide exactly the snapshot drop/reinsert rewrite that shipped
 *   in v2.2.5. Replayed snapshot messages are rebuilt each request from a
 *   varying base message, so only provider-visible fields (role, agent,
 *   parts) participate — `info` never reaches the provider.
 *
 * A new `BackgroundJobsConfigSchema` strategy must add an entry here (the
 * drift guard below fails until it does), forcing an explicit decision
 * about its cache-safety semantics before it can ship.
 */
const STRATEGY_STABLE_FINGERPRINTS: Record<
  BoardStrategy,
  (messages: unknown[]) => string[]
> = {
  latest: stableFingerprints,
  'checkpoint-compatible': (messages) =>
    (messages as MessageWithParts[]).map((message) =>
      JSON.stringify({
        role: message.info.role,
        agent: message.info.agent,
        parts: message.parts,
      }),
    ),
};

const BOARD_STRATEGIES = Object.keys(
  STRATEGY_STABLE_FINGERPRINTS,
) as BoardStrategy[];

describe('cache-safety: board strategy coverage drift guard', () => {
  test('every configurable board strategy has property coverage', () => {
    const schemaStrategies =
      BackgroundJobsConfigSchema.shape.strategy.unwrap().options;
    expect([...BOARD_STRATEGIES].sort()).toEqual([...schemaStrategies].sort());
  });
});

describe.each(BOARD_STRATEGIES)(
  'cache-safety: turn-over-turn prefix stability (%s)',
  (strategy) => {
    test('re-rendering a growing conversation reproduces byte-identical history', async () => {
      const pipeline = createPipeline({ strategy });
      const history = buildHistory();
      const turns = turnEndIndices(history);
      const fingerprintsFor = STRATEGY_STABLE_FINGERPRINTS[strategy];

      let previous: string[] | undefined;
      for (const [turnNumber, endIndex] of turns.entries()) {
        // Exercise cross-turn hook state: a file-tool nudge fires and a
        // background job launches before the second turn (a real user turn,
        // so checkpoint mode creates a snapshot), the job is dropped before
        // the internal-initiator turn renders with an empty board, and a
        // second job launches before the fourth turn. Snapshot creation,
        // replay across internal-initiator and empty-board turns, and
        // unchanged-board dedupe all must leave stable bytes untouched —
        // the v2.2.5 checkpoint regression rewrote them on exactly these
        // transitions.
        if (turnNumber === 1) {
          pipeline.markFileToolPending();
          pipeline.board.registerLaunch({
            taskID: 'task-alpha',
            parentSessionID: SESSION_ID,
            agent: 'explorer',
            description: 'churn fixture',
            now: FIXTURE_NOW,
          });
        }
        if (turnNumber === 2) pipeline.board.drop('task-alpha');
        if (turnNumber === 3) {
          pipeline.board.registerLaunch({
            taskID: 'task-beta',
            parentSessionID: SESSION_ID,
            agent: 'fixer',
            description: 'second churn fixture',
            now: FIXTURE_NOW,
          });
        }

        const output = await renderTurn(pipeline, history, endIndex);
        const fingerprints = fingerprintsFor(output.messages);

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
  },
);

describe('cache-safety: turn-over-turn prefix stability', () => {
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

describe.each(BOARD_STRATEGIES)(
  'cache-safety: specialist sessions (%s)',
  (strategy) => {
    test('non-orchestrator payloads pass through byte-identical', async () => {
      const pipeline = createPipeline({ strategy });
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
  },
);

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

    // The board is a single tagged part appended to the very end of the last
    // message (never a separate trailing message that the provider SDK would
    // coalesce into the last real message and rob of its cache breakpoint).
    // Keeping the message COUNT identical to the no-board render lets the
    // provider's last-two-messages breakpoint land on stable real content.
    expect(withJobs.messages).toHaveLength(withoutJobs.messages.length);

    const allTaggedParts = withJobs.messages.flatMap((message, index) =>
      (message as MessageWithParts).parts
        .map((part, partIndex) => ({ index, partIndex, part }))
        .filter(({ part }) =>
          isTaggedPart(part, BACKGROUND_JOB_BOARD_METADATA_KEY),
        ),
    );
    expect(allTaggedParts).toHaveLength(1);

    const lastMessage = withJobs.messages.at(-1) as MessageWithParts;
    const boardHit = allTaggedParts[0];
    // The one board part lives on the last message and is its last part.
    expect(boardHit.index).toBe(withJobs.messages.length - 1);
    expect(boardHit.partIndex).toBe(lastMessage.parts.length - 1);

    // The no-board render carries no board part anywhere.
    expect(
      withoutJobs.messages.some((message) =>
        (message as MessageWithParts).parts.some((part) =>
          isTaggedPart(part, BACKGROUND_JOB_BOARD_METADATA_KEY),
        ),
      ),
    ).toBe(false);
  });

  test('checkpoint-compatible board state only ever adds tagged snapshot messages', async () => {
    const history = buildHistory();
    const lastTurn = history.length - 1;

    const emptyBoard = createPipeline({ strategy: 'checkpoint-compatible' });
    const busyBoard = createPipeline({ strategy: 'checkpoint-compatible' });
    busyBoard.board.registerLaunch({
      taskID: 'task-beta',
      parentSessionID: SESSION_ID,
      agent: 'fixer',
      description: 'checkpoint isolation fixture',
      now: FIXTURE_NOW,
    });

    const withoutJobs = await renderTurn(emptyBoard, history, lastTurn);
    const withJobs = await renderTurn(busyBoard, history, lastTurn);

    // Real message bytes must be identical; board content may only appear
    // as tagged snapshot messages (append-only by design, so they are part
    // of the stable prefix rather than a volatile tail).
    expect(stableFingerprints(withJobs.messages)).toEqual(
      stableFingerprints(withoutJobs.messages),
    );
    const snapshots = withJobs.messages.filter((message) =>
      isVolatileTaggedMessage(message, BACKGROUND_JOB_BOARD_METADATA_KEY),
    );
    expect(snapshots.length).toBeGreaterThan(0);
    expect(
      withoutJobs.messages.some((message) =>
        isVolatileTaggedMessage(message, BACKGROUND_JOB_BOARD_METADATA_KEY),
      ),
    ).toBe(false);
  });
});

describe.each(BOARD_STRATEGIES)(
  'cache-safety: determinism under ambient inputs (%s)',
  (strategy) => {
    test('wall clock and randomness never leak into the payload', async () => {
      const history = buildHistory();
      const lastTurn = history.length - 1;
      const originalRandom = Math.random;

      const render = async (
        time: number,
        random: number,
      ): Promise<string[]> => {
        setSystemTime(new Date(time));
        Math.random = () => random;
        try {
          const pipeline = createPipeline({ strategy });
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
  },
);

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
