function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Fail when an SDK reply reports an error rather than throwing. */
export function assertHostReplyResult(
  result: unknown,
  operation: string,
): void {
  if (typeof result !== 'object' || result === null) return;
  const record = result as {
    error?: unknown;
    response?: { ok?: unknown; status?: unknown };
  };
  if (record.error !== undefined && record.error !== null) {
    throw new Error(`${operation} failed: ${errorText(record.error)}`);
  }
  const response = record.response;
  if (response && typeof response.ok === 'boolean' && !response.ok) {
    const status =
      typeof response.status === 'number'
        ? ` with HTTP ${response.status}`
        : '';
    throw new Error(`${operation} failed${status}`);
  }
}

/** Fold v1 question selections into a v2 form reply using the host field keys. */
export function toFormAnswer(
  answers: string[][],
  questions:
    | Array<{
        key?: string;
        multiple?: boolean;
        header?: string;
        question?: string;
      }>
    | undefined,
): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {};
  answers.forEach((selections, index) => {
    const question = questions?.[index];
    const key =
      question?.key ||
      question?.header?.trim() ||
      question?.question?.trim() ||
      `question_${index}`;
    answer[key] =
      question?.multiple || selections.length !== 1
        ? [...selections]
        : selections[0];
  });
  return answer;
}
