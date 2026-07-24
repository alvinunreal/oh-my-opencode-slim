/**
 * Shared harness for the cache-safety test suites (no tests of its own).
 *
 * The `.test.ts` suffix keeps this file out of the published build
 * (tsconfig excludes `**\/*.test.ts`); it contains only fixtures and the
 * pipeline mirror used by cache-safety.property.test.ts and
 * cache-payload.snapshot.test.ts.
 */

import type { PluginConfig } from '../config';
import {
  DEFAULT_MAX_RETAINED_SNAPSHOTS,
  resolveImageRouting,
} from '../config/constants';
import { BackgroundJobBoard, createInternalAgentTextPart } from '../utils';
import { createDisplayNameMentionRewriter } from '../utils/agent-variant';
import { isVolatileTaggedMessage } from './cache-safe-injection';
import { createFilterAvailableSkillsHook } from './filter-available-skills';
import { processImageAttachments } from './image-hook';
import { createPhaseReminderHook } from './phase-reminder';
import { createPostFileToolNudgeHook } from './post-file-tool-nudge';
import { SessionLifecycle } from './session-lifecycle';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  createTaskSessionManagerHook,
} from './task-session-manager';
import type { MessageWithParts } from './types';

export const SESSION_ID = 'ses_cache_safety_fixture';
export const FIXTURE_NOW = 1_700_000_000_000;

export type TransformOutput = { messages: unknown[] };

export type BoardStrategy = 'latest' | 'checkpoint-compatible';

export interface PipelineOptions {
  /** Board injection strategy under test; defaults to the production default. */
  strategy?: BoardStrategy;
}

export interface Pipeline {
  run: (output: TransformOutput) => Promise<void>;
  markFileToolPending: () => void;
  board: BackgroundJobBoard;
}

/**
 * Mirrors the transform composition in src/index.ts. The drift guard test in
 * cache-safety.property.test.ts fails when the two fall out of sync — update
 * BOTH when adding, removing, or reordering a transform step.
 */
export function createPipeline(options: PipelineOptions = {}): Pipeline {
  const sessionAgentMap = new Map<string, string>();
  const board = new BackgroundJobBoard();
  const lifecycle = new SessionLifecycle(() => {});
  const noopLog = () => {};

  const rewriteDisplayNameMentions =
    createDisplayNameMentionRewriter(undefined);

  const shouldInjectOrchestratorReminder = (sessionID: string) =>
    sessionAgentMap.get(sessionID) === 'orchestrator';

  const taskSessionManagerHook = createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: async () => ({ data: {} }),
        },
      },
      directory: '/tmp/cache-safety-fixture',
      worktree: '/tmp/cache-safety-fixture',
    } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: DEFAULT_MAX_RETAINED_SNAPSHOTS,
      ...(options.strategy ? { strategy: options.strategy } : {}),
      backgroundJobBoard: board,
      shouldManageSession: (sessionID) =>
        sessionAgentMap.get(sessionID) === 'orchestrator',
      registerSessionAsOrchestrator: (sessionID) => {
        sessionAgentMap.set(sessionID, 'orchestrator');
      },
      coordinator: lifecycle,
    },
  );

  const postFileToolNudge = createPostFileToolNudgeHook({
    shouldInject: shouldInjectOrchestratorReminder,
    coordinator: lifecycle,
  });

  const phaseReminder = createPhaseReminderHook({
    shouldInject: shouldInjectOrchestratorReminder,
  });

  const filterAvailableSkills = createFilterAvailableSkillsHook(
    {} as never,
    {} as PluginConfig,
  );

  const run = async (output: TransformOutput): Promise<void> => {
    for (const message of output.messages as MessageWithParts[]) {
      if (message.info.role !== 'user') continue;
      for (const part of message.parts) {
        if (part.type !== 'text' || typeof part.text !== 'string') continue;
        part.text = rewriteDisplayNameMentions(part.text);
      }
    }

    processImageAttachments({
      messages: output.messages as MessageWithParts[],
      workDir: '/tmp/cache-safety-fixture',
      imageRouting: resolveImageRouting(undefined, true),
      disabledAgents: new Set(),
      log: noopLog,
    });

    await taskSessionManagerHook['experimental.chat.messages.transform'](
      {} as never,
      output as never,
    );
    await postFileToolNudge['experimental.chat.messages.transform'](
      {} as never,
      output as never,
    );
    await phaseReminder['experimental.chat.messages.transform'](
      {} as never,
      output as never,
    );
    await filterAvailableSkills['experimental.chat.messages.transform'](
      {} as never,
      output as never,
    );
    await taskSessionManagerHook.injectBackgroundJobBoard(
      {} as never,
      output as never,
    );
  };

  return {
    run,
    markFileToolPending: () => lifecycle.markPending(SESSION_ID),
    board,
  };
}

export function userTurn(id: string, text: string, agent = 'orchestrator') {
  return {
    info: { role: 'user', agent, sessionID: SESSION_ID, id },
    parts: [{ type: 'text', text }],
  };
}

export function assistantTurn(id: string, text: string) {
  return {
    info: {
      role: 'assistant',
      agent: 'orchestrator',
      sessionID: SESSION_ID,
      id,
    },
    parts: [
      { type: 'text', text },
      {
        type: 'tool',
        tool: 'read',
        callID: `${id}-call`,
        state: {
          status: 'completed',
          input: { filePath: '/tmp/cache-safety-fixture/package.json' },
          output: '{"name":"fixture"}',
        },
      },
    ],
  };
}

export function internalInitiatorTurn(id: string, text: string) {
  return {
    info: {
      role: 'user',
      agent: 'orchestrator',
      sessionID: SESSION_ID,
      id,
    },
    parts: [createInternalAgentTextPart(text)],
  };
}

/**
 * Conversation fixture covering the paths that produced past cache bugs:
 * plain orchestrator turns, assistant tool loops, a specialist message, an
 * internal-initiator continuation, and a message carrying a rewritable
 * <available_skills> block.
 */
export function buildHistory(): unknown[] {
  return [
    userTurn('m01', 'set up the project'),
    assistantTurn('m02', 'Reading the manifest first.'),
    userTurn('m03', 'now add tests'),
    assistantTurn('m04', 'Delegating test work.'),
    userTurn('m05', 'specialist context', 'explorer'),
    internalInitiatorTurn('m06', 'continue coordinating remaining todos'),
    userTurn(
      'm07',
      'also consider skills\n<available_skills>\n<skill>\n<name>some-skill</name>\n<description>demo</description>\n</skill>\n</available_skills>',
    ),
    assistantTurn('m08', 'Wrapping up.'),
    userTurn('m09', 'final adjustments please'),
  ];
}

/**
 * Indices whose message is the latest user turn of a simulated request.
 * Only orchestrator turns end requests: when the acting agent changes, the
 * host swaps system prompt and tools, so the provider cache restarts anyway
 * and prefix stability across the switch is not a meaningful property.
 */
export function turnEndIndices(history: unknown[]): number[] {
  const indices: number[] = [];
  for (const [index, message] of history.entries()) {
    const info = (message as MessageWithParts).info;
    if (info.role === 'user' && info.agent === 'orchestrator') {
      indices.push(index);
    }
  }
  return indices;
}

export function stableFingerprints(messages: unknown[]): string[] {
  return messages
    .filter(
      (message) =>
        !isVolatileTaggedMessage(message, BACKGROUND_JOB_BOARD_METADATA_KEY),
    )
    .map((message) => JSON.stringify(message));
}

export async function renderTurn(
  pipeline: Pipeline,
  history: unknown[],
  endIndex: number,
): Promise<TransformOutput> {
  const output: TransformOutput = {
    messages: structuredClone(history.slice(0, endIndex + 1)),
  };
  await pipeline.run(output);
  return output;
}
