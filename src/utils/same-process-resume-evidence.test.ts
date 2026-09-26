import { describe, expect, test } from 'bun:test';
import {
  createSameProcessResumeEvidence,
  hostResumeEvidence,
} from './same-process-resume-evidence';

const admission = {
  sessionID: 'child',
  messageID: 'child-user-1',
  createdAt: 10,
};

const terminal = {
  taskID: 'child',
  parentSessionID: 'parent',
  generation: 3,
  terminalRevision: 7,
  state: 'completed' as const,
  resultSummary: 'finished',
  completedAt: 20,
};

function brokerWithTerminal() {
  const broker = createSameProcessResumeEvidence();
  broker.observeAdmission(admission);
  broker.recordTerminal(terminal);
  return broker;
}

function authorize(
  broker: ReturnType<typeof createSameProcessResumeEvidence>,
  evidence = terminal,
) {
  return broker.authorize({
    taskID: evidence.taskID,
    parentSessionID: evidence.parentSessionID,
    generation: evidence.generation,
    terminalRevision: evidence.terminalRevision,
    resultSummary: evidence.resultSummary,
    acknowledgedAt: 30,
  });
}

describe('same-process resume evidence', () => {
  test('reuses the broker supplied by the host setup', () => {
    const supplied = createSameProcessResumeEvidence();

    expect(hostResumeEvidence({ experimental_v2: {} })).toBeUndefined();
    expect(
      hostResumeEvidence({
        experimental_v2: { sameProcessResumeEvidence: supplied },
      }),
    ).toBe(supplied);
  });

  test('rejects authorization before terminal evidence exists', () => {
    const broker = createSameProcessResumeEvidence();
    broker.observeAdmission(admission);

    expect(authorize(broker)).toBeUndefined();
  });

  test('issues an opaque token and claim for valid terminal evidence', () => {
    const broker = brokerWithTerminal();
    const token = authorize(broker);

    expect(token).toBeDefined();
    expect(token && Reflect.ownKeys(token)).toHaveLength(0);
    expect(token && Object.isFrozen(token)).toBe(true);
    expect(token && JSON.stringify(token)).toBe('{}');
    expect(token && broker.claim(token)).toBeDefined();
  });

  test('a new child admission invalidates its prior tokens and claims', () => {
    const broker = brokerWithTerminal();
    const token = authorize(broker);
    if (!token) throw new Error('missing token');
    const claim = broker.claim(token);
    if (!claim) throw new Error('missing claim');

    broker.observeAdmission({
      sessionID: 'child',
      messageID: 'child-user-2',
      createdAt: 40,
    });

    expect(broker.claim(token)).toBeUndefined();
    expect(broker.accept(claim)).toBe(false);
    expect(broker.releaseBeforeSend(claim)).toBe(false);
    expect(authorize(broker)).toBeUndefined();
  });

  test.each([
    { generation: 2, terminalRevision: terminal.terminalRevision },
    { generation: terminal.generation, terminalRevision: 6 },
  ])('rejects generation/revision mismatch: %j', (identity) => {
    const broker = brokerWithTerminal();

    expect(
      broker.authorize({
        taskID: terminal.taskID,
        parentSessionID: terminal.parentSessionID,
        ...identity,
        resultSummary: terminal.resultSummary,
        acknowledgedAt: 30,
      }),
    ).toBeUndefined();
  });

  test('disposal invalidates both a token and an outstanding claim', () => {
    const broker = brokerWithTerminal();
    const token = authorize(broker);
    if (!token) throw new Error('missing token');
    const claim = broker.claim(token);
    if (!claim) throw new Error('missing claim');

    broker.dispose();
    broker.dispose();

    expect(broker.claim(token)).toBeUndefined();
    expect(broker.accept(claim)).toBe(false);
    expect(broker.releaseBeforeSend(claim)).toBe(false);
    expect(authorize(broker)).toBeUndefined();
  });

  test('allows one concurrent claim per token', () => {
    const broker = brokerWithTerminal();
    const token = authorize(broker);
    if (!token) throw new Error('missing token');

    const first = broker.claim(token);
    expect(first).toBeDefined();
    expect(broker.claim(token)).toBeUndefined();
  });

  test('release-before-send permits a controlled retry but retires the old claim', () => {
    const broker = brokerWithTerminal();
    const token = authorize(broker);
    if (!token) throw new Error('missing token');
    const first = broker.claim(token);
    if (!first) throw new Error('missing first claim');

    expect(broker.releaseBeforeSend(first)).toBe(true);
    expect(broker.releaseBeforeSend(first)).toBe(false);
    expect(broker.accept(first)).toBe(false);

    const retry = broker.claim(token);
    expect(retry).toBeDefined();
    expect(retry).not.toBe(first);
  });

  test('accept consumes the claim and blocks token reuse', () => {
    const broker = brokerWithTerminal();
    const token = authorize(broker);
    if (!token) throw new Error('missing token');
    const claim = broker.claim(token);
    if (!claim) throw new Error('missing claim');

    expect(broker.accept(claim)).toBe(true);
    expect(broker.accept(claim)).toBe(false);
    expect(broker.claim(token)).toBeUndefined();
    expect(
      broker.authorize({
        taskID: terminal.taskID,
        parentSessionID: terminal.parentSessionID,
        generation: terminal.generation,
        terminalRevision: terminal.terminalRevision,
        resultSummary: 'different result',
        acknowledgedAt: 31,
      }),
    ).toBeUndefined();
  });

  test('requires the exact terminal and an acknowledgement after its timestamps', () => {
    const broker = createSameProcessResumeEvidence();
    broker.observeAdmission(admission);
    broker.recordTerminal({ ...terminal, parentSessionID: 'other-parent' });
    expect(authorize(broker)).toBeUndefined();

    broker.recordTerminal(terminal);
    expect(
      broker.authorize({
        taskID: terminal.taskID,
        parentSessionID: terminal.parentSessionID,
        generation: terminal.generation,
        terminalRevision: terminal.terminalRevision,
        resultSummary: terminal.resultSummary,
        acknowledgedAt: terminal.completedAt - 1,
      }),
    ).toBeUndefined();

    broker.observeAdmission({
      ...admission,
      messageID: 'child-user-2',
      createdAt: 40,
    });
    broker.recordTerminal(terminal);
    expect(authorize(broker)).toBeUndefined();
  });

  test('a later child admission does not inherit the previous result', () => {
    const broker = createSameProcessResumeEvidence();
    broker.observeAdmission({
      sessionID: admission.sessionID,
      messageID: 'child-user-1',
    });
    broker.observeAdmission({
      sessionID: admission.sessionID,
      messageID: 'child-user-2',
    });
    broker.recordTerminal({ ...terminal, completedAt: undefined });

    expect(authorize(broker)).toBeUndefined();

    broker.recordTerminal({
      ...terminal,
      terminalRevision: terminal.terminalRevision + 1,
      resultSummary: 'second run',
      completedAt: undefined,
    });
    expect(
      broker.authorize({
        taskID: terminal.taskID,
        parentSessionID: terminal.parentSessionID,
        generation: terminal.generation,
        terminalRevision: terminal.terminalRevision + 1,
        resultSummary: 'second run',
        acknowledgedAt: 30,
      }),
    ).toBeDefined();
  });

  test('a recorded first run does not block the next completed run', () => {
    const broker = createSameProcessResumeEvidence();
    broker.observeAdmission({
      sessionID: admission.sessionID,
      messageID: 'child-user-1',
    });
    broker.recordTerminal({ ...terminal, completedAt: undefined });
    broker.observeAdmission({
      sessionID: admission.sessionID,
      messageID: 'child-user-2',
    });
    broker.recordTerminal({
      ...terminal,
      generation: terminal.generation + 1,
      resultSummary: 'second run',
      completedAt: undefined,
    });

    expect(
      broker.authorize({
        taskID: terminal.taskID,
        parentSessionID: terminal.parentSessionID,
        generation: terminal.generation + 1,
        terminalRevision: terminal.terminalRevision,
        resultSummary: 'second run',
        acknowledgedAt: 30,
      }),
    ).toBeDefined();
    expect(authorize(broker)).toBeUndefined();
  });

  test('a parent follow-up after child terminal does not revoke child evidence', () => {
    const broker = brokerWithTerminal();
    const token = authorize(broker);
    if (!token) throw new Error('missing token');
    const claim = broker.claim(token);
    if (!claim) throw new Error('missing claim');

    broker.observeAdmission({
      sessionID: 'parent',
      messageID: 'parent-user-2',
      createdAt: 25,
    });

    expect(authorize(broker)).toBe(token);
    expect(broker.accept(claim)).toBe(true);
  });

  test('two child sessions are isolated when one admission changes', () => {
    const broker = brokerWithTerminal();
    const second = { ...terminal, taskID: 'child-2', resultSummary: 'second' };
    broker.observeAdmission({
      sessionID: second.taskID,
      messageID: 'second-1',
      createdAt: 11,
    });
    broker.recordTerminal(second);
    const firstToken = authorize(broker);
    const secondToken = authorize(broker, second);
    if (!firstToken || !secondToken) throw new Error('missing token');
    const firstClaim = broker.claim(firstToken);
    const secondClaim = broker.claim(secondToken);
    if (!firstClaim || !secondClaim) throw new Error('missing claim');

    broker.observeAdmission({ ...admission, messageID: 'child-user-2' });

    expect(broker.accept(firstClaim)).toBe(false);
    expect(broker.claim(firstToken)).toBeUndefined();
    expect(authorize(broker)).toBeUndefined();
    expect(authorize(broker, second)).toBe(secondToken);
    expect(broker.accept(secondClaim)).toBe(true);
  });

  test('terminal before its child admission is rejected, even with a parent admission', () => {
    const broker = createSameProcessResumeEvidence();
    broker.observeAdmission({
      sessionID: 'parent',
      messageID: 'parent-user-1',
    });
    broker.recordTerminal(terminal);
    broker.observeAdmission(admission);
    expect(authorize(broker)).toBeUndefined();

    broker.recordTerminal(terminal);
    expect(authorize(broker)).toBeDefined();
  });

  test('same message gains a timestamp without invalidating an existing claim', () => {
    const broker = createSameProcessResumeEvidence();
    broker.observeAdmission({
      sessionID: 'child',
      messageID: admission.messageID,
    });
    broker.recordTerminal(terminal);
    const token = authorize(broker);
    if (!token) throw new Error('missing token');
    const claim = broker.claim(token);
    if (!claim) throw new Error('missing claim');

    broker.observeAdmission(admission);
    broker.observeAdmission({
      sessionID: 'child',
      messageID: admission.messageID,
    });

    expect(authorize(broker)).toBe(token);
    expect(broker.accept(claim)).toBe(true);
  });

  test('conflicting timestamp invalidates only the affected child', () => {
    const broker = brokerWithTerminal();
    const other = { ...terminal, taskID: 'other-child' };
    broker.observeAdmission({ sessionID: other.taskID, messageID: 'other-1' });
    broker.recordTerminal(other);
    const oldToken = authorize(broker);
    const otherToken = authorize(broker, other);
    if (!oldToken || !otherToken) throw new Error('missing token');
    const oldClaim = broker.claim(oldToken);
    if (!oldClaim) throw new Error('missing claim');

    broker.observeAdmission({
      ...admission,
      createdAt: admission.createdAt + 1,
    });

    expect(broker.accept(oldClaim)).toBe(false);
    expect(broker.claim(oldToken)).toBeUndefined();
    expect(authorize(broker)).toBeUndefined();
    expect(authorize(broker, other)).toBe(otherToken);
  });

  test('bounded admission eviction invalidates an outstanding claim', () => {
    const broker = brokerWithTerminal();
    const token = authorize(broker);
    if (!token) throw new Error('missing token');
    const claim = broker.claim(token);
    if (!claim) throw new Error('missing claim');

    for (let i = 0; i < 512; i++) {
      broker.observeAdmission({
        sessionID: `session-${i}`,
        messageID: `message-${i}`,
      });
    }

    expect(broker.accept(claim)).toBe(false);
    expect(broker.claim(token)).toBeUndefined();
    expect(authorize(broker)).toBeUndefined();
    broker.recordTerminal(terminal);
    expect(authorize(broker)).toBeUndefined();
  });

  test('bounded terminal eviction invalidates its token without removing admission', () => {
    const broker = brokerWithTerminal();
    const token = authorize(broker);
    if (!token) throw new Error('missing token');
    const claim = broker.claim(token);
    if (!claim) throw new Error('missing claim');

    for (let i = 0; i < 256; i++) {
      const taskID = `task-${i}`;
      broker.observeAdmission({ sessionID: taskID, messageID: `message-${i}` });
      broker.recordTerminal({ ...terminal, taskID });
    }

    expect(broker.releaseBeforeSend(claim)).toBe(false);
    expect(broker.claim(token)).toBeUndefined();
    expect(authorize(broker)).toBeUndefined();
    broker.recordTerminal(terminal);
    expect(authorize(broker)).toBeDefined();
  });

  test('disposed broker cannot use old tokens in a fresh broker', () => {
    const old = brokerWithTerminal();
    const token = authorize(old);
    if (!token) throw new Error('missing token');
    const fresh = brokerWithTerminal();
    old.dispose();

    expect(fresh.claim(token)).toBeUndefined();
    expect(authorize(fresh)).toBeDefined();
  });

  test('replacement terminal fences changed generation, revision, state and digest', () => {
    for (const change of [
      { generation: 4 },
      { terminalRevision: 8 },
      { state: 'error' as const },
      { resultSummary: 'changed' },
      { completedAt: 31 },
    ]) {
      const broker = brokerWithTerminal();
      const token = authorize(broker);
      if (!token) throw new Error('missing token');
      const claim = broker.claim(token);
      if (!claim) throw new Error('missing claim');
      broker.recordTerminal({ ...terminal, ...change });
      expect(broker.accept(claim)).toBe(false);
      expect(broker.claim(token)).toBeUndefined();
      const replacementToken = authorize(broker);
      if ('state' in change) {
        expect(replacementToken).toBeDefined();
        expect(replacementToken).not.toBe(token);
      } else {
        expect(replacementToken).toBeUndefined();
      }
    }
  });
});
