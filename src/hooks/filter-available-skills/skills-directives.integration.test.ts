import { describe, expect, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginConfig } from '../../config';
import { RuntimeConfig } from '../../config/runtime';
import { createFilterAvailableSkillsHook } from './index';

const mockCtx = {} as PluginInput;
const TEST_DIRECTORY = 'runtime-test-filter-skills-directives';

function runtimeFor(config: PluginConfig) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config);
  return RuntimeConfig.get(TEST_DIRECTORY);
}

function skillBlock(name: string): string {
  return `<skill>\n  <name>${name}</name>\n  <description>${name} description</description>\n  <location>file:///tmp/${name}</location>\n</skill>`;
}

function availableSkillsBlock(...names: string[]): string {
  return `<available_skills>\n${names.map((name) => skillBlock(name)).join('\n')}\n</available_skills>`;
}

describe('available-skills integration with skill directives', () => {
  test('lifted exclusion is re-added before the hook filters the prompt', async () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          skills: ['skill1', '!skill2'],
          skills_add: ['skill2'],
          skills_remove: ['!skill2'],
        },
      },
    };

    const runtime = runtimeFor(config);
    expect(runtime.agents().oracle?.skills).toEqual(['skill1', 'skill2']);

    const hook = createFilterAvailableSkillsHook(mockCtx, runtime);
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
          info: { role: 'user', agent: 'oracle' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    const resultText = output.messages[0].parts[0].text;
    expect(resultText).toContain('<name>skill1</name>');
    expect(resultText).toContain('<name>skill2</name>');
    expect(resultText).not.toContain('<name>skill3</name>');

    RuntimeConfig.reset(TEST_DIRECTORY);
  });
});
