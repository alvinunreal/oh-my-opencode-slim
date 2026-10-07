import { describe, expect, test } from 'bun:test';
import {
  buildAnswerPrompt,
  buildBlockCommentPrompt,
  buildChatPrompt,
  buildKickoffPrompt,
  buildNudgePrompt,
  buildPatchRepairPrompt,
  buildResumePrompt,
  type SpecPromptContext,
  TOOL_FALLBACK_HINT,
} from './prompts';
import type { InterviewQuestion } from './types';

const CONTEXT: SpecPromptContext = {
  relativePath: 'interview/spec.md',
  title: 'spec',
  outline: '# Introduction\n## 1. Purpose & Scope',
};

const QUESTIONS: InterviewQuestion[] = [
  {
    id: 'q-1',
    question: 'Platform?',
    options: ['Web', 'Mobile'],
    suggested: 'Web',
  },
];

function toolModePrompts(): Record<string, string> {
  return {
    kickoff: buildKickoffPrompt('An idea', 2),
    resume: buildResumePrompt(CONTEXT, 2),
    answer: buildAnswerPrompt(
      [{ questionId: 'q-1', answer: 'Web' }],
      QUESTIONS,
      2,
      CONTEXT,
    ),
    blockComment: buildBlockCommentPrompt(
      'Introduction',
      'Tighten it',
      2,
      CONTEXT,
    ),
    chat: buildChatPrompt('Add a section', 2, CONTEXT),
    nudge: buildNudgePrompt('more-questions', 2, CONTEXT),
    patchRepair: buildPatchRepairPrompt('-old', '+new', 2),
  };
}

function printStatePrompts(): Record<string, string> {
  return {
    kickoff: buildKickoffPrompt('An idea', 2, true),
    resume: buildResumePrompt(CONTEXT, 2, true),
    answer: buildAnswerPrompt(
      [{ questionId: 'q-1', answer: 'Web' }],
      QUESTIONS,
      2,
      CONTEXT,
      true,
    ),
    blockComment: buildBlockCommentPrompt(
      'Introduction',
      'Tighten it',
      2,
      CONTEXT,
      true,
    ),
    chat: buildChatPrompt('Add a section', 2, CONTEXT, true),
    nudge: buildNudgePrompt('more-questions', 2, CONTEXT, true),
    patchRepair: buildPatchRepairPrompt('-old', '+new', 2, true),
  };
}

describe('interview prompt tool fallback', () => {
  test('every non-printState tool prompt carries the fallback', () => {
    for (const [name, prompt] of Object.entries(toolModePrompts())) {
      expect(prompt, name).toContain(TOOL_FALLBACK_HINT);
      expect(prompt, name).not.toContain(
        'mcp__<server>__interview_submit_state',
      );
      expect(prompt, name).not.toContain('After any short');
    }
  });

  test('the fallback names the block format and forbids prose', () => {
    const fallback = TOOL_FALLBACK_HINT.toLowerCase();
    expect(fallback).toContain('<interview_state>{...}</interview_state>');
    expect(fallback).toContain('no prose');
    expect(fallback).toContain('no explanation');
  });

  test('printState prompts keep the legacy block wording and omit the fallback', () => {
    for (const [name, prompt] of Object.entries(printStatePrompts())) {
      expect(prompt, name).toContain('<interview_state>');
      expect(prompt, name).toContain('</interview_state>');
      expect(prompt, name).not.toContain(TOOL_FALLBACK_HINT);
    }
    expect(printStatePrompts().kickoff).toContain(
      [
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
      ].join('\n'),
    );
    expect(printStatePrompts().resume).toContain(
      [
        'After any short human-friendly preface, you MUST include a machine-readable block in this exact format:',
        '<interview_state>',
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
        '</interview_state>',
      ].join('\n'),
    );
  });

  test('printState prompts are deterministic', () => {
    expect(printStatePrompts()).toEqual(printStatePrompts());
    expect(toolModePrompts()).toEqual(toolModePrompts());
  });
});
