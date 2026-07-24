import { afterAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveImageRouting } from '../config/constants';
import { processImageAttachments } from './image-hook';
import type { MessageWithParts } from './types';

const TEST_DIR = path.join(os.tmpdir(), `image-hook-test-${process.pid}`);
const IMG = { type: 'image', url: 'data:image/png;base64,AAAA' };

function makeTestDir(name: string): { workDir: string; saveDir: string } {
  const workDir = path.join(TEST_DIR, name);
  const saveDir = path.join(workDir, '.opencode', 'images');
  mkdirSync(saveDir, { recursive: true });
  return { workDir, saveDir };
}

function makeOldFile(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, 'data');
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(filePath, past, past);
  return filePath;
}

function makeUserMsg(parts: MessageWithParts['parts']): MessageWithParts {
  return { info: { role: 'user', sessionID: 's1' }, parts };
}

function imagePartCount(message: MessageWithParts): number {
  return message.parts.filter((part) => part.type === 'image').length;
}

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('image-hook catch logging', () => {
  it('survives file cleanup failure without throwing', () => {
    const { workDir, saveDir } = makeTestDir('cleanup-fail-1');
    makeOldFile(saveDir, 'old-image.png');
    chmodSync(saveDir, 0o555);

    try {
      expect(() => {
        processImageAttachments({
          messages: [],
          workDir,
          imageRouting: 'auto',
          disabledAgents: new Set<string>(),
          log: () => {},
        });
      }).not.toThrow();
    } finally {
      chmodSync(saveDir, 0o755);
    }
  });

  it('survives subdirectory file cleanup failure without throwing', () => {
    const { workDir, saveDir } = makeTestDir('cleanup-fail-2');
    const sessionDir = path.join(saveDir, 'ses-abc');
    mkdirSync(sessionDir, { recursive: true });
    makeOldFile(sessionDir, 'img.png');
    chmodSync(sessionDir, 0o555);

    try {
      expect(() => {
        processImageAttachments({
          messages: [],
          workDir,
          imageRouting: 'auto',
          disabledAgents: new Set<string>(),
          log: () => {},
        });
      }).not.toThrow();
    } finally {
      chmodSync(sessionDir, 0o755);
    }
  });
});

describe('processImageAttachments image routing', () => {
  it('direct mode leaves image parts untouched', () => {
    const message = makeUserMsg([IMG]);
    const result = processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'direct'),
      imageRouting: 'direct',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(result).toBe(false);
    expect(imagePartCount(message)).toBe(1);
  });

  it('auto mode saves image parts and adds an @observer nudge', () => {
    const message = makeUserMsg([IMG]);
    const result = processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'auto'),
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(result).toBe(false);
    expect(imagePartCount(message)).toBe(0);
    const textParts = message.parts.filter((part) => part.type === 'text');
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toContain('@observer');
  });

  it('resolves omitted image routing to auto and intercepts for Observer', () => {
    const message = makeUserMsg([IMG]);
    processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'omitted-routing'),
      imageRouting: resolveImageRouting(undefined, true),
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(imagePartCount(message)).toBe(0);
    expect(message.parts.some((part) => part.type === 'text')).toBe(true);
  });

  it('returns true when observer disabled and message has images', () => {
    const message = makeUserMsg([IMG]);
    const result = processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'disabled'),
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: () => {},
    });
    expect(result).toBe(true);
    expect(imagePartCount(message)).toBe(1);
  });

  it('returns false when observer disabled but no images present', () => {
    const message = makeUserMsg([{ type: 'text', text: 'hello' }]);
    const result = processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'disabled-noimg'),
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: () => {},
    });
    expect(result).toBe(false);
  });

  it('returns true when observer disabled and an earlier (non-last) user message has images', () => {
    const earlierMsg = makeUserMsg([IMG]);
    const lastMsg = makeUserMsg([{ type: 'text', text: 'follow-up question' }]);
    const result = processImageAttachments({
      messages: [earlierMsg, lastMsg],
      workDir: path.join(TEST_DIR, 'earlier-image'),
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: () => {},
    });
    expect(result).toBe(true);
  });

  it('does not re-trigger on text-only messages after image was processed', () => {
    // Regression test: Greptile #1 fix checked ALL messages, causing the hook
    // to fire on every transform once an image was in the conversation history.
    const workDir = path.join(TEST_DIR, 'no-rere-trigger');
    const imageMsg = makeUserMsg([IMG]);
    const textMsg = makeUserMsg([{ type: 'text', text: 'follow-up' }]);

    // First call: image present → should return true
    const result1 = processImageAttachments({
      messages: [imageMsg, textMsg],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: () => {},
    });
    expect(result1).toBe(true);

    // Second call: same messages, no new image → should return false
    const result2 = processImageAttachments({
      messages: [imageMsg, textMsg],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: () => {},
    });
    expect(result2).toBe(false);
  });

  it('keeps images when auto mode cannot save them', () => {
    const message = makeUserMsg([
      { type: 'image', url: 'https://example.com/image.png' },
    ]);
    const logs: string[] = [];
    processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'unsaved'),
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: (message) => logs.push(message),
    });
    expect(imagePartCount(message)).toBe(1);
    expect(message.parts).toHaveLength(1);
    expect(logs.some((message) => message.includes('[image-routing]'))).toBe(
      false,
    );
  });

  it('strips only attachments saved successfully', () => {
    const message = makeUserMsg([
      IMG,
      { type: 'image', url: 'https://example.com/image.png' },
    ]);
    processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'mixed'),
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(imagePartCount(message)).toBe(1);
    expect(message.parts.some((part) => part.type === 'text')).toBe(true);
  });

  it('continues after an earlier message cannot save its images', () => {
    const failed = makeUserMsg([
      { type: 'image', url: 'https://example.com/image.png' },
    ]);
    const saved = makeUserMsg([IMG]);
    processImageAttachments({
      messages: [failed, saved],
      workDir: path.join(TEST_DIR, 'multiple'),
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(imagePartCount(failed)).toBe(1);
    expect(imagePartCount(saved)).toBe(0);
  });

  it('ignores non-user messages and non-image parts', () => {
    const userText = makeUserMsg([{ type: 'text', text: 'hello' }]);
    const assistant = {
      info: { role: 'assistant', sessionID: 's1' },
      parts: [{ type: 'text', text: 'hi' }],
    } as unknown as MessageWithParts;
    processImageAttachments({
      messages: [userText, assistant],
      workDir: path.join(TEST_DIR, 'non-image'),
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(userText.parts).toHaveLength(1);
    expect(assistant.parts).toHaveLength(1);
  });
});

describe('resolveImageRouting', () => {
  it('returns auto when omitted and observer enabled', () => {
    expect(resolveImageRouting(undefined, true)).toBe('auto');
  });

  it('returns direct when omitted and observer disabled', () => {
    expect(resolveImageRouting(undefined, false)).toBe('direct');
  });

  it('preserves explicit auto even when observer disabled', () => {
    expect(resolveImageRouting('auto', false)).toBe('auto');
  });

  it('preserves explicit direct even when observer enabled', () => {
    expect(resolveImageRouting('direct', true)).toBe('direct');
  });
});
