import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgents } from '../agents';
import { loadAgentPrompt, mergePluginConfigs } from './loader';
import { resolvePreset } from './presets';
import { RuntimeConfig } from './runtime';
import { type PluginConfig, PluginConfigSchema } from './schema';

const TEST_DIRECTORY = 'runtime-test-project-local';
function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(TEST_DIRECTORY);
}

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
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test('inherits prompts across repository and nested worktree boundaries', () => {
    const workspace = path.join(tempDir, 'workspace');
    const repository = path.join(workspace, 'repository');
    const worktree = path.join(repository, '.slim', 'worktrees', 'feature');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ignored-fixture');
    const prompts = path.join(workspace, '.opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(path.join(prompts, 'team'), { recursive: true });
    fs.writeFileSync(path.join(prompts, 'oracle.md'), 'ancestor-root');
    fs.writeFileSync(
      path.join(prompts, 'team', 'oracle.md'),
      'ancestor-preset',
    );
    fs.writeFileSync(path.join(prompts, 'oracle_append.md'), 'ancestor-append');

    expect(
      loadAgentPrompt('oracle', {
        preset: 'team',
        projectDirectory: worktree,
        hostFlavor: 'v2',
      }),
    ).toEqual({ prompt: 'ancestor-preset', appendPrompt: 'ancestor-append' });

    const localPrompts = path.join(
      worktree,
      '.opencode',
      'oh-my-opencode-slim',
    );
    fs.mkdirSync(localPrompts, { recursive: true });
    fs.writeFileSync(path.join(localPrompts, 'oracle.md'), 'local-root');
    expect(
      loadAgentPrompt('oracle', {
        preset: 'team',
        projectDirectory: worktree,
        hostFlavor: 'v2',
      }),
    ).toEqual({ prompt: 'local-root', appendPrompt: 'ancestor-append' });

    fs.writeFileSync(
      path.join(localPrompts, 'oracle_append.md'),
      'local-append',
    );
    expect(
      loadAgentPrompt('oracle', {
        preset: 'team',
        projectDirectory: worktree,
        hostFlavor: 'v2',
      }),
    ).toEqual({ prompt: 'local-root', appendPrompt: 'local-append' });
  });

  test('ancestor prompts beat global prompts and do not search siblings', () => {
    const workspace = path.join(tempDir, 'workspace');
    const worktree = path.join(workspace, 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    const userPrompts = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const ancestorPrompts = path.join(
      workspace,
      '.opencode',
      'oh-my-opencode-slim',
    );
    const siblingPrompts = path.join(
      workspace,
      'other',
      '.opencode',
      'oh-my-opencode-slim',
    );
    for (const directory of [userPrompts, ancestorPrompts, siblingPrompts]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(userPrompts, 'oracle.md'), 'global');
    fs.writeFileSync(path.join(ancestorPrompts, 'oracle.md'), 'ancestor');
    fs.writeFileSync(path.join(siblingPrompts, 'explorer.md'), 'sibling');

    expect(
      loadAgentPrompt('oracle', { projectDirectory: worktree }).prompt,
    ).toBe('ancestor');
    expect(
      loadAgentPrompt('explorer', { projectDirectory: worktree }).prompt,
    ).toBeUndefined();
    fs.unlinkSync(path.join(ancestorPrompts, 'oracle.md'));
    expect(
      loadAgentPrompt('oracle', { projectDirectory: worktree }).prompt,
    ).toBe('global');
  });

  test('agent factories apply inherited prompt files in a nested worktree', () => {
    const workspace = path.join(tempDir, 'workspace');
    const worktree = path.join(workspace, 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    const prompts = path.join(workspace, '.opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(prompts, { recursive: true });
    fs.writeFileSync(
      path.join(prompts, 'oracle.md'),
      'ancestor oracle instructions',
    );
    fs.writeFileSync(
      path.join(prompts, 'oracle_append.md'),
      'ancestor extra rules',
    );
    const runtime = RuntimeConfig.createDetached(worktree, {});
    const oracle = createAgents(runtime, { projectDirectory: worktree }).find(
      (agent) => agent.name === 'oracle',
    );
    expect(oracle?.config.prompt).toContain('ancestor oracle instructions');
    expect(oracle?.config.prompt).toContain('ancestor extra rules');
  });

  test('pre-rename librarian prompt files apply to explorer and warn once', () => {
    const userDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'librarian.md'), 'legacy prompt');
    fs.writeFileSync(
      path.join(userDir, 'librarian_append.md'),
      'legacy append',
    );

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadAgentPrompt('explorer', {})).toEqual({
        prompt: 'legacy prompt',
        appendPrompt: 'legacy append',
      });
      // Repeated loads keep applying the files; each stale file warns once.
      expect(loadAgentPrompt('explorer', {}).prompt).toBe('legacy prompt');
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "'librarian.md' uses a pre-rename name",
      );
      expect(String(warn.mock.calls[1]?.[0])).toContain(
        "'librarian_append.md' uses a pre-rename name",
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('explorer prompt files win over the pre-rename librarian files', () => {
    const userDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'explorer.md'), 'canonical prompt');
    fs.writeFileSync(path.join(userDir, 'librarian.md'), 'legacy prompt');

    expect(loadAgentPrompt('explorer', {})).toEqual({
      prompt: 'canonical prompt',
    });
  });

  test('local legacy prompt files take precedence over global canonical files', () => {
    const userDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const projectDir = path.join(tempDir, 'project');
    const localDir = path.join(projectDir, '.opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'explorer.md'), 'global prompt');
    fs.writeFileSync(path.join(userDir, 'explorer_append.md'), 'global append');
    fs.writeFileSync(path.join(localDir, 'librarian.md'), 'local prompt');
    fs.writeFileSync(
      path.join(localDir, 'librarian_append.md'),
      'local append',
    );
    for (const hostFlavor of ['v1', 'v2']) {
      expect(
        loadAgentPrompt('explorer', {
          projectDirectory: projectDir,
          hostFlavor,
        }),
      ).toEqual({ prompt: 'local prompt', appendPrompt: 'local append' });
    }
    fs.unlinkSync(path.join(localDir, 'librarian_append.md'));
    expect(
      loadAgentPrompt('explorer', { projectDirectory: projectDir }),
    ).toEqual({
      prompt: 'local prompt',
      appendPrompt: 'global append',
    });
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

    const agents = createAgents(runtimeFor(undefined), {
      projectDirectory: projectDir,
    });
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

    const agents = createAgents(runtimeFor(config));
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.prompt).toBe(
      'You are the inline oracle prompt override.',
    );
  });

  // Test Case 6: Inline prompt overrides file prompt
  test('6. Inline prompt overrides file prompt', () => {
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

    const agents = createAgents(runtimeFor(config));
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.prompt).toBe(
      'You are the inline oracle prompt override.',
    );
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

    const agents = createAgents(runtimeFor(config));
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

    const agents = createAgents(runtimeFor(config));
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

    const agents = createAgents(runtimeFor(config));
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

  test('same-name project inheritance clears user preset models', () => {
    const merged = mergePluginConfigs(
      {
        presets: {
          session: {
            explore: {
              model: 'user/explorer',
              options: { fromUser: true, shared: { user: true } },
            },
          },
          orchestrator: {
            oracle: { model: 'user/oracle' },
          },
        },
      },
      {
        presets: {
          session: {
            explorer: {
              inheritModelFrom: 'session',
              options: { fromProject: true, shared: { project: true } },
            },
          },
          orchestrator: {
            oracle: { inheritModelFrom: 'orchestrator' },
          },
        },
      },
    );

    expect(resolvePreset('session', merged.presets ?? {})).toEqual({
      explorer: {
        inheritModelFrom: 'session',
        options: {
          fromUser: true,
          fromProject: true,
          shared: { user: true, project: true },
        },
      },
    });
    expect(resolvePreset('orchestrator', merged.presets ?? {})).toEqual({
      oracle: { inheritModelFrom: 'orchestrator' },
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
