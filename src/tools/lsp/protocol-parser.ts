/**
 * Utility for parsing LSP (Language Server Protocol) messages from a raw byte buffer.
 * LSP uses a header-based protocol similar to HTTP.
 */

const decoder = new TextDecoder();
const CONTENT_LENGTH = [67, 111, 110, 116, 101, 110, 116, 45, 76, 101, 110, 103, 116, 104, 58]; // "Content-Length:"
const CRLF_CRLF = [13, 10, 13, 10]; // "\r\n\r\n"
const LF_LF = [10, 10]; // "\n\n"

/**
 * Finds the first occurrence of a byte sequence in a Uint8Array.
 * 
 * @param haystack The buffer to search in.
 * @param needle The byte sequence to find.
 * @returns The index of the first occurrence, or -1 if not found.
 */
function findSequence(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Parses LSP messages from a raw byte buffer.
 * 
 * @param buffer The raw bytes received from the LSP server.
 * @returns An object containing the parsed messages and any remaining bytes.
 */
export function parseMessages(buffer: Uint8Array): { messages: any[]; remainingBuffer: Uint8Array } {
  const messages: any[] = [];
  let currentBuffer = buffer;

  while (true) {
    const headerStart = findSequence(currentBuffer, CONTENT_LENGTH);
    if (headerStart === -1) break;
    
    // Discard any data before Content-Length
    if (headerStart > 0) {
      currentBuffer = currentBuffer.slice(headerStart);
    }

    let headerEnd = findSequence(currentBuffer, CRLF_CRLF);
    let sepLen = 4;
    if (headerEnd === -1) {
      headerEnd = findSequence(currentBuffer, LF_LF);
      sepLen = 2;
    }
    
    if (headerEnd === -1) break;

    const header = decoder.decode(currentBuffer.slice(0, headerEnd));
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // If we found something that looks like a header but doesn't have Content-Length,
      // skip past it to avoid infinite loops.
      currentBuffer = currentBuffer.slice(headerEnd + sepLen);
      continue;
    }

    const len = parseInt(match[1], 10);
    const start = headerEnd + sepLen;
    const end = start + len;

    if (currentBuffer.length < end) break;

    const content = decoder.decode(currentBuffer.slice(start, end));
    currentBuffer = currentBuffer.slice(end);

    try {
      const msg = JSON.parse(content);
      messages.push(msg);
    } catch (err) {
      // We log but don't throw to avoid crashing the whole client on one malformed message
      console.error(`[protocol-parser] Failed to parse LSP message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    messages,
    remainingBuffer: currentBuffer,
  };
}
