import { describe, expect, test } from 'bun:test';
import {
  appendTaggedSyntheticPart,
  appendTrailingVolatileMessage,
  createTaggedSyntheticPart,
  hasTaggedPart,
  isTaggedPart,
  isVolatileTaggedMessage,
  stripTaggedContent,
} from './cache-safe-injection';
import type { MessageWithParts } from './types';

const KEY = 'oh-my-opencode-slim.testTag';

function userMessage(text: string): MessageWithParts {
  return {
    info: { role: 'user', agent: 'orchestrator', sessionID: 's1', id: 'm1' },
    parts: [{ type: 'text', text }],
  };
}

describe('createTaggedSyntheticPart', () => {
  test('builds a synthetic text part with the tag winning over extras', () => {
    const part = createTaggedSyntheticPart({
      text: 'hello',
      metadataKey: KEY,
      extraMetadata: { other: 1, [KEY]: false },
    });

    expect(part).toEqual({
      type: 'text',
      synthetic: true,
      text: 'hello',
      metadata: { other: 1, [KEY]: true },
    });
  });
});

describe('isTaggedPart / hasTaggedPart', () => {
  test('recognizes only synthetic parts carrying the exact tag', () => {
    const tagged = createTaggedSyntheticPart({ text: 'x', metadataKey: KEY });
    expect(isTaggedPart(tagged, KEY)).toBe(true);
    expect(isTaggedPart(tagged, 'other-key')).toBe(false);
    expect(isTaggedPart({ type: 'text', text: 'x' }, KEY)).toBe(false);
    expect(
      isTaggedPart({ type: 'text', text: 'x', metadata: { [KEY]: true } }, KEY),
    ).toBe(false);
    expect(isTaggedPart(undefined, KEY)).toBe(false);
  });

  test('hasTaggedPart scans all parts of a message', () => {
    const message = userMessage('hi');
    expect(hasTaggedPart(message, KEY)).toBe(false);
    appendTaggedSyntheticPart(message, { text: 'r', metadataKey: KEY });
    expect(hasTaggedPart(message, KEY)).toBe(true);
  });
});

describe('appendTaggedSyntheticPart', () => {
  test('appends at the tail without touching existing parts', () => {
    const message = userMessage('original');
    const before = JSON.stringify(message.parts[0]);

    appendTaggedSyntheticPart(message, { text: 'reminder', metadataKey: KEY });

    expect(message.parts).toHaveLength(2);
    expect(JSON.stringify(message.parts[0])).toBe(before);
    expect(isTaggedPart(message.parts[1], KEY)).toBe(true);
  });
});

describe('stripTaggedContent', () => {
  test('removes tagged parts from real messages and drops emptied synthetic messages', () => {
    const real = userMessage('keep me');
    appendTaggedSyntheticPart(real, { text: 'legacy', metadataKey: KEY });
    const messages: unknown[] = [real];
    appendTrailingVolatileMessage(
      messages,
      { role: 'user', id: 'm1-tag' },
      { text: 'volatile', metadataKey: KEY },
    );

    stripTaggedContent(messages, KEY);

    expect(messages).toHaveLength(1);
    expect((messages[0] as MessageWithParts).parts).toHaveLength(1);
    expect((messages[0] as MessageWithParts).parts[0].text).toBe('keep me');
  });

  test('leaves messages without the tag byte-identical', () => {
    const real = userMessage('untouched');
    const other = userMessage('also untouched');
    appendTaggedSyntheticPart(other, {
      text: 'different tag',
      metadataKey: 'other-key',
    });
    const messages: unknown[] = [real, other];
    const before = JSON.stringify(messages);

    stripTaggedContent(messages, KEY);

    expect(JSON.stringify(messages)).toBe(before);
  });

  test('preserves messages that were already empty', () => {
    const empty: MessageWithParts = {
      info: { role: 'user' },
      parts: [],
    };
    const messages: unknown[] = [empty];

    stripTaggedContent(messages, KEY);

    expect(messages).toHaveLength(1);
  });
});

describe('appendTrailingVolatileMessage / isVolatileTaggedMessage', () => {
  test('appends a synthetic message at the end and marks it volatile', () => {
    const real = userMessage('turn');
    const messages: unknown[] = [real];

    appendTrailingVolatileMessage(
      messages,
      { role: 'user', agent: 'orchestrator', sessionID: 's1', id: 'm1-board' },
      { text: 'board', metadataKey: KEY },
    );

    expect(messages).toHaveLength(2);
    expect(isVolatileTaggedMessage(messages[1], KEY)).toBe(true);
    expect(isVolatileTaggedMessage(messages[0], KEY)).toBe(false);
    expect(isVolatileTaggedMessage(messages[1], 'other-key')).toBe(false);
  });

  test('strip-then-append keeps at most one instance, always trailing', () => {
    const real = userMessage('turn');
    const messages: unknown[] = [real];

    for (const text of ['board v1', 'board v2']) {
      stripTaggedContent(messages, KEY);
      appendTrailingVolatileMessage(
        messages,
        { role: 'user', id: 'm1-board' },
        { text, metadataKey: KEY },
      );
    }

    expect(messages).toHaveLength(2);
    const trailing = messages[1] as MessageWithParts;
    expect(trailing.parts[0].text).toBe('board v2');
  });
});
