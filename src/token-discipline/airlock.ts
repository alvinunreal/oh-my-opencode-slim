import { TOOL_CAPS } from './config';
import type { ToolCapResult } from './types';

const NOISE_PATTERNS = [
  /\[=*=>*\s*\]/g,
  /npm WARN deprecated.*/g,
  /npm notice.*/g,
  /yarn warning.*/g,
  /pnpm warn.*/g,
];

let commandCounter = 0;

function generateCommandId(): string {
  commandCounter++;
  return `cmd_${commandCounter.toString().padStart(3, '0')}`;
}

export function stripNoise(output: string): string {
  let cleaned = output;
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

export function capLines(output: string, maxLines: number): string {
  const lines = output.split('\n');
  if (lines.length <= maxLines) {
    return output;
  }
  return (
    lines.slice(0, maxLines).join('\n') +
    `\n\n... [truncated ${lines.length - maxLines} lines]`
  );
}

export function capBytes(output: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(output);

  if (bytes.length <= maxBytes) {
    return output;
  }

  const decoder = new TextDecoder();
  const truncated = bytes.slice(0, maxBytes);
  const result = decoder.decode(truncated);

  return `${result}\n\n... [truncated ${bytes.length - maxBytes} bytes]`;
}

export function capToolOutput(
  toolName: string,
  rawOutput: string,
  _threadId: string,
): ToolCapResult {
  const cmdId = generateCommandId();
  const originalSize = rawOutput.length;

  const cleaned = stripNoise(rawOutput);
  let capped = cleaned;

  const caps = TOOL_CAPS[toolName as keyof typeof TOOL_CAPS];
  if (caps) {
    if ('maxLines' in caps) {
      capped = capLines(cleaned, caps.maxLines);
    } else if ('maxBytes' in caps) {
      capped = capBytes(cleaned, caps.maxBytes);
    } else if ('maxResults' in caps) {
      const lines = cleaned.split('\n');
      if (lines.length > caps.maxResults) {
        capped = lines.slice(0, caps.maxResults).join('\n');
        capped += `\n\n... [truncated ${lines.length - caps.maxResults} results]`;
      }
    }
  }

  return {
    capped: capped !== rawOutput,
    output: capped,
    pointer: `cmd:${cmdId}`,
    originalSize,
    cappedSize: capped.length,
  };
}
