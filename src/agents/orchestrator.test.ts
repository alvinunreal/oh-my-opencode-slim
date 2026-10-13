import { describe, expect, test } from 'bun:test';
import {
  buildOrchestratorPrompt,
  buildOrchestratorPromptV2,
  createOrchestratorAgent,
} from './orchestrator';
import { ROLE_ROUTING_SLIM_LINES } from './role-routing';

describe('orchestrator prompt', () => {
  test('v2 routes active amendments through soft steering without claiming consumption', () => {
    const prompt = buildOrchestratorPrompt(
      undefined,
      undefined,
      true,
      true,
      'v2',
    );

    expect(prompt).toContain('`delivery: "queue"` waits for idle');
    expect(prompt).toContain('`"steer"` lands at the next step boundary');
    expect(prompt).toContain(
      '`task_message` sends a bounded note to a running child',
    );
    expect(prompt).toContain('Acceptance confirms transport only');
    expect(prompt).toContain('never claim the child saw or acted on it');
    expect(prompt).toContain('then reconcile against its result');
    expect(prompt).toContain(
      '`task_status` is read-only inspection; `task_result` reads a finished result; neither launches, resumes, or instructs a child.',
    );
    expect(prompt).not.toContain('There is no safe live-prompt channel');
    expect(prompt).not.toContain("wait for that lane's terminal result. Then");
    expect(
      buildOrchestratorPrompt(undefined, undefined, true, true, 'v2'),
    ).toBe(prompt);
  });

  test('v1 retains queued amendment instructions without v2 delivery options', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('only queues a concise, non-interrupting');
    expect(prompt).toContain('There is no safe live-prompt channel');
    expect(prompt).toContain("wait for that lane's terminal result. Then");
    expect(prompt).not.toContain('delivery:');
  });

  test('requires the question tool for blocking user input', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('use the `question` tool');
    expect(prompt).toContain('Enable custom input');
    expect(prompt).toContain('concise pasted response or command output');
    expect(prompt).toContain('small bounded set of options');
    expect(prompt).toContain('ordinary dialogue that does not block work');
  });

  test('requires wait_for_user for external manual work', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('call `wait_for_user` as your final tool action');
    expect(prompt).toContain('give the user concrete manual steps');
    expect(prompt).toContain('end the turn');
    expect(prompt).toContain('never use `wait_for_user` to await them');
    expect(prompt).toContain('Do not rely on ordinary text alone');
  });

  test('sends existing-session work to task_revive without requiring the reusable list', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain(
      '`task_revive(task_id: "<task-id>", prompt: "...")`',
    );
    expect(prompt).toContain(
      'even when that session is not listed under Reusable Sessions',
    );
    expect(prompt).toContain(
      'not required before continuing an existing session',
    );
    expect(prompt).not.toContain(
      'Only sessions listed under Reusable Sessions may be resumed',
    );
    expect(prompt).not.toContain(
      'use `task_revive` only for Retained / Recovery tasks',
    );
  });

  test('falls back to question when wait_for_user is disabled', () => {
    const prompt = buildOrchestratorPrompt(undefined, undefined, false);

    expect(prompt).not.toContain(
      'call `wait_for_user` as your final tool action',
    );
    expect(prompt).toContain('`wait_for_user` is disabled');
    expect(prompt).toContain(
      'use the `question` tool as the blocking boundary',
    );
  });

  test('omits end-turn instruction when wake scheduler is disabled', () => {
    const prompt = buildOrchestratorPrompt(undefined, undefined, true, false);

    expect(prompt).toContain('call `wait_for_user` as your final tool action');
    expect(prompt).not.toContain('End Turn After Background Tasks');
    // The launch→status→end-turn flow line is scheduler-gated; the
    // two-channel rule itself stays in every state.
    expect(prompt).not.toContain('launch → brief status → end turn');
    expect(prompt).toContain('Two-channel delegation:');
  });

  test('defaults to board-aware wording while board injection is on', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('the Background Job Board');
    expect(prompt).toContain('The board is ambient status');
  });

  test('drops every Background Job Board reference when board injection is off', () => {
    const prompt = buildOrchestratorPrompt(
      undefined,
      undefined,
      true,
      true,
      undefined,
      false,
    );

    expect(prompt).not.toContain('Background Job Board');
    expect(prompt).not.toContain('If the board lists');
    expect(prompt).not.toContain('The board is ambient status');
    // The pull channel replaces the panel in every affected line.
    expect(prompt).toContain(
      'the system resumes automatically via background completion notifications and the orchestrator wake scheduler',
    );
    expect(prompt).toContain(
      'check `task_status` and the current conversation for an existing task',
    );
    expect(prompt).toContain('Background status is ambient');
    expect(prompt.match(/`task_status`/g)?.length ?? 0).toBeGreaterThan(2);
  });
  test('evaluates all four path-selection criteria', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain(
      'Evaluate approach by: quality, speed, cost, and reliability.',
    );
    expect(prompt).toContain('Choose the path that optimizes all four.');
  });

  test('enforces delegation: no direct-work escape hatch, denial stated', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('denied to you by configuration');
    expect(prompt).toContain('Delegate all implementation work to specialists');
    expect(prompt).toContain('Do not use bash to modify files');
    expect(prompt).not.toContain('Handle work directly only when');
    expect(prompt).not.toContain('delegation overhead exceeds');
    expect(prompt).not.toContain(
      'Do not delegate merely because an agent exists',
    );
  });
});

describe('v1 prompt byte parity (frozen template)', () => {
  test('default render is byte-identical across invocations and host flavors', () => {
    const noFlavor = buildOrchestratorPrompt();
    // 'v1' and unknown flavors must not move a byte from the no-flavor
    // (v1 default) render — v1 now renders the same ROLE_ROUTING_SLIM_LINES
    // content as v2, but through its own frozen wrapper template — the v2
    // wrapper (`<Role>`/`<Workflow>` wording) must still never leak in.
    expect(
      buildOrchestratorPrompt(undefined, undefined, true, true, 'v1'),
    ).toBe(noFlavor);
    expect(
      buildOrchestratorPrompt(undefined, undefined, true, true, 'v3-ish'),
    ).toBe(noFlavor);
    // Deterministic: a second render matches byte-for-byte.
    expect(buildOrchestratorPrompt()).toBe(noFlavor);
  });

  test('default v1 render is snapshot-pinned', () => {
    expect(buildOrchestratorPrompt()).toMatchSnapshot();
  });

  test('createOrchestratorAgent keeps v1 on the frozen template', () => {
    const v1 = createOrchestratorAgent(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      undefined,
    );
    expect(v1.config.prompt).toBe(buildOrchestratorPrompt());
    const explicitV1 = createOrchestratorAgent(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      'v1',
    );
    expect(explicitV1.config.prompt).toBe(buildOrchestratorPrompt());
  });

  test('default v1 render sources its <Agents> block from the slim routing lines', () => {
    const prompt = buildOrchestratorPrompt();

    for (const line of Object.values(ROLE_ROUTING_SLIM_LINES)) {
      expect(prompt).toContain(line);
    }
    // The full routing block is gone: Stats/Capabilities are prose the
    // orchestrator can never execute, and the Delegate/Don't criteria —
    // the only routing-bearing content — survive in the slim lines.
    expect(prompt).not.toContain('Stats:');
    expect(prompt).not.toContain('Capabilities:');
    expect(prompt).not.toContain('- Lane:');
  });

  test('default v1 render keeps a well-formed <Agents> wrapper around the slim lines', () => {
    const prompt = buildOrchestratorPrompt();

    const agentsBlock = /<Agents>([\s\S]*?)<\/Agents>/.exec(prompt);
    expect(agentsBlock).not.toBeNull();
    expect(agentsBlock![1].trim()).toContain(ROLE_ROUTING_SLIM_LINES.designer);
    // Exactly one wrapper element — no duplicated or unclosed tag.
    expect(prompt.match(/<Agents>/g)?.length).toBe(1);
    expect(prompt.match(/<\/Agents>/g)?.length).toBe(1);
  });

  test('v1 and v2 render the same <Agents> routing content', () => {
    const v1Block = /<Agents>([\s\S]*?)<\/Agents>/.exec(
      buildOrchestratorPrompt(),
    );
    const v2Block = /<Agents>([\s\S]*?)<\/Agents>/.exec(
      buildOrchestratorPromptV2(),
    );
    expect(v1Block).not.toBeNull();
    expect(v2Block).not.toBeNull();
    // Both builders join the same ROLE_ROUTING_SLIM_LINES values with
    // '\n\n'. Only the wrapper padding differs: v1 uses
    // `<Agents>\n\n${enabledAgents}\n\n</Agents>` (frozen template wording),
    // v2 uses `<Agents>\n${enabledAgents}\n</Agents>` — hence the trim.
    expect(v1Block![1].trim()).toBe(v2Block![1].trim());
  });
});

describe('v2 slim prompt (buildOrchestratorPromptV2)', () => {
  test('routes createOrchestratorAgent v2 to the slim builder', () => {
    const v2 = createOrchestratorAgent(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      'v2',
    );
    expect(v2.config.prompt).toBe(buildOrchestratorPromptV2());
    expect(v2.config.prompt).toContain(
      'You are a workflow manager for coding work: plan, delegate, monitor, reconcile, and verify specialist work.',
    );
    // The frozen v1 template must never leak into the v2 render.
    expect(v2.config.prompt).not.toContain('You have perfect understanding');
    expect(v2.config.prompt).not.toContain('Marketplace Packages');
    expect(v2.config.prompt).not.toContain('Delegation Check');
  });

  test('board injection never changes v2 bytes; scheduler-off does (master switch semantics)', () => {
    const v2 = createOrchestratorAgent(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      'v2',
    );
    const boardOff = createOrchestratorAgent(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      'v2',
      false,
    );
    expect(boardOff.config.prompt).toBe(v2.config.prompt);
    // Board injection never changes v2 bytes; the wake-scheduler master
    // switch does (it disables ALL scheduler wakes, unlike the periodic
    // gate), and is covered by its own test below.
    expect(v2.config.prompt).toContain(
      'completion notifications and the wake scheduler resume you',
    );
    expect(v2.config.prompt).toContain(
      'check `task_status` for an existing task covering the objective',
    );
  });

  test('wake scheduler disabled drops the scheduler from the resume promise', () => {
    const enabled = buildOrchestratorPromptV2();
    const disabled = buildOrchestratorPromptV2(
      undefined,
      undefined,
      true,
      false,
    );

    expect(enabled).toContain(
      'completion notifications and the wake scheduler resume you',
    );
    expect(disabled).toContain('completion notifications resume you');
    expect(disabled).not.toContain('wake scheduler resume you');
    expect(disabled).not.toBe(enabled);
  });

  test('waitForUser flag no longer changes v2 bytes (question is the single blocking boundary)', () => {
    const enabled = buildOrchestratorPromptV2();
    const disabled = buildOrchestratorPromptV2(undefined, undefined, false);

    expect(disabled).toBe(enabled);
    expect(enabled).toContain(
      'use the `question` tool as the blocking boundary',
    );
    expect(enabled).not.toContain('wait_for_user');
  });

  test('disabledAgents and excludeDescriptions filter routing lines', () => {
    const full = buildOrchestratorPromptV2();
    const noExplorer = buildOrchestratorPromptV2(new Set(['explorer']));
    const noCouncil = buildOrchestratorPromptV2(undefined, ['council'], true);

    for (const line of Object.values(ROLE_ROUTING_SLIM_LINES)) {
      expect(full).toContain(line);
    }
    expect(noExplorer).not.toContain('@explorer —');
    expect(noExplorer).toContain(ROLE_ROUTING_SLIM_LINES.librarian);
    expect(noCouncil).not.toContain('@council —');
    expect(noCouncil).toContain(ROLE_ROUTING_SLIM_LINES.fixer);
  });

  test('renders byte-identical output for identical arguments (construction-time constant)', () => {
    // b-seat cache-safety assertion: no time, randomness, or per-request
    // state may reach the template.
    expect(buildOrchestratorPromptV2()).toBe(buildOrchestratorPromptV2());
    expect(
      buildOrchestratorPromptV2(new Set(['explorer']), undefined, false),
    ).toBe(buildOrchestratorPromptV2(new Set(['explorer']), undefined, false));
  });

  test('v2 render is snapshot-pinned (waitForUser flag is byte-inert)', () => {
    expect(buildOrchestratorPromptV2()).toMatchSnapshot();
    expect(buildOrchestratorPromptV2(undefined, undefined, false)).toBe(
      buildOrchestratorPromptV2(),
    );
  });

  test('enforces delegation in v2: denial stated, no mutation-tool grant', () => {
    const prompt = buildOrchestratorPromptV2();

    expect(prompt).toContain('Never implement directly');
    expect(prompt).toContain('denied to you by configuration');
    expect(prompt).toContain('Do not use bash to modify files');
    expect(prompt).not.toContain('edit/write for changes');
    expect(prompt).not.toContain('act directly only for one isolated');
    expect(ROLE_ROUTING_SLIM_LINES.fixer).not.toContain('<20-line');
  });

  test('explicit re-allow switches v1 and v2 off the denial claim', () => {
    const allowedV1 = buildOrchestratorPrompt(
      undefined,
      undefined,
      true,
      true,
      undefined,
      true,
      true,
      true,
    );
    expect(allowedV1).toContain('explicitly re-allowed in configuration');
    expect(allowedV1).not.toContain('denied to you by configuration');
    expect(allowedV1).not.toContain('Never implement directly');

    const allowedV2 = buildOrchestratorPromptV2(
      undefined,
      undefined,
      true,
      true,
      true,
      true,
    );
    expect(allowedV2).toContain('explicitly re-allowed in configuration');
    expect(allowedV2).not.toContain('denied to you by configuration');
    expect(allowedV2).not.toContain('Never implement directly');
  });
});

describe('routingBlock (v2-only <Agents> removal)', () => {
  test('v2 off removes the whole <Agents> element and nothing else', () => {
    const on = buildOrchestratorPromptV2();
    const off = buildOrchestratorPromptV2(
      undefined,
      undefined,
      true,
      true,
      false,
    );
    expect(off).not.toContain('<Agents>');
    expect(off).not.toContain('</Agents>');
    // No slim-line routing content survives; identity stays in the host's
    // native subagent roster, which the roster appends to the subagent
    // tool description.
    expect(off).not.toContain('read-only codebase recon');
    expect(off).not.toContain('an escalation, not a default verification step');
    // Byte-exact surgery: splicing the <Agents> element out of the default
    // render yields exactly the off render.
    const [head, tail] = on.split('<Agents>');
    expect(off).toBe(`${head}${tail.split('</Agents>\n\n')[1]}`);
  });

  test('v2 default and explicit true stay byte-frozen', () => {
    const on = buildOrchestratorPromptV2(
      undefined,
      undefined,
      true,
      true,
      true,
    );
    expect(on).toBe(buildOrchestratorPromptV2());
    expect(on).toContain('<Agents>');
  });

  test('createOrchestratorAgent v2 honors routingBlock=false (10th positional param pinned)', () => {
    const v2 = createOrchestratorAgent(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
      'v2',
      true,
      false,
    );
    expect(v2.config.prompt).not.toContain('<Agents>');
    expect(v2.config.prompt).toBe(
      buildOrchestratorPromptV2(undefined, undefined, true, true, false),
    );
  });

  test('v1 ignores routingBlock=false and warns once (warn AND ignore)', () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => {
      warnings.push(String(message));
    };
    try {
      const v1Off = createOrchestratorAgent(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
        undefined,
        true,
        false,
      );
      const v1Default = createOrchestratorAgent(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
        undefined,
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('routingBlock');
      expect(warnings[0]).toContain('orchestrator.md');
      // Not a half-application: bytes identical to the default render.
      expect(v1Off.config.prompt).toBe(v1Default.config.prompt);
      expect(v1Off.config.prompt).toContain('<Agents>');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('v1 builder-level flag is a no-op (frozen bytes)', () => {
    expect(
      buildOrchestratorPrompt(
        undefined,
        undefined,
        true,
        true,
        undefined,
        true,
        false,
      ),
    ).toBe(buildOrchestratorPrompt());
    expect(
      buildOrchestratorPrompt(
        undefined,
        undefined,
        true,
        true,
        'v1',
        true,
        false,
      ),
    ).toBe(buildOrchestratorPrompt());
  });

  test('disabledAgents/excludeDescriptions keep their meaning with routingBlock=false', () => {
    const off = buildOrchestratorPromptV2(
      new Set(['explorer']),
      ['council'],
      true,
      true,
      false,
    );
    expect(off).not.toContain('<Agents>');
    const on = buildOrchestratorPromptV2(new Set(['explorer']), ['council']);
    expect(on).not.toContain('@explorer —');
    expect(on).not.toContain('@council —');
  });
});

describe('background-default flip prompt alignment', () => {
  test('v2 slim drops the Prefer-background line (the flipped subagent description owns the default)', () => {
    const prompt = buildOrchestratorPromptV2();
    expect(prompt).not.toContain('Prefer `subagent(..., background: true)`');
    // The end-of-turn discipline the line carried stays.
    expect(prompt).toContain('After dispatching, do non-overlapping work');
  });

  test('v1 render replaces the blanket prefer-background line with the two-channel rule', () => {
    const prompt = buildOrchestratorPrompt();
    // The host tool description covers launch/poll mechanics; the v1 prompt
    // keeps only the channel-choice rule and its own end-turn discipline.
    expect(prompt).toContain(
      'Two-channel delegation: short work whose result feeds the next step → foreground',
    );
    expect(prompt).toContain(
      'work that runs independently or is long → background, then end the turn or continue non-overlapping work',
    );
    expect(prompt).not.toContain('Prefer `task(..., background: true)`');
    expect(prompt).not.toContain('Do not immediately wait after spawning');
  });
});
