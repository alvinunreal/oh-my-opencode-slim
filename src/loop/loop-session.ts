import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HISTORY_DIR = join(process.cwd(), '.opencode', 'loop-history');

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

export function loopDirname(loopID: string, goal: string): string {
  const parts = loopID.split('-');
  const shortID = parts[parts.length - 1] ?? loopID;
  return `${slugify(goal)}-${shortID}`;
}

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
  parentSessionID?: string;
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
  historyDir: string;
  manualReviewPending: boolean;
}

export function createLoopSession(
  definition: LoopDefinition,
  loopID: string,
): LoopSession {
  const dir = join(HISTORY_DIR, loopDirname(loopID, definition.goal));
  return {
    loopID,
    definition,
    currentPhase: 'executing',
    attempts: 1,
    history: [],
    manualReviewPending: false,
    historyDir: dir,
  };
}

export function compactAttempt(attempt: AttemptRecord): string {
  const outcome = attempt.verificationResult.passed
    ? 'PASS'
    : `FAIL: ${attempt.verificationResult.reason}`;
  const artifacts = attempt.artifactPaths?.length
    ? `\n  → artifacts: ${attempt.artifactPaths.join(', ')}`
    : '';
  return `## Attempt ${attempt.attemptNumber}

**Outcome:** ${outcome}${artifacts}

### Execution Result
\`\`\`
${attempt.executionResult}
\`\`\`
`;
}

export function writeHistoryFile(session: LoopSession): void {
  const lastAttempt = session.history.at(-1);
  if (!lastAttempt) return;
  const attemptFile = join(
    session.historyDir,
    `history-${String(lastAttempt.attemptNumber).padStart(3, '0')}.md`,
  );
  mkdirSync(session.historyDir, { recursive: true });
  const content = compactAttempt(lastAttempt);
  writeFileSync(attemptFile, content, { encoding: 'utf-8' });
}
