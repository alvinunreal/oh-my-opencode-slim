/** Model cost/quality tiers resolved from the active preset. */
export type ModelTier = 'fast' | 'balanced' | 'max';

export const MODEL_TIERS: readonly ModelTier[] = [
  'fast',
  'balanced',
  'max',
] as const;

export type ModelEntry = { id: string; variant?: string };

/** Specialists Jev may recommend. `direct` = orchestrator handles it. */
export type JevSpecialist =
  | 'explorer'
  | 'librarian'
  | 'oracle'
  | 'designer'
  | 'fixer'
  | 'observer'
  | 'council'
  | 'direct';

export type JevQuestionKind = 'choice' | 'score' | 'noul';

export type JevChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
};

export type JevScoreQuestion = {
  type: 'score';
  instructions: string;
  criteria: string[];
};

export type JevNoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
};

export type JevQuestion =
  | JevChoiceQuestion
  | JevScoreQuestion
  | JevNoulQuestion;

export type JevChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type JevScoreAnswer = {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};

export type JevNoulAnswer = {
  type: 'noul';
  noul: number;
};

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export type JevSystemOneResponse = {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type JevRouteInput = {
  /** Compact task state (user intent, constraints, paths). */
  state: string;
  /** Optional: only allow these specialists (enabled agents + direct). */
  allowedSpecialists?: readonly JevSpecialist[];
  /** Optional session id — used to cache the decision for dispatch inject. */
  sessionID?: string;
};

export type JevRouteStatus = 'ok' | 'low_confidence' | 'error';

export type JevRouteResult = {
  status: JevRouteStatus;
  /** Recommended specialist when status is ok or low_confidence with escalate. */
  specialist?: JevSpecialist;
  /** Confidence of the specialist Choice (0–1). */
  confidence?: number;
  /** Probability distribution over specialists. */
  probabilities?: Record<string, number>;
  /** Raw complexity score (0–1 scale over ordered levels). */
  complexity?: number;
  /** Raw risk score (0–1 scale over ordered levels). */
  risk?: number;
  /** Resolved model tier after policy (including confidence escalate). */
  modelTier?: ModelTier;
  /** Concrete model from the active preset for this tier/specialist. */
  model?: ModelEntry;
  /** Human-readable decision line for the orchestrator. */
  recommendation: string;
  /** Error detail when status is error. */
  error?: string;
};
