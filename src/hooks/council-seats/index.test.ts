/**
 * Hook gating: the seat hook must act ONLY on a council delegation with a
 * final Seats line, and must leave every other call byte-identical.
 */
import { describe, expect, test } from 'bun:test';
import type { CouncilSeatHook } from './index';
import { createCouncilSeatHook } from './index';
import type { SeatRequest, SeatResult } from './types';

const ASSEMBLED =
  'Question?\n\n## Seat: earl-1\n[no response — unresolved ref]';

const isCanonicalCouncil = (name: string) => name === 'council';

function hookWith(
  results:
    | ((parentSessionID: string, seats: SeatRequest[]) => Promise<SeatResult[]>)
    | Error,
  isCouncilAgent = isCanonicalCouncil,
): { hook: CouncilSeatHook; calls: { count: number } } {
  const calls = { count: 0 };
  const hook = createCouncilSeatHook({
    isCouncilAgent,
    resolveSeats: async (parent, seats) => {
      calls.count += 1;
      if (results instanceof Error) throw results;
      return results(parent, seats);
    },
  });
  return { hook, calls };
}

function councilHook() {
  return hookWith(async (_parent, seats) =>
    seats.map(() => ({ kind: 'missing', reason: 'unresolved ref' })),
  );
}

async function runBefore(
  hook: CouncilSeatHook,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  await hook['tool.execute.before'](
    { tool, sessionID: 'ses_parent', callID: 'c1' },
    { args },
  );
}

describe('council seat hook gating', () => {
  test('acts on a v1 council task call', async () => {
    const { hook, calls } = councilHook();
    const args: Record<string, unknown> = {
      subagent_type: 'council',
      prompt: 'Question?\nSeats: earl-1',
    };
    await runBefore(hook, 'task', args);
    expect(calls.count).toBe(1);
    expect(args.prompt).toBe(ASSEMBLED);
  });

  test('acts on a raw v2 subagent call (agent param)', async () => {
    const { hook, calls } = councilHook();
    const args: Record<string, unknown> = {
      agent: 'council',
      prompt: 'Question?\nSeats: earl-1',
    };
    await runBefore(hook, 'subagent', args);
    expect(calls.count).toBe(1);
    // seat + childID are both the literal session ref.
    expect(args.prompt).toBe(ASSEMBLED);
  });

  test('inlines both seat bodies for a renamed council target', async () => {
    const { hook, calls } = hookWith(
      async (_parent, seats) =>
        seats.map(({ seat }) => ({
          kind: 'completed',
          text: `Answer from ${seat}`,
        })),
      (name) => name === 'judge',
    );
    const prompt = 'Question?\nSeats: ses_alpha, ses_beta';
    const args = { agent: '  judge  ', prompt };
    await runBefore(hook, 'subagent', args);
    expect(calls.count).toBe(1);
    expect(args.prompt).toBe(
      'Question?\n\n## Seat: ses_alpha\nAnswer from ses_alpha\n\n## Seat: ses_beta\nAnswer from ses_beta',
    );

    const nonCouncil = { agent: 'council', prompt };
    await runBefore(hook, 'subagent', nonCouncil);
    expect(nonCouncil.prompt).toBe(prompt);
    expect(calls.count).toBe(1);
  });

  test('trims the agent value before comparing', async () => {
    const { hook, calls } = councilHook();
    const args: Record<string, unknown> = {
      subagent_type: '  council  ',
      prompt: 'Question?\nSeats: earl-1',
    };
    await runBefore(hook, 'task', args);
    expect(calls.count).toBe(1);
    expect(args.prompt).toBe(ASSEMBLED);
  });

  test('non-council agents are byte-identical and never call the resolver', async () => {
    const { hook, calls } = councilHook();
    for (const agent of ['councilor', 'councilor-1', 'orchestrator', '']) {
      const args: Record<string, unknown> = {
        subagent_type: agent,
        prompt: 'Question?\nSeats: earl-1',
      };
      await runBefore(hook, 'task', args);
      expect(args.prompt).toBe('Question?\nSeats: earl-1');
    }
    expect(calls.count).toBe(0);
  });

  test('non-delegation tools are ignored even with a Seats line', async () => {
    const { hook, calls } = councilHook();
    const args: Record<string, unknown> = {
      prompt: 'Question?\nSeats: earl-1',
      subagent_type: 'council',
    };
    await runBefore(hook, 'edit', args);
    await runBefore(hook, 'TASK_STATUS', args);
    expect(calls.count).toBe(0);
    expect(args.prompt).toBe('Question?\nSeats: earl-1');
  });

  test('a prompt without a Seats line is byte-identical (cache expectation)', async () => {
    const { hook, calls } = councilHook();
    const prompt = [
      'Synthesize the council report.',
      '## Councillor alpha',
      'PASTED ANSWER',
    ].join('\n');
    const args: Record<string, unknown> = {
      subagent_type: 'council',
      prompt,
    };
    await runBefore(hook, 'task', args);
    expect(calls.count).toBe(0);
    expect(args.prompt).toBe(prompt);
  });

  test('a quoted lowercase seats line is not a trigger', async () => {
    const { hook, calls } = councilHook();
    const prompt = 'seats: none listed above.';
    const args: Record<string, unknown> = {
      subagent_type: 'council',
      prompt,
    };
    await runBefore(hook, 'task', args);
    expect(calls.count).toBe(0);
    expect(args.prompt).toBe(prompt);
  });

  test('a non-string prompt is left untouched', async () => {
    const { hook, calls } = councilHook();
    const args: Record<string, unknown> = {
      subagent_type: 'council',
      prompt: { text: 'Question?\nSeats: earl-1' },
    };
    await runBefore(hook, 'task', args);
    expect(calls.count).toBe(0);
    expect(args.prompt).toEqual({ text: 'Question?\nSeats: earl-1' });
  });

  test('a missing sessionID leaves the call untouched', async () => {
    const { hook, calls } = councilHook();
    const args: Record<string, unknown> = {
      subagent_type: 'council',
      prompt: 'Question?\nSeats: earl-1',
    };
    await hook['tool.execute.before']({ tool: 'task' }, { args });
    expect(calls.count).toBe(0);
    expect(args.prompt).toBe('Question?\nSeats: earl-1');
  });

  test('non-record or absent args are left untouched', async () => {
    const { hook, calls } = councilHook();
    await runBefore(hook, 'task', undefined as never);
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_parent' },
      { args: 'Seats: earl-1' },
    );
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_parent' },
      { args: ['x'] },
    );
    expect(calls.count).toBe(0);
  });

  test('the hook never throws out of a failing resolver', async () => {
    const { hook } = hookWith(new Error('resolver exploded'));
    const args: Record<string, unknown> = {
      subagent_type: 'council',
      prompt: 'Question?\nSeats: earl-1',
    };
    await runBefore(hook, 'task', args);
    expect(args.prompt).toBe(
      'Question?\n\n## Seat: earl-1\n[no response — resolver error]',
    );
  });

  test('session-shaped refs carry childID; aliases do not', async () => {
    let observed: Array<Record<string, unknown>> = [];
    const hook = createCouncilSeatHook({
      isCouncilAgent: isCanonicalCouncil,
      resolveSeats: async (_parent, seats) => {
        observed = seats as never;
        return seats.map(() => ({ kind: 'missing', reason: 'unresolved ref' }));
      },
    });
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_parent' },
      {
        args: {
          subagent_type: 'council',
          prompt: 'Question?\nSeats: earl-1, ses_child',
        },
      },
    );
    expect(observed).toEqual([
      { seat: 'earl-1' },
      { seat: 'ses_child', childID: 'ses_child' },
    ]);
  });
});
