import { Readable } from 'node:stream';
import { MAX_STDERR_CHARS, RG_BINARY } from './constants';
import { formatNonUtf8TextDisplay, tryDecodeUtf8 } from './path-utils';
import type { RgJsonEvent, RgPathPayload, RgTextPayload } from './types';

function decodeChunk(decoder: TextDecoder, chunk?: Uint8Array): string {
  return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
}

function decodeBase64Text(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  return tryDecodeUtf8(bytes) ?? formatNonUtf8TextDisplay(bytes);
}

export function decodeRgPayload(
  payload: RgTextPayload | RgPathPayload | undefined,
): string {
  if (!payload) {
    return '';
  }

  if (typeof payload.text === 'string') {
    return payload.text;
  }

  if (typeof payload.bytes === 'string') {
    return decodeBase64Text(payload.bytes);
  }

  return '';
}

type BinaryReadableStream =
  | NodeJS.ReadableStream
  | ReadableStream<Uint8Array>
  | null
  | undefined;

function toWebReadableStream(
  stream: BinaryReadableStream,
): ReadableStream<Uint8Array> | null {
  if (!stream) {
    return null;
  }

  if ('getReader' in stream && typeof stream.getReader === 'function') {
    return stream as ReadableStream<Uint8Array>;
  }

  return Readable.toWeb(
    stream as unknown as Readable,
  ) as unknown as ReadableStream<Uint8Array>;
}

class GrowableByteBuffer {
  private buffer = new Uint8Array(0);
  private start = 0;
  private end = 0;
  private searchStart = 0;

  append(chunk?: Uint8Array): void {
    if (!chunk || chunk.length === 0) {
      return;
    }

    this.ensureCapacity(chunk.length);
    this.buffer.set(chunk, this.end);
    this.end += chunk.length;
  }

  takeUntil(delimiter: number): Uint8Array | undefined {
    const scanStart = Math.max(this.start, this.searchStart);
    const relativeIndex = this.buffer
      .subarray(scanStart, this.end)
      .indexOf(delimiter);
    if (relativeIndex < 0) {
      this.searchStart = this.end;
      return undefined;
    }

    const absoluteIndex = scanStart + relativeIndex;
    const item = this.buffer.slice(this.start, absoluteIndex);
    this.start = absoluteIndex + 1;
    this.searchStart = this.start;
    this.compactIfNeeded();
    return item;
  }

  private ensureCapacity(additional: number): void {
    const currentLength = this.end - this.start;
    const requiredLength = currentLength + additional;

    if (this.buffer.length === 0) {
      this.buffer = new Uint8Array(Math.max(64, requiredLength));
      return;
    }

    if (requiredLength <= this.buffer.length) {
      if (this.end + additional <= this.buffer.length) {
        return;
      }

      const previousStart = this.start;
      this.buffer.copyWithin(0, this.start, this.end);
      this.start = 0;
      this.end = currentLength;
      this.searchStart = Math.max(0, this.searchStart - previousStart);
      return;
    }

    const next = new Uint8Array(
      Math.max(this.buffer.length * 2, requiredLength),
    );
    next.set(this.buffer.subarray(this.start, this.end), 0);
    this.searchStart = Math.max(0, this.searchStart - this.start);
    this.buffer = next;
    this.start = 0;
    this.end = currentLength;
  }

  private compactIfNeeded(): void {
    const currentLength = this.end - this.start;

    if (currentLength === 0) {
      this.start = 0;
      this.end = 0;
      this.searchStart = 0;
      return;
    }

    if (this.start < this.buffer.length / 2) {
      return;
    }

    const previousStart = this.start;
    this.buffer.copyWithin(0, this.start, this.end);
    this.start = 0;
    this.end = currentLength;
    this.searchStart = Math.max(0, this.searchStart - previousStart);
  }
}

async function consumeDelimitedText(
  stream: BinaryReadableStream,
  delimiter: string,
  onItem: (line: string) => boolean | undefined,
  options?: {
    flushTrailing?: boolean;
    normalizeItem?: (item: string) => string;
  },
): Promise<void> {
  const readable = toWebReadableStream(stream);
  if (!readable) {
    return;
  }

  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flushTrailing = options?.flushTrailing !== false;
  const normalizeItem = options?.normalizeItem ?? ((item: string) => item);

  while (true) {
    const { done, value } = await reader.read();
    buffer += decodeChunk(decoder, value);

    let index = buffer.indexOf(delimiter);
    while (index >= 0) {
      const item = normalizeItem(buffer.slice(0, index));
      buffer = buffer.slice(index + delimiter.length);

      if (onItem(item) === false) {
        await reader.cancel();
        return;
      }

      index = buffer.indexOf(delimiter);
    }

    if (done) {
      break;
    }
  }

  buffer += decodeChunk(decoder);
  if (flushTrailing && buffer.length > 0) {
    onItem(normalizeItem(buffer));
  }
}

export function consumeTextLines(
  stream: BinaryReadableStream,
  onLine: (line: string) => boolean | undefined,
): Promise<void> {
  return consumeDelimitedText(stream, '\n', onLine, {
    normalizeItem: (line) => line.replace(/\r$/, ''),
  });
}

export function consumeNullItems(
  stream: BinaryReadableStream,
  onItem: (item: string) => boolean | undefined,
): Promise<void> {
  return consumeDelimitedText(stream, '\0', onItem, {
    flushTrailing: false,
  });
}

export async function consumeNullItemsBytes(
  stream: BinaryReadableStream,
  onItem: (item: Uint8Array) => boolean | undefined,
): Promise<void> {
  const readable = toWebReadableStream(stream);
  if (!readable) {
    return;
  }

  const reader = readable.getReader();
  const buffer = new GrowableByteBuffer();

  while (true) {
    const { done, value } = await reader.read();
    buffer.append(value);

    let item = buffer.takeUntil(0);
    while (item !== undefined) {
      if (onItem(item) === false) {
        await reader.cancel();
        return;
      }

      item = buffer.takeUntil(0);
    }

    if (done) {
      return;
    }
  }
}

export async function consumeNullCountPairs(
  stream: BinaryReadableStream,
  onPair: (filePath: string, countText: string) => boolean | undefined,
): Promise<void> {
  const readable = toWebReadableStream(stream);
  if (!readable) {
    return;
  }

  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentPath: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decodeChunk(decoder, value);

    while (true) {
      if (currentPath === undefined) {
        const nullIndex = buffer.indexOf('\0');
        if (nullIndex < 0) {
          break;
        }

        currentPath = buffer.slice(0, nullIndex);
        buffer = buffer.slice(nullIndex + 1);
        continue;
      }

      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }

      const countText = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      const path = currentPath;
      currentPath = undefined;

      if (onPair(path, countText) === false) {
        await reader.cancel();
        return;
      }
    }

    if (done) {
      break;
    }
  }

  buffer += decodeChunk(decoder);
}

export async function consumeNullCountPairsBytes(
  stream: BinaryReadableStream,
  onPair: (filePath: Uint8Array, countText: string) => boolean | undefined,
): Promise<void> {
  const readable = toWebReadableStream(stream);
  if (!readable) {
    return;
  }

  const reader = readable.getReader();
  const decoder = new TextDecoder();
  const buffer = new GrowableByteBuffer();
  let currentPath: Uint8Array | undefined;

  while (true) {
    const { done, value } = await reader.read();
    buffer.append(value);

    while (true) {
      if (currentPath === undefined) {
        const pathBytes = buffer.takeUntil(0);
        if (pathBytes === undefined) {
          break;
        }

        currentPath = pathBytes;
        continue;
      }

      const countBytes = buffer.takeUntil(0x0a);
      if (countBytes === undefined) {
        break;
      }

      const pathBytes = currentPath;
      currentPath = undefined;
      const countText = decoder.decode(countBytes).replace(/\r$/, '');

      if (onPair(pathBytes, countText) === false) {
        await reader.cancel();
        return;
      }
    }

    if (done) {
      return;
    }
  }
}

export async function consumeRgJsonStream(
  stream: BinaryReadableStream,
  onEvent: (event: RgJsonEvent) => boolean | undefined,
): Promise<void> {
  const readable = toWebReadableStream(stream);
  if (!readable) {
    return;
  }

  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decodeChunk(decoder, value);

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);

      if (rawLine.length > 0) {
        let parsed: RgJsonEvent;
        try {
          parsed = JSON.parse(rawLine) as RgJsonEvent;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `${RG_BINARY} returned invalid JSON: ${message}. Line: ${rawLine.slice(0, 200)}`,
          );
        }

        if (onEvent(parsed) === false) {
          await reader.cancel();
          return;
        }
      }

      newlineIndex = buffer.indexOf('\n');
    }

    if (done) {
      break;
    }
  }

  buffer += decodeChunk(decoder);
  const trailing = buffer.replace(/\r$/, '');
  if (trailing.length === 0) {
    return;
  }

  try {
    if (onEvent(JSON.parse(trailing) as RgJsonEvent) === false) {
      await reader.cancel();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${RG_BINARY} returned invalid trailing JSON: ${message}. Line: ${trailing.slice(0, 200)}`,
    );
  }
}

export async function readTextStream(
  stream: BinaryReadableStream,
  maxChars = MAX_STDERR_CHARS,
): Promise<string> {
  const readable = toWebReadableStream(stream);
  if (!readable) {
    return '';
  }

  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    text += decodeChunk(decoder, value);

    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n[stderr truncated]`;
      await reader.cancel();
      break;
    }

    if (done) {
      break;
    }
  }

  return text;
}
