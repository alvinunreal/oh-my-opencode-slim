/**
 * Shared v2 session submit + text helpers.
 *
 * One implementation of "submit text as a user prompt on a v2 session" so the
 * generic command bridge (setup.ts) and the interview bridge stay identical;
 * avoids a setup↔interview-bridge import cycle.
 */

import { LRUCache } from 'lru-cache';
import { log } from '../utils/logger';
import type { V2Context, V2SessionContextEvent } from './types';

type CommandPart = {
  type: string;
  text?: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
};

export type V1CommandBeforeHook = (
  input: { command: string; sessionID: string; arguments: string },
  output: { parts: CommandPart[] },
) => Promise<void>;

const commandExpansions = new WeakMap<
  V1CommandBeforeHook,
  LRUCache<string, Promise<CommandPart[]>>
>();

export async function replayMarkerExpansions(
  event: V2SessionContextEvent,
  commandBefore: V1CommandBeforeHook,
  parse: (text: string) => { name: string; args: string } | undefined,
  mayRun: (index: number) => boolean = () => true,
  beforeRun?: () => void,
): Promise<void> {
  for (const [index, message] of event.messages.entries()) {
    if (message.role !== 'user') continue;
    const markerIndex = message.content.findIndex(
      (part) => part.type === 'text' && part.synthetic !== true,
    );
    const marker = message.content[markerIndex];
    const text = typeof marker?.text === 'string' ? marker.text : '';
    const parsed = parse(text);
    if (!parsed) continue;

    let cache = commandExpansions.get(commandBefore);
    if (!cache) {
      cache = new LRUCache({ max: 512 });
      commandExpansions.set(commandBefore, cache);
    }
    const key =
      message.id && JSON.stringify([event.sessionID, message.id, text]);
    let expansion = key ? cache.get(key) : undefined;
    if (!expansion && mayRun(index)) {
      beforeRun?.();
      const output = { parts: [] as CommandPart[] };
      expansion = commandBefore(
        {
          command: parsed.name,
          sessionID: event.sessionID,
          arguments: parsed.args.trim(),
        },
        output,
      ).then(() => output.parts);
      if (key) cache.set(key, expansion);
    }
    const parts = await expansion?.catch((error) => {
      if (key) cache.delete(key);
      throw error;
    });
    const otherParts = message.content.filter((_, i) => i !== markerIndex);
    message.content = parts?.length
      ? [...parts.map((part) => ({ ...part })), ...otherParts]
      : [{ type: 'text', text: parsed.args }, ...otherParts];
  }
}

/** Function that submits `text` as a user prompt on a v2 session. */
export type V2CommandSubmit = (
  sessionID: string,
  text: string,
  files?: Array<{ uri: string; name?: string }>,
) => Promise<void>;

/** Submit marker text as a user prompt via `ctx.session.prompt`. Never
 * throws — the session methods reject on transport errors and command
 * `execute` must not leak that out to the host. */
export function createSessionSubmit(ctx: V2Context): V2CommandSubmit {
  // Reduced hosts may omit the session domain entirely (mirrors
  // interview-bridge.ts); without the ?? {} the probe below would throw a
  // TypeError and be mislogged as a submit failure.
  const session = (ctx.session ?? {}) as V2Context['session'];
  return async (sessionID, text, files) => {
    try {
      if (typeof session.prompt === 'function') {
        await session.prompt({ sessionID, text, ...(files ? { files } : {}) });
        return;
      }
      log('[v2] command submit unavailable', { sessionID });
    } catch (err) {
      log('[v2] command submit failed', { sessionID, err: String(err) });
    }
  };
}

/**
 * Join the text of `type: 'text'` content parts with `separator`.
 *
 * Non-text parts and text parts whose `text` is not a string are dropped.
 * With an empty separator this is byte-identical to keeping such parts as
 * empty strings — the join only inserts bytes between kept parts.
 */
export function joinTextParts(
  parts: ReadonlyArray<unknown>,
  separator: string,
): string {
  return parts
    .filter(
      (part): part is { text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join(separator);
}

/** Join the text parts of a v2 message content array. */
export function textFromContent(
  content: Array<Record<string, unknown>>,
): string {
  return joinTextParts(content, '');
}
