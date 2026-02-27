export interface DelegateTaskErrorPattern {
  pattern: string;
  errorType: string;
  fixHint: string;
}

export const DELEGATE_TASK_ERROR_PATTERNS: DelegateTaskErrorPattern[] = [
  {
    pattern: 'run_in_background',
    errorType: 'missing_run_in_background',
    fixHint:
      'Add run_in_background=false (delegation) or run_in_background=true (parallel exploration).',
  },
  {
    pattern: 'load_skills',
    errorType: 'missing_load_skills',
    fixHint:
      'Add load_skills=[] (empty array when no skill is needed).',
  },
  {
    pattern: 'category OR subagent_type',
    errorType: 'mutual_exclusion',
    fixHint:
      'Provide only one: category (e.g., "unspecified-low") OR subagent_type (e.g., "explorer").',
  },
  {
    pattern: 'Must provide either category or subagent_type',
    errorType: 'missing_category_or_agent',
    fixHint:
      'Add either category="unspecified-low" or subagent_type="explorer".',
  },
  {
    pattern: 'Unknown category',
    errorType: 'unknown_category',
    fixHint:
      'Use a valid category listed in the error output.',
  },
  {
    pattern: 'Unknown agent',
    errorType: 'unknown_agent',
    fixHint: 'Use a valid agent name from the available list.',
  },
  {
    pattern: 'Skills not found',
    errorType: 'unknown_skills',
    fixHint: 'Use valid skill names listed in the error output.',
  },
  {
    pattern: 'is not allowed. Allowed agents:',
    errorType: 'background_agent_not_allowed',
    fixHint:
      'Use one of the allowed agents shown in the error or delegate from a parent agent that can call this subagent.',
  },
];

export interface DetectedError {
  errorType: string;
  originalOutput: string;
}

export function detectDelegateTaskError(output: string): DetectedError | null {
  if (!output || typeof output !== 'string') return null;

  const hasErrorSignal =
    output.includes('[ERROR]') ||
    output.includes('Invalid arguments') ||
    output.includes('is not allowed. Allowed agents:');

  if (!hasErrorSignal) return null;

  for (const pattern of DELEGATE_TASK_ERROR_PATTERNS) {
    if (output.includes(pattern.pattern)) {
      return {
        errorType: pattern.errorType,
        originalOutput: output,
      };
    }
  }

  return null;
}
