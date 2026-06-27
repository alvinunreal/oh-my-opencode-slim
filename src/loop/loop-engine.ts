import { unlinkSync } from 'node:fs';
import type {
  BackgroundJobBoard,
  BackgroundJobRecord,
} from '../utils/background-job-board';
import type {
  LoopDefinition,
  LoopSession,
  VerificationResult,
} from './loop-session';
import { createLoopSession, writeHistoryFile } from './loop-session';

export type DispatchCallback = (
  agent: string,
  prompt: string,
  contextFiles: string[],
) => string;

export interface LoopEngineCallbacks {
  onLoopComplete?: (loopID: string, success: boolean) => void;
  onEscalated?: (loopID: string, reason: string) => void;
  onManualReview?: (loopID: string, reason: string) => void;
  onArtifactWrite?: (loopID: string, artifactPath: string) => void;
}

export class LoopEngine {
  private sessions = new Map<string, LoopSession>();

  constructor(
    private readonly jobBoard: BackgroundJobBoard,
    private readonly callbacks: LoopEngineCallbacks,
    private readonly dispatch: DispatchCallback,
  ) {
    this.jobBoard.addTerminalStateListener(this.handleTerminalJob.bind(this));
  }

  startLoop(definition: LoopDefinition): string {
    if (
      (definition.executeAgent as string) === (definition.verifyAgent as string)
    ) {
      throw new Error('executeAgent and verifyAgent must differ');
    }

    const loopID = `loop-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const session = createLoopSession(definition, loopID);
    this.sessions.set(loopID, session);
    writeHistoryFile(session);
    this.dispatchPhase(session);
    return loopID;
  }

  resolveManualReview(loopID: string, passed: boolean, reason?: string): void {
    const session = this.sessions.get(loopID);
    if (!session || session.currentPhase !== 'verifying') return;
    session.manualReviewPending = false;
    const verification: VerificationResult = {
      passed,
      reason:
        reason ?? (passed ? 'Manual review passed' : 'Manual review failed'),
    };
    session.history.push({
      attemptNumber: session.attempts,
      executionResult: 'manual review',
      verificationResult: verification,
    });
    writeHistoryFile(session);

    if (passed) {
      this.finishSession(session, true);
      return;
    }

    if (session.attempts >= session.definition.maxAttempts) {
      this.escalate(session, 'Manual review failed, max attempts reached');
      return;
    }

    session.attempts += 1;
    session.currentPhase = 'executing';
    this.dispatchPhase(session);
  }

  private dispatchPhase(session: LoopSession): void {
    if (session.manualReviewPending) return;

    if (session.currentPhase === 'executing') {
      const prompt = `Loop ${session.loopID} attempt ${session.attempts}`;
      const taskID = this.dispatch(
        session.definition.executeAgent,
        prompt,
        session.definition.contextFiles ?? [],
      );
      session.activeJobID = taskID;
      this.jobBoard.registerLaunch({
        taskID,
        parentSessionID: session.loopID,
        agent: session.definition.executeAgent,
        description: prompt,
      });
      return;
    }

    if (session.currentPhase === 'verifying') {
      if (session.definition.success.type === 'manual') {
        session.manualReviewPending = true;
        this.callbacks.onManualReview?.(
          session.loopID,
          session.definition.successCriteria,
        );
        return;
      }

      const prompt = `Loop ${session.loopID} verification attempt ${session.attempts}`;
      const taskID = this.dispatch(
        session.definition.verifyAgent,
        prompt,
        session.definition.contextFiles ?? [],
      );
      session.activeJobID = taskID;
      this.jobBoard.registerLaunch({
        taskID,
        parentSessionID: session.loopID,
        agent: session.definition.verifyAgent,
        description: prompt,
      });
    }
  }

  private handleTerminalJob(taskID: string): void {
    const record = this.jobBoard.get(taskID);
    if (!record) return;
    const session = this.sessions.get(record.parentSessionID);
    if (!session) return;
    session.activeJobID = undefined;

    if (record.state === 'cancelled') {
      this.finishSession(session, false);
      return;
    }

    if (record.state === 'error') {
      if (this.jobBoard.hasConvergenceSignals(taskID)) {
        this.escalate(session, 'Convergence signals exceeded');
        return;
      }
      this.failSession(session, record);
      return;
    }

    if (session.currentPhase === 'executing') {
      session.currentPhase = 'verifying';
      this.dispatchPhase(session);
      return;
    }

    if (session.currentPhase === 'verifying') {
      this.evaluateVerification(session, record);
    }
  }

  private evaluateVerification(
    session: LoopSession,
    record: BackgroundJobRecord,
  ): void {
    const result = this.parseVerification(record.resultSummary);
    if (result) {
      session.history.push({
        attemptNumber: session.attempts,
        executionResult: record.description,
        verificationResult: result,
      });
      writeHistoryFile(session);
      if (result.passed) {
        this.finishSession(session, true);
        return;
      }

      if (session.attempts >= session.definition.maxAttempts) {
        this.escalate(session, result.reason);
        return;
      }
      session.attempts += 1;
      session.currentPhase = 'executing';
      writeHistoryFile(session);
      this.dispatchPhase(session);
      return;
    }

    session.currentPhase = 'executing';
    writeHistoryFile(session);
    this.dispatchPhase(session);
  }

  private parseVerification(raw?: string): VerificationResult | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.passed !== 'boolean') return null;
      if (typeof parsed.reason !== 'string') return null;
      return {
        passed: parsed.passed,
        reason: parsed.reason,
        suggestedFix: parsed.suggestedFix,
      };
    } catch {
      return null;
    }
  }

  private escalate(session: LoopSession, reason: string): void {
    session.currentPhase = 'escalated';
    this.cleanupSession(session);
    this.callbacks.onEscalated?.(session.loopID, reason);
  }

  private failSession(session: LoopSession, record: BackgroundJobRecord): void {
    this.escalate(session, record.lastStatusError ?? 'Execution failed');
  }

  private finishSession(session: LoopSession, success: boolean): void {
    session.currentPhase = success ? 'done' : 'escalated';
    this.cleanupSession(session);
    this.callbacks.onLoopComplete?.(session.loopID, success);
  }

  private cleanupSession(session: LoopSession): void {
    try {
      unlinkSync(session.historyFilePath);
    } catch {
      // best effort
    }
    this.sessions.delete(session.loopID);
  }
}
