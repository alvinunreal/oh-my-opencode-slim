import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraceFreshnessHook } from './index';

interface MessagePart {
  type: string;
  text?: string;
}
interface Message {
  info: { role: string; agent?: string };
  parts: MessagePart[];
}

function userMsg(text: string, agent = 'orchestrator'): Message {
  return { info: { role: 'user', agent }, parts: [{ type: 'text', text }] };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trace-fresh-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('trace-freshness hook', () => {
  test('no-op when spec dir does not exist', async () => {
    const hook = createTraceFreshnessHook({ specDir: join(dir, 'missing') });
    const messages: Message[] = [userMsg('hi')];
    await hook['experimental.chat.messages.transform'](
      {} as Record<string, never>,
      { messages },
    );
    expect(messages[0].parts).toHaveLength(1);
  });

  test('no-op when last message is from non-orchestrator agent', async () => {
    const spec = join(dir, 'spec');
    require('node:fs').mkdirSync(spec);
    writeFileSync(join(spec, 'requirements.md'), '## REQ-001: x\n');
    writeFileSync(
      join(spec, 'design.md'),
      '## DES-001: y\nRationale anchor: REQ-001.\n',
    );
    const hook = createTraceFreshnessHook({ specDir: spec });
    const messages: Message[] = [userMsg('hi', 'fixer')];
    await hook['experimental.chat.messages.transform'](
      {} as Record<string, never>,
      { messages },
    );
    expect(messages[0].parts).toHaveLength(1);
  });

  test('regenerates and appends notice when trace is stale', async () => {
    const spec = join(dir, 'spec');
    require('node:fs').mkdirSync(spec);
    writeFileSync(join(spec, 'requirements.md'), '## REQ-001: a\n');
    writeFileSync(
      join(spec, 'design.md'),
      '## DES-001: b\nRationale anchor: REQ-001.\n',
    );
    // Pre-existing stale trace: mtime older than requirements.
    writeFileSync(join(spec, 'trace.md'), 'stale\n');
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(spec, 'trace.md'), past, past);

    const hook = createTraceFreshnessHook({ specDir: spec });
    const messages: Message[] = [userMsg('continue')];
    await hook['experimental.chat.messages.transform'](
      {} as Record<string, never>,
      { messages },
    );

    expect(messages[0].parts).toHaveLength(2);
    expect(messages[0].parts[1].text).toContain('trace_regenerate: refreshed');
    expect(
      require('node:fs').readFileSync(join(spec, 'trace.md'), 'utf8'),
    ).toContain('REQ-001');
  });

  test('no-op when trace is up-to-date', async () => {
    const spec = join(dir, 'spec');
    require('node:fs').mkdirSync(spec);
    writeFileSync(join(spec, 'requirements.md'), '## REQ-001: a\n');
    writeFileSync(
      join(spec, 'design.md'),
      '## DES-001: b\nRationale anchor: REQ-001.\n',
    );
    // Make trace newer than sources.
    writeFileSync(join(spec, 'trace.md'), 'fresh\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(spec, 'trace.md'), future, future);

    const hook = createTraceFreshnessHook({ specDir: spec });
    const messages: Message[] = [userMsg('continue')];
    await hook['experimental.chat.messages.transform'](
      {} as Record<string, never>,
      { messages },
    );

    expect(messages[0].parts).toHaveLength(1);
  });

  test('does not double-inject when notice already present', async () => {
    const spec = join(dir, 'spec');
    require('node:fs').mkdirSync(spec);
    writeFileSync(join(spec, 'requirements.md'), '## REQ-001: a\n');
    writeFileSync(
      join(spec, 'design.md'),
      '## DES-001: b\nRationale anchor: REQ-001.\n',
    );
    writeFileSync(join(spec, 'trace.md'), 'stale\n');
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(spec, 'trace.md'), past, past);

    const hook = createTraceFreshnessHook({ specDir: spec });
    const messages: Message[] = [userMsg('continue')];
    messages[0].parts.push({
      type: 'text',
      text: '<internal_reminder>trace_regenerate: refreshed</internal_reminder>',
    });
    await hook['experimental.chat.messages.transform'](
      {} as Record<string, never>,
      { messages },
    );

    expect(messages[0].parts).toHaveLength(2);
  });
});
