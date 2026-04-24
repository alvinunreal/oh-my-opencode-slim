import { describe, expect, test } from 'bun:test';
import { deriveTaskSessionLabel, SessionManager } from './session-manager';

describe('SessionManager', () => {
  test('keeps most recently used sessions within limit', () => {
    const manager = new SessionManager(2);

    manager.remember({
      parentSessionId: 'parent-1',
      taskId: 'task-1',
      agentType: 'explorer',
      label: 'first thread',
    });
    manager.remember({
      parentSessionId: 'parent-1',
      taskId: 'task-2',
      agentType: 'explorer',
      label: 'second thread',
    });
    manager.markUsed('parent-1', 'explorer', 'task-1');
    manager.remember({
      parentSessionId: 'parent-1',
      taskId: 'task-3',
      agentType: 'explorer',
      label: 'third thread',
    });

    const prompt = manager.formatForPrompt('parent-1');
    expect(prompt).toContain('exp-1 first thread');
    expect(prompt).toContain('exp-3 third thread');
    expect(prompt).not.toContain('exp-2 second thread');
  });

  test('clears parent-scoped sessions', () => {
    const manager = new SessionManager(2);

    manager.remember({
      parentSessionId: 'parent-1',
      taskId: 'task-1',
      agentType: 'oracle',
      label: 'architecture',
    });

    manager.clearParent('parent-1');

    expect(manager.formatForPrompt('parent-1')).toBeUndefined();
  });

  test('includes read context for remembered sessions', () => {
    const manager = new SessionManager(2);

    manager.remember({
      parentSessionId: 'parent-1',
      taskId: 'task-1',
      agentType: 'explorer',
      label: 'session manager',
    });
    manager.addContext('task-1', [
      { path: 'src/index.ts', lineCount: 42, lastReadAt: 1 },
      {
        path: 'src/multiplexer/session-manager.ts',
        lineCount: 24,
        lastReadAt: 2,
      },
    ]);

    const prompt = manager.formatForPrompt('parent-1');
    expect(prompt).toContain('exp-1 session manager');
    expect(prompt).toContain(
      'Context read by exp-1: src/multiplexer/session-manager.ts (24 lines), src/index.ts (42 lines)',
    );
  });

  test('filters tiny reads and caps read context files', () => {
    const manager = new SessionManager(2);

    manager.remember({
      parentSessionId: 'parent-1',
      taskId: 'task-1',
      agentType: 'explorer',
      label: 'large context',
    });
    manager.addContext(
      'task-1',
      Array.from({ length: 10 }, (_, index) => ({
        path: `file-${index}.ts`,
        lineCount: index === 0 ? 9 : 20 + index,
        lastReadAt: index,
      })),
    );

    const prompt = manager.formatForPrompt('parent-1') ?? '';
    expect(prompt).not.toContain('file-0.ts');
    expect(prompt).toContain('file-9.ts (29 lines)');
    expect(prompt).toContain('(+1 more)');
  });
});

describe('deriveTaskSessionLabel', () => {
  test('prefers description over prompt', () => {
    expect(
      deriveTaskSessionLabel({
        description: 'config schema lookup',
        prompt: 'ignored prompt line',
        agentType: 'explorer',
      }),
    ).toBe('config schema lookup');
  });

  test('falls back to prompt then generic label', () => {
    expect(
      deriveTaskSessionLabel({
        prompt: '\n  inspect task resumption support  \nmore context',
        agentType: 'explorer',
      }),
    ).toBe('inspect task resumption support');

    expect(
      deriveTaskSessionLabel({
        agentType: 'fixer',
      }),
    ).toBe('recent fixer task');
  });
});
