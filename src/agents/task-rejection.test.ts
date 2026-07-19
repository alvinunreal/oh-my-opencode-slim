import { describe, expect, test } from 'bun:test';
import { TASK_REJECTION_INSTRUCTION } from './task-rejection';

describe('task rejection instruction', () => {
  test('requires a plain reason-only response', () => {
    expect(TASK_REJECTION_INSTRUCTION).toBe(
      'If a task is outside your role, do not attempt partial work. Return a brief reason to the orchestrator.',
    );
    expect(TASK_REJECTION_INSTRUCTION).not.toMatch(
      /<|>|task_rejection|recommended[_ -]?agent/i,
    );
    expect(TASK_REJECTION_INSTRUCTION).not.toContain('permissions');
    expect(TASK_REJECTION_INSTRUCTION).not.toContain('available context');
  });
});
