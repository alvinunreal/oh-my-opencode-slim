import { createHash } from 'node:crypto';

const MAX_TERMINAL_RECORDS = 256;
const MAX_ADMISSION_RECORDS = 512;
const MAX_IDENTIFIER_LENGTH = 4096;

declare const resumeEvidenceTokenBrand: unique symbol;
declare const resumeEvidenceClaimBrand: unique symbol;

/** A broker-issued token. Its value is intentionally not inspectable by callers. */
export type SameProcessResumeEvidenceToken = Readonly<{
  readonly [resumeEvidenceTokenBrand]: never;
}>;

/** A single-use send claim derived from a broker-issued token. */
export type SameProcessResumeEvidenceClaim = Readonly<{
  readonly [resumeEvidenceClaimBrand]: never;
}>;

export interface SameProcessResumeAdmission {
  sessionID: string;
  messageID: string;
  createdAt?: number;
}

export interface SameProcessResumeTerminal {
  taskID: string;
  parentSessionID: string;
  generation: number;
  terminalRevision: number;
  state: 'completed' | 'error' | 'cancelled';
  resultSummary: string;
  completedAt?: number;
}

export interface SameProcessResumeAuthorization {
  taskID: string;
  parentSessionID: string;
  generation: number;
  terminalRevision: number;
  resultSummary: string;
  acknowledgedAt: number;
}

export interface SameProcessResumeEvidenceBroker {
  /** Observe a session turn; a conflicting turn fences that session's evidence. */
  observeAdmission(admission: SameProcessResumeAdmission): void;
  /** Record terminal evidence only for an admitted child session. */
  recordTerminal(terminal: SameProcessResumeTerminal): void;
  /** Authorize the exact currently acknowledged terminal publication. */
  authorize(
    authorization: SameProcessResumeAuthorization,
  ): SameProcessResumeEvidenceToken | undefined;
  /** Take the one concurrent send slot for an authorized token. */
  claim(
    token: SameProcessResumeEvidenceToken,
  ): SameProcessResumeEvidenceClaim | undefined;
  /** Consume a claim after the caller has accepted the send. */
  accept(claim: SameProcessResumeEvidenceClaim): boolean;
  /** Return a claim before sending so a controlled retry can take its place. */
  releaseBeforeSend(claim: SameProcessResumeEvidenceClaim): boolean;
  /** Invalidate every token and claim owned by this broker. */
  dispose(): void;
}

/** Alias for callers that prefer the shorter object type name. */
export type SameProcessResumeEvidence = SameProcessResumeEvidenceBroker;

/** The v2 setup broker, when the host passed one in. Callers must not
 * create a second broker for the same plugin setup. */
export function hostResumeEvidence(input: {
  experimental_v2?: {
    sameProcessResumeEvidence?: SameProcessResumeEvidence;
  };
}): SameProcessResumeEvidence | undefined {
  return input.experimental_v2?.sameProcessResumeEvidence;
}

interface AdmissionRecord {
  sessionID: string;
  messageID: string;
  createdAt?: number;
}

type TokenStatus = 'available' | 'claimed' | 'accepted' | 'invalidated';

interface TerminalRecord {
  taskID: string;
  parentSessionID: string;
  generation: number;
  terminalRevision: number;
  state: SameProcessResumeTerminal['state'];
  resultDigest: string;
  completedAt?: number;
  admission: AdmissionRecord;
  token?: TokenState;
}

interface TokenState {
  token: SameProcessResumeEvidenceToken;
  terminal: TerminalRecord;
  status: TokenStatus;
  claim?: SameProcessResumeEvidenceClaim;
}

interface ClaimState {
  token: TokenState;
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH
  );
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function resultDigest(resultSummary: string): string {
  return createHash('sha256').update(resultSummary, 'utf8').digest('hex');
}

function opaqueObject(): object {
  return Object.freeze(Object.create(null));
}

function sameAdmission(
  left: AdmissionRecord,
  right: SameProcessResumeAdmission,
): boolean {
  return (
    left.sessionID === right.sessionID && left.messageID === right.messageID
  );
}

function validAdmission(
  admission: SameProcessResumeAdmission,
): admission is SameProcessResumeAdmission {
  return (
    isObjectLike(admission) &&
    validIdentifier(admission.sessionID) &&
    validIdentifier(admission.messageID) &&
    (admission.createdAt === undefined || validTime(admission.createdAt))
  );
}

function validTerminal(
  terminal: SameProcessResumeTerminal,
): terminal is SameProcessResumeTerminal {
  return (
    isObjectLike(terminal) &&
    validIdentifier(terminal.taskID) &&
    validIdentifier(terminal.parentSessionID) &&
    validCounter(terminal.generation) &&
    validCounter(terminal.terminalRevision) &&
    (terminal.state === 'completed' ||
      terminal.state === 'error' ||
      terminal.state === 'cancelled') &&
    typeof terminal.resultSummary === 'string' &&
    (terminal.completedAt === undefined || validTime(terminal.completedAt))
  );
}

function validAuthorization(
  authorization: SameProcessResumeAuthorization,
): authorization is SameProcessResumeAuthorization {
  return (
    isObjectLike(authorization) &&
    validIdentifier(authorization.taskID) &&
    validIdentifier(authorization.parentSessionID) &&
    validCounter(authorization.generation) &&
    validCounter(authorization.terminalRevision) &&
    typeof authorization.resultSummary === 'string' &&
    validTime(authorization.acknowledgedAt)
  );
}

function invalidateToken(token: TokenState): void {
  token.status = 'invalidated';
  token.claim = undefined;
}

function invalidateTerminal(terminal: TerminalRecord): void {
  if (terminal.token) invalidateToken(terminal.token);
}

/**
 * Create a process-local broker for same-process resume evidence.
 *
 * There is deliberately no module-level state here. The returned closure owns
 * its bounded admission and terminal ledgers, so a disposed setup
 * cannot affect another setup and no evidence survives a process restart.
 */
export function createSameProcessResumeEvidence(): SameProcessResumeEvidence {
  let disposed = false;

  const admissionsBySession = new Map<string, AdmissionRecord>();
  const terminalsByTask = new Map<string, TerminalRecord>();
  /** No terminal was recorded before this admission changed. The next
   * terminal still belongs to the previous turn and must not attach. */
  const unmatchedTerminal = new Set<string>();
  /** A recorded terminal was invalidated by a newer admission. A repeat of
   * that same result must not attach, but a later run may. */
  const supersededTerminal = new Map<
    string,
    { generation: number; terminalRevision: number; resultDigest: string }
  >();
  let tokens = new WeakMap<object, TokenState>();
  let claims = new WeakMap<object, ClaimState>();

  function clearTerminals(): void {
    for (const terminal of terminalsByTask.values())
      invalidateTerminal(terminal);
    terminalsByTask.clear();
  }

  function invalidateSession(sessionID: string): void {
    for (const [taskID, terminal] of terminalsByTask) {
      if (terminal.admission.sessionID !== sessionID) continue;
      invalidateTerminal(terminal);
      terminalsByTask.delete(taskID);
    }
  }

  function current(terminal: TerminalRecord): boolean {
    return (
      !disposed &&
      admissionsBySession.get(terminal.taskID) === terminal.admission &&
      terminalsByTask.get(terminal.taskID) === terminal
    );
  }

  function invalidateStaleToken(token: TokenState): false {
    invalidateToken(token);
    return false;
  }

  const broker: SameProcessResumeEvidenceBroker = {
    observeAdmission(admission) {
      if (disposed || !validAdmission(admission)) return;
      const existing = admissionsBySession.get(admission.sessionID);
      if (existing && sameAdmission(existing, admission)) {
        if (
          existing.createdAt === undefined &&
          admission.createdAt !== undefined
        ) {
          existing.createdAt = admission.createdAt;
          return;
        }
        if (
          admission.createdAt === undefined ||
          existing.createdAt === admission.createdAt
        )
          return;
      }

      if (existing) {
        const previous = terminalsByTask.get(admission.sessionID);
        invalidateSession(admission.sessionID);
        admissionsBySession.delete(admission.sessionID);
        if (previous) {
          supersededTerminal.set(admission.sessionID, {
            generation: previous.generation,
            terminalRevision: previous.terminalRevision,
            resultDigest: previous.resultDigest,
          });
        } else unmatchedTerminal.add(admission.sessionID);
      }
      while (admissionsBySession.size >= MAX_ADMISSION_RECORDS) {
        const oldest = admissionsBySession.keys().next().value;
        if (oldest === undefined) break;
        invalidateSession(oldest);
        admissionsBySession.delete(oldest);
      }
      admissionsBySession.set(admission.sessionID, {
        sessionID: admission.sessionID,
        messageID: admission.messageID,
        ...(admission.createdAt === undefined
          ? {}
          : { createdAt: admission.createdAt }),
      });
    },

    recordTerminal(terminal) {
      if (disposed || !validTerminal(terminal)) return;

      const admission = admissionsBySession.get(terminal.taskID);
      if (!admission) return;
      if (unmatchedTerminal.delete(terminal.taskID)) return;

      const digest = resultDigest(terminal.resultSummary);
      const superseded = supersededTerminal.get(terminal.taskID);
      if (
        superseded &&
        superseded.generation === terminal.generation &&
        superseded.terminalRevision === terminal.terminalRevision &&
        superseded.resultDigest === digest
      )
        return;
      supersededTerminal.delete(terminal.taskID);
      const previous = terminalsByTask.get(terminal.taskID);
      if (
        previous &&
        previous.admission === admission &&
        previous.parentSessionID === terminal.parentSessionID &&
        previous.generation === terminal.generation &&
        previous.terminalRevision === terminal.terminalRevision &&
        previous.state === terminal.state &&
        previous.resultDigest === digest &&
        previous.completedAt === terminal.completedAt
      )
        return;

      if (previous) {
        invalidateTerminal(previous);
        terminalsByTask.delete(terminal.taskID);
      }
      while (terminalsByTask.size >= MAX_TERMINAL_RECORDS) {
        const oldest = terminalsByTask.keys().next().value;
        if (oldest === undefined) break;
        const evicted = terminalsByTask.get(oldest);
        if (evicted) invalidateTerminal(evicted);
        terminalsByTask.delete(oldest);
      }

      terminalsByTask.set(terminal.taskID, {
        taskID: terminal.taskID,
        parentSessionID: terminal.parentSessionID,
        generation: terminal.generation,
        terminalRevision: terminal.terminalRevision,
        state: terminal.state,
        resultDigest: digest,
        ...(terminal.completedAt === undefined
          ? {}
          : { completedAt: terminal.completedAt }),
        admission,
      });
    },

    authorize(authorization) {
      if (disposed || !validAuthorization(authorization)) return undefined;

      const terminal = terminalsByTask.get(authorization.taskID);
      if (
        !terminal ||
        !current(terminal) ||
        terminal.parentSessionID !== authorization.parentSessionID ||
        terminal.generation !== authorization.generation ||
        terminal.terminalRevision !== authorization.terminalRevision ||
        terminal.resultDigest !== resultDigest(authorization.resultSummary)
      )
        return undefined;

      const admission = terminal.admission;

      // Acknowledgement must be a later observation than both the terminal
      // and the admitted child turn whenever the host supplied timestamps.
      if (
        (terminal.completedAt !== undefined &&
          terminal.completedAt > authorization.acknowledgedAt) ||
        (admission.createdAt !== undefined &&
          admission.createdAt > authorization.acknowledgedAt)
      )
        return undefined;

      const existing = terminal.token;
      if (existing) {
        return existing.status === 'accepted' ||
          existing.status === 'invalidated'
          ? undefined
          : existing.token;
      }

      const token = opaqueObject() as SameProcessResumeEvidenceToken;
      const state: TokenState = {
        token,
        terminal,
        status: 'available',
      };
      terminal.token = state;
      tokens.set(token, state);
      return token;
    },

    claim(token) {
      if (disposed || !isObjectLike(token)) return undefined;
      const state = tokens.get(token);
      if (!state || !current(state.terminal)) {
        if (state) invalidateToken(state);
        return undefined;
      }
      if (state.status !== 'available') return undefined;

      const claim = opaqueObject() as SameProcessResumeEvidenceClaim;
      state.status = 'claimed';
      state.claim = claim;
      claims.set(claim, { token: state });
      return claim;
    },

    accept(claim) {
      if (disposed || !isObjectLike(claim)) return false;
      const state = claims.get(claim);
      if (!state) return false;
      claims.delete(claim);

      const token = state.token;
      if (
        token.status !== 'claimed' ||
        token.claim !== claim ||
        !current(token.terminal)
      )
        return invalidateStaleToken(token);

      token.status = 'accepted';
      token.claim = undefined;
      return true;
    },

    releaseBeforeSend(claim) {
      if (disposed || !isObjectLike(claim)) return false;
      const state = claims.get(claim);
      if (!state) return false;
      claims.delete(claim);

      const token = state.token;
      if (
        token.status !== 'claimed' ||
        token.claim !== claim ||
        !current(token.terminal)
      )
        return invalidateStaleToken(token);

      token.status = 'available';
      token.claim = undefined;
      return true;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearTerminals();
      admissionsBySession.clear();
      unmatchedTerminal.clear();
      supersededTerminal.clear();
      tokens = new WeakMap();
      claims = new WeakMap();
    },
  };

  return broker;
}
