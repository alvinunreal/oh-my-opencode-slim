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
import { isTaggedPart } from './cache-safe-injection';
import {
  assistantTurn,
  buildHistory,
  createPipeline,
  FIXTURE_NOW,
  refusedChildTurn,
  renderTurn,
  SESSION_ID,
  stableFingerprints,
  type TransformOutput,
  turnEndIndices,
  userTurn,
} from './cache-safety-harness.test';
import { COUNCIL_INJECT_METADATA_KEY } from './council-inject';
import { GOAL_POINTER_METADATA_KEY } from './deepwork-goal';
import { PHASE_REMINDER_METADATA_KEY } from './phase-reminder';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from './task-session-manager';
import type { MessageWithParts } from './types';

afterEach(() => {
  setSystemTime();
});

/**
 * Definition of "the bytes that must never be rewritten" under the single
 * change-only scheme: the board rides as a volatile trailing tagged part on
 * the current tail (stripped and re-appended per request), so the stable
 * prefix is every non-volatile message.
 */
const stablePrefixFingerprints = stableFingerprints;

function goalMessages(messages: unknown[]): MessageWithParts[] {
  return messages.filter(
    (message): message is MessageWithParts =>
      (message as MessageWithParts)?.info?.id?.startsWith('deepwork-goal-') ===
      true,
  );
}

describe('cache-safety: turn-over-turn prefix stability', () => {
  test('a fallback notice can disappear without changing earlier payload bytes', async () => {
    const pipeline = createPipeline({ refusalCorrection: true });
    const history = [...buildHistory(), refusedChildTurn()];
    const running = await renderTurn(pipeline, history, history.length - 1);
    pipeline.board.drop('ses_refused_child');
    const evicted = await renderTurn(pipeline, history, history.length - 1);
    expect(stableFingerprints(running.messages)).toEqual(
      stableFingerprints(evicted.messages),
    );
    expect(running.messages).toHaveLength(evicted.messages.length + 1);
  });
  test('re-rendering a growing conversation reproduces byte-identical history', async () => {
    const pipeline = createPipeline({ goalPointer: true });
    const history = buildHistory();
    const turns = turnEndIndices(history);
    const fingerprintsFor = stablePrefixFingerprints;

    let previous: string[] | undefined;
    for (const [turnNumber, endIndex] of turns.entries()) {
      // Exercise cross-turn hook state: a background job launches before
      // the second turn (a real user turn, so a fresh board is placed),
      // the job is dropped before the internal-initiator turn renders
      // with an empty board, and a second job launches before the fourth
      // turn. Frozen replay across internal-initiator and empty-board
      // turns, and
      // unchanged-board dedupe all must leave stable bytes untouched —
      // the v2.2.5 checkpoint regression rewrote them on exactly these
      // transitions.
      if (turnNumber === 1) {
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

  test('agent switch after history does not rewrite the shared prefix (issue #1640)', async () => {
    const pipeline = createPipeline({ goalPointer: true });
    const history = buildHistory();

    const firstRun = await renderTurn(pipeline, history, history.length - 1);
    const beforeSwitch = stablePrefixFingerprints(firstRun.messages).slice(
      0,
      history.length,
    );

    // The host rebuilds history, appends a turn from a different agent, and
    // reruns the transforms. The reminder and council anchors live in the
    // prefix; an agent-keyed gate would drop them and rewrite cached bytes.
    const switchedRun = await renderTurn(
      pipeline,
      [...history, userTurn('m11', 'next phase', 'build')],
      history.length,
    );
    const afterSwitch = stablePrefixFingerprints(switchedRun.messages).slice(
      0,
      history.length,
    );

    expect(beforeSwitch).toHaveLength(history.length);
    expect(afterSwitch).toEqual(beforeSwitch);

    // Both anchors are still in the shared prefix after the switch: the
    // fingerprints above prove they were rebuilt, these prove they exist.
    for (const run of [firstRun, switchedRun]) {
      const prefixParts = run.messages
        .slice(0, history.length)
        .flatMap((message) => (message as MessageWithParts).parts);
      expect(
        prefixParts.some((part) =>
          isTaggedPart(part, PHASE_REMINDER_METADATA_KEY),
        ),
      ).toBe(true);
      expect(
        prefixParts.some((part) =>
          isTaggedPart(part, COUNCIL_INJECT_METADATA_KEY),
        ),
      ).toBe(true);
    }
  });
});

describe('cache-safety: active interview history', () => {
  test('re-rendering a new turn preserves the collapsed prefix', async () => {
    const history = [
      assistantTurn(
        'i01',
        '<interview_state>{"summary":"full","questions":[]}</interview_state>',
      ),
      assistantTurn(
        'i02',
        '<interview_state>{"summary":"status","patch":"x","questions":[]}</interview_state>',
      ),
    ];
    const pipeline = createPipeline({ activeInterview: true });
    const oldTurn = await renderTurn(pipeline, history, history.length - 1);
    const nextTurn = await renderTurn(
      pipeline,
      [...history, userTurn('i03', 'continue')],
      history.length,
    );

    expect(nextTurn.messages.slice(0, oldTurn.messages.length)).toEqual(
      oldTurn.messages,
    );
  });
});

describe('cache-safety: specialist sessions', () => {
  test('non-orchestrator payloads pass through byte-identical', async () => {
    const pipeline = createPipeline({ goalPointer: true });
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

describe('cache-safety: skill-list conversation text', () => {
  test('remaining transforms leave available_skills text untouched', async () => {
    const text =
      'quoted context\n<available_skills>\nkeep this text\n</available_skills>';
    const pipeline = createPipeline({ goalPointer: true });
    const output: TransformOutput = {
      messages: [userTurn('skill-text', text)],
    };

    await pipeline.run(output);

    expect((output.messages[0] as MessageWithParts).parts[0]).toMatchObject({
      type: 'text',
      text,
    });
  });
});

describe('cache-safety: volatile content isolation', () => {
  test('background-job state never enters the payload', async () => {
    // Issue #1647: the job board is never rendered. A launch, a completion,
    // or a stop must not add a single byte to the prompt — the only prompt
    // surfaces left are the one-shot pushes and the on-demand tool.
    const history = buildHistory();
    const lastTurn = history.length - 1;

    const emptyBoard = createPipeline({ goalPointer: true });
    const busyBoard = createPipeline({ goalPointer: true });
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
    expect(withJobs.messages).toHaveLength(withoutJobs.messages.length);

    // No board part anywhere in either render: the board key is used only
    // by the goal pointer (dual-tag contract) and never by a job listing.
    const boardParts = withJobs.messages.flatMap((message) =>
      (message as MessageWithParts).parts.filter(
        (part) =>
          isTaggedPart(part, BACKGROUND_JOB_BOARD_METADATA_KEY) &&
          !isTaggedPart(part, GOAL_POINTER_METADATA_KEY),
      ),
    );
    expect(boardParts).toHaveLength(0);
    expect(goalMessages(withJobs.messages)).toHaveLength(1);
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
        const pipeline = createPipeline({ goalPointer: true });
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

    // Every byte must be independent of wall clock and randomness: the
    // change-only board's digest comparison, frozen replays, and ids are
    // derived from board content only, so no ambient input may leak.
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
      'phaseReminder',
      'councilInject',
      'deepworkGoal',
    ]);
    expect(source).toContain(
      'collapseActiveInterviewHistory?.(typedOutput.messages);',
    );
    expect(source).toContain('let view = createMessageTransformView(');
    expect(source).toContain('stripTaggedContents(typedOutput.messages, [');

    // One handler definition plus the three remaining dispatch calls above.
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
      'council-inject/index.ts',
      'deepwork-goal/index.ts',
      'phase-reminder/index.ts',
      'task-session-manager/index.ts',
    ]);
  });
});
