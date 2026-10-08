/** The only file outsiders import: one seam over the background-jobs
 * deep module — board state machine, terminal gate, wall-clock
 * supervisor, and lifecycle policy, composed by
 * `createBackgroundJobLifecycle`. */

// Test seams: the board constructor and the gate factory are consumed by
// adapter/integration tests outside this package. Production code composes
// everything through `createBackgroundJobLifecycle` exclusively.
export {
  BackgroundJobBoard,
  type BackgroundJobBoardApi,
} from './board';
export {
  boardFixture,
  type FixtureBoardInstance,
  FixtureBoardProxy as FixtureBoard,
} from './fixture';
export {
  ACCEPTED_HOST_OUTCOMES,
  readSessionInfoForObservation,
  runtimeObservationFromSnapshot,
} from './host-reads';
export type {
  BackgroundJobInjectedCompletionFence,
  BackgroundJobLifecycleLedger,
  BackgroundJobSyntheticTerminalOccurrence,
  BackgroundJobSyntheticTerminalOccurrencePhase,
} from './ledger';
export {
  type BackgroundJobIdentityEvent,
  BackgroundJobLifecycle,
  type BackgroundJobLifecycleOptions,
  createBackgroundJobLifecycle,
} from './lifecycle';
export {
  type BackgroundJobStorageBackend,
  clearSuppression,
  configureBackgroundJobPersistence,
  getSuppressionTombstone,
  loadInitialBackgroundJobPersistence,
  MAX_PERSISTED_TOMBSTONES,
  type PersistedBackgroundJobState,
  type PersistedTombstoneEntry,
  persistedBackgroundJobState,
  recordSuppression,
} from './persistence';

export {
  type BackgroundJobSupervisor,
  type BackgroundJobSupervisorOptions,
  DefaultBackgroundJobSupervisor,
} from './supervisor';
export {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
  DEFAULT_EVIDENCE_READ_TIMEOUT_MS,
  EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
  type GateResult,
  type ObservationToken,
  type RunRef,
  type RuntimeObservation,
  raceEvidenceDeadline,
  STOP_CONFIRMATION_GRACE_MS,
  STOPPED_WITHOUT_TERMINAL_RESULT,
  type TaskOutputOrigin,
  type TerminalSignal,
} from './terminal-gate';
export {
  AGED_ENTRY_RENDER_TTL_MS,
  type BackgroundJobAdoptionInput,
  type BackgroundJobBoardOptions,
  type BackgroundJobEvictedSession,
  type BackgroundJobExecution,
  BackgroundJobLaunchConflictError,
  type BackgroundJobLaunchInput,
  type BackgroundJobLease,
  type BackgroundJobLeaseKind,
  type BackgroundJobPromptMetadata,
  type BackgroundJobRecord,
  type BackgroundJobState,
  type BackgroundJobStatusInput,
  type BackgroundJobTerminalInput,
  type ContextFile,
  deriveFullObjective,
  deriveTaskSessionLabel,
  isPrunableEvictedSession,
  type RestoreRetainedSessionInput,
  type ReusableSessionSelection,
  STATUS_UNCERTAIN_DEMOTE_AFTER_MS,
  type WallClockTimeoutClaimInput,
  type WallClockTimeoutFinalizeInput,
} from './types';
