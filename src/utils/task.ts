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
