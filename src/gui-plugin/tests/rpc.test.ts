import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionPresetState } from '../rpc';
import { OmosConfig, SessionPreset } from '../rpc';

interface Schema {
  [key: string]: unknown;
}

function asSchema(value: unknown): Schema {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as Schema;
}

test('OmosConfig keeps its public id and accepts an optional directory on every method', () => {
  assert.equal(OmosConfig.id, 'oh-my-opencode-slim.gui-config.v1');
  const methods = OmosConfig.methods as unknown as Record<
    string,
    { input: Schema; output: Schema }
  >;
  assert.deepEqual(Object.keys(methods).sort(), [
    'clearPresetDefault',
    'createPreset',
    'deletePreset',
    'getGoMonthlyLimits',
    'getSnapshot',
    'removeAgent',
    'setAgentDisabled',
    'setAgentOverride',
    'switchPreset',
  ]);
  assert.equal('getNativeModelPrefs' in methods, false);
  for (const [name, method] of Object.entries(methods)) {
    const properties = asSchema(method.input.properties ?? {});
    if (name !== 'getGoMonthlyLimits') {
      assert.equal(
        properties.directory !== undefined,
        true,
        `${name} must accept directory`,
      );
    }
    const required = Array.isArray(method.input.required)
      ? method.input.required
      : [];
    assert.equal(required.includes('directory'), false);
  }

  const snapshotOutput = asSchema(methods.getSnapshot.output);
  const snapshotProperties = asSchema(snapshotOutput.properties);
  for (const key of [
    'found',
    'configPath',
    'preset',
    'envOverride',
    'omosVersion',
    'presets',
    'disabledAgents',
    'globalPreset',
    'projectPreset',
    'envPreset',
    'liveConfigRefresh',
    'warnings',
    'projectConfigPaths',
    'roster',
  ]) {
    assert.equal(
      snapshotProperties[key] !== undefined,
      true,
      `missing snapshot field ${key}`,
    );
  }

  const presetItems = asSchema(asSchema(snapshotProperties.presets).items);
  const presetProperties = asSchema(presetItems.properties);
  for (const key of [
    'name',
    'description',
    'inUserConfig',
    'inProjectConfig',
    'agents',
    'editable',
    'extends',
    'validationError',
  ]) {
    assert.equal(
      presetProperties[key] !== undefined,
      true,
      `missing preset field ${key}`,
    );
  }
  const agentItems = asSchema(asSchema(presetProperties.agents).items);
  const agentProperties = asSchema(agentItems.properties);
  for (const key of [
    'name',
    'model',
    'variant',
    'temperature',
    'optionsJson',
    'skills',
    'mcps',
    'modelChain',
    'inheritModelFrom',
    'inherited',
    'primary',
  ]) {
    assert.equal(
      agentProperties[key] !== undefined,
      true,
      `missing agent field ${key}`,
    );
  }
});

test("SessionPreset exports OMOS's exact public read/apply/unbind contract", () => {
  assert.equal(SessionPreset.id, 'oh-my-opencode-slim.session-preset.v1');
  assert.deepEqual(Object.keys(SessionPreset.methods).sort(), [
    'apply',
    'read',
    'unbind',
  ]);
  assert.deepEqual(SessionPreset.events, {});

  const methods = SessionPreset.methods as unknown as Record<
    string,
    { input: Schema; output: Schema }
  >;
  const readInput = asSchema(methods.read.input);
  assert.deepEqual(readInput.required, ['sessionID']);
  assert.deepEqual(asSchema(readInput.properties).sessionID, {
    type: 'string',
    minLength: 1,
  });
  const unbindInput = asSchema(methods.unbind.input);
  assert.deepEqual(unbindInput.required, ['sessionID']);
  assert.deepEqual(asSchema(unbindInput.properties).sessionID, {
    type: 'string',
    minLength: 1,
  });
  const applyInput = asSchema(methods.apply.input);
  assert.deepEqual(applyInput.required, ['sessionID', 'presetName']);
  assert.deepEqual(asSchema(applyInput.properties).presetName, {
    type: 'string',
    minLength: 1,
  });

  const output = asSchema(methods.read.output);
  const properties = asSchema(output.properties);
  assert.deepEqual(properties.status, {
    type: 'string',
    enum: ['bound', 'unbound'],
  });
  assert.deepEqual(properties.affects, {
    type: 'string',
    enum: ['future-children-only'],
  });
  assert.deepEqual(properties.presetName, {
    anyOf: [{ type: 'string' }, { type: 'null' }],
  });
  assert.deepEqual(properties.selection, {
    type: 'string',
    enum: ['explicit', 'default'],
  });
  assert.deepEqual(output.required, [
    'sessionID',
    'status',
    'presetName',
    'affects',
  ]);
  const team = asSchema(properties.team);
  assert.deepEqual(asSchema(team.required), [
    'agentModels',
    'agentVariants',
    'inheritance',
  ]);
  const inheritance = asSchema(asSchema(team.properties).inheritance);
  assert.deepEqual(inheritance.additionalProperties, {
    type: 'string',
    enum: ['session', 'orchestrator'],
  });

  const state: SessionPresetState = {
    sessionID: 'ses_1',
    status: 'bound',
    presetName: 'work',
    selection: 'explicit',
    affects: 'future-children-only',
    team: {
      agentModels: { oracle: 'openai/o3' },
      agentVariants: { oracle: 'high' },
      inheritance: { oracle: 'orchestrator' },
    },
  };
  assert.equal(state.affects, 'future-children-only');

  const defaultState: SessionPresetState = {
    sessionID: 'ses_2',
    status: 'bound',
    presetName: null,
    selection: 'default',
    affects: 'future-children-only',
  };
  assert.equal(defaultState.selection, 'default');
});
