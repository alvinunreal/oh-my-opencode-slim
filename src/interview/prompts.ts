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

export function buildKickoffPrompt(idea: string, maxQuestions: number): string {
  return [
    'You are running an interview q&a session for the user inside their repository.',
    `Initial idea: ${idea}`,
    `Clarify the idea through short rounds of at most ${maxQuestions} questions at a time.`,
    'When useful, each question may include 2 to 4 answer options and one suggested option.',
    'Be practical. Focus on the highest-ambiguity and highest-risk decisions first.',
    'After any short human-friendly preface, you MUST include a machine-readable block in this exact format:',
    '<interview_state>',
    '{',
    '  "summary": "one short paragraph about the current understanding",',
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
    '- If there are no more useful questions, return zero questions.',
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
    'Do not restart from scratch.',
    '',
    document,
    '',
    `Ask the next highest-value clarifying questions, up to ${maxQuestions} at a time.`,
    'If there are no more useful questions, return zero questions.',
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
    'These were the active questions:',
    formatQuestionContext(questions),
    'The user answered:',
    answerText,
    'Now update your understanding and ask the next highest-value clarifying questions.',
    `Return 0 to ${maxQuestions} questions. If there are no more useful questions, return zero questions.`,
    'Return the same <interview_state> JSON block format as before.',
  ].join('\n\n');
}
