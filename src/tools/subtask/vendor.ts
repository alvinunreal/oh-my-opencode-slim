/**
 * Vendored read-format helpers from OpenCode.
 *
 * Source: https://github.com/sst/opencode
 * File: packages/opencode/src/tool/read.ts
 *
 * These functions and constants are copied to ensure synthetic file parts
 * match OpenCode's Read tool output exactly.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Constants from OpenCode's ReadTool
 */
export const DEFAULT_READ_LIMIT = 2000;
export const MAX_LINE_LENGTH = 2000;
export const MAX_BYTES = 50 * 1024;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`;
const SAMPLE_BYTES = 4096;

/**
 * Binary file extensions (from OpenCode's ReadTool)
 */
const BINARY_EXTENSIONS = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.exe',
  '.dll',
  '.so',
  '.class',
  '.jar',
  '.war',
  '.7z',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.bin',
  '.dat',
  '.obj',
  '.o',
  '.a',
  '.lib',
  '.wasm',
  '.pyc',
  '.pyo',
]);

/**
 * Check if a file is binary (copied from OpenCode's ReadTool)
 */
export async function isBinaryFile(filepath: string): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase();

  // Check extension first
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  try {
    const file = await fs.open(filepath, 'r');
    try {
      const buffer = Buffer.alloc(SAMPLE_BYTES);
      const result = await file.read(buffer, 0, SAMPLE_BYTES, 0);
      if (result.bytesRead === 0) return false;

      const bytes = buffer.subarray(0, result.bytesRead);

      let nonPrintableCount = 0;
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        if (byte === undefined) continue;
        if (byte === 0) return true;
        if (byte < 9 || (byte > 13 && byte < 32)) {
          nonPrintableCount++;
        }
      }

      // If >30% non-printable characters, consider it binary
      return nonPrintableCount / bytes.length > 0.3;
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

/**
 * Format file content matching OpenCode's Read tool output format.
 *
 * @param _filepath - Absolute path to the file (used as `<path>` in the output)
 * @param content - File content as string
 * @returns Formatted output with line numbers in <file> tags
 */
export function formatFileContent(_filepath: string, content: string): string {
  const cappedContent = Buffer.byteLength(content, 'utf8') > MAX_BYTES;
  const contentToFormat = cappedContent ? content.slice(0, MAX_BYTES) : content;
  const lines = contentToFormat.split('\n');
  const limit = DEFAULT_READ_LIMIT;
  const offset = 0;

  const raw = lines.slice(offset, offset + limit).map((line) => {
    return line.length > MAX_LINE_LENGTH
      ? `${line.substring(0, MAX_LINE_LENGTH)}${MAX_LINE_SUFFIX}`
      : line;
  });

  const formatted = raw.map((line, index) => {
    return `${index + offset + 1}: ${line}`;
  });

  let output = [
    `<path>${_filepath}</path>`,
    '<type>file</type>',
    '<content>\n',
  ].join('\n');
  output += formatted.join('\n');

  const totalLines = lines.length;
  const lastReadLine = offset + formatted.length;
  const hasMoreLines = totalLines > lastReadLine;

  if (cappedContent) {
    output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines 1-${lastReadLine}. Use offset=${lastReadLine + 1} to continue.)`;
  } else if (hasMoreLines) {
    output += `\n\n(Showing lines 1-${lastReadLine} of ${totalLines}. Use offset=${lastReadLine + 1} to continue.)`;
  } else {
    output += `\n\n(End of file - total ${totalLines} lines)`;
  }
  output += '\n</content>';

  return output;
}
