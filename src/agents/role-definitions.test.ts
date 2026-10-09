import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createDesignerAgent } from './designer';
import { createExplorerAgent } from './explorer';
import { createFixerAgent } from './fixer';
import { createLibrarianAgent } from './librarian';
import { createObserverAgent } from './observer';
import { createOracleAgent } from './oracle';
import { buildOrchestratorPrompt } from './orchestrator';
import { ROLE_DEFINITIONS, SPECIALIST_ROLES } from './role-definitions';
import { ROLE_ROUTING_BLOCKS } from './role-routing';

const FACTORIES = {
  explorer: createExplorerAgent,
  librarian: createLibrarianAgent,
  oracle: createOracleAgent,
  designer: createDesignerAgent,
  fixer: createFixerAgent,
  observer: createObserverAgent,
} as const;

describe('specialist role definitions', () => {
  test('matches golden factory prompts and descriptions', () => {
    const outputs = SPECIALIST_ROLES.map((role) => {
      const agent = FACTORIES[role]('test/model');
      return {
        name: agent.name,
        description: agent.description,
        promptSha256: createHash('sha256')
          .update(agent.config.prompt)
          .digest('hex'),
      };
    });

    expect(outputs).toMatchSnapshot();
  });

  test('preserve baseline factory definitions', () => {
    expect(Object.keys(ROLE_DEFINITIONS)).toEqual([...SPECIALIST_ROLES]);

    for (const role of SPECIALIST_ROLES) {
      const definition = ROLE_DEFINITIONS[role];
      const agent = FACTORIES[role]('test/model');
      expect(agent.name).toBe(role);
      expect(agent.description).toBe(definition.description);
      expect(agent.config.model).toBe('test/model');
      expect(agent.config.prompt).toBe(definition.prompt);
    }
  });

  test('preserves custom prompt precedence and append behavior', () => {
    const base = ROLE_DEFINITIONS.explorer.prompt;
    expect(createExplorerAgent('m', 'custom', 'append').config.prompt).toBe(
      'custom',
    );
    expect(createExplorerAgent('m', undefined, 'append').config.prompt).toBe(
      `${base}\n\nappend`,
    );
  });

  test('keeps routing blocks available for specialists and council', () => {
    const prompt = buildOrchestratorPrompt();
    for (const role of SPECIALIST_ROLES) {
      expect(prompt).toContain(ROLE_ROUTING_BLOCKS[role]);
    }
    expect(prompt).toContain(ROLE_ROUTING_BLOCKS.council);
    expect(buildOrchestratorPrompt(new Set(['explorer']))).not.toContain(
      ROLE_ROUTING_BLOCKS.explorer,
    );
  });
  test('keeps behavioral steering while fixing local prompt inconsistencies', () => {
    const designerPrompt = ROLE_DEFINITIONS.designer.prompt;

    expect(designerPrompt).toContain(
      'Prioritize visual excellence-code perfection comes second',
    );
    expect(designerPrompt).toContain('requested product language');
    expect(designerPrompt).not.toContain('regular english');

    expect(ROLE_ROUTING_BLOCKS.council).toContain(
      'Permissions: Synthesis only; no tools',
    );
    expect(ROLE_ROUTING_BLOCKS.council).toContain(
      'Stats: 3x slower than orchestrator',
    );
    expect(ROLE_ROUTING_BLOCKS.oracle).toContain(
      'materially reduces risk or uncertainty',
    );
  });
});

describe('nested-dispatch stance', () => {
  test('advisory roles scope task to observer-only with deny-first order', () => {
    for (const role of [
      'explorer',
      'librarian',
      'oracle',
      'designer',
    ] as const) {
      const def = FACTORIES[role]('provider/model');
      const task = (
        def.config.permission as Record<string, Record<string, string>>
      ).task;
      expect(task).toBeDefined();
      // Last-match evaluation: the '*' deny must precede the observer allow.
      expect(Object.keys(task)).toEqual(['*', 'observer']);
      expect(task['*']).toBe('deny');
      expect(task.observer).toBe('allow');
    }
  });

  test('fixer and observer deny nested dispatch entirely', () => {
    for (const role of ['fixer', 'observer'] as const) {
      const def = FACTORIES[role]('provider/model');
      const task = (
        def.config.permission as Record<string, Record<string, string>>
      ).task;
      expect(task).toEqual({ '*': 'deny' });
    }
  });
});
