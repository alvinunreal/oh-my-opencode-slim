export type CmuxCloseReason = 'idle' | 'deleted' | 'cleanup';
export interface CmuxCloseIntent {
  reason: CmuxCloseReason;
  expectedActivityVersion: number;
  attempts: number;
  deadline: number;
  phase: 'pending' | 'cooldown';
  nextAttemptAt: number;
  cooldowns: number;
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
        cooldowns: 0,
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
      const cooldowns = intent.cooldowns + 1;
      const delay =
        cooldowns === 1 ? 30_000 : cooldowns === 2 ? 60_000 : Infinity;
      return {
        ...intent,
        attempts,
        phase: 'cooldown',
        nextAttemptAt: now + delay,
        cooldowns,
      };
    }
    return { ...intent, attempts, nextAttemptAt: now + 1_000 };
  }
  resume(intent: CmuxCloseIntent, now: number): CmuxCloseIntent {
    if (intent.phase !== 'cooldown' || now < intent.nextAttemptAt)
      return intent;
    return {
      ...intent,
      attempts: 0,
      deadline: now + this.budgetMs,
      phase: 'pending',
      nextAttemptAt: now,
    };
  }
  complete(): undefined {
    return undefined;
  }
}
