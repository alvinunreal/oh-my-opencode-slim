/**
 * Detection logic for empty/interrupted task tool results.
 *
 * Distinguishes from parameter validation errors (handled by delegate-task-retry)
 * by checking for error signals that indicate a provider/server interruption
 * rather than a malformed task call.
 */

import { parseTaskIdFromTaskOutput } from '../../utils/task';

/** Patterns that suggest a provider error or interruption (not a parameter error). */
const PROVIDER_ERROR_PATTERNS = [
  /provider.*error/i,
  /server.*error/i,
  /connection.*error/i,
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  /timeout/i,
  /overloaded/i,
  /quota.?exceeded/i,
  /usage.?exceeded/i,
  /resource.?exhausted/i,
  /insufficient.?quota/i,
];

/**
 * Signals that indicate a parameter validation error — these are handled by
 * delegate-task-retry and should NOT trigger session-resume guidance.
 */
const PARAMETER_ERROR_SIGNALS = [
  'Invalid arguments',
  '[ERROR]',
  'is not allowed. Allowed agents:',
];

/**
 * Extract the task_id from a task tool output string.
 *
 * Reuses the canonical line-based parser from src/utils/task.ts introduced by
 * the session-manager work, then falls back to legacy XML-style parsing for
 * compatibility with older/synthetic test outputs.
 *
 * Supported formats:
 * 1. Line-based (canonical OpenCode format):
 *      task_id: ses_xxx (for resuming to continue this task if needed)
 * 2. XML-style (fallback only):
 *      <task_id>ses_xxx</task_id>
 */
export function parseTaskId(output: string): string | undefined {
  const taskId = parseTaskIdFromTaskOutput(output);
  if (taskId) return taskId;

  const xmlMatch = output.match(/<task_id>([^<]+)<\/task_id>/);
  return xmlMatch ? xmlMatch[1] : undefined;
}

/**
 * Detect whether a task tool output looks like an interrupted/empty result
 * that may contain recoverable partial state.
 *
 * Returns true when:
 * - Output is empty or whitespace-only
 * - Output contains a provider error signal
 *
 * Returns false when:
 * - Output looks like a parameter validation error (delegate-task-retry handles those)
 * - Output has substantial content (likely a successful result)
 */
export function detectInterruptedTask(output: string): boolean {
  if (typeof output !== 'string') return false;

  const trimmed = output.trim();

  // Empty output — the most common interrupted case
  if (trimmed.length === 0) return true;

  // Empty task_result XML tag
  if (/<task_result>\s*<\/task_result>/.test(trimmed)) return true;

  // Check if this is a parameter error — those belong to delegate-task-retry
  const isParameterError = PARAMETER_ERROR_SIGNALS.some((signal) =>
    output.includes(signal),
  );
  if (isParameterError) return false;

  // Check for provider error signals
  const hasProviderError = PROVIDER_ERROR_PATTERNS.some((p) => p.test(trimmed));
  if (hasProviderError) return true;

  // Default: not interrupted
  return false;
}
