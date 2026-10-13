/**
 * Council Mode host-side seat assembly (tool.execute.before resolver).
 *
 * The orchestrator emits only a `Seats: <ref, ref>` line on the council
 * synthesis call; the harness resolves those refs from its own Background
 * Job Board (parent-scoped, read-only) and inlines the stored terminal text,
 * so the orchestrator never re-emits seat text as 2-5x-priced output tokens.
 * v2 native `subagent` calls reach the same resolver because the v2
 * execute.before bridge normalizes them into the v1 `task` shape first —
 * test 1 pins that end-to-end path through the real bridge.
 */
import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createToolExecuteBridges } from '../../v2/setup';
import { handleToolExecuteBefore } from './tool-execute-hooks';

const PARENT = 'ses_parent';
const OTHER_PARENT = 'ses_other';

/** Minimal deps for the resolver path: managed session, board, pending stub. */
function deps(board: BackgroundJobBoard, hostFlavor?: string) {
  return {
    shouldManageSession: () => true,
    backgroundJobBoard: board,
    pendingCallTracker: {
      add() {},
      take: () => undefined,
      pendingCallId: () => 'call_council',
    },
    taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
    hostFlavor,
  };
}

async function runCouncilCall(
  board: BackgroundJobBoard,
  prompt: string,
  hostFlavor?: string,
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {
    subagent_type: 'council',
    description: 'Council synthesis',
    prompt,
    background: false,
  };
  await handleToolExecuteBefore(
    { tool: 'task', sessionID: PARENT, callID: 'call_council' },
    { args },
    deps(board, hostFlavor),
  );
  return args;
}

function seedCompleted(
  board: BackgroundJobBoard,
  input: {
    taskID: string;
    agent: string;
    alias: string;
    resultSummary?: string;
    state?: 'completed' | 'error' | 'cancelled' | 'stopped';
    parentSessionID?: string;
  },
): void {
  const restored = board.restoreRetainedSession({
    taskID: input.taskID,
    parentSessionID: input.parentSessionID ?? PARENT,
    agent: input.agent,
    description: `seat ${input.alias}`,
    state: input.state ?? 'completed',
    background: true,
    ...(input.resultSummary !== undefined
      ? { resultSummary: input.resultSummary }
      : {}),
    alias: input.alias,
  });
  expect(restored).toBeDefined();
}

function seedRunning(
  board: BackgroundJobBoard,
  input: { taskID: string; agent: string },
): string {
  const record = board.registerLaunch({
    taskID: input.taskID,
    parentSessionID: PARENT,
    agent: input.agent,
    description: 'running seat',
    background: true,
  });
  expect(record.state).toBe('running');
  return record.alias;
}

describe('council seat assembly', () => {
  test('v2 native subagent call reaches the resolver through the execute.before bridge', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    seedCompleted(board, {
      taskID: 'ses_beta',
      agent: 'councillor-beta',
      alias: 'councillor-2',
      resultSummary: 'BETA VERBATIM TEXT',
    });
    const event = {
      tool: 'subagent',
      sessionID: PARENT,
      id: 'call_v2',
      input: {
        agent: 'council',
        description: 'Council synthesis',
        prompt: 'Which migration is safest?\nSeats: councillor-1, councillor-2',
        background: false,
      },
    };
    const bridges = createToolExecuteBridges(
      (hookInput, output) =>
        handleToolExecuteBefore(hookInput, output, deps(board, 'v2')),
      undefined,
    );
    await bridges.beforeBridge(event);
    const prompt = (event.input as { prompt: string }).prompt;
    expect(prompt).toBe(
      [
        'Which migration is safest?',
        '',
        '## Seat: councillor-alpha',
        'ALPHA VERBATIM TEXT',
        '',
        '## Seat: councillor-beta',
        'BETA VERBATIM TEXT',
      ].join('\n'),
    );
  });

  test('v1 task call with a Seats line is rewritten with resolved sections', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    seedCompleted(board, {
      taskID: 'ses_beta',
      agent: 'councillor-beta',
      alias: 'councillor-2',
      resultSummary: 'BETA VERBATIM TEXT',
    });
    const args = await runCouncilCall(
      board,
      'Which migration is safest?\nSeats: councillor-1, councillor-2',
    );
    expect(args.prompt).toBe(
      [
        'Which migration is safest?',
        '',
        '## Seat: councillor-alpha',
        'ALPHA VERBATIM TEXT',
        '',
        '## Seat: councillor-beta',
        'BETA VERBATIM TEXT',
      ].join('\n'),
    );
  });

  test('the FINAL Seats line wins; a Seats roster quoted in the question cannot shadow it', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    // The question quotes the static roster ("Seats: councillor-alpha,
    // councillor-beta, ..."), which resolves to nothing; the orchestrator's
    // final line carries the real refs. The earlier line must survive
    // byte-identical in the question and the final line must drive assembly.
    const args = await runCouncilCall(
      board,
      [
        'Question citing the roster line below:',
        'Seats: councillor-alpha, councillor-beta, councillor-gamma',
        'and some trailing question text.',
        'Seats: councillor-1',
      ].join('\n'),
    );
    expect(args.prompt).toBe(
      [
        'Question citing the roster line below:',
        'Seats: councillor-alpha, councillor-beta, councillor-gamma',
        'and some trailing question text.',
        '',
        '## Seat: councillor-alpha',
        'ALPHA VERBATIM TEXT',
      ].join('\n'),
    );
  });

  test('assembly disabled ⇒ inert: any Seats-bearing prompt passes through byte-identically (backstop deliberately absent)', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    // A refusal on the disabled path would fail CLOSED: quoting a roster or
    // pasting content that contains a Seats line re-triggers it on every
    // retry (the remedy itself re-fails). Disabled must mean inert; the
    // stale-harness-block window fails OPEN and visibly at synthesis time
    // (the council's mandated format reports missing seats).
    for (const prompt of [
      'Which migration is safest?\nSeats: councillor-1',
      'Question quoting a roster:\nSeats: councillor-alpha, councillor-beta\n…and already-pasted answers below.',
      'Question?\nSeats: , ,',
    ]) {
      const args: Record<string, unknown> = {
        subagent_type: 'council',
        description: 'Council synthesis',
        prompt,
        background: false,
      };
      await handleToolExecuteBefore(
        { tool: 'task', sessionID: PARENT, callID: 'call_council' },
        { args },
        { ...deps(board), councilAssembly: false },
      );
      expect(args.prompt).toBe(prompt);
    }
  });

  test('a seat owned by another parent is never resolved', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    seedCompleted(board, {
      taskID: 'ses_theft',
      agent: 'councillor-beta',
      alias: 'councillor-9',
      resultSummary: 'STOLEN TEXT',
      parentSessionID: OTHER_PARENT,
    });
    const args = await runCouncilCall(
      board,
      'Question?\nSeats: councillor-1, councillor-9',
    );
    const prompt = args.prompt as string;
    expect(prompt).toContain('## Seat: councillor-alpha');
    expect(prompt).toContain(
      '## Seat: councillor-9\n[no response — unresolved ref]',
    );
    expect(prompt).not.toContain('STOLEN TEXT');
  });

  test('cross-parent isolation is explicit: the same alias resolves only for its owner', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    seedCompleted(board, {
      taskID: 'ses_theft',
      agent: 'councillor-beta',
      alias: 'councillor-9',
      resultSummary: 'STOLEN TEXT',
      parentSessionID: OTHER_PARENT,
    });
    // Read-only board invariant the control tools enforce, inherited here.
    expect(board.resolve(OTHER_PARENT, 'councillor-9')?.taskID).toBe(
      'ses_theft',
    );
    expect(board.resolve(PARENT, 'councillor-9')).toBeUndefined();
    const args = await runCouncilCall(board, 'Question?\nSeats: councillor-1');
    expect(args.prompt).not.toContain('STOLEN TEXT');
  });

  test('unknown refs never throw and never leak; all-unknown leaves the prompt untouched', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    const mixed = await runCouncilCall(
      board,
      'Question?\nSeats: councillor-1, nope-1, ses_missing',
    );
    expect(mixed.prompt).toContain(
      '## Seat: nope-1\n[no response — unresolved ref]',
    );
    expect(mixed.prompt).toContain(
      '## Seat: ses_missing\n[no response — unresolved ref]',
    );
    expect(mixed.prompt).toContain('ALPHA VERBATIM TEXT');
    // All-unknown refs: the trigger line is still stripped and each ref
    // becomes a placeholder — the council must SEE which seats are missing
    // (restart / cross-conversation board misses), never a bare ID line.
    const alone = await runCouncilCall(
      board,
      'Question?\nSeats: nope-1, nope-2',
    );
    expect(alone.prompt).toBe(
      [
        'Question?',
        '',
        '## Seat: nope-1',
        '[no response — unresolved ref]',
        '',
        '## Seat: nope-2',
        '[no response — unresolved ref]',
      ].join('\n'),
    );
  });

  test('lifecycle diagnostics are never injected as a councillor opinion', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_cancelled',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'cancelled: revived',
      state: 'cancelled',
    });
    seedCompleted(board, {
      taskID: 'ses_errored',
      agent: 'councillor-beta',
      alias: 'councillor-2',
      resultSummary: 'Host reported outcome: failed.',
      state: 'error',
    });
    const args = await runCouncilCall(
      board,
      'Question?\nSeats: councillor-1, councillor-2',
    );
    const prompt = args.prompt as string;
    expect(prompt).toContain(
      '## Seat: councillor-alpha\n[no response — no output (cancelled)]',
    );
    expect(prompt).toContain(
      '## Seat: councillor-beta\n[no response — no output (error)]',
    );
    expect(prompt).not.toContain('cancelled: revived');
    expect(prompt).not.toContain('Host reported outcome');
  });

  test('a still-running seat gets a placeholder and never blocks the hook', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    const runningAlias = seedRunning(board, {
      taskID: 'ses_gamma',
      agent: 'councillor-gamma',
    });
    const args = await runCouncilCall(
      board,
      `Question?\nSeats: councillor-1, ${runningAlias}`,
    );
    const prompt = args.prompt as string;
    expect(prompt).toContain(
      `## Seat: councillor-gamma\n[no response — still running]`,
    );
    expect(prompt).toContain('ALPHA VERBATIM TEXT');
    expect(prompt).not.toContain('Seats:');
  });

  test('terminal seat without a resultSummary reports its state', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    seedCompleted(board, {
      taskID: 'ses_cancelled',
      agent: 'councillor-gamma',
      alias: 'councillor-2',
      state: 'cancelled',
    });
    seedCompleted(board, {
      taskID: 'ses_empty',
      agent: 'councillor-delta',
      alias: 'councillor-3',
      resultSummary: '',
    });
    const args = await runCouncilCall(
      board,
      'Question?\nSeats: councillor-1, councillor-2, councillor-3',
    );
    const prompt = args.prompt as string;
    expect(prompt).toContain(
      '## Seat: councillor-gamma\n[no response — no output (cancelled)]',
    );
    expect(prompt).toContain(
      '## Seat: councillor-delta\n[no response — no output (completed)]',
    );
  });

  test('no Seats line passes through byte-identically (old paste behavior)', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    const prompt = [
      'Synthesize the council report.',
      '## Councillor alpha (gpt-x)',
      'ALPHA PASTED RESPONSE',
    ].join('\n');
    const args = await runCouncilCall(board, prompt);
    expect(args.prompt).toBe(prompt);
  });

  test('free text mentioning seats or tasks without a Seats line is never scanned', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    const prompt = [
      'The council weighed in: seat 1 liked option A.',
      'task 1 (alpha) also approved. seats: none listed above.',
    ].join('\n');
    const args = await runCouncilCall(board, prompt);
    expect(args.prompt).toBe(prompt);
  });

  test('a second pass over an already-assembled prompt is a no-op; a re-sent call with a fresh Seats line attaches the new round', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    const args = await runCouncilCall(
      board,
      'Question?\nSeats: councillor-1, councillor-1',
    );
    const assembled = args.prompt as string;
    expect(assembled.match(/## Seat: /g)?.length).toBe(2);
    const second = await runCouncilCall(board, assembled);
    expect(second.prompt).toBe(assembled);
    // Retry-then-resynthesize: a fresh Seats line on an already-assembled
    // prompt is CONSUMED (the sentinel is gone — it used to blanket-skip
    // this and silently drop the retried seat's new text). The new section
    // is appended; the earlier sections stay. Duplication is the accepted
    // residual — visible, input-leg, never silent loss.
    const third = await runCouncilCall(
      board,
      `${assembled}\nSeats: councillor-1`,
    );
    const thirdPrompt = third.prompt as string;
    expect(thirdPrompt).not.toContain('\nSeats: councillor-1\n');
    expect(thirdPrompt.match(/## Seat: /g)?.length).toBe(3);
    expect(thirdPrompt).toContain('ALPHA VERBATIM TEXT');
  });

  test('a 50KB seat result is inlined byte-identically (no truncation, no cap)', async () => {
    const board = new BackgroundJobBoard();
    const huge = `${'LÖNG ünicode lïne — '.repeat(3000)}TAIL`;
    const bytes = Buffer.byteLength(huge, 'utf8');
    expect(bytes).toBeGreaterThan(50_000);
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: huge,
    });
    const args = await runCouncilCall(board, 'Question?\nSeats: councillor-1');
    const prompt = args.prompt as string;
    expect(prompt).toBe(`Question?\n\n## Seat: councillor-alpha\n${huge}`);
    expect(Buffer.byteLength(prompt, 'utf8')).toBe(
      Buffer.byteLength('Question?\n\n## Seat: councillor-alpha\n', 'utf8') +
        bytes,
    );
  });

  test('partial resolution: 3 seats with 1 unresolvable yields 2 sections plus 1 placeholder', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    seedCompleted(board, {
      taskID: 'ses_beta',
      agent: 'councillor-beta',
      alias: 'councillor-2',
      resultSummary: 'BETA VERBATIM TEXT',
    });
    const args = await runCouncilCall(
      board,
      'Question?\nSeats: councillor-1, ghost-7, councillor-2',
    );
    const prompt = args.prompt as string;
    expect(prompt.match(/## Seat: /g)?.length).toBe(3);
    expect(prompt).toContain('## Seat: councillor-alpha');
    expect(prompt).toContain('ALPHA VERBATIM TEXT');
    expect(prompt).toContain('## Seat: councillor-beta');
    expect(prompt).toContain('BETA VERBATIM TEXT');
    expect(prompt).toContain(
      '## Seat: ghost-7\n[no response — unresolved ref]',
    );
    expect(prompt).not.toContain('Seats:');
  });

  test('a quoted \\n## Seat: heading in the question never blocks assembly (sentinel removed)', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary: 'ALPHA VERBATIM TEXT',
    });
    seedCompleted(board, {
      taskID: 'ses_beta',
      agent: 'councillor-beta',
      alias: 'councillor-2',
      resultSummary: 'BETA VERBATIM TEXT',
    });
    // The question quotes an assembled-looking section (a seat's own
    // resultSummary can legitimately contain such headings — council.ts:81
    // mandates the form). The old sentinel skipped assembly here and the
    // tool-less council lost ALL answers; now the valid final trigger wins.
    const prompt = [
      'Question quoting round-1 material:',
      '## Seat: councillor-alpha',
      'QUOTED OLD TEXT',
      'Seats: councillor-1, councillor-2',
    ].join('\n');
    const args = await runCouncilCall(board, prompt);
    const out = args.prompt as string;
    expect(out).toContain('QUOTED OLD TEXT');
    expect(out).toContain('## Seat: councillor-alpha\nALPHA VERBATIM TEXT');
    expect(out).toContain('## Seat: councillor-beta\nBETA VERBATIM TEXT');
    expect(out.match(/## Seat: councillor-alpha/g)?.length).toBe(2);
    expect(out).not.toContain('\nSeats: councillor-1, councillor-2');
  });

  test('a seat whose own resultSummary contains a ## Seat: heading still assembles', async () => {
    const board = new BackgroundJobBoard();
    seedCompleted(board, {
      taskID: 'ses_alpha',
      agent: 'councillor-alpha',
      alias: 'councillor-1',
      resultSummary:
        'council.ts:81 says headings like ## Seat: are normal\nALPHA BODY',
    });
    const args = await runCouncilCall(board, 'Question?\nSeats: councillor-1');
    const out = args.prompt as string;
    expect(out).toContain('ALPHA BODY');
    expect(out).not.toContain('\nSeats: councillor-1');
  });

  test('an empty-refs Seats line reports itself instead of passing through silently', async () => {
    const board = new BackgroundJobBoard();
    const args = await runCouncilCall(board, 'Question?\nSeats: , ,');
    expect(args.prompt).toBe(
      ['Question?', '', '[no seat references were provided]'].join('\n'),
    );
  });
});
