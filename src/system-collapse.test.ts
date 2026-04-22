import { test, expect, describe } from 'bun:test';

/**
 * Regression tests for the system message collapse in the
 * experimental.chat.system.transform hook.
 *
 * PR #336's collapse was a silent no-op because it reassigned
 * output.system to a new array, but OpenCode core reads from the
 * original array reference. The fix mutates in-place.
 *
 * These tests validate the in-place mutation contract directly,
 * without needing the full plugin machinery.
 */

describe('system array in-place collapse', () => {
  function collapse(output: { system: string[] }): void {
    const joined = output.system.join('\n\n');
    output.system.length = 0;
    if (joined) {
      output.system.push(joined);
    }
  }

  test('mutates multi-element array in-place', () => {
    const system = ['part one', 'part two'];
    const output = { system };

    collapse(output);

    // Same reference — callers holding the original array see the change
    expect(output.system).toBe(system);
    expect(system).toHaveLength(1);
    expect(system[0]).toBe('part one\n\npart two');
  });

  test('mutates three-element array in-place', () => {
    const system = ['header', 'todo reminder', 'file nudge'];
    const output = { system };

    collapse(output);

    expect(output.system).toBe(system);
    expect(system).toHaveLength(1);
    expect(system[0]).toBe('header\n\ntodo reminder\n\nfile nudge');
  });

  test('handles single-element array', () => {
    const system = ['only element'];
    const output = { system };

    collapse(output);

    expect(output.system).toBe(system);
    expect(system).toHaveLength(1);
    expect(system[0]).toBe('only element');
  });

  test('handles empty array', () => {
    const system: string[] = [];
    const output = { system };

    collapse(output);

    expect(output.system).toBe(system);
    expect(system).toHaveLength(0);
  });

  test('reassignment would NOT be visible (regression guard)', () => {
    // This test documents WHY we mutate in-place and not via reassignment.
    // Simulating the broken PR #336 approach to prove it fails.
    const system = ['a', 'b'];
    const output = { system };

    // Broken approach: reassign the property
    output.system = [output.system.join('\n\n')];

    // The output object sees the new array...
    expect(output.system).toEqual(['a\n\nb']);

    // ...but the original reference is untouched — this is the bug.
    expect(system).toEqual(['a', 'b']);
    expect(system).not.toBe(output.system);
  });
});
