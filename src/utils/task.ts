/**
 * Parse Task tool output to recover a session/task ID for resumption.
 */

export function parseTaskIdFromTaskOutput(output: string): string | undefined {
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    const match = /^task_id:\s*([^\s()]+)(?:\s*\(.*)?$/.exec(trimmed);

    if (!match) {
      continue;
    }

    return match[1];
  }

  return undefined;
}

const MAX_CONTEXT_SUMMARY_LENGTH = 280;

const FINAL_CONTEXT_SUMMARY_PATTERN =
  /(?:^|\n)\s*<context_summary>((?:(?!<context_summary>)[\s\S])*?)<\/context_summary>\s*$/i;

const FINAL_MALFORMED_CONTEXT_SUMMARY_PATTERN =
  /(?:^|\n)\s*<context_summary>((?:(?!<context_summary>|<\/context_summary>)[\s\S])*?)\s*$/i;

function normalizeContextSummary(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;

  return normalized.slice(0, MAX_CONTEXT_SUMMARY_LENGTH);
}

/**
 * Parse the final standalone context summary metadata block from Task output.
 */
export function parseContextSummaryFromTaskOutput(
  output: string,
): string | undefined {
  const match = FINAL_CONTEXT_SUMMARY_PATTERN.exec(output);
  if (match) return normalizeContextSummary(match[1]);

  const fallbackMatch = FINAL_MALFORMED_CONTEXT_SUMMARY_PATTERN.exec(output);

  return fallbackMatch ? normalizeContextSummary(fallbackMatch[1]) : undefined;
}

/**
 * Remove the final standalone context summary metadata block before the parent
 * model sees output.
 */
export function stripContextSummaryFromTaskOutput(output: string): string {
  return output
    .replace(FINAL_CONTEXT_SUMMARY_PATTERN, '')
    .replace(FINAL_MALFORMED_CONTEXT_SUMMARY_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
