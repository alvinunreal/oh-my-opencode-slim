import { TOOL_CAPS } from './config';

const NOISE_PATTERNS = [
  /\[=*=>*\s*\]/g,
  /npm WARN deprecated.*/g,
  /npm notice.*/g,
  /yarn warning.*/g,
  /pnpm warn.*/g,
];

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

/**
 * Canonical tool output capping pipeline:
 * 1. Strip package-manager noise (npm/yarn/pnpm warnings, progress bars)
 * 2. Cap to per-tool limit (lines or bytes)
 *
 * Returns the cleaned, capped string ready to inject into agent context.
 */
export function capToolOutput(toolName: string, rawOutput: string): string {
  const cleaned = stripNoise(rawOutput);

  const caps = TOOL_CAPS[toolName as keyof typeof TOOL_CAPS];
  if (!caps) return cleaned;

  if ('maxLines' in caps) {
    return capLines(cleaned, caps.maxLines);
  }
  if ('maxBytes' in caps) {
    return capBytes(cleaned, caps.maxBytes);
  }
  if ('maxResults' in caps) {
    const lines = cleaned.split('\n');
    if (lines.length > caps.maxResults) {
      return (
        lines.slice(0, caps.maxResults).join('\n') +
        `\n\n... [truncated ${lines.length - caps.maxResults} results]`
      );
    }
  }

  return cleaned;
}
