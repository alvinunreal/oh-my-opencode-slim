import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseJsonConfigText } from '../../config/jsonc';
import { createOmosConfigBackend } from '../config-backend';

const CONFIG_NAME = 'oh-my-opencode-slim';

interface Fixture {
  root: string;
  configDir: string;
  userFile: string;
  projectDir: string;
  env: Record<string, string | undefined>;
}

async function makeFixture(t: test.TestContext): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omos-gui-test-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const configDir = path.join(root, 'config');
  const projectDir = path.join(root, 'project');
  const env: Record<string, string | undefined> = {
    OPENCODE_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
  };
  return {
    root,
    configDir,
    userFile: path.join(configDir, `${CONFIG_NAME}.jsonc`),
    projectDir,
    env,
  };
}

function backend(
  fixture: Fixture,
  overrides: Record<string, string | undefined> = {},
) {
  return createOmosConfigBackend({
    directory: fixture.projectDir,
    env: { ...fixture.env, ...overrides },
    homedir: () => path.join(fixture.root, 'home'),
  });
}

async function writeText(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return parseJsonConfigText(await fs.readFile(file, 'utf8'));
}

function projectConfigFile(directory: string): string {
  return path.join(directory, '.opencode', `${CONFIG_NAME}.jsonc`);
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function presetOf(
  config: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  return asRecord(asRecord(config.presets)[name]);
}

const MUTATION_FIXTURE = [
  '\uFEFF{',
  '  // keep this comment',
  '  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",',
  '  "theme": "dark",',
  '  "futureTopLevel": { "keep": true },',
  '  "presets": {',
  '    "work": {',
  '      "agents": {',
  '        "oracle": {',
  '          "model": [',
  '            { "id": "openai/o1", "variant": "high" },',
  '            { "id": "openai/o2", "variant": "low" },',
  '          ],',
  '          "temperature": 0.3,',
  '          "options": { "a": 1 },',
  '        },',
  '        "fixer": { "model": "openai/f" },',
  '      },',
  '    },',
  '  },',
  '}',
  '',
].join('\r\n');

test('user discovery prefers jsonc and falls back to XDG per directory', async (t) => {
  const fixture = await makeFixture(t);
  const xdgFile = path.join(
    fixture.root,
    'xdg',
    'opencode',
    `${CONFIG_NAME}.jsonc`,
  );
  const overrideJson = path.join(fixture.configDir, `${CONFIG_NAME}.json`);

  await writeJson(xdgFile, { preset: 'xdg-jsonc' });
  await writeJson(overrideJson, { preset: 'override-json' });

  let snapshot = await backend(fixture).getSnapshot();
  assert.equal(snapshot.globalPreset, 'override-json');
  assert.equal(snapshot.configPath, overrideJson);

  const overrideJsonc = path.join(fixture.configDir, `${CONFIG_NAME}.jsonc`);
  await writeJson(overrideJsonc, { preset: 'override-jsonc' });
  snapshot = await backend(fixture).getSnapshot();
  assert.equal(snapshot.globalPreset, 'override-jsonc');
  assert.equal(snapshot.configPath, overrideJsonc);

  // The first search directory wins; the XDG fallback only applies when the
  // override directory has no config file at all.
  await fs.rm(fixture.configDir, { recursive: true, force: true });
  snapshot = await backend(fixture).getSnapshot();
  assert.equal(snapshot.globalPreset, 'xdg-jsonc');
  assert.equal(snapshot.configPath, xdgFile);
  assert.equal(snapshot.found, true);
});

test('project layers merge root-to-session and honor both disable flags', async (t) => {
  const fixture = await makeFixture(t);
  const sessionDir = path.join(fixture.projectDir, 'session');
  const rootFile = projectConfigFile(fixture.projectDir);
  const sessionFile = projectConfigFile(sessionDir);

  await writeJson(rootFile, {
    preset: 'root-default',
    presets: { layer: { agents: { oracle: { model: 'root/model' } } } },
  });
  await writeJson(sessionFile, {
    preset: 'session-default',
    presets: { layer: { agents: { oracle: { variant: 'high' } } } },
  });

  const scoped = createOmosConfigBackend({
    directory: sessionDir,
    env: fixture.env,
    homedir: () => path.join(fixture.root, 'home'),
  });
  let snapshot = await scoped.getSnapshot();
  assert.equal(snapshot.projectPreset, 'session-default');
  assert.equal(snapshot.preset, 'session-default');
  assert.deepEqual(snapshot.projectConfigPaths, [rootFile, sessionFile]);
  const layer = snapshot.presets.find((preset) => preset.name === 'layer');
  assert.ok(layer);
  assert.equal(layer.inProjectConfig, true);
  assert.equal(layer.editable, false);
  assert.equal(
    layer.agents.find((agent) => agent.name === 'oracle')?.model,
    'root/model',
  );
  assert.equal(
    layer.agents.find((agent) => agent.name === 'oracle')?.variant,
    'high',
  );

  snapshot = await scoped.getSnapshot(
    { directory: sessionDir },
    { omosVersion: '3.0.7' },
  );
  assert.equal(snapshot.omosVersion, '3.0.7');

  for (const flag of [
    'OPENCODE_DISABLE_PROJECT_CONFIG',
    'OPENCODE_CONFIG_PROJECT_DISABLE',
  ] as const) {
    const disabled = await createOmosConfigBackend({
      directory: sessionDir,
      env: { ...fixture.env, [flag]: '1' },
      homedir: () => path.join(fixture.root, 'home'),
    }).getSnapshot();
    assert.deepEqual(disabled.projectConfigPaths, []);
    assert.equal(disabled.projectPreset, '');
  }

  const notDisabled = await createOmosConfigBackend({
    directory: sessionDir,
    env: { ...fixture.env, OPENCODE_CONFIG_PROJECT_DISABLE: '0' },
    homedir: () => path.join(fixture.root, 'home'),
  }).getSnapshot();
  assert.deepEqual(notDisabled.projectConfigPaths, [rootFile, sessionFile]);
});

test('snapshot surfaces resolved inheritance, aliases, roster, warnings and validation errors', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    preset: 'global-default',
    disabled_agents: [],
    agents: {
      explore: { model: 'openai/explorer', temperature: 0.2 },
      'my-helper': { model: 'openai/helper', description: 'Helper agent' },
      declared: { inheritModelFrom: 'session' },
      'ignored-custom': { temperature: 0.3 },
      'bad name!': { model: 'x/y' },
    },
    presets: {
      base: {
        agents: {
          oracle: { model: 'openai/oracle', options: { a: 1 } },
          'frontend-ui-ux-engineer': { variant: 'high' },
        },
      },
      child: {
        extends: 'base',
        agents: {
          oracle: { temperature: 0.5 },
          fixer: {
            model: [
              { id: 'openai/fixer-a', variant: 'high' },
              'openai/fixer-b',
            ],
            inheritModelFrom: 'orchestrator',
          },
        },
      },
      market: { marketplace: { agents: ['author/pkg'] } },
      empty: {},
      'cycle-a': { extends: 'cycle-b' },
      'cycle-b': { extends: 'cycle-a' },
      missing: { extends: 'does-not-exist' },
    },
  });
  await writeJson(projectConfigFile(fixture.projectDir), {
    presets: {
      'project-only': { agents: { oracle: { model: 'project/oracle' } } },
    },
  });

  const snapshot = await backend(fixture).getSnapshot();
  assert.equal(snapshot.globalPreset, 'global-default');
  assert.equal(snapshot.projectPreset, '');
  assert.equal(snapshot.envPreset, '');
  assert.equal(snapshot.preset, 'global-default');
  assert.equal(snapshot.envOverride, false);
  assert.equal(snapshot.liveConfigRefresh, true);
  assert.deepEqual(snapshot.disabledAgents, []);
  assert.ok(snapshot.warnings.every((warning) => typeof warning === 'string'));

  const rosterNames = snapshot.roster.map((entry) => entry.name);
  assert.deepEqual(rosterNames.slice(0, 8), [
    'orchestrator',
    'explorer',
    'oracle',
    'designer',
    'fixer',
    'observer',
    'council',
    'councillor',
  ]);
  assert.deepEqual(rosterNames.slice(8), ['declared', 'my-helper']);
  assert.equal(
    snapshot.roster.find((entry) => entry.name === 'orchestrator')?.protected,
    true,
  );
  assert.equal(
    snapshot.roster.find((entry) => entry.name === 'councillor')?.protected,
    true,
  );
  assert.equal(
    snapshot.roster.find((entry) => entry.name === 'orchestrator')?.primary,
    true,
  );
  assert.equal(
    snapshot.roster.find((entry) => entry.name === 'my-helper')?.description,
    'Helper agent',
  );
  assert.equal(
    snapshot.roster.find((entry) => entry.name === 'declared')?.primary,
    false,
  );

  const child = snapshot.presets.find((preset) => preset.name === 'child');
  assert.ok(child);
  assert.deepEqual(child.extends, ['base']);
  assert.equal(child.editable, true);
  assert.equal(child.validationError, undefined);
  const oracle = child.agents.find((agent) => agent.name === 'oracle');
  assert.ok(oracle);
  assert.equal(oracle.model, 'openai/oracle');
  assert.equal(oracle.temperature, 0.5);
  assert.equal(oracle.optionsJson, '{"a":1}');
  assert.equal(oracle.inherited, false);
  assert.equal(oracle.primary, false);
  const designer = child.agents.find((agent) => agent.name === 'designer');
  assert.ok(designer);
  assert.equal(designer.variant, 'high');
  assert.equal(designer.inherited, true);
  const fixer = child.agents.find((agent) => agent.name === 'fixer');
  assert.ok(fixer);
  assert.deepEqual(fixer.modelChain, ['openai/fixer-a', 'openai/fixer-b']);
  assert.equal(fixer.variant, 'high');
  assert.equal(fixer.inheritModelFrom, 'orchestrator');

  const cycle = snapshot.presets.find((preset) => preset.name === 'cycle-a');
  assert.ok(cycle?.validationError?.includes('cycle'));
  const missing = snapshot.presets.find((preset) => preset.name === 'missing');
  assert.ok(missing?.validationError?.includes('missing preset'));
  const market = snapshot.presets.find((preset) => preset.name === 'market');
  assert.ok(market);
  assert.equal(market.validationError, undefined);
  assert.deepEqual(market.agents, []);

  const projectOnly = snapshot.presets.find(
    (preset) => preset.name === 'project-only',
  );
  assert.ok(projectOnly);
  assert.equal(projectOnly.inProjectConfig, true);
  assert.equal(projectOnly.inUserConfig, false);
  assert.equal(projectOnly.editable, false);
});

test('switchPreset refuses a project preset dropped by an invalid project layer', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, { presets: {} });
  await writeJson(projectConfigFile(fixture.projectDir), {
    presets: {
      other: { agents: { oracle: { model: 'a/b' } } },
      broken: { extends: ['other'], agents: {} },
    },
  });
  const subject = backend(fixture);
  const snapshot = await subject.getSnapshot();
  assert.equal(
    snapshot.presets.find((preset) => preset.name === 'other')?.inProjectConfig,
    true,
  );
  assert.ok(
    snapshot.presets.find((preset) => preset.name === 'broken')
      ?.validationError,
  );

  const result = await subject.switchPreset({ name: 'other' });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('runtime config'));
  assert.equal('preset' in (await readJson(fixture.userFile)), false);
});

test('disabled agents default to observer only when unset and canonicalize aliases', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, { presets: {} });
  let snapshot = await backend(fixture).getSnapshot();
  assert.deepEqual(snapshot.disabledAgents, ['observer']);

  await writeJson(fixture.userFile, { disabled_agents: [] });
  snapshot = await backend(fixture).getSnapshot();
  assert.deepEqual(snapshot.disabledAgents, []);

  await writeJson(fixture.userFile, {
    disabled_agents: ['explore', 'orchestrator', 'librarian'],
  });
  snapshot = await backend(fixture).getSnapshot();
  assert.deepEqual(snapshot.disabledAgents, ['explorer']);
});

test('extends arrays are rejected by the runtime schema and never selected or mutated', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      base: { agents: { oracle: { model: 'a/b' } } },
      multi: { extends: ['base'], agents: {} },
    },
  });
  const subject = backend(fixture);
  const before = await fs.readFile(fixture.userFile, 'utf8');

  const snapshot = await subject.getSnapshot();
  const multi = snapshot.presets.find((preset) => preset.name === 'multi');
  assert.ok(multi);
  assert.deepEqual(multi.extends, ['base']); // shown for diagnosis; the runtime accepts a string parent only
  assert.ok(multi.validationError);
  assert.ok(
    multi.validationError?.includes('extends') ||
      multi.validationError?.includes('string'),
  );
  assert.ok(snapshot.warnings.length > 0);

  let result = await subject.switchPreset({ name: 'multi' });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('invalid'));

  // The whole user layer is rejected by the runtime, so no switch may report
  // success even when the requested preset itself is valid.
  result = await subject.switchPreset({ name: 'base' });
  assert.equal(result.ok, false);
  assert.ok(
    result.message.includes('invalid') ||
      result.message.includes('user config'),
  );

  result = await subject.setAgentOverride({
    preset: 'multi',
    agent: 'oracle',
    patch: { temperature: 0.5 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('invalid'));
  assert.equal(await fs.readFile(fixture.userFile, 'utf8'), before);

  result = await subject.createPreset({ name: 'copy', copyFrom: 'multi' });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('Cannot copy'));
});

test('top-level agent variant wins over an embedded chain variant when the model changes', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      work: {
        agents: {
          oracle: {
            model: [
              { id: 'provider/model', variant: 'fast' },
              'provider/fallback',
            ],
            variant: 'high',
          },
          fixer: {
            model: [
              { id: 'provider/embedded', variant: 'fast' },
              'provider/next',
            ],
          },
        },
      },
    },
  });
  const subject = backend(fixture);

  let snapshot = await subject.getSnapshot();
  let work = snapshot.presets.find((preset) => preset.name === 'work');
  let oracle = work?.agents.find((agent) => agent.name === 'oracle');
  const fixer = work?.agents.find((agent) => agent.name === 'fixer');
  assert.equal(oracle?.variant, 'high');
  assert.equal(fixer?.variant, 'fast');

  // A temperature-only patch must leave the fallback chain and variant intact.
  let result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { temperature: 0.2 },
  });
  assert.equal(result.ok, true, result.message);
  let parsed = await readJson(fixture.userFile);
  let oracleEntry = asRecord(asRecord(presetOf(parsed, 'work').agents).oracle);
  assert.deepEqual(oracleEntry.model, [
    { id: 'provider/model', variant: 'fast' },
    'provider/fallback',
  ]);
  assert.equal(oracleEntry.variant, 'high');

  // Embedded-only variants remain preserved when scalarizing a chain.
  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'fixer',
    patch: { model: 'provider/embedded-next' },
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  const fixerEntry = asRecord(asRecord(presetOf(parsed, 'work').agents).fixer);
  assert.equal(fixerEntry.model, 'provider/embedded-next');
  assert.equal(fixerEntry.variant, 'fast');

  // The explicit agent-level variant outranks the first model entry's variant.
  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { model: 'provider/other' },
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  oracleEntry = asRecord(asRecord(presetOf(parsed, 'work').agents).oracle);
  assert.equal(oracleEntry.model, 'provider/other');
  assert.equal(oracleEntry.variant, 'high');

  snapshot = await subject.getSnapshot();
  work = snapshot.presets.find((preset) => preset.name === 'work');
  oracle = work?.agents.find((agent) => agent.name === 'oracle');
  assert.equal(oracle?.variant, 'high');

  // An explicit variant patch still overrides both sources.
  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { model: 'provider/third', variant: 'low' },
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  oracleEntry = asRecord(asRecord(presetOf(parsed, 'work').agents).oracle);
  assert.equal(oracleEntry.variant, 'low');

  snapshot = await subject.getSnapshot();
  work = snapshot.presets.find((preset) => preset.name === 'work');
  oracle = work?.agents.find((agent) => agent.name === 'oracle');
  assert.equal(oracle?.variant, 'low');
});

test('editing a variant inherited from a parent writes it at agent level', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      base: {
        agents: {
          oracle: {
            model: ['base/a', 'base/b'],
            variant: 'high',
          },
        },
      },
      child: {
        extends: 'base',
        agents: {
          oracle: { model: ['child/a', 'child/b'] },
        },
      },
    },
  });
  const subject = backend(fixture);

  const result = await subject.setAgentOverride({
    preset: 'child',
    agent: 'oracle',
    patch: { variant: 'max' },
  });
  assert.equal(result.ok, true, result.message);

  // The local chain keeps its shape; the edited variant overrides the
  // parent's agent-level variant at runtime.
  const parsed = await readJson(fixture.userFile);
  const child = asRecord(presetOf(parsed, 'child'));
  const entry = asRecord(asRecord(child.agents).oracle);
  assert.deepEqual(entry.model, ['child/a', 'child/b']);
  assert.equal(entry.variant, 'max');

  const snapshot = await subject.getSnapshot();
  const childInfo = snapshot.presets.find((preset) => preset.name === 'child');
  const oracle = childInfo?.agents.find((agent) => agent.name === 'oracle');
  assert.equal(oracle?.variant, 'max');
  assert.deepEqual(oracle?.modelChain, ['child/a', 'child/b']);
});

test('environment-based parents resolve for snapshots and preset switches', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      base: {
        agents: {
          oracle: { model: 'base/model', variant: 'high' },
        },
      },
      child: {
        extends: '{env:OMOS_TEST_BASE}',
        agents: {
          fixer: { model: 'child/fixer' },
        },
      },
    },
  });
  const subject = backend(fixture, { OMOS_TEST_BASE: 'base' });

  const snapshot = await subject.getSnapshot();
  const child = snapshot.presets.find((preset) => preset.name === 'child');
  assert.ok(child);
  assert.equal(child.validationError, undefined);
  assert.deepEqual(child.extends, ['base']);
  const oracle = child.agents.find((agent) => agent.name === 'oracle');
  assert.equal(oracle?.model, 'base/model');
  assert.equal(oracle?.variant, 'high');

  const switched = await subject.switchPreset({ name: 'child' });
  assert.equal(switched.ok, true, switched.message);

  // The placeholder stays in the file so the environment still owns it.
  const parsed = await readJson(fixture.userFile);
  assert.equal(presetOf(parsed, 'child').extends, '{env:OMOS_TEST_BASE}');
});

test('environment placeholders in agent fields show the runtime value and survive edits', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      work: {
        agents: {
          explorer: { model: '{env:REVIEW_MODEL}' },
          oracle: {
            model: [{ id: '{env:REVIEW_MODEL}', variant: 'high' }, 'b/two'],
          },
        },
      },
    },
  });
  const subject = backend(fixture, { REVIEW_MODEL: 'test/model' });

  const snapshot = await subject.getSnapshot();
  const work = snapshot.presets.find((preset) => preset.name === 'work');
  assert.ok(work);
  assert.equal(work.validationError, undefined);
  const explorer = work.agents.find((agent) => agent.name === 'explorer');
  assert.equal(explorer?.model, 'test/model');
  const oracle = work.agents.find((agent) => agent.name === 'oracle');
  assert.equal(oracle?.model, 'test/model');
  assert.deepEqual(oracle?.modelChain, ['test/model', 'b/two']);

  const result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'explorer',
    patch: { temperature: 0.2 },
  });
  assert.equal(result.ok, true, result.message);
  const parsed = await readJson(fixture.userFile);
  const entry = asRecord(asRecord(presetOf(parsed, 'work').agents).explorer);
  assert.equal(entry.model, '{env:REVIEW_MODEL}');
  assert.equal(entry.temperature, 0.2);
});

test('presets in a file with unquoted env tokens are visible but read-only', async (t) => {
  const fixture = await makeFixture(t);
  const text =
    '{ "presets": { "work": { "agents": { "explorer": { "model": "a/b", "temperature": {env:REVIEW_TEMP} } } } } }';
  await writeText(fixture.userFile, text);
  const subject = backend(fixture, { REVIEW_TEMP: '0.3' });

  const snapshot = await subject.getSnapshot();
  const work = snapshot.presets.find((preset) => preset.name === 'work');
  assert.ok(work);
  assert.equal(work.editable, false);
  const explorer = work.agents.find((agent) => agent.name === 'explorer');
  assert.equal(explorer?.temperature, 0.3);
  assert.ok(snapshot.warnings.some((warning) => warning.includes('Read-only')));

  const edit = await subject.setAgentOverride({
    preset: 'work',
    agent: 'explorer',
    patch: { temperature: 0.5 },
  });
  assert.equal(edit.ok, false);
  assert.ok(edit.message.includes('unquoted {env:...}'));
  const removed = await subject.deletePreset({ name: 'work' });
  assert.equal(removed.ok, false);
  assert.equal(await fs.readFile(fixture.userFile, 'utf8'), text);
});

test('JSONC edits preserve comments, BOM, CRLF, top-level fields and fallback variants', async (t) => {
  const fixture = await makeFixture(t);
  await writeText(fixture.userFile, MUTATION_FIXTURE);
  const original = await fs.readFile(fixture.userFile, 'utf8');
  const subject = backend(fixture);

  let result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { variant: 'max' },
  });
  assert.equal(result.ok, true, result.message);
  const text = await fs.readFile(fixture.userFile, 'utf8');
  assert.ok(text.startsWith('\uFEFF'));
  assert.ok(text.includes('// keep this comment'));
  assert.ok(text.includes('futureTopLevel'));
  assert.ok(text.includes('"theme": "dark"'));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(await fs.readFile(`${fixture.userFile}.bak`, 'utf8'), original);

  let parsed = await readJson(fixture.userFile);
  let oracleEntry = asRecord(asRecord(presetOf(parsed, 'work').agents).oracle);
  assert.deepEqual(oracleEntry.model, [
    { id: 'openai/o1', variant: 'high' },
    { id: 'openai/o2', variant: 'low' },
  ]);
  assert.equal(oracleEntry.variant, 'max');

  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { temperature: 0.6 },
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  oracleEntry = asRecord(asRecord(presetOf(parsed, 'work').agents).oracle);
  assert.equal(oracleEntry.temperature, 0.6);
  assert.deepEqual(oracleEntry.options, { a: 1 });

  // Changing the model without an explicit variant patch scalarizes the chain
  // and keeps the explicit agent-level variant.
  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { model: 'anthropic/claude' },
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  oracleEntry = asRecord(asRecord(presetOf(parsed, 'work').agents).oracle);
  assert.equal(oracleEntry.model, 'anthropic/claude');
  assert.equal(oracleEntry.variant, 'max');
  assert.equal(asRecord(oracleEntry).futureField, undefined);

  let snapshot = await subject.getSnapshot();
  let work = snapshot.presets.find((preset) => preset.name === 'work');
  const oracle = work?.agents.find((agent) => agent.name === 'oracle');
  assert.equal(oracle?.model, 'anthropic/claude');
  assert.equal(oracle?.variant, 'max');
  assert.equal(oracle?.modelChain, undefined);

  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { variant: '' },
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  oracleEntry = asRecord(asRecord(presetOf(parsed, 'work').agents).oracle);
  assert.equal('variant' in oracleEntry, false);

  const beforeNoop = await fs.readFile(fixture.userFile, 'utf8');
  const beforeBackup = await fs.readFile(`${fixture.userFile}.bak`, 'utf8');
  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { temperature: 0.6 },
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(await fs.readFile(fixture.userFile, 'utf8'), beforeNoop);
  assert.equal(
    await fs.readFile(`${fixture.userFile}.bak`, 'utf8'),
    beforeBackup,
  );

  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { optionsJson: '{"thinking":{"type":"enabled"}}' },
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  oracleEntry = asRecord(asRecord(presetOf(parsed, 'work').agents).oracle);
  assert.deepEqual(oracleEntry.options, { thinking: { type: 'enabled' } });

  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { model: '' },
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  oracleEntry = asRecord(asRecord(presetOf(parsed, 'work').agents).oracle);
  assert.equal('model' in oracleEntry, false);
  assert.equal('variant' in oracleEntry, false);
  assert.deepEqual(oracleEntry.options, { thinking: { type: 'enabled' } });

  const beforeInvalid = await fs.readFile(fixture.userFile, 'utf8');
  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { optionsJson: '[]' },
  });
  assert.equal(result.ok, false);
  result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { temperature: 3 },
  });
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(fixture.userFile, 'utf8'), beforeInvalid);

  snapshot = await subject.getSnapshot();
  work = snapshot.presets.find((preset) => preset.name === 'work');
  assert.ok(work);
  assert.equal(work.validationError, undefined);
});

test('same-field drafts merge only the changed patch into the freshly leased entry', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      work: {
        agents: {
          oracle: {
            model: 'old/model',
            temperature: 0.1,
            options: { keep: true },
          },
          fixer: { model: 'fixer/model' },
        },
      },
    },
  });
  const subject = backend(fixture);
  // Simulate another editor changing the same entry while the GUI draft is open.
  await writeJson(fixture.userFile, {
    presets: {
      work: {
        agents: {
          oracle: {
            model: 'external/newer-model',
            temperature: 0.4,
            options: { keep: true },
          },
          fixer: { model: 'fixer/model' },
        },
      },
    },
  });

  const result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { temperature: 0.2 },
  });
  assert.equal(result.ok, true, result.message);
  const parsed = await readJson(fixture.userFile);
  const oracle = asRecord(asRecord(presetOf(parsed, 'work').agents).oracle);
  assert.equal(oracle.model, 'external/newer-model');
  assert.equal(oracle.temperature, 0.2);
  assert.deepEqual(oracle.options, { keep: true });
  assert.equal(
    asRecord(asRecord(presetOf(parsed, 'work').agents).fixer).model,
    'fixer/model',
  );
});

test('alias edits canonicalize without duplicate display and preserve unrelated fields', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      work: {
        agents: {
          explore: { model: 'openai/alias', temperature: 0.1 },
          explorer: { variant: 'high' },
        },
      },
    },
  });
  const subject = backend(fixture);
  const result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'explore',
    patch: { temperature: 0.7 },
  });
  assert.equal(result.ok, true, result.message);
  const parsed = await readJson(fixture.userFile);
  const agents = asRecord(presetOf(parsed, 'work').agents);
  assert.deepEqual(Object.keys(agents), ['explorer']);
  assert.deepEqual(agents.explorer, {
    variant: 'high',
    model: 'openai/alias',
    temperature: 0.7,
  });

  const snapshot = await subject.getSnapshot();
  const work = snapshot.presets.find((preset) => preset.name === 'work');
  assert.deepEqual(
    work?.agents.map((agent) => agent.name),
    ['explorer'],
  );
});

test('legacy flat presets stay flat and model chains survive variant edits', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      legacy: {
        oracle: { model: 'openai/o1', temperature: 0.2 },
        designer: { model: 'openai/d1' },
      },
      chain: {
        fixer: { model: ['openai/f-a', 'openai/f-b'] },
      },
    },
  });
  const subject = backend(fixture);

  let result = await subject.setAgentOverride({
    preset: 'legacy',
    agent: 'oracle',
    patch: { temperature: 0.8 },
  });
  assert.equal(result.ok, true, result.message);
  let parsed = await readJson(fixture.userFile);
  const legacy = presetOf(parsed, 'legacy');
  assert.deepEqual(Object.keys(legacy), ['oracle', 'designer']);
  assert.equal('agents' in legacy, false);
  assert.deepEqual(legacy.oracle, { model: 'openai/o1', temperature: 0.8 });

  result = await subject.setAgentOverride({
    preset: 'chain',
    agent: 'fixer',
    patch: { variant: 'high' },
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  let fixer = asRecord(presetOf(parsed, 'chain').fixer);
  assert.deepEqual(fixer.model, ['openai/f-a', 'openai/f-b']);
  assert.equal(fixer.variant, 'high');

  result = await subject.setAgentOverride({
    preset: 'chain',
    agent: 'fixer',
    patch: { optionsJson: '{"thinking":{"type":"enabled"}}' },
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  fixer = asRecord(presetOf(parsed, 'chain').fixer);
  assert.deepEqual(fixer.model, ['openai/f-a', 'openai/f-b']);
  assert.equal(fixer.variant, 'high');
  assert.deepEqual(fixer.options, { thinking: { type: 'enabled' } });

  const snapshot = await subject.getSnapshot();
  const chain = snapshot.presets.find((preset) => preset.name === 'chain');
  const fixerEntry = chain?.agents.find((agent) => agent.name === 'fixer');
  assert.equal(fixerEntry?.variant, 'high');
  assert.deepEqual(fixerEntry?.modelChain, ['openai/f-a', 'openai/f-b']);
});

test('root agent declarations warn when they override a preset edit', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    agents: { explorer: { model: 'root/model' } },
    presets: { work: { agents: { explorer: { model: 'preset/model' } } } },
  });
  const result = await backend(fixture).setAgentOverride({
    preset: 'work',
    agent: 'explore',
    patch: { temperature: 0.2 },
  });
  assert.equal(result.ok, true, result.message);
  assert.ok(result.message.includes('root agents.explorer'));
  assert.ok(result.message.includes('overrides this preset entry'));
});

test('new agent insertions keep CRLF and BOM formatting', async (t) => {
  const fixture = await makeFixture(t);
  const fixtureText = [
    '\uFEFF{',
    '  "presets": {',
    '    "work": {',
    '      "agents": {',
    '        "oracle": { "model": "a/b" }',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\r\n');
  await writeText(fixture.userFile, fixtureText);
  const result = await backend(fixture).setAgentOverride({
    preset: 'work',
    agent: 'fixer',
    patch: { model: 'c/d', temperature: 0.2 },
  });
  assert.equal(result.ok, true, result.message);
  const text = await fs.readFile(fixture.userFile, 'utf8');
  assert.ok(text.startsWith('\uFEFF'));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
  const parsed = await readJson(fixture.userFile);
  const agents = asRecord(presetOf(parsed, 'work').agents);
  assert.deepEqual(agents.oracle, { model: 'a/b' });
  assert.deepEqual(agents.fixer, { model: 'c/d', temperature: 0.2 });
});

test('createPreset rejects collisions/dangerous names and clones project presets safely', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      base: { agents: { oracle: { model: 'user/oracle' } } },
      'inline-base': { extends: 'base' },
    },
  });
  await writeJson(projectConfigFile(fixture.projectDir), {
    presets: {
      proj: {
        extends: 'base',
        agents: { oracle: { model: 'project/oracle' } },
        marketplace: { agents: ['author/pkg'], agents_add: ['author/extra'] },
      },
      'proj-child': { extends: 'proj' },
    },
  });
  const subject = backend(fixture);
  const beforeUser = await fs.readFile(fixture.userFile, 'utf8');
  const beforeProject = await fs.readFile(
    projectConfigFile(fixture.projectDir),
    'utf8',
  );

  for (const name of [
    'proj',
    'base',
    'bad name',
    '__proto__',
    'constructor',
    'prototype',
    '__omo_new',
  ]) {
    const result = await subject.createPreset({ name, copyFrom: 'proj' });
    assert.equal(result.ok, false, `expected ${name} to be rejected`);
  }

  let result = await subject.createPreset({ name: 'copy', copyFrom: 'proj' });
  assert.equal(result.ok, true, result.message);
  let parsed = await readJson(fixture.userFile);
  assert.deepEqual(presetOf(parsed, 'copy'), {
    extends: 'base',
    agents: { oracle: { model: 'project/oracle' } },
    marketplace: { agents: ['author/pkg'], agents_add: ['author/extra'] },
  });
  assert.equal(
    await fs
      .readFile(fixture.userFile, 'utf8')
      .then((text) => text.includes('author/extra')),
    true,
  );
  assert.equal(
    await fs.readFile(projectConfigFile(fixture.projectDir), 'utf8'),
    beforeProject,
  );

  result = await subject.createPreset({ name: 'copy2', copyFrom: 'proj' });
  assert.equal(result.ok, true, result.message);
  result = await subject.createPreset({ name: 'copy2' });
  assert.equal(result.ok, false);

  // An inherited-only preset stays in the runtime-valid inline form instead
  // of the ambiguous `{ extends, agents: {} }` wrapper.
  result = await subject.createPreset({
    name: 'inline-copy',
    copyFrom: 'inline-base',
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  assert.deepEqual(presetOf(parsed, 'inline-copy'), { extends: 'base' });

  const snapshot = await subject.getSnapshot();
  assert.equal(
    snapshot.presets.find((preset) => preset.name === 'copy')?.editable,
    true,
  );
  assert.equal(
    snapshot.presets.find((preset) => preset.name === 'proj')?.editable,
    false,
  );
  assert.notEqual(await fs.readFile(fixture.userFile, 'utf8'), beforeUser);
});

test('createPreset creates the preferred user config when none exists', async (t) => {
  const fixture = await makeFixture(t);
  const result = await backend(fixture).createPreset({ name: 'fresh' });
  assert.equal(result.ok, true, result.message);
  const parsed = await readJson(fixture.userFile);
  assert.deepEqual(presetOf(parsed, 'fresh'), {});
  assert.equal(
    parsed.$schema,
    'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json',
  );
});

test('project-defined presets reject edits, removal and deletion', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: { shared: { agents: { oracle: { model: 'user/oracle' } } } },
  });
  const projectFile = projectConfigFile(fixture.projectDir);
  await writeJson(projectFile, {
    presets: {
      shared: {
        extends: 'base',
        agents: { oracle: { model: 'project/oracle' } },
      },
      base: {},
    },
  });
  const subject = backend(fixture);
  const beforeUser = await fs.readFile(fixture.userFile, 'utf8');
  const beforeProject = await fs.readFile(projectFile, 'utf8');

  let result = await subject.setAgentOverride({
    preset: 'shared',
    agent: 'oracle',
    patch: { temperature: 0.5 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('read-only'));
  result = await subject.removeAgent({ preset: 'shared', agent: 'oracle' });
  assert.equal(result.ok, false);
  result = await subject.deletePreset({ name: 'shared' });
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(fixture.userFile, 'utf8'), beforeUser);
  assert.equal(await fs.readFile(projectFile, 'utf8'), beforeProject);
});

test('deleting a base preset is blocked while dependents, project selection or env select it', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    preset: 'base',
    presets: {
      base: { agents: { oracle: { model: 'a/b' } } },
      child: { extends: 'base' },
    },
  });
  const subject = backend(fixture);
  let result = await subject.deletePreset({ name: 'base' });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('child'));
  result = await subject.deletePreset({ name: 'child' });
  assert.equal(result.ok, true, result.message);
  result = await subject.deletePreset({ name: 'base' });
  assert.equal(result.ok, true, result.message);
  const parsed = await readJson(fixture.userFile);
  assert.deepEqual(parsed.presets, {});
  assert.equal('preset' in parsed, false);

  await writeJson(fixture.userFile, {
    preset: 'base',
    presets: { base: { agents: { oracle: { model: 'a/b' } } } },
  });
  await writeJson(projectConfigFile(fixture.projectDir), { preset: 'base' });
  result = await subject.deletePreset({ name: 'base' });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('project config'));

  await fs.rm(projectConfigFile(fixture.projectDir), { force: true });
  result = await createOmosConfigBackend({
    directory: fixture.projectDir,
    env: { ...fixture.env, OH_MY_OPENCODE_SLIM_PRESET: 'base' },
    homedir: () => path.join(fixture.root, 'home'),
  }).deletePreset({ name: 'base' });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('OH_MY_OPENCODE_SLIM_PRESET'));
  assert.ok((await readJson(fixture.userFile)).presets);

  await writeJson(fixture.userFile, {
    preset: '{env:OMOS_DELETE_DEFAULT}',
    presets: { base: { agents: { oracle: { model: 'a/b' } } } },
  });
  result = await createOmosConfigBackend({
    directory: fixture.projectDir,
    env: { ...fixture.env, OMOS_DELETE_DEFAULT: 'base' },
    homedir: () => path.join(fixture.root, 'home'),
  }).deletePreset({ name: 'base' });
  assert.equal(result.ok, true, result.message);
  const afterDelete = await readJson(fixture.userFile);
  assert.equal('preset' in afterDelete, false);
  assert.deepEqual(afterDelete.presets, {});
});

test('inherited agent removal rejects and local removal keeps inheritance honest', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      base: {
        agents: {
          oracle: { model: 'base/oracle' },
          designer: { model: 'base/designer' },
        },
      },
      child: {
        extends: 'base',
        agents: {
          oracle: { temperature: 0.4 },
          fixer: { model: 'child/fixer' },
        },
      },
    },
  });
  const subject = backend(fixture);

  let result = await subject.removeAgent({
    preset: 'child',
    agent: 'designer',
  });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('inherited'));

  result = await subject.removeAgent({ preset: 'child', agent: 'oracle' });
  assert.equal(result.ok, true, result.message);
  assert.ok(result.message.includes('still inherits'));
  let snapshot = await subject.getSnapshot();
  const child = snapshot.presets.find((preset) => preset.name === 'child');
  const inheritedOracle = child?.agents.find(
    (agent) => agent.name === 'oracle',
  );
  assert.equal(inheritedOracle?.inherited, true);
  assert.equal(inheritedOracle?.model, 'base/oracle');

  result = await subject.removeAgent({ preset: 'child', agent: 'fixer' });
  assert.equal(result.ok, true, result.message);
  result = await subject.removeAgent({ preset: 'child', agent: 'fixer' });
  assert.equal(result.ok, true);
  const parsed = await readJson(fixture.userFile);
  const childOnDisk = presetOf(parsed, 'child');
  assert.equal(childOnDisk.extends, 'base');
  assert.equal('agents' in childOnDisk, false);

  result = await subject.removeAgent({ preset: 'base', agent: 'designer' });
  assert.equal(result.ok, true, result.message);
  snapshot = await subject.getSnapshot();
  assert.equal(
    snapshot.presets
      .find((preset) => preset.name === 'base')
      ?.agents.some((agent) => agent.name === 'designer'),
    false,
  );
});

test('switchPreset writes only the global default and refuses env/project conflicts', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    theme: 'dark',
    presets: {
      work: { agents: { oracle: { model: 'a/b' } } },
      market: { marketplace: { agents: ['author/pkg'] } },
      cycle: { extends: 'cycle' },
    },
  });
  const projectFile = projectConfigFile(fixture.projectDir);
  await writeJson(projectFile, {
    preset: 'project-default',
    presets: { 'project-default': { agents: { oracle: { model: 'p/q' } } } },
  });

  let result = await backend(fixture).switchPreset({ name: 'work' });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('project config'));

  const noProjectFile = path.join(fixture.root, 'unused-project');
  await writeJson(fixture.userFile, {
    theme: 'dark',
    presets: {
      work: { agents: { oracle: { model: 'a/b' } } },
      market: { marketplace: { agents: ['author/pkg'] } },
      cycle: { extends: 'cycle' },
    },
  });
  const unscoped = createOmosConfigBackend({
    directory: noProjectFile,
    env: fixture.env,
    homedir: () => path.join(fixture.root, 'home'),
  });
  result = await unscoped.switchPreset({ name: 'work' });
  assert.equal(result.ok, true, result.message);
  let parsed = await readJson(fixture.userFile);
  assert.equal(parsed.preset, 'work');
  assert.equal(parsed.theme, 'dark');

  result = await unscoped.switchPreset({ name: 'cycle' });
  assert.equal(result.ok, false);
  result = await unscoped.switchPreset({ name: 'market' });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  assert.equal(parsed.preset, 'market');

  result = await createOmosConfigBackend({
    directory: path.join(fixture.root, 'unused-project-2'),
    env: { ...fixture.env, OH_MY_OPENCODE_SLIM_PRESET: 'other' },
    homedir: () => path.join(fixture.root, 'home'),
  }).switchPreset({ name: 'work' });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('OH_MY_OPENCODE_SLIM_PRESET'));
  assert.equal((await readJson(fixture.userFile)).preset, 'market');

  result = await unscoped.switchPreset({ name: 'missing' });
  assert.equal(result.ok, false);

  result = await unscoped.clearPresetDefault();
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  assert.equal('preset' in parsed, false);
  assert.equal(parsed.theme, 'dark');
});

test('clearPresetDefault never creates config and never touches project selection', async (t) => {
  const fixture = await makeFixture(t);
  const missing = await backend(fixture).clearPresetDefault();
  assert.equal(missing.ok, true);
  await assert.rejects(fs.stat(fixture.userFile));

  await writeJson(fixture.userFile, { preset: 'user-default' });
  await writeJson(projectConfigFile(fixture.projectDir), {
    preset: 'project-default',
  });
  const subject = backend(fixture);
  const result = await subject.clearPresetDefault();
  assert.equal(result.ok, true, result.message);
  const parsed = await readJson(fixture.userFile);
  assert.equal('preset' in parsed, false);
  const snapshot = await subject.getSnapshot();
  assert.equal(snapshot.globalPreset, '');
  assert.equal(snapshot.projectPreset, 'project-default');
  assert.equal(snapshot.preset, 'project-default');
});

test('setAgentDisabled canonicalizes aliases, protects agents and rejects project shadows', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, { presets: {} });
  const subject = backend(fixture);

  let result = await subject.setAgentDisabled({
    agent: 'explore',
    disabled: true,
  });
  assert.equal(result.ok, true, result.message);
  let parsed = await readJson(fixture.userFile);
  assert.deepEqual(parsed.disabled_agents, ['observer', 'explorer']);

  result = await subject.setAgentDisabled({
    agent: 'librarian',
    disabled: true,
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  assert.deepEqual(parsed.disabled_agents, ['observer', 'explorer']);

  result = await subject.setAgentDisabled({
    agent: 'explorer',
    disabled: false,
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  assert.deepEqual(parsed.disabled_agents, ['observer']);

  const beforeProtected = await fs.readFile(fixture.userFile, 'utf8');
  result = await subject.setAgentDisabled({
    agent: 'orchestrator',
    disabled: true,
  });
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(fixture.userFile, 'utf8'), beforeProtected);

  result = await subject.setAgentDisabled({
    agent: 'observer',
    disabled: false,
  });
  assert.equal(result.ok, true, result.message);
  parsed = await readJson(fixture.userFile);
  assert.deepEqual(parsed.disabled_agents, []);

  await writeJson(fixture.userFile, {
    preset: 'none',
    disabled_agents: [],
    presets: {},
  });
  await writeJson(projectConfigFile(fixture.projectDir), {
    preset: 'none',
    disabled_agents: ['explorer'],
    presets: { none: { agents: { oracle: { model: 'a/b' } } } },
  });
  const beforeUser = await fs.readFile(fixture.userFile, 'utf8');
  result = await subject.setAgentDisabled({
    agent: 'explorer',
    disabled: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('project config'));
  assert.ok(result.message.includes('disabled_agents'));
  assert.equal(await fs.readFile(fixture.userFile, 'utf8'), beforeUser);

  result = await subject.setAgentDisabled({
    agent: 'explorer',
    disabled: true,
  });
  assert.equal(result.ok, true, result.message);
  assert.ok(result.message.includes('project config'));
  assert.equal(await fs.readFile(fixture.userFile, 'utf8'), beforeUser);

  result = await createOmosConfigBackend({
    directory: fixture.projectDir,
    env: { ...fixture.env, OPENCODE_CONFIG_PROJECT_DISABLE: '1' },
    homedir: () => path.join(fixture.root, 'home'),
  }).setAgentDisabled({ agent: 'explorer', disabled: false });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual((await readJson(fixture.userFile)).disabled_agents, []);
});

test('setAgentDisabled creates the preferred user config when none exists', async (t) => {
  const fixture = await makeFixture(t);
  const result = await backend(fixture).setAgentDisabled({
    agent: 'explore',
    disabled: true,
  });
  assert.equal(result.ok, true, result.message);
  const parsed = await readJson(fixture.userFile);
  assert.deepEqual(parsed.disabled_agents, ['observer', 'explorer']);
  assert.equal(
    parsed.$schema,
    'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json',
  );
});

test('concurrent GUI writes are serialized and both survive', async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(fixture.userFile, {
    presets: {
      work: { agents: { oracle: { model: 'a/b' }, fixer: { model: 'c/d' } } },
    },
  });
  const subject = backend(fixture);
  const [first, second] = await Promise.all([
    subject.setAgentOverride({
      preset: 'work',
      agent: 'oracle',
      patch: { temperature: 0.2 },
    }),
    subject.setAgentOverride({
      preset: 'work',
      agent: 'fixer',
      patch: { temperature: 0.8 },
    }),
  ]);
  assert.equal(first.ok, true, first.message);
  assert.equal(second.ok, true, second.message);
  const parsed = await readJson(fixture.userFile);
  const agents = asRecord(presetOf(parsed, 'work').agents);
  assert.equal(asRecord(agents.oracle).temperature, 0.2);
  assert.equal(asRecord(agents.fixer).temperature, 0.8);
});

test('parse errors abort without destructive replacement', async (t) => {
  const fixture = await makeFixture(t);
  await writeText(fixture.userFile, '{ this is not json');
  const before = await fs.readFile(fixture.userFile, 'utf8');
  const subject = backend(fixture);
  const result = await subject.setAgentDisabled({
    agent: 'observer',
    disabled: true,
  });
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(fixture.userFile, 'utf8'), before);
  await assert.rejects(fs.stat(`${fixture.userFile}.bak`));
});

test('writes follow a symlink target and keep the backup beside the link', async (t) => {
  const fixture = await makeFixture(t);
  const realFile = path.join(fixture.root, 'real', `${CONFIG_NAME}.jsonc`);
  await writeJson(realFile, {
    preset: 'linked',
    presets: { work: { agents: { oracle: { model: 'a/b' } } } },
  });
  await fs.mkdir(path.dirname(fixture.userFile), { recursive: true });
  try {
    await fs.symlink(realFile, fixture.userFile, 'file');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
      t.skip(`file symlinks unavailable: ${code}`);
      return;
    }
    throw error;
  }

  const subject = backend(fixture);
  const original = await fs.readFile(fixture.userFile, 'utf8');
  const result = await subject.setAgentOverride({
    preset: 'work',
    agent: 'oracle',
    patch: { temperature: 0.9 },
  });
  assert.equal(result.ok, true, result.message);
  const parsed = await readJson(realFile);
  assert.equal(
    asRecord(asRecord(presetOf(parsed, 'work').agents).oracle).temperature,
    0.9,
  );
  assert.equal((await fs.lstat(fixture.userFile)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(`${fixture.userFile}.bak`, 'utf8'), original);
});
