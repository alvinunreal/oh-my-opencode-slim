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

export function buildKickoffPrompt(idea: string): string {
  return [
    'You are running an interview q&a session for the user inside their repository.',
    `Initial idea: ${idea}`,
    'Clarify the idea through short rounds of at most 2 questions at a time.',
    'When useful, each question may include 2 to 4 answer options and one suggested option.',
    'Be practical. Focus on the highest-ambiguity and highest-risk decisions first.',
    'After any short human-friendly preface, you MUST include a machine-readable block in this exact format:',
    '<interview_state>',
    '{',
    '  "summary": "one short paragraph about the current understanding",',
    '  "questions": [',
    '    {',
    '      "id": "short-kebab-id",',
    '      "question": "question text",',
    '      "options": ["option 1", "option 2", "option 3"],',
    '      "suggested": "best suggested option"',
    '    },',
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
    '- Return 0 to 2 questions.',
    '- If there are no more useful questions, return zero questions.',
    '- Do not ask more than 2 questions in one round.',
  ].join('\n');
}

export function buildAnswerPrompt(
  answers: Array<{ questionId: string; answer: string }>,
  questions: InterviewQuestion[],
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
    'Return 0 to 2 questions. If there are no more useful questions, return zero questions.',
    'Return the same <interview_state> JSON block format as before.',
  ].join('\n\n');
}
