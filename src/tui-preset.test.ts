import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { openPresetManager } from './tui-preset';
import type { TuiSnapshot } from './tui-state';

let tempDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-preset-test-'));
  process.env.OPENCODE_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

interface MockDialogElement {
  type: string;
  props: Record<string, unknown>;
}

interface MockToast {
  variant?: string;
  title?: string;
  message?: string;
}

function createMockApi() {
  const dialogStack: Array<() => unknown> = [];
  const toasts: MockToast[] = [];

  const api = {
    ui: {
      dialog: {
        replace: (renderFn: () => unknown) => {
          dialogStack.push(renderFn);
        },
        clear: () => {
          dialogStack.length = 0;
        },
      },
      Dialog: (props: Record<string, unknown>): MockDialogElement => ({
        type: 'Dialog',
        props,
      }),
      DialogSelect: (props: Record<string, unknown>): MockDialogElement => ({
        type: 'DialogSelect',
        props,
      }),
      DialogConfirm: (props: Record<string, unknown>): MockDialogElement => ({
        type: 'DialogConfirm',
        props,
      }),
      DialogPrompt: (props: Record<string, unknown>): MockDialogElement => ({
        type: 'DialogPrompt',
        props,
      }),
      toast: (t: MockToast) => {
        toasts.push(t);
      },
    },
    client: {
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: 'anthropic',
                models: {
                  'claude-3.5-haiku': { name: 'Claude 3.5 Haiku' },
                },
              },
            ],
          },
        }),
      },
    },
  } as unknown as TuiPluginApi;

  const getCurrentDialog = (): MockDialogElement | null => {
    if (dialogStack.length === 0) return null;
    const renderFn = dialogStack[dialogStack.length - 1];
    return renderFn() as MockDialogElement;
  };

  const getSelectProps = (): Record<string, unknown> | null => {
    const dialog = getCurrentDialog();
    if (!dialog?.props.children) return null;
    const child = dialog.props.children as MockDialogElement;
    return child.type === 'DialogSelect' ? child.props : null;
  };

  const getConfirmProps = (): Record<string, unknown> | null => {
    const dialog = getCurrentDialog();
    if (!dialog?.props.children) return null;
    const child = dialog.props.children as MockDialogElement;
    return child.type === 'DialogConfirm' ? child.props : null;
  };

  const getPromptProps = (): Record<string, unknown> | null => {
    const dialog = getCurrentDialog();
    if (!dialog?.props.children) return null;
    const child = dialog.props.children as MockDialogElement;
    return child.type === 'DialogPrompt' ? child.props : null;
  };

  const selectOption = (
    selectProps: Record<string, unknown> | null,
    option: { value: string },
  ) => {
    if (!selectProps || typeof selectProps.onSelect !== 'function') {
      throw new Error('Expected select with onSelect callback');
    }
    (selectProps.onSelect as (opt: { value: string }) => void)(option);
  };

  return {
    api,
    toasts,
    getCurrentDialog,
    getSelectProps,
    getConfirmProps,
    getPromptProps,
    selectOption,
  };
}

function writeProjectConfigFile(data: Record<string, unknown>): void {
  const projectDir = path.join(tempDir, '.opencode');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'oh-my-opencode-slim.jsonc'),
    JSON.stringify(data, null, 2),
  );
}

function writeUserConfigFile(data: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(tempDir, 'oh-my-opencode-slim.json'),
    JSON.stringify(data, null, 2),
  );
}

function readUserConfigFile(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(tempDir, 'oh-my-opencode-slim.json'), 'utf-8'),
  ) as Record<string, unknown>;
}

describe('openPresetManager', () => {
  const snapshotRef = {
    snapshot: {
      version: 1,
      updatedAt: 0,
      agentModels: {},
      agentVariants: {},
      activeSessions: {},
      activityPids: {},
      sessionParents: {},
      sessionDetails: {},
      reusableByAgent: {},
    } as TuiSnapshot,
  };

  test('lists presets with effective descriptions and extends info', () => {
    writeUserConfigFile({
      presets: {
        base: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        child: { extends: 'base', agents: {} },
      },
    });

    const mock = createMockApi();
    openPresetManager(mock.api, tempDir, snapshotRef);

    const select = mock.getSelectProps();
    expect(select).not.toBeNull();
    expect(select?.title).toBe('Presets');

    const options = select?.options as Array<{
      value: string;
      title: string;
      description?: string;
    }>;
    expect(options).toBeDefined();

    const childOption = options.find((o) => o.value === 'child');
    expect(childOption).toBeDefined();
    expect(childOption?.description).toContain('extends: base');
    expect(childOption?.description).toContain('anthropic/claude-3.5-haiku');
  });

  test('edits a child preset preserving local extends and only local agents', () => {
    writeUserConfigFile({
      presets: {
        base: {
          orchestrator: { model: 'anthropic/claude-3.5-haiku' },
          oracle: { model: 'openai/gpt-5.6-luna' },
        },
        child: {
          extends: 'base',
          agents: {
            explorer: { model: 'openai/gpt-5-mini' },
          },
        },
      },
    });

    const mock = createMockApi();
    openPresetManager(mock.api, tempDir, snapshotRef);

    // Select 'child' preset
    let select = mock.getSelectProps();
    mock.selectOption(select, { value: 'child' });

    // In preset actions, select 'edit'
    select = mock.getSelectProps();
    expect(select?.title).toBe('Preset: child');
    mock.selectOption(select, { value: 'edit' });

    // Now in Level 2: Edit preset: child
    select = mock.getSelectProps();
    expect(select?.title).toBe('Edit preset: child');

    const options = select?.options as Array<{
      value: string;
      title: string;
      description?: string;
    }>;

    // 1. Has 'Base preset: base' option
    const baseOption = options.find((o) => o.value === '__omo_base_preset__');
    expect(baseOption).toBeDefined();
    expect(baseOption?.title).toBe('Base preset: base');

    // 2. Only local agent 'explorer' is editable
    const localAgent = options.find((o) => o.value === 'explorer');
    expect(localAgent).toBeDefined();
    expect(localAgent?.title).toBe('explorer');

    // 3. Inherited agents (orchestrator, oracle) are visible with inherited markers
    const inheritedOrch = options.find((o) =>
      o.value.startsWith('__omo_inherited__orchestrator'),
    );
    expect(inheritedOrch).toBeDefined();
    expect(inheritedOrch?.title).toContain(
      'orchestrator (inherited from base)',
    );

    // 4. Selecting an inherited agent toasts info and does not enter Level 3
    if (!inheritedOrch) {
      throw new Error('inheritedOrch option not found');
    }
    mock.selectOption(select, inheritedOrch);
    expect(mock.toasts.length).toBeGreaterThan(0);
    const lastToast = mock.toasts[mock.toasts.length - 1];
    expect(lastToast.title).toBe('Inherited agent');
    expect(lastToast.message).toContain('inherited from base preset "base"');

    // 5. Saving writes extends and local agents only, NOT materializing base agents
    select = mock.getSelectProps();
    mock.selectOption(select, {
      value: '__omo_save__',
    });

    const persisted = readUserConfigFile();
    const persistedChild = (
      persisted.presets as Record<string, Record<string, unknown>>
    )?.child;
    expect(persistedChild).toEqual({
      extends: 'base',
      agents: {
        explorer: { model: 'openai/gpt-5-mini' },
      },
    });
  });

  test('Base preset action lists valid candidates and prevents cyclic choices', () => {
    writeUserConfigFile({
      presets: {
        root: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        mid: { extends: 'root', agents: {} },
        child: { extends: 'mid', agents: {} },
        other: { orchestrator: { model: 'openai/gpt-5' } },
      },
    });

    const mock = createMockApi();
    openPresetManager(mock.api, tempDir, snapshotRef);

    // Navigate to edit 'mid'
    let select = mock.getSelectProps();
    mock.selectOption(select, { value: 'mid' });
    select = mock.getSelectProps();
    mock.selectOption(select, { value: 'edit' });

    // Level 2: select 'Base preset'
    select = mock.getSelectProps();
    mock.selectOption(select, {
      value: '__omo_base_preset__',
    });

    // In base preset picker
    select = mock.getSelectProps();
    expect(select?.title).toContain('Base preset for "mid"');

    const candidateOptions = select?.options as Array<{
      value: string;
      title: string;
    }>;
    const candidateValues = candidateOptions.map((o) => o.value);

    // Option to clear base:
    expect(candidateValues).toContain('');

    // 'root' and 'other' are valid choices:
    expect(candidateValues).toContain('root');
    expect(candidateValues).toContain('other');

    // 'mid' (self) is excluded:
    expect(candidateValues).not.toContain('mid');

    // 'child' (which extends mid, so mid extending child would create a cycle: mid -> child -> mid) is excluded:
    expect(candidateValues).not.toContain('child');

    // Select 'other' as new base preset
    mock.selectOption(select, { value: 'other' });

    expect(mock.toasts.length).toBeGreaterThan(0);
    expect(mock.toasts[mock.toasts.length - 1].message).toContain(
      'Base preset set to "other"',
    );

    // Now save mid
    select = mock.getSelectProps();
    expect(select?.title).toBe('Edit preset: mid');
    mock.selectOption(select, {
      value: '__omo_save__',
    });

    const persisted = readUserConfigFile();
    const persistedMid = (
      persisted.presets as Record<string, Record<string, unknown>>
    )?.mid;
    expect(persistedMid.extends).toBe('other');
  });

  test('rejects deleting a base preset that has dependents with clear feedback', () => {
    writeUserConfigFile({
      presets: {
        base: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        dependent1: { extends: 'base', agents: {} },
        dependent2: { extends: 'base', agents: {} },
      },
    });

    const mock = createMockApi();
    openPresetManager(mock.api, tempDir, snapshotRef);

    // Select 'base'
    let select = mock.getSelectProps();
    mock.selectOption(select, { value: 'base' });

    // Select 'delete' action
    select = mock.getSelectProps();
    mock.selectOption(select, { value: 'delete' });

    // Confirm dialog was NOT opened because deletion was rejected
    const confirm = mock.getConfirmProps();
    expect(confirm).toBeNull();

    // Toast explains why
    expect(mock.toasts.length).toBeGreaterThan(0);
    const toast = mock.toasts[mock.toasts.length - 1];
    expect(toast.variant).toBe('warning');
    expect(toast.title).toBe('Cannot delete preset');
    expect(toast.message).toContain('dependent1');
    expect(toast.message).toContain('dependent2');

    // 'base' is still intact in config
    const persisted = readUserConfigFile();
    expect(persisted.presets).toHaveProperty('base');
  });

  test('supports saving and applying an inheritance-only child preset', () => {
    writeUserConfigFile({
      presets: {
        base: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        child: { extends: 'base', agents: {} },
      },
    });

    const mock = createMockApi();
    openPresetManager(mock.api, tempDir, snapshotRef);

    // Select 'child'
    let select = mock.getSelectProps();
    mock.selectOption(select, { value: 'child' });

    // Apply preset
    select = mock.getSelectProps();
    mock.selectOption(select, { value: 'apply' });

    // Toasted success with effective agent summary
    expect(mock.toasts.length).toBeGreaterThan(0);
    const toast = mock.toasts[mock.toasts.length - 1];
    expect(toast.variant).toBe('success');
    expect(toast.message).toContain('Saved preset "child"');
    expect(toast.message).toContain('orchestrator');

    // Preset persisted to user config
    const persisted = readUserConfigFile();
    expect(persisted.preset).toBe('child');
  });

  test('marks project presets as [project - read-only] and limits actions', () => {
    writeUserConfigFile({
      presets: {
        userPreset: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
      },
    });
    writeProjectConfigFile({
      presets: {
        projectPreset: {
          orchestrator: { model: 'anthropic/claude-3.5-haiku' },
        },
      },
    });

    const mock = createMockApi();
    openPresetManager(mock.api, tempDir, snapshotRef);

    let select = mock.getSelectProps();
    const options = select?.options as Array<{ title: string; value: string }>;
    const projectOpt = options.find((o) => o.value === 'projectPreset');
    expect(projectOpt).toBeDefined();
    expect(projectOpt?.title).toBe('projectPreset [project - read-only]');

    mock.selectOption(select, { value: 'projectPreset' });

    select = mock.getSelectProps();
    expect(select?.title).toBe('Preset: projectPreset');
    if (!select?.options) throw new Error('Expected options');
    const actionValues = (select.options as Array<{ value: string }>).map(
      (o) => o.value,
    );
    expect(actionValues).toContain('apply');
    expect(actionValues).toContain('__omo_back__');
    expect(actionValues).not.toContain('edit');
    expect(actionValues).not.toContain('delete');
  });

  test('rejects creating a preset when the name matches an existing project preset', () => {
    writeProjectConfigFile({
      presets: {
        projectFixed: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
      },
    });

    const mock = createMockApi();
    openPresetManager(mock.api, tempDir, snapshotRef);

    mock.selectOption(mock.getSelectProps(), { value: '__omo_new_preset__' });

    const prompt = mock.getPromptProps();
    expect(prompt).not.toBeNull();
    if (!prompt) throw new Error('Expected prompt');
    (prompt.onConfirm as (v: string) => void)('projectFixed');

    expect(mock.toasts.length).toBeGreaterThan(0);
    const toast = mock.toasts[mock.toasts.length - 1];
    expect(toast.variant).toBe('warning');
    expect(toast.title).toBe('Preset already exists');
    expect(toast.message).toContain(
      'already defined in project config (.opencode)',
    );
  });

  test('rejects deleting user base preset if a project preset extends it', () => {
    writeUserConfigFile({
      presets: {
        userBase: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
      },
    });
    writeProjectConfigFile({
      presets: {
        projectChild: { extends: 'userBase', agents: {} },
      },
    });

    const mock = createMockApi();
    openPresetManager(mock.api, tempDir, snapshotRef);

    let select = mock.getSelectProps();
    mock.selectOption(select, { value: 'userBase' });

    select = mock.getSelectProps();
    mock.selectOption(select, { value: 'delete' });

    expect(mock.getConfirmProps()).toBeNull();
    expect(mock.toasts.length).toBeGreaterThan(0);
    const toast = mock.toasts[mock.toasts.length - 1];
    expect(toast.variant).toBe('warning');
    expect(toast.title).toBe('Cannot delete preset');
    expect(toast.message).toContain('projectChild');

    const persisted = readUserConfigFile();
    expect(persisted.presets).toHaveProperty('userBase');
  });

  test('allows choosing (inherit from base) in model picker to clear model and retain inheritance', async () => {
    writeUserConfigFile({
      presets: {
        base: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        child: {
          extends: 'base',
          agents: {
            orchestrator: {
              model: 'anthropic/claude-3.5-haiku',
              temperature: 0.2,
            },
          },
        },
      },
    });

    const mock = createMockApi();
    openPresetManager(mock.api, tempDir, snapshotRef);

    // Select child
    let select = mock.getSelectProps();
    mock.selectOption(select, { value: 'child' });

    // Select edit
    select = mock.getSelectProps();
    mock.selectOption(select, { value: 'edit' });

    // Select orchestrator agent to edit
    select = mock.getSelectProps();
    mock.selectOption(select, { value: 'orchestrator' });

    // Wait for fetchModelOptions async promise in pickModel
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Now in pickModel DialogSelect
    select = mock.getSelectProps();
    expect(select?.title).toBe('Edit orchestrator — model');

    const modelOptions = select?.options as Array<{
      value: string;
      title: string;
      description?: string;
    }>;
    const inheritOpt = modelOptions.find(
      (o) => o.value === '__omo_inherit_model__',
    );
    expect(inheritOpt).toBeDefined();
    expect(inheritOpt?.title).toContain('(inherit from base)');
    expect(inheritOpt?.description).toContain('anthropic/claude-3.5-haiku');

    // Select (inherit from base)
    if (!inheritOpt) throw new Error('inheritOpt not found');
    mock.selectOption(select, inheritOpt);

    // Transitions to pickTemperature (variant skipped)
    const tempPrompt = mock.getPromptProps();
    expect(tempPrompt?.title).toContain('temperature');
    if (!tempPrompt) throw new Error('Expected tempPrompt');
    (tempPrompt.onConfirm as (v: string) => void)('0.7');

    // Transitions to pickOptions
    const optionsPrompt = mock.getPromptProps();
    expect(optionsPrompt?.title).toContain('options');
    if (!optionsPrompt) throw new Error('Expected optionsPrompt');
    (optionsPrompt.onConfirm as (v: string) => void)('');

    // Back in Level 2: Edit preset: child
    select = mock.getSelectProps();
    expect(select?.title).toBe('Edit preset: child');
    mock.selectOption(select, { value: '__omo_save__' });

    const persisted = readUserConfigFile();
    const persistedChild = (
      persisted.presets as Record<string, Record<string, unknown>>
    )?.child;
    expect(persistedChild.extends).toBe('base');
    const childAgents = persistedChild.agents as Record<
      string,
      Record<string, unknown>
    >;
    expect(childAgents.orchestrator).toBeDefined();
    expect(childAgents.orchestrator.temperature).toBe(0.7);
    // model must NOT be defined
    expect(childAgents.orchestrator.model).toBeUndefined();
  });

  test('formats non-model fields in describePreset for effective presets', () => {
    writeUserConfigFile({
      presets: {
        nonModel: {
          orchestrator: {
            inheritModelFrom: 'oracle',
            skills: ['code-review'],
          },
        },
      },
    });

    const mock = createMockApi();
    openPresetManager(mock.api, tempDir, snapshotRef);

    const select = mock.getSelectProps();
    const options = select?.options as Array<{
      value: string;
      description?: string;
    }>;
    const nonModelOpt = options.find((o) => o.value === 'nonModel');
    expect(nonModelOpt).toBeDefined();
    expect(nonModelOpt?.description).toContain('inherit=oracle');
    expect(nonModelOpt?.description).toContain('skills=[code-review]');
  });
});
