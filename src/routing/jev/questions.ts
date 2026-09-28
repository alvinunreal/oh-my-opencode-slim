import type {
  JevChoiceQuestion,
  JevNoulQuestion,
  JevQuestion,
  JevScoreQuestion,
  JevSpecialist,
} from './types';

const SPECIALIST_CRITERIA: Record<JevSpecialist, string> = {
  explorer:
    'Fast codebase recon: locate files, symbols, patterns; return a compressed map rather than full contents.',
  librarian:
    'External knowledge: library docs, API references, web research, current best practices, bug reports online.',
  oracle:
    'ADVICE/REVIEW only: architecture decisions, trade-off analysis, debugging strategy, code review, security/data-integrity judgment. Does NOT write the implementation.',
  designer:
    'UI/UX design, layout, visual hierarchy, responsive behavior, animation, design polish on user-facing surfaces.',
  fixer:
    'ALL implementation/execution work: writing or changing code to satisfy a requirement or plan — including complex multi-file, multi-system, high-risk builds. Task type is implementation; difficulty does not move it to oracle.',
  observer:
    'Visual/media analysis of images, screenshots, PDFs, diagrams when the orchestrator should not load raw bytes.',
  council:
    'High-stakes decision that needs multi-model consensus or independent second opinions.',
  direct:
    'Only when no specialist role applies: pure planning/synthesis, or a truly isolated one-step action the orchestrator would do itself. Prefer a specialist for any real coding lane.',
};

export function buildSpecialistQuestion(
  allowed: readonly JevSpecialist[] = Object.keys(
    SPECIALIST_CRITERIA,
  ) as JevSpecialist[],
): JevChoiceQuestion {
  const criteria: Record<string, string | null> = {};
  for (const name of allowed) {
    criteria[name] = SPECIALIST_CRITERIA[name] ?? null;
  }
  return {
    type: 'choice',
    instructions:
      'Which TASK TYPE owns this work? Pick the specialist whose role matches the kind of work (recon, research, architecture, UI, implementation, visual analysis, consensus), or direct for orchestrator-owned work. Do NOT pick by difficulty/complexity — that only affects model strength.',
    criteria,
  };
}

export function buildComplexityQuestion(): JevScoreQuestion {
  return {
    type: 'score',
    instructions:
      'How complex is this task to execute well (scope, coupling, unknowns)? This selects model STRENGTH for the chosen specialist, never a different specialist.',
    criteria: [
      'Trivial or single well-known step',
      'Moderate: a few files or one non-trivial concern',
      'Complex: multi-file, multi-system, or significant unknowns',
    ],
  };
}

export function buildRiskQuestion(): JevScoreQuestion {
  return {
    type: 'score',
    instructions:
      'How costly is a wrong or sloppy outcome (architecture, data, security, user-facing breakage)? This selects model STRENGTH for the chosen specialist, never a different specialist.',
    criteria: [
      'Low stakes; easy to reverse',
      'Medium: user-visible or multi-file blast radius',
      'High: architecture, security, data loss, or hard-to-reverse changes',
    ],
  };
}

export function buildNeedsExternalQuestion(): JevNoulQuestion {
  return {
    type: 'noul',
    instructions:
      'Does this task need external/up-to-date documentation or web research to do well?',
    criteria: {
      true: 'Unfamiliar library, version-specific API, or online investigation is required',
      false: 'Local code and general knowledge are enough',
    },
  };
}

export function buildNeedsVisualQuestion(): JevNoulQuestion {
  return {
    type: 'noul',
    instructions:
      'Does this task center on UI/UX, visual polish, or analyzing an image/PDF/diagram?',
    criteria: {
      true: 'Design taste, layout, or visual file analysis is the core work',
      false: 'Headless logic, research, or non-visual implementation',
    },
  };
}

export function buildMultiLaneQuestion(): JevNoulQuestion {
  return {
    type: 'noul',
    instructions:
      'Can this task be split into independent parallel specialist lanes?',
    criteria: {
      true: 'Two or more parts can proceed concurrently without write conflicts',
      false: 'Sequential or single-lane work',
    },
  };
}

/** One SystemOne request covering all routing dimensions in parallel. */
export function buildRouteQuestions(options?: {
  allowedSpecialists?: readonly JevSpecialist[];
}): Record<string, JevQuestion> {
  return {
    specialist: buildSpecialistQuestion(options?.allowedSpecialists),
    complexity: buildComplexityQuestion(),
    risk: buildRiskQuestion(),
    needs_external: buildNeedsExternalQuestion(),
    needs_visual: buildNeedsVisualQuestion(),
    multi_lane: buildMultiLaneQuestion(),
  };
}
