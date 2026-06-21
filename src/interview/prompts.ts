import type { InterviewQuestion } from './types';

function formatQuestionContext(questions: InterviewQuestion[]): string {
  if (questions.length === 0) {
    return 'No current interview questions were parsed.';
  }

  return questions
    .map((question, index) => {
      const options = question.options.length
        ? `Options: ${question.options.join(' | ')}`
        : 'Options: freeform';
      const suggested = question.suggested
        ? `Suggested: ${question.suggested}`
        : 'Suggested: none';
      return `${index + 1}. ${question.question}\n${options}\n${suggested}`;
    })
    .join('\n\n');
}

const SPECIFICATION_TEMPLATE_GUIDELINE = `
Your target document MUST be structured strictly using the following 11-section template (exclude the frontmatter itself from the summary JSON field, as the tool handles frontmatter automatically):

# Introduction
[Short intro to the spec and goals]

## 1. Purpose & Scope
[Intended audience, boundaries, and assumptions]

## 2. Definitions
[Acronyms, terms defined]

## 3. Requirements, Constraints & Guidelines
[Explicitly list requirements using:
- **REQ-001**: Description
- **SEC-001**: Security constraints
- **CON-001**: System constraints/technologies
- **GUD-001**: Guidelines]

## 4. Interfaces & Data Contracts
[APIs, JSON schemas, protocol buffers, or class/data structures]

## 5. Acceptance Criteria
[Define testable criteria in Given-When-Then format:
- **AC-001**: Given [context], When [action], Then [expected outcome]]

## 6. Test Automation Strategy
[Mocking approach, test framework, unit/integration details]

## 7. Rationale & Context
[Trade-offs and architectural decisions]

## 8. Dependencies & External Integrations
[Conceptual integrations or external dependencies:
- **EXT-001**: Dependency details]

## 9. Examples & Edge Cases
[Concrete code examples, settings, or JSON structures]

## 10. Validation Criteria
[Testing or validation check logic]

## 11. Related Specifications / Further Reading
[Internal doc references]

ANTI-ASSUMPTION & SUB-AGENT DELEGATION RULE:
Do not invent file structures, API signatures, package lists, or library behaviors. If you need to trace local code, verify file paths, or check configurations, you MUST call the sub-agent '@explorer' or search files directly. If you need to search documentation or web info for external APIs/libraries, you MUST call the sub-agent '@librarian' or search the web. Do not guess. Pause, run discovery, and integrate facts into the spec.
`;

export function buildKickoffPrompt(idea: string, maxQuestions: number): string {
  return [
    'You are running an interview q&a session for the user inside their repository.',
    `Initial idea: ${idea}`,
    `Goal: Iteratively generate and populate a highly structured Specification document.`,
    SPECIFICATION_TEMPLATE_GUIDELINE,
    `Clarify the idea through short rounds of at most ${maxQuestions} questions at a time.`,
    'When useful, each question may include 2 to 4 answer options and one suggested option.',
    'Be practical. Focus on the highest-ambiguity and highest-risk decisions first.',
    'After any short human-friendly preface, you MUST include a machine-readable block in this exact format:',
    '<interview_state>',
    '{',
    '  "summary": "Full specification markdown (strictly matching the 11 section titles above)",',
    '  "title": "concise-kebab-case-title-for-filename",',
    '  "questions": [',
    '    {',
    '      "id": "short-kebab-id-2",',
    '      "question": "question text",',
    '      "options": ["option 1", "option 2", "option 3"],',
    '      "suggested": "best suggested option"',
    '    }',
    '  ]',
    '}',
    '</interview_state>',
    'Rules:',
    `- Return 0 to ${maxQuestions} questions.`,
    '- If there are no more useful questions or the specification is complete, return zero questions.',
    `- Do not ask more than ${maxQuestions} questions in one round.`,
    '- Provide a concise "title" field (kebab-case, 3-6 words) suitable for a filename.',
  ].join('\n');
}

export function buildResumePrompt(
  document: string,
  maxQuestions: number,
): string {
  return [
    'Resume the interview from this existing markdown document.',
    'Use the current spec and Q&A history as ground truth so far.',
    SPECIFICATION_TEMPLATE_GUIDELINE,
    'Do not restart from scratch.',
    '',
    document,
    '',
    `Ask the next highest-value clarifying questions, up to ${maxQuestions} at a time.`,
    'If there are no more useful questions or the spec is complete, return zero questions.',
    'Return the same <interview_state> JSON block format as before.',
  ].join('\n');
}

export function buildAnswerPrompt(
  answers: Array<{ questionId: string; answer: string }>,
  questions: InterviewQuestion[],
  maxQuestions: number,
): string {
  const answerText = answers
    .map(
      (answer, index) =>
        `${index + 1}. ${answer.questionId}: ${answer.answer.trim()}`,
    )
    .join('\n');

  return [
    'Continue the same interview.',
    SPECIFICATION_TEMPLATE_GUIDELINE,
    'These were the active questions:',
    formatQuestionContext(questions),
    'The user answered:',
    answerText,
    'Now update the specification summary document and ask the next highest-value clarifying questions.',
    `Return 0 to ${maxQuestions} questions. If there are no more useful questions or the spec is complete, return zero questions.`,
    'Return the same <interview_state> JSON block format as before.',
  ].join('\n\n');
}
