/** Low-level board fixtures for adapter/state-machine tests. These deliberately
 * bypass asynchronous evidence policy; that policy is exercised with the real
 * gate in background-job-terminal-gate.test.ts. No production consumer imports
 * this module. */

import type { BackgroundJobBoardApi } from './board';
import { BackgroundJobBoard as ProductionBoard } from './board';
import type {
  BackgroundJobStatusInput,
  BackgroundJobTerminalInput,
} from './types';

function commit(
  board: BackgroundJobBoardApi,
  input: BackgroundJobTerminalInput,
  generation = board.get(input.taskID)?.generation,
) {
  // This test-only module deliberately accesses the private builder. Production
  // tokens cannot be fabricated, even by this fixture.
  const raw =
    board instanceof ProductionBoard
      ? board
      : (board as unknown as { board: ProductionBoard }).board;
  return (
    raw as unknown as {
      commitTerminalRecord(
        input: BackgroundJobTerminalInput,
        generation: number,
      ): ReturnType<ProductionBoard['commitTerminal']>;
    }
  ).commitTerminalRecord(input, generation ?? -1);
}

export const boardFixture = {
  updateStatus(board: BackgroundJobBoardApi, input: BackgroundJobStatusInput) {
    return input.state === 'running'
      ? board.updateStatus({ ...input, state: 'running' })
      : commit(
          board,
          {
            ...input,
            state: input.state,
            resultSummary: input.resultSummary ?? '',
          },
          input.expectedGeneration,
        );
  },
  markStopped(
    board: BackgroundJobBoardApi,
    taskID: string,
    resultSummary: string,
    observedAt = Date.now(),
    generation?: number,
    now = Date.now(),
  ) {
    if ((board.get(taskID)?.lastLiveBusyAt ?? -1) >= observedAt)
      return board.get(taskID);
    return commit(
      board,
      { taskID, state: 'stopped', resultSummary, now },
      generation,
    );
  },
  markCancelled(
    board: BackgroundJobBoardApi,
    taskID: string,
    reason?: string,
    now = Date.now(),
    options: {
      expectedGeneration?: number;
      cancellationLease?: BackgroundJobTerminalInput['cancellationLease'];
    } = {},
  ) {
    return commit(
      board,
      {
        taskID,
        state: 'cancelled',
        resultSummary: reason ?? '',
        now,
        cancellationLease: options.cancellationLease,
      },
      options.expectedGeneration,
    );
  },
};

/** The facade only seeds board state through its synchronous commit seam.
 * It implements no runtime/evidence policy and is never wired to the host. */
type FixtureBoard = ProductionBoard & {
  updateStatus(
    input: BackgroundJobStatusInput,
  ): ReturnType<ProductionBoard['updateStatus']>;
};
export const FixtureBoardProxy = new Proxy(ProductionBoard, {
  construct(Target, args) {
    const board = new Target(...args);
    return new Proxy(board, {
      get(target, key) {
        if (key === 'updateStatus') {
          return (input: BackgroundJobStatusInput) =>
            boardFixture.updateStatus(target, input);
        }
        if (key === 'markStopped')
          return (
            ...args: Parameters<typeof boardFixture.markStopped> extends [
              unknown,
              ...infer Rest,
            ]
              ? Rest
              : never
          ) => boardFixture.markStopped(target, ...args);
        if (key === 'markCancelled')
          return (
            ...args: Parameters<typeof boardFixture.markCancelled> extends [
              unknown,
              ...infer Rest,
            ]
              ? Rest
              : never
          ) => boardFixture.markCancelled(target, ...args);
        const value = Reflect.get(target, key);
        return value;
      },
    });
  },
}) as new (
  ...args: ConstructorParameters<typeof ProductionBoard>
) => FixtureBoard;
export type FixtureBoardInstance = FixtureBoard;
