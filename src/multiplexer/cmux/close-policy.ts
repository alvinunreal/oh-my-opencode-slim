export type CmuxCloseReason = 'idle' | 'deleted' | 'cleanup';
export interface CmuxCloseIntent {
  reason: CmuxCloseReason;
  expectedActivityVersion: number;
  attempts: number;
  deadline: number;
  phase: 'pending' | 'cooldown';
  nextAttemptAt: number;
}

export class CmuxClosePolicy {
  constructor(
    private readonly budgetMs = 30_000,
    private readonly maxAttempts = 4,
  ) {}
  request(
    reason: CmuxCloseReason,
    version: number,
    now: number,
    current?: CmuxCloseIntent,
  ): CmuxCloseIntent {
    if (!current || (reason === 'deleted' && current.reason === 'idle')) {
      return {
        reason,
        expectedActivityVersion: version,
        attempts: 0,
        deadline: now + this.budgetMs,
        phase: 'pending',
        nextAttemptAt: now,
      };
    }
    return current;
  }
  activity(intent?: CmuxCloseIntent): CmuxCloseIntent | undefined {
    return intent?.reason === 'idle' ? undefined : intent;
  }
  failed(intent: CmuxCloseIntent, now: number): CmuxCloseIntent {
    const attempts = intent.attempts + 1;
    if (attempts >= this.maxAttempts || now >= intent.deadline) {
      const delay = intent.phase === 'cooldown' ? 60_000 : 30_000;
      return {
        ...intent,
        attempts,
        phase: 'cooldown',
        nextAttemptAt: now + delay,
      };
    }
    return { ...intent, attempts, nextAttemptAt: now + 1_000 };
  }
  complete(): undefined {
    return undefined;
  }
}
