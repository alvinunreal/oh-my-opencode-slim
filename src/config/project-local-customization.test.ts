import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgents } from '../agents';
import { loadAgentPrompt, mergePluginConfigs } from './loader';
import { PluginConfigSchema } from './schema';

describe('Project-local customization - 15 core cases', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-custom-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  // Test Case 1: Project prompt root beats user prompt root
  test('1. Project prompt root beats user prompt root', () => {
    const userDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'oracle.md'), 'user-oracle');

    const projectDir = path.join(tempDir, 'project');
    const projectPromptDir = path.join(
      projectDir,
      '.opencode',
      'oh-my-opencode-slim',
    );
    fs.mkdirSync(projectPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectPromptDir, 'oracle.md'),
      'project-oracle',
    );

    const loaded = loadAgentPrompt('oracle', { projectDirectory: projectDir });
    expect(loaded.prompt).toBe('project-oracle');
  });

  // Test Case 2: Project preset prompt beats project root prompt
  test('2. Project preset prompt beats project root prompt', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectPromptDir = path.join(
      projectDir,
      '.opencode',
      'oh-my-opencode-slim',
    );
    const projectPresetDir = path.join(projectPromptDir, 'test-preset');
    fs.mkdirSync(projectPresetDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectPromptDir, 'oracle.md'),
      'project-root-oracle',
    );
    fs.writeFileSync(
      path.join(projectPresetDir, 'oracle.md'),
      'project-preset-oracle',
    );

    const loaded = loadAgentPrompt('oracle', {
      preset: 'test-preset',
      projectDirectory: projectDir,
    });
    expect(loaded.prompt).toBe('project-preset-oracle');
  });

  // Test Case 3: User preset prompt beats user root prompt when no project prompt exists
  test('3. User preset prompt beats user root prompt when no project prompt exists', () => {
    const userDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const userPresetDir = path.join(userDir, 'test-preset');
    fs.mkdirSync(userPresetDir, { recursive: true });

    fs.writeFileSync(path.join(userDir, 'oracle.md'), 'user-root-oracle');
    fs.writeFileSync(
      path.join(userPresetDir, 'oracle.md'),
      'user-preset-oracle',
    );

    const loaded = loadAgentPrompt('oracle', { preset: 'test-preset' });
    expect(loaded.prompt).toBe('user-preset-oracle');
  });

  // Test Case 4: Replacement and append both apply together
  test('4. Replacement and append both apply together', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectPromptDir = path.join(
      projectDir,
      '.opencode',
      'oh-my-opencode-slim',
    );
    fs.mkdirSync(projectPromptDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectPromptDir, 'oracle.md'),
      'replacement prompt',
    );
    fs.writeFileSync(
      path.join(projectPromptDir, 'oracle_append.md'),
      'append prompt',
    );

    const agents = createAgents(undefined, { projectDirectory: projectDir });
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.prompt).toBe('replacement prompt\n\nappend prompt');
  });

  // Test Case 5: Inline built-in prompt is accepted and used
  test('5. Inline built-in prompt is accepted and used', () => {
    const config = {
      agents: {
        oracle: {
          model: 'openai/gpt-4o',
          prompt: 'You are the inline oracle prompt override.',
        },
      },
    };

    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.prompt).toBe(
      'You are the inline oracle prompt override.',
    );
  });

  // Test Case 6: File prompt overrides inline built-in prompt
  test('6. File prompt overrides inline built-in prompt', () => {
    const config = {
      agents: {
        oracle: {
          model: 'openai/gpt-4o',
          prompt: 'You are the inline oracle prompt override.',
        },
      },
    };

    // User prompt file mock
    const userDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'oracle.md'),
      'File prompt override content',
    );

    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.prompt).toBe('File prompt override content');
  });

  // Test Case 7: Append file appends to inline built-in prompt
  test('7. Append file appends to inline built-in prompt', () => {
    const config = {
      agents: {
        oracle: {
          model: 'openai/gpt-4o',
          prompt: 'You are the inline oracle prompt override.',
        },
      },
    };

    // User append file mock
    const userDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'oracle_append.md'), 'append content');

    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.prompt).toBe(
      'You are the inline oracle prompt override.\n\nappend content',
    );
  });

  // Test Case 8: Built-in orchestratorPrompt is injected into orchestrator prompt
  test('8. Built-in orchestratorPrompt is injected into orchestrator prompt', () => {
    const config = {
      agents: {
        oracle: {
          model: 'openai/gpt-4o',
          orchestratorPrompt:
            'Please routing to @oracle when architecture is queried.',
        },
      },
    };

    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?.config.prompt).toContain(
      '# Project-specific routing guidance',
    );
    expect(orchestrator?.config.prompt).toContain(
      'Please routing to @oracle when architecture is queried.',
    );
  });

  // Test Case 9: Disabled built-in agent\'s orchestratorPrompt is not injected
  test("9. Disabled built-in agent's orchestratorPrompt is not injected", () => {
    const config = {
      disabled_agents: ['oracle'],
      agents: {
        oracle: {
          model: 'openai/gpt-4o',
          orchestratorPrompt:
            'Please routing to @oracle when architecture is queried.',
        },
      },
    };

    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?.config.prompt).not.toContain(
      'Please routing to @oracle',
    );
  });

  // Test Case 10: agents.orchestrator.orchestratorPrompt is rejected or explicitly ignored
  test('10. agents.orchestrator.orchestratorPrompt is rejected', () => {
    const invalidConfig = {
      agents: {
        orchestrator: {
          model: 'openai/gpt-4o',
          orchestratorPrompt: 'Self guidance',
        },
      },
    };

    const parsed = PluginConfigSchema.safeParse(invalidConfig);
    expect(parsed.success).toBe(false);
  });

  // Test Case 11: presets deep-merge preserves unrelated user presets
  test('11. presets deep-merge preserves unrelated user presets', () => {
    const userConfig = {
      presets: {
        presetA: {
          oracle: { model: 'model-a' },
        },
      },
    };

    const projectConfig = {
      presets: {
        presetB: {
          explorer: { model: 'model-b' },
        },
      },
    };

    const merged = mergePluginConfigs(userConfig, projectConfig);
    expect(merged.presets?.presetA).toBeDefined();
    expect(merged.presets?.presetB).toBeDefined();
    expect(merged.presets?.presetA.oracle?.model).toBe('model-a');
    expect(merged.presets?.presetB.explorer?.model).toBe('model-b');
  });

  // Test Case 12: Same-name preset deep-merges by agent and nested options
  test('12. Same-name preset deep-merges by agent and nested options', () => {
    const userConfig = {
      presets: {
        myPreset: {
          oracle: {
            model: 'model-a',
            options: { tokenLimit: 1000, debug: true },
          },
        },
      },
    };

    const projectConfig = {
      presets: {
        myPreset: {
          oracle: {
            temperature: 0.7,
            options: { debug: false, maxSearch: 5 },
          },
        },
      },
    };

    const merged = mergePluginConfigs(userConfig, projectConfig);
    const oraclePreset = merged.presets?.myPreset?.oracle;
    expect(oraclePreset?.model).toBe('model-a');
    expect(oraclePreset?.temperature).toBe(0.7);
    expect(oraclePreset?.options).toEqual({
      tokenLimit: 1000,
      debug: false,
      maxSearch: 5,
    });
  });

  // Test Case 13: Project config still overrides user config for root agents
  test('13. Project config still overrides user config for root agents', () => {
    const userConfig = {
      agents: {
        oracle: {
          model: 'user-model',
          temperature: 0.1,
        },
      },
    };

    const projectConfig = {
      agents: {
        oracle: {
          model: 'project-model',
        },
      },
    };

    const merged = mergePluginConfigs(userConfig, projectConfig);
    expect(merged.agents?.oracle?.model).toBe('project-model');
    expect(merged.agents?.oracle?.temperature).toBe(0.1);
  });

  // Test Case 14: Schema accepts built-in prompt/orchestratorPrompt in root and presets, but rejects empty strings
  test('14. Schema accepts built-in prompt/orchestratorPrompt in root and presets, but rejects empty strings', () => {
    // Non-empty is allowed
    const valid = PluginConfigSchema.safeParse({
      agents: {
        oracle: {
          prompt: 'non-empty prompt',
          orchestratorPrompt: 'non-empty guidance',
        },
      },
    });
    expect(valid.success).toBe(true);

    // Empty prompt is rejected
    const invalidPrompt = PluginConfigSchema.safeParse({
      agents: {
        oracle: {
          prompt: '',
        },
      },
    });
    expect(invalidPrompt.success).toBe(false);

    // Empty orchestratorPrompt is rejected
    const invalidOrchestrator = PluginConfigSchema.safeParse({
      agents: {
        oracle: {
          orchestratorPrompt: '',
        },
      },
    });
    expect(invalidOrchestrator.success).toBe(false);
  });

  // Test Case 15: Docs examples match actual precedence
  test('15. Precedence chain: project preset -> project root -> user preset -> user root', () => {
    const userDir = path.join(tempDir, 'opencode');
    const userPromptDir = path.join(userDir, 'oh-my-opencode-slim');
    const userPresetDir = path.join(userPromptDir, 'my-preset');

    const projectDir = path.join(tempDir, 'project');
    const projectPromptDir = path.join(
      projectDir,
      '.opencode',
      'oh-my-opencode-slim',
    );
    const projectPresetDir = path.join(projectPromptDir, 'my-preset');

    fs.mkdirSync(userPresetDir, { recursive: true });
    fs.mkdirSync(projectPresetDir, { recursive: true });

    fs.writeFileSync(path.join(userPromptDir, 'oracle.md'), 'user-root');
    fs.writeFileSync(path.join(userPresetDir, 'oracle.md'), 'user-preset');
    fs.writeFileSync(path.join(projectPromptDir, 'oracle.md'), 'project-root');
    fs.writeFileSync(
      path.join(projectPresetDir, 'oracle.md'),
      'project-preset',
    );

    // 1. All exist -> project preset won
    let result = loadAgentPrompt('oracle', {
      preset: 'my-preset',
      projectDirectory: projectDir,
    });
    expect(result.prompt).toBe('project-preset');

    // 2. Remove project preset -> project root won
    fs.unlinkSync(path.join(projectPresetDir, 'oracle.md'));
    result = loadAgentPrompt('oracle', {
      preset: 'my-preset',
      projectDirectory: projectDir,
    });
    expect(result.prompt).toBe('project-root');

    // 3. Remove project root -> user preset won
    fs.unlinkSync(path.join(projectPromptDir, 'oracle.md'));
    result = loadAgentPrompt('oracle', {
      preset: 'my-preset',
      projectDirectory: projectDir,
    });
    expect(result.prompt).toBe('user-preset');

    // 4. Remove user preset -> user root won
    fs.unlinkSync(path.join(userPresetDir, 'oracle.md'));
    result = loadAgentPrompt('oracle', {
      preset: 'my-preset',
      projectDirectory: projectDir,
    });
    expect(result.prompt).toBe('user-root');
  });
});
