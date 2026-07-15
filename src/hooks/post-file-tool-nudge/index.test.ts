import { describe, expect, test } from 'bun:test';

import { PHASE_REMINDER } from '../../config/constants';
import { createInternalAgentTextPart } from '../../utils';
import {
  createPhaseReminderHook,
  PHASE_REMINDER_METADATA_KEY,
} from '../phase-reminder';
import { SessionLifecycle } from '../session-lifecycle';
import { createPostFileToolNudgeHook } from './index';

const orchestratorMessage = (sessionID = 's1') => ({
  info: { role: 'user', agent: 'orchestrator', sessionID },
  parts: [{ type: 'text', text: 'hello' }],
});

const reminderParts = (message: ReturnType<typeof orchestratorMessage>) =>
  message.parts.filter((part) => part.text === PHASE_REMINDER);

describe('post-file-tool-nudge hook', () => {
  test('injects a synthetic reminder without a system transform or text mutation', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const message = orchestratorMessage();

    expect(hook['experimental.chat.system.transform']).toBeUndefined();
    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [message] },
    );

    expect(message.parts[0].text).toBe('hello');
    expect(reminderParts(message)).toHaveLength(1);
    expect(message.parts[1]).toMatchObject({
      synthetic: true,
      metadata: { [PHASE_REMINDER_METADATA_KEY]: true },
    });
  });

  test('composes with phase reminder without duplication and permits a fresh reminder', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const nudge = createPostFileToolNudgeHook({ coordinator });
    const phaseReminder = createPhaseReminderHook();
    const afterFileMessage = orchestratorMessage();

    await nudge['tool.execute.after']({ tool: 'Write', sessionID: 's1' }, {});
    await nudge['experimental.chat.messages.transform'](
      {},
      { messages: [afterFileMessage] },
    );
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages: [afterFileMessage] },
    );
    expect(reminderParts(afterFileMessage)).toHaveLength(1);

    const freshMessage = orchestratorMessage();
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages: [freshMessage] },
    );
    expect(reminderParts(freshMessage)).toHaveLength(1);
  });

  test('shared session eligibility suppresses both reminders for a rejected turn', async () => {
    const coordinator = new SessionLifecycle(() => {});
    let isOrchestratorSession = false;
    const shouldInject = () => isOrchestratorSession;
    const nudge = createPostFileToolNudgeHook({ coordinator, shouldInject });
    const phaseReminder = createPhaseReminderHook({ shouldInject });
    const rejectedMessage = orchestratorMessage();

    await nudge['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await nudge['experimental.chat.messages.transform'](
      {},
      { messages: [rejectedMessage] },
    );
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages: [rejectedMessage] },
    );
    expect(reminderParts(rejectedMessage)).toHaveLength(0);

    isOrchestratorSession = true;
    const eligibleMessage = orchestratorMessage();
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages: [eligibleMessage] },
    );
    expect(reminderParts(eligibleMessage)).toHaveLength(1);
  });

  test('collapses multiple Read and Write calls into one reminder', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const message = orchestratorMessage();

    await hook['tool.execute.after']({ tool: 'read', sessionID: 's1' }, {});
    await hook['tool.execute.after']({ tool: 'write', sessionID: 's1' }, {});
    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [message] },
    );

    expect(reminderParts(message)).toHaveLength(1);
  });

  test('injects only into the latest user message', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const olderMessage = orchestratorMessage();
    const latestMessage = orchestratorMessage();

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await hook['experimental.chat.messages.transform'](
      {},
      {
        messages: [
          olderMessage,
          {
            info: { role: 'assistant', sessionID: 's1' },
            parts: [{ type: 'text', text: 'working' }],
          },
          latestMessage,
        ],
      },
    );

    expect(reminderParts(olderMessage)).toHaveLength(0);
    expect(reminderParts(latestMessage)).toHaveLength(1);
  });

  test.each([
    ['wrong session', { messages: [orchestratorMessage('s2')] }],
    ['empty messages', { messages: [] }],
    [
      'non-orchestrator turn',
      {
        messages: [
          {
            info: { role: 'user', agent: 'explorer', sessionID: 's1' },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ],
      },
    ],
    [
      'turn without a session',
      {
        messages: [
          {
            info: { role: 'user', agent: 'orchestrator' },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ],
      },
    ],
    [
      'attachment-only turn',
      {
        messages: [
          {
            info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
            parts: [{ type: 'image', url: 'https://example.com/image.png' }],
          },
        ],
      },
    ],
    [
      'internal turn',
      {
        messages: [
          {
            info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
            parts: [createInternalAgentTextPart('internal notification')],
          },
        ],
      },
    ],
  ])('does not consume pending for %s', async (_name, output) => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const eligibleMessage = orchestratorMessage();

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await hook['experimental.chat.messages.transform']({}, output);
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [eligibleMessage] },
    );

    expect(reminderParts(eligibleMessage)).toHaveLength(1);
  });

  test('trusted phase reminder metadata consumes pending without duplication', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const message = orchestratorMessage();
    message.parts.push({
      type: 'text',
      synthetic: true,
      text: PHASE_REMINDER,
      metadata: { [PHASE_REMINDER_METADATA_KEY]: true },
    });

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [message] },
    );
    expect(reminderParts(message)).toHaveLength(1);

    const freshMessage = orchestratorMessage();
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [freshMessage] },
    );
    expect(reminderParts(freshMessage)).toHaveLength(0);
  });

  test('passes the derived session ID to shouldInject', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const seenSessionIDs: string[] = [];
    const hook = createPostFileToolNudgeHook({
      coordinator,
      shouldInject: (sessionID) => {
        seenSessionIDs.push(sessionID);
        return false;
      },
    });
    const message = orchestratorMessage();

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [message] },
    );
    expect(reminderParts(message)).toHaveLength(0);
    expect(seenSessionIDs).toEqual(['s1']);
  });

  test('cleans pending state after session deletion', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const message = orchestratorMessage();

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    coordinator.dispatchSessionDeleted('s1');
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [message] },
    );

    expect(reminderParts(message)).toHaveLength(0);
  });

  test('ignores non-file tools and file calls without a session', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const message = orchestratorMessage();

    await hook['tool.execute.after']({ tool: 'bash', sessionID: 's1' }, {});
    await hook['tool.execute.after']({ tool: 'Read' }, {});
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [message] },
    );

    expect(reminderParts(message)).toHaveLength(0);
  });

  test('keeps pending sessions isolated', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const s1Message = orchestratorMessage('s1');
    const s2Message = orchestratorMessage('s2');

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await hook['tool.execute.after']({ tool: 'Write', sessionID: 's2' }, {});
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [s2Message] },
    );
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [s1Message] },
    );

    expect(reminderParts(s2Message)).toHaveLength(1);
    expect(reminderParts(s1Message)).toHaveLength(1);
  });
});
