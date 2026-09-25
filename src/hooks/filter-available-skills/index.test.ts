import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { PluginInput } from '@opencode-ai/plugin';
import { buildResolvedAgentRegistry } from '../../agents';
import type { PluginConfig } from '../../config';
import { RuntimeConfig } from '../../config/runtime';
import type { V2PermissionRule } from '../../v2/types';
import {
  createFilterAvailableSkillsHook,
  filterAvailableSkillsText,
} from './index';

const mockCtx = {} as PluginInput;
const TEST_DIRECTORY = 'runtime-test-filter-skills';

function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(TEST_DIRECTORY);
}

function skillBlock(name: string): string {
  return `<skill>
  <name>${name}</name>
  <description>${name} description</description>
  <location>file:///tmp/${name}</location>
</skill>`;
}

function availableSkillsBlock(...names: string[]): string {
  return `<available_skills>
${names.map((name) => skillBlock(name)).join('\n')}
</available_skills>`;
}

describe('filterAvailableSkillsText', () => {
  test('keeps only allowed skills using exact skill names', () => {
    const text = availableSkillsBlock('skill1', 'skill2', 'skill3');
    const result = filterAvailableSkillsText(text, {
      '*': 'deny',
      skill1: 'allow',
      skill3: 'allow',
    });

    expect(result).toContain('<name>skill1</name>');
    expect(result).not.toContain('<name>skill2</name>');
    expect(result).toContain('<name>skill3</name>');
  });

  test('renders No skills available when nothing is allowed', () => {
    const result = filterAvailableSkillsText(availableSkillsBlock('skill1'), {
      '*': 'deny',
    });

    expect(result).toContain('No skills available.');
    expect(result).not.toContain('<name>skill1</name>');
  });
});

describe('createFilterAvailableSkillsHook', () => {
  test('v1 registry hides role skills denied by a scalar skill policy', async () => {
    const runtime = runtimeFor({
      agents: {
        oracle: {
          displayName: 'advisor',
          permission: { skill: 'deny' },
        },
      },
    });
    const registry = buildResolvedAgentRegistry(runtime);
    expect(registry.skillPermissions.advisor).toEqual({ '*': 'deny' });
    const hook = createFilterAvailableSkillsHook(mockCtx, registry);
    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [{ type: 'text', text: availableSkillsBlock('simplify') }],
        },
        {
          info: { role: 'user', agent: 'advisor' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };
    await hook['experimental.chat.messages.transform']({}, output);
    expect(output.messages[0].parts[0].text).toContain('No skills available.');
    expect(output.messages[0].parts[0].text).not.toContain(
      '<name>simplify</name>',
    );
  });

  test('uses the immutable v2 policy for native host wildcard and skill exceptions', async () => {
    const runtime = runtimeFor({
      agents: { explorer: { skills: ['codemap'] } },
    });
    const hostRules: V2PermissionRule[] = [
      { action: 'skill', resource: '*', effect: 'deny' },
      { action: 'skill', resource: 'codemap', effect: 'allow' },
    ];
    const registry = buildResolvedAgentRegistry(runtime, {
      hostFlavor: 'v2',
      nativePermissionsByAgent: { explorer: hostRules },
    });
    const hook = createFilterAvailableSkillsHook(mockCtx, registry);
    assert(hostRules[1]);
    hostRules[1].effect = 'deny';
    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [
            {
              type: 'text',
              text: availableSkillsBlock('codemap', 'clonedeps'),
            },
          ],
        },
        {
          info: { role: 'user', agent: 'explorer' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);
    const text = output.messages[0].parts[0].text;
    expect(text).toContain('<name>codemap</name>');
    expect(text).not.toContain('<name>clonedeps</name>');
  });

  test('ignores messages without OpenCode info or parts', async () => {
    const hook = createFilterAvailableSkillsHook(mockCtx, runtimeFor());
    const output = {
      messages: [
        {},
        { info: { role: 'assistant' } },
        {
          info: { role: 'system' },
          parts: [{ type: 'text', text: availableSkillsBlock('skill1') }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output as never);

    expect(output.messages[2].parts[0].text).toContain('<name>skill1</name>');
  });

  test('filters system prompt skill blocks for explicit agent skills', async () => {
    const config: PluginConfig = {
      agents: {
        explorer: {
          skills: ['skill1', 'skill3'],
        },
      },
    };

    const hook = createFilterAvailableSkillsHook(mockCtx, runtimeFor(config));
    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [
            {
              type: 'text',
              text: availableSkillsBlock('skill1', 'skill2', 'skill3'),
            },
          ],
        },
        {
          info: { role: 'user', agent: 'explorer' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    const resultText = output.messages[0].parts[0].text;
    expect(resultText).toContain('<name>skill1</name>');
    expect(resultText).not.toContain('<name>skill2</name>');
    expect(resultText).toContain('<name>skill3</name>');
  });

  test('projects skills from the resolved agent registry', async () => {
    const registry = {
      skillPermissions: {
        researcher: { codemap: 'allow', '*': 'deny' },
      },
    } as never;
    const hook = createFilterAvailableSkillsHook(mockCtx, registry);
    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [
            {
              type: 'text',
              text: availableSkillsBlock('codemap', 'clonedeps'),
            },
          ],
        },
        {
          info: { role: 'user', agent: 'researcher' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toContain('<name>codemap</name>');
    expect(output.messages[0].parts[0].text).not.toContain(
      '<name>clonedeps</name>',
    );
  });

  test('shows no skills for agents configured with an empty skills list', async () => {
    const config: PluginConfig = {
      agents: {
        fixer: {
          skills: [],
        },
      },
    };

    const hook = createFilterAvailableSkillsHook(mockCtx, runtimeFor(config));
    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [{ type: 'text', text: availableSkillsBlock('skill1') }],
        },
        {
          info: { role: 'user', agent: 'fixer' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    const resultText = output.messages[0].parts[0].text;
    expect(resultText).toContain('No skills available.');
    expect(resultText).not.toContain('<name>skill1</name>');
  });

  test('preserves orchestrator default wildcard allow', async () => {
    const hook = createFilterAvailableSkillsHook(mockCtx, runtimeFor());
    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [
            { type: 'text', text: availableSkillsBlock('skill1', 'skill2') },
          ],
        },
        {
          info: { role: 'user', agent: 'orchestrator' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    const resultText = output.messages[0].parts[0].text;
    expect(resultText).toContain('<name>skill1</name>');
    expect(resultText).toContain('<name>skill2</name>');
  });

  test('supports wildcard allow with explicit exclusions', async () => {
    const config: PluginConfig = {
      agents: {
        designer: {
          skills: ['*', '!skill2'],
        },
      },
    };

    const hook = createFilterAvailableSkillsHook(mockCtx, runtimeFor(config));
    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [
            { type: 'text', text: availableSkillsBlock('skill1', 'skill2') },
          ],
        },
        {
          info: { role: 'user', agent: 'designer' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    const resultText = output.messages[0].parts[0].text;
    expect(resultText).toContain('<name>skill1</name>');
    expect(resultText).not.toContain('<name>skill2</name>');
  });

  test('defaults to orchestrator when no agent is present', async () => {
    const hook = createFilterAvailableSkillsHook(mockCtx, runtimeFor());
    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [{ type: 'text', text: availableSkillsBlock('skill1') }],
        },
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toContain('<name>skill1</name>');
  });

  test('filters multiple skill blocks across messages', async () => {
    const config: PluginConfig = {
      agents: {
        explorer: {
          skills: ['skill1'],
        },
      },
    };

    const hook = createFilterAvailableSkillsHook(mockCtx, runtimeFor(config));
    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [
            {
              type: 'text',
              text: `Intro\n${availableSkillsBlock('skill1', 'skill2')}`,
            },
          ],
        },
        {
          info: { role: 'developer' },
          parts: [
            { type: 'text', text: availableSkillsBlock('skill2', 'skill3') },
          ],
        },
        {
          info: { role: 'user', agent: 'explorer' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toContain('<name>skill1</name>');
    expect(output.messages[0].parts[0].text).not.toContain(
      '<name>skill2</name>',
    );
    expect(output.messages[1].parts[0].text).toContain('No skills available.');
  });

  test('reuses permission rules without caching the final skills block text', async () => {
    const config: PluginConfig = {
      agents: {
        explorer: {
          skills: ['skill1', 'skill3'],
        },
      },
    };

    const hook = createFilterAvailableSkillsHook(mockCtx, runtimeFor(config));
    const firstOutput = {
      messages: [
        {
          info: { role: 'system' },
          parts: [
            {
              type: 'text',
              text: availableSkillsBlock('skill1', 'skill2'),
            },
          ],
        },
        {
          info: { role: 'user', agent: 'explorer' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };
    const secondOutput = {
      messages: [
        {
          info: { role: 'system' },
          parts: [
            {
              type: 'text',
              text: availableSkillsBlock('skill2', 'skill3'),
            },
          ],
        },
        {
          info: { role: 'user', agent: 'explorer' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, firstOutput);
    await hook['experimental.chat.messages.transform']({}, secondOutput);

    expect(firstOutput.messages[0].parts[0].text).toContain(
      '<name>skill1</name>',
    );
    expect(firstOutput.messages[0].parts[0].text).not.toContain(
      '<name>skill3</name>',
    );
    expect(secondOutput.messages[0].parts[0].text).not.toContain(
      '<name>skill1</name>',
    );
    expect(secondOutput.messages[0].parts[0].text).toContain(
      '<name>skill3</name>',
    );
  });

  test('keeps the registry snapshot when runtime config is reseeded', async () => {
    const runtime = runtimeFor({
      agents: {
        fixer: {
          skills: ['skill1'],
        },
      },
    });
    const hook = createFilterAvailableSkillsHook(mockCtx, runtime);

    RuntimeConfig.init(TEST_DIRECTORY, {
      agents: {
        fixer: {
          skills: ['skill2'],
        },
      },
    });

    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [
            { type: 'text', text: availableSkillsBlock('skill1', 'skill2') },
          ],
        },
        {
          info: { role: 'user', agent: 'fixer' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toContain('<name>skill1</name>');
    expect(output.messages[0].parts[0].text).not.toContain(
      '<name>skill2</name>',
    );
  });
});
