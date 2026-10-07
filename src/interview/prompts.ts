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

export const TOOL_FALLBACK_HINT =
  'If no interview_submit_state tool is available, output exactly one <interview_state>{...}</interview_state> block with the same JSON object and nothing else: no prose and no explanation that the tool is unavailable.';

const KICKOFF_STATE_FIELDS = [
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
] as const;

const PATCH_STATE_FIELDS = [
  '{',
  '  "summary": "one-line status of what changed",',
  '  "patch": "--- a/spec\\n+++ b/spec\\n@@ -1,1 +1,1 @@\\n-old line\\n+new line",',
  '  "questions": [',
  '    {',
  '      "id": "short-kebab-id",',
  '      "question": "question text",',
  '      "options": ["option 1", "option 2"],',
  '      "suggested": "option 1"',
  '    }',
  '  ]',
  '}',
] as const;

function stateInstruction(
  fields: readonly string[],
  printState: boolean,
): string[] {
  return printState
    ? [
        'After any short human-friendly preface, you MUST include a machine-readable block in this exact format:',
        '<interview_state>',
        ...fields,
        '</interview_state>',
      ]
    : [
        'Call the interview_submit_state tool exactly once with this object:',
        ...fields,
        TOOL_FALLBACK_HINT,
        'Otherwise do not print an <interview_state> block and write no other prose.',
      ];
}

export const SPECIFICATION_TEMPLATE_GUIDELINE = `
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

export function buildKickoffPrompt(
  idea: string,
  maxQuestions: number,
  printState = false,
): string {
  return [
    'You are running an interview q&a session for the user inside their repository.',
    `Initial idea: ${idea}`,
    `Goal: Iteratively generate and populate a highly structured Specification document.`,
    SPECIFICATION_TEMPLATE_GUIDELINE,
    `Clarify the idea through short rounds of at most ${maxQuestions} questions at a time.`,
    'When useful, each question may include 2 to 4 answer options and one suggested option.',
    'Be practical. Focus on the highest-ambiguity and highest-risk decisions first.',
    ...stateInstruction(KICKOFF_STATE_FIELDS, printState),
    'Rules:',
    `- Return 0 to ${maxQuestions} questions.`,
    '- If there are no more useful questions or the specification is complete, return zero questions.',
    `- Do not ask more than ${maxQuestions} questions in one round.`,
    '- Provide a concise "title" field (kebab-case, 3-6 words) suitable for a filename.',
    '- This first turn only: put the full specification in summary. Later turns will ask for a unified diff in patch instead.',
  ].join('\n');
}

export interface SpecPromptContext {
  relativePath: string;
  title: string;
  outline: string;
}

function describeSpec(context: SpecPromptContext): string {
  return [
    `Specification file: ${context.relativePath}`,
    `Title: ${context.title || '(untitled)'}`,
    'Heading outline of the current spec body:',
    context.outline || '(no headings yet)',
    'Read that file if you need a section. Do not expect the spec body or the Q&A history in this prompt.',
  ].join('\n');
}

function patchContract(maxQuestions: number, printState = false): string {
  const contract = [
    'The file on disk is the source of truth.',
    'summary is a one-line status of what changed, not the specification.',
    'patch is a unified diff against the current spec body only: the markdown under "## Current spec".',
    'Do not include YAML frontmatter or the "## Q&A history" section in the diff.',
    'If the spec body does not change, set patch to an empty string.',
    `Return 0 to ${maxQuestions} questions.`,
    'If there are no more useful questions or the specification is complete, return zero questions.',
  ];
  return [
    ...contract,
    ...stateInstruction(PATCH_STATE_FIELDS, printState),
  ].join('\n');
}

export function buildResumePrompt(
  context: SpecPromptContext,
  maxQuestions: number,
  printState = false,
): string {
  return [
    'Resume the interview from the existing markdown document.',
    'Use the file on disk as ground truth so far.',
    'Do not restart from scratch.',
    SPECIFICATION_TEMPLATE_GUIDELINE,
    describeSpec(context),
    `Ask the next highest-value clarifying questions, up to ${maxQuestions} at a time.`,
    patchContract(maxQuestions, printState),
  ].join('\n\n');
}

export function buildAnswerPrompt(
  answers: Array<{ questionId: string; answer: string }>,
  questions: InterviewQuestion[],
  maxQuestions: number,
  context: SpecPromptContext,
  printState = false,
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
    describeSpec(context),
    'These were the active questions:',
    formatQuestionContext(questions),
    'The user answered:',
    answerText,
    'Update the specification with a unified diff and ask the next highest-value clarifying questions.',
    patchContract(maxQuestions, printState),
  ].join('\n\n');
}

export function buildBlockCommentPrompt(
  sectionTitle: string,
  comment: string,
  maxQuestions: number,
  context: SpecPromptContext,
  printState = false,
): string {
  return [
    'Continue the same interview.',
    SPECIFICATION_TEMPLATE_GUIDELINE,
    describeSpec(context),
    `The user submitted feedback for the section "${sectionTitle}".`,
    `Feedback: ${comment}`,
    `Update the spec with a unified diff, focusing on "${sectionTitle}".`,
    'If this feedback implies other parts of the spec should change, include those hunks too.',
    patchContract(maxQuestions, printState),
  ].join('\n\n');
}

export function buildChatPrompt(
  message: string,
  maxQuestions: number,
  context: SpecPromptContext,
  printState = false,
): string {
  return [
    'Continue the same interview.',
    SPECIFICATION_TEMPLATE_GUIDELINE,
    describeSpec(context),
    'The user sent a freeform message via the dashboard chat panel:',
    message,
    'The request may add a section, revise content, or ask for clarifying questions.',
    'Update the specification with a unified diff.',
    patchContract(maxQuestions, printState),
  ].join('\n\n');
}

export function buildNudgePrompt(
  action: 'more-questions' | 'confirm-complete',
  maxQuestions: number,
  context: SpecPromptContext,
  printState = false,
): string {
  if (action === 'confirm-complete') {
    return [
      'You are finishing the interview.',
      describeSpec(context),
      'The user confirmed the interview spec is complete.',
      'Produce a final, polished version of the full spec document as clean markdown.',
      'Do NOT include any <interview_state> block.',
      'The spec should be comprehensive, well-structured, and ready for implementation.',
    ].join('\n\n');
  }

  return [
    'Continue the same interview.',
    SPECIFICATION_TEMPLATE_GUIDELINE,
    describeSpec(context),
    'The user reviewed the spec and wants more questions.',
    `Ask up to ${maxQuestions} new clarifying questions about aspects that are still unclear or underspecified.`,
    patchContract(maxQuestions, printState),
  ].join('\n\n');
}

export function buildImplementPrompt(relativePath: string): string {
  return [
    'The specification is complete.',
    `Specification file: ${relativePath}`,
    'Read that file. Implement the markdown under "## Current spec".',
    'Ignore YAML frontmatter and the "## Q&A history" section.',
    'Do not reprint the specification.',
    'Do not include an interview state block.',
  ].join('\n');
}

export function buildImplementRefusalPrompt(): string {
  return [
    'The interview still has open questions.',
    'Finish them in the browser before implementing.',
    'Reply with that sentence only. Do not implement anything.',
  ].join('\n');
}

export function buildImplementPatchFailurePrompt(): string {
  return [
    'The latest spec update failed to apply; fix it before implementing.',
    'Resume the interview and submit a corrected patch first.',
    'Reply with that sentence only. Do not implement anything.',
  ].join('\n');
}

export function buildImplementMissingPrompt(): string {
  return [
    'No completed interview spec was found.',
    'Run /interview or pass a markdown path to /implement.',
    'Reply with that sentence only. Do not implement anything.',
  ].join('\n');
}

export function buildPatchRepairPrompt(
  failedHunk: string,
  contextWindow: string,
  maxQuestions: number,
  printState = false,
): string {
  return [
    'The previous spec patch did not apply.',
    'Return one corrected unified diff of the current spec body.',
    'Do not include frontmatter or Q&A history.',
    'Failed hunk:',
    failedHunk,
    'Nearby spec lines:',
    contextWindow,
    patchContract(maxQuestions, printState),
  ].join('\n\n');
}

export function buildPatchMissingRepairPrompt(
  maxQuestions: number,
  printState = false,
): string {
  return [
    'The previous interview state omitted the required spec patch.',
    'Return one unified diff of the current spec body.',
    'Do not include frontmatter or Q&A history.',
    patchContract(maxQuestions, printState),
  ].join('\n\n');
}
