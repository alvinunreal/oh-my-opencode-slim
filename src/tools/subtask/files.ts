/**
 * File reference parsing and synthetic file parts for subtask sessions.
 *
 * Handles extraction of @file references from subtask prompts and
 * building synthetic text parts that match OpenCode's Read tool output
 * format.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TextPartInput } from '@opencode-ai/sdk';
import { formatFileContent, isBinaryFile } from './vendor';

/**
 * File reference regex matching OpenCode's internal pattern.
 * Matches @file references like @src/plugin.ts
 */
export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g;
const TRAILING_PATH_PUNCTUATION = /[!?:;]+$/;

export function cleanFileReference(ref: string): string {
  return ref.replace(/^@/, '').replace(TRAILING_PATH_PUNCTUATION, '');
}

/**
 * Parse @file references from text.
 *
 * @param text - Text to search for @file references
 * @returns Set of file paths referenced in the text
 */
export function parseFileReferences(text: string): Set<string> {
  const fileRefs = new Set<string>();

  for (const match of text.matchAll(FILE_REGEX)) {
    if (match[1]) {
      fileRefs.add(cleanFileReference(match[1]));
    }
  }

  return fileRefs;
}

/**
 * Build synthetic text parts matching OpenCode's Read tool output.
 *
 * Creates two synthetic text parts for each file:
 * 1. Header describing the Read tool call
 * 2. Formatted file content with line numbers
 *
 * @param directory - Project directory to resolve relative paths against
 * @param refs - Set of file path references to check
 * @returns Array of synthetic text parts (non-existent and binary files are
 *   skipped)
 */
export async function buildSyntheticFileParts(
  directory: string,
  refs: Set<string>,
): Promise<TextPartInput[]> {
  const parts: TextPartInput[] = [];
  const realDirectory = await fs.realpath(directory);

  for (const ref of refs) {
    const filepath = path.resolve(directory, ref);
    const relative = path.relative(directory, filepath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;

    try {
      const realFilepath = await fs.realpath(filepath);
      const realRelative = path.relative(realDirectory, realFilepath);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        continue;
      }

      // Check if file exists
      const stats = await fs.stat(realFilepath);
      if (!stats.isFile()) continue;

      // Skip binary files
      if (await isBinaryFile(realFilepath)) continue;

      // Read file content
      const content = await fs.readFile(realFilepath, 'utf-8');

      // Create header part (matching OpenCode's prompt.ts:820 format)
      parts.push({
        type: 'text',
        synthetic: true,
        text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: realFilepath })}`,
      });

      // Create content part (matching OpenCode's ReadTool format)
      parts.push({
        type: 'text',
        synthetic: true,
        text: formatFileContent(realFilepath, content),
      });
    } catch {
      // Skip silently if file can't be read
    }
  }

  return parts;
}
