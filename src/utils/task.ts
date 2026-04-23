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

const MAX_CONTEXT_SUMMARY_LENGTH = 600;

function normalizeContextSummary(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;

  return normalized.slice(0, MAX_CONTEXT_SUMMARY_LENGTH);
}

/**
 * Parse the last context summary metadata block from Task tool output.
 */
export function parseContextSummaryFromTaskOutput(
  output: string,
): string | undefined {
  const matches = [
    ...output.matchAll(/<context_summary>([\s\S]*?)<\/context_summary>/gi),
  ];
  const lastMatch = matches.at(-1);
  if (!lastMatch) {
    const fallbackMatch =
      /<context_summary>([\s\S]*?)(?:<\/task_result>|$)/i.exec(output);

    return fallbackMatch
      ? normalizeContextSummary(fallbackMatch[1])
      : undefined;
  }

  return normalizeContextSummary(lastMatch[1]);
}

/**
 * Remove context summary metadata blocks before the parent model sees output.
 */
export function stripContextSummaryFromTaskOutput(output: string): string {
  return output
    .replace(/\n?\s*<context_summary>[\s\S]*?<\/context_summary>\s*/gi, '\n')
    .replace(/\n?\s*<context_summary>[\s\S]*?(?:<\/task_result>|$)/i, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
