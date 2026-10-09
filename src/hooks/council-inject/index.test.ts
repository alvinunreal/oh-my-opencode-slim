import { describe, expect, test } from 'bun:test';
import { createInternalAgentTextPart } from '../../utils';
import {
  buildCouncilModeBlock,
  COUNCIL_INJECT_METADATA_KEY,
  createCouncilInjectHook,
  matchesCouncilTrigger,
} from './index';

describe('matchesCouncilTrigger', () => {
  test('matches ASCII keywords with word boundaries', () => {
    expect(matchesCouncilTrigger('run a council on this')).toBe(true);
    expect(matchesCouncilTrigger('please get a second opinion')).toBe(true);
    expect(matchesCouncilTrigger('this plan needs consensus')).toBe(true);
    expect(matchesCouncilTrigger('@council compare these')).toBe(true);
    expect(matchesCouncilTrigger('dispatch @councillor-a now')).toBe(true);
    // Plural forms are natural council phrasing and must trigger too.
    expect(matchesCouncilTrigger('ask the councillors')).toBe(true);
    expect(matchesCouncilTrigger('gather opinions from multiple models')).toBe(
      true,
    );
  });

  test('matches CJK keywords by substring', () => {
    expect(matchesCouncilTrigger('拉个议会评估一下')).toBe(true);
    expect(matchesCouncilTrigger('多方代理讨论，要共识')).toBe(true);
    expect(matchesCouncilTrigger('多模型交叉验证')).toBe(true);
    expect(matchesCouncilTrigger('用多代理的方式再讨论一遍')).toBe(true);
  });

  test('matches keywords in every supported language', () => {
    // 日本語
    expect(matchesCouncilTrigger('この件は評議会にかけよう')).toBe(true);
    expect(matchesCouncilTrigger('円卓会議で合意を取りたい')).toBe(true);
    expect(matchesCouncilTrigger('セカンドオピニオンが欲しい')).toBe(true);
    expect(matchesCouncilTrigger('マルチエージェントで意見を集めて')).toBe(
      true,
    );
    // 한국어
    expect(matchesCouncilTrigger('평의회에 부탁해보자')).toBe(true);
    expect(matchesCouncilTrigger('원탁 토의로 합의를 만들자')).toBe(true);
    expect(matchesCouncilTrigger('여러 모델에게 물어봐')).toBe(true);
    // فارسی
    expect(matchesCouncilTrigger('لطفاً از شورا بپرس')).toBe(true);
    expect(matchesCouncilTrigger('اینجا به اجماع نیاز داریم')).toBe(true);
    expect(matchesCouncilTrigger('چند مدل نظر بدهند')).toBe(true);
    // 繁體中文
    expect(matchesCouncilTrigger('開個圓桌會議求共識')).toBe(true);
    expect(matchesCouncilTrigger('問問其他模型的第二意見')).toBe(true);
  });

  test('matches broader English council phrasings', () => {
    expect(matchesCouncilTrigger('get diverse perspectives on this')).toBe(
      true,
    );
    expect(matchesCouncilTrigger('use it as a sounding board')).toBe(true);
    expect(matchesCouncilTrigger('is this a deliberate design choice?')).toBe(
      true,
    );
    expect(matchesCouncilTrigger('compare it as a multi-agent approach')).toBe(
      true,
    );
  });

  test('does not match single-token hot words', () => {
    expect(matchesCouncilTrigger('switch the model for this task')).toBe(false);
    expect(matchesCouncilTrigger('このモデルは速い')).toBe(false);
  });

  test('does not match plain text without triggers', () => {
    expect(matchesCouncilTrigger('fix the login bug')).toBe(false);
    expect(matchesCouncilTrigger('refactor the parser module')).toBe(false);
  });

  test('does not match keywords inside code fences or inline code', () => {
    expect(
      matchesCouncilTrigger(
        'review my config:\n```jsonc\n"council": { "presets": {} }\n```\nthanks',
      ),
    ).toBe(false);
    expect(
      matchesCouncilTrigger('the `council` key goes in the plugin config'),
    ).toBe(false);
  });

  test('does not match slash commands', () => {
    expect(matchesCouncilTrigger('/council run this')).toBe(false);
  });

  test('does not do negation parsing (recall-biased)', () => {
    expect(matchesCouncilTrigger('上次没用 council，这次来一次')).toBe(true);
  });
});

describe('buildCouncilModeBlock', () => {
  test('v2 wording renders the terse standing procedure', () => {
    const block = buildCouncilModeBlock({
      tool: 'subagent',
      agentParam: 'agent',
    });

    expect(block).toContain('## Council Mode');
    // Descriptive gate, not a restrictive one: weaker models must still run
    // the procedure on a genuine ask.
    expect(block).toContain(
      'When the conversation calls for multi-model consensus',
    );
    expect(block).not.toContain('INSTEAD of delegating');
    expect(block).toContain('every council seat in parallel via subagent()');
    // The synthesis call must show the prompt= parameter (the old static
    // block omitted it, teaching the model a bad example).
    expect(block).toMatch(
      /subagent\(agent='council', description='[^']+', prompt=/,
    );
    // Seat names are not enumerated: the orchestrator's static seat pointer
    // already lists them, and duplicating them here invites drift.
    expect(block).not.toContain('councillor-a');
  });

  test('v1 wording uses task/subagent_type', () => {
    const block = buildCouncilModeBlock({
      tool: 'task',
      agentParam: 'subagent_type',
    });

    expect(block).toContain('via task()');
    expect(block).toMatch(/task\(subagent_type='council', description=/);
    expect(block).not.toContain('subagent(');
  });
});

describe('createCouncilInjectHook', () => {
  const hook = createCouncilInjectHook({
    wording: { tool: 'subagent', agentParam: 'agent' },
  });
  const transform = hook['experimental.chat.messages.transform'];

  test('appends the block only to matching orchestrator messages', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'fix the parser' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council on the plan' }],
        },
      ],
    };

    await transform({}, output);

    expect(output.messages[0].parts.length).toBe(1);
    expect(output.messages[1].parts.length).toBe(2);
    const injected = output.messages[1].parts[1];
    expect(injected).toMatchObject({
      synthetic: true,
      metadata: { [COUNCIL_INJECT_METADATA_KEY]: true },
    });
    expect(injected.text).toContain('## Council Mode');
  });

  test('does not inject for specialist agents (passthrough)', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'explorer', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council please' }],
        },
      ],
    };

    await transform({}, output);

    expect(output.messages[0].parts.length).toBe(1);
  });

  test('scans every text part, not just the first', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [
            { type: 'text', text: 'compare these two designs' },
            { type: 'text', text: 'and run a council before choosing' },
          ],
        },
      ],
    };

    await transform({}, output);

    expect(output.messages[0].parts.length).toBe(3);
    expect(output.messages[0].parts[2]).toMatchObject({ synthetic: true });
  });

  test('a leading slash command disables the whole multipart message', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [
            { type: 'text', text: '/preset openai' },
            { type: 'text', text: 'and run a council after that' },
          ],
        },
      ],
    };

    await transform({}, output);

    // Slash commands never trigger, even when a later part carries a
    // trigger word.
    expect(output.messages[0].parts.length).toBe(2);
  });

  test('does not inject onto internal initiator parts', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [createInternalAgentTextPart('wake: run a council now')],
        },
      ],
    };

    await transform({}, output);

    expect(output.messages[0].parts.length).toBe(1);
  });

  test('is idempotent across repeated transforms on the same payload', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council' }],
        },
      ],
    };

    await transform({}, output);
    const partsAfterFirst = [...output.messages[0].parts];
    await transform({}, output);

    // The tagged-part dedupe keeps the second run from appending again.
    expect(output.messages[0].parts.length).toBe(2);
    expect(output.messages[0].parts[1]).toEqual(partsAfterFirst[1]);
  });

  test('replays byte-identical blocks on later turns (cache safety)', async () => {
    const turnOne = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council on this' }],
        },
      ],
    };
    await transform({}, turnOne);

    // Turn two: the host re-renders history WITHOUT the injected part (it is
    // never persisted) and adds a new user message. The historical block must
    // be re-derived at the same position with the same bytes.
    const turnTwo = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council on this' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'thanks, now just fix it' }],
        },
      ],
    };
    await transform({}, turnTwo);

    expect(turnTwo.messages[0].parts.length).toBe(2);
    expect(turnTwo.messages[0].parts[1]).toEqual(turnOne.messages[0].parts[1]);
    expect(turnTwo.messages[1].parts.length).toBe(1);
  });

  test('injects once per transcript: later triggers never add a second block', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'run a council on the API design' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [
            { type: 'text', text: 'also get a second opinion on the CLI' },
          ],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: '再来一轮共识确认一下' }],
        },
      ],
    };

    await transform({}, output);

    // First-hit: exactly one block, on the earliest triggering message.
    expect(output.messages[0].parts.length).toBe(2);
    expect(output.messages[1].parts.length).toBe(1);
    expect(output.messages[2].parts.length).toBe(1);
  });

  test('a block already in the payload suppresses any further injection', async () => {
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [
            { type: 'text', text: 'run a council on this' },
            {
              type: 'text',
              synthetic: true,
              text: 'pre-existing block',
              metadata: { [COUNCIL_INJECT_METADATA_KEY]: true },
            },
          ],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'another trigger: consensus check' }],
        },
      ],
    };

    await transform({}, output);

    // The existing tagged part satisfies the one-block invariant; a new
    // triggering message must not grow a second one.
    expect(output.messages[0].parts.length).toBe(2);
    expect(output.messages[1].parts.length).toBe(1);
  });
});
