import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type LoopPhase =
  | 'executing'
  | 'verifying'
  | 'done'
  | 'escalated'
  | 'cancelled';

export type ExecuteAgent = 'fixer' | 'designer' | 'explorer' | 'librarian';
export type VerifyAgent = 'oracle' | 'observer' | 'test';

export type SuccessCriterion =
  | { type: 'test'; command: string }
  | { type: 'build'; command: string }
  | { type: 'lint'; command: string }
  | { type: 'fileExists'; path: string }
  | { type: 'command'; command: string; expectExitCode?: number }
  | { type: 'oracle' }
  | { type: 'observer' }
  | { type: 'manual' };

export interface LoopDefinition {
  goal: string;
  successCriteria: string;
  success: SuccessCriterion;
  maxAttempts: number;
  executeAgent: ExecuteAgent;
  verifyAgent: VerifyAgent;
  contextFiles?: string[];
}

export type VerificationResult =
  | { passed: true; reason: string }
  | { passed: false; reason: string; suggestedFix?: string };

export interface AttemptRecord {
  attemptNumber: number;
  executionResult: string;
  verificationResult: VerificationResult;
  artifactPaths?: string[];
}

export interface LoopSession {
  loopID: string;
  definition: LoopDefinition;
  currentPhase: LoopPhase;
  attempts: number;
  activeJobID?: string;
  history: AttemptRecord[];
  historyFilePath: string;
  manualReviewPending: boolean;
}

export function createLoopSession(
  definition: LoopDefinition,
  loopID: string,
): LoopSession {
  const historyFilePath = join(process.cwd(), `.loop-history-${loopID}.md`);
  return {
    loopID,
    definition,
    currentPhase: 'executing',
    attempts: 1,
    history: [],
    historyFilePath,
    manualReviewPending: false,
  };
}

export function compactHistory(history: AttemptRecord[]): string {
  if (history.length === 0) return '';
  const lines = history.map((attempt, index) => {
    const outcome = attempt.verificationResult.passed
      ? 'PASS'
      : `FAIL: ${attempt.verificationResult.reason}`;
    const artifacts = attempt.artifactPaths?.length
      ? ` → artifacts: ${attempt.artifactPaths.join(', ')}`
      : '';
    return `[Attempt ${index + 1}] ${outcome}${artifacts}`;
  });
  return `# Loop Attempt History\n\n${lines.join('\n')}\n`;
}

export function writeHistoryFile(session: LoopSession): void {
  const content = compactHistory(session.history);
  writeFileSync(session.historyFilePath, content, { encoding: 'utf-8' });
}
