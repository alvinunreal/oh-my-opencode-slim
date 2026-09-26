import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'jsonc-parser';
import { withMarketplaceConfigReferencesRemoved } from './config-references';

const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousReferenceId = process.env.MARKETPLACE_REFERENCE_ID;
const previousKeptId = process.env.MARKETPLACE_KEPT_ID;
const previousMissingId = process.env.MARKETPLACE_MISSING_ID;

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  if (previousReferenceId === undefined) {
    delete process.env.MARKETPLACE_REFERENCE_ID;
  } else {
    process.env.MARKETPLACE_REFERENCE_ID = previousReferenceId;
  }
  if (previousKeptId === undefined) delete process.env.MARKETPLACE_KEPT_ID;
  else process.env.MARKETPLACE_KEPT_ID = previousKeptId;
  if (previousMissingId === undefined) {
    delete process.env.MARKETPLACE_MISSING_ID;
  } else {
    process.env.MARKETPLACE_MISSING_ID = previousMissingId;
  }
});

function createConfigs() {
  const root = mkdtempSync(join(tmpdir(), 'marketplace-config-references-'));
  const project = join(root, 'project');
  const configDir = join(root, 'config', 'opencode');
  const userPath = join(configDir, 'oh-my-opencode-slim.jsonc');
  const projectPath = join(project, '.opencode', 'oh-my-opencode-slim.jsonc');
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(project, '.opencode'), { recursive: true });
  return { root, project, userPath, projectPath };
}

describe('marketplace config reference cleanup', () => {
  test('prepares every file before publishing when the second is malformed', () => {
    const fixture = createConfigs();
    try {
      const valid = JSON.stringify({
        presets: { work: { marketplace: { agents: ['community/remove'] } } },
      });
      writeFileSync(fixture.userPath, valid);
      writeFileSync(fixture.projectPath, '{ invalid');
      const malformed =
        fixture.projectPath.localeCompare(fixture.userPath) > 0
          ? fixture.projectPath
          : fixture.userPath;
      if (malformed === fixture.userPath) {
        writeFileSync(fixture.projectPath, valid);
        writeFileSync(fixture.userPath, '{ invalid');
      }
      const userBefore = readFileSync(fixture.userPath, 'utf8');
      const projectBefore = readFileSync(fixture.projectPath, 'utf8');

      expect(() =>
        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/remove',
          () => {
            throw new Error('operation must not run');
          },
        ),
      ).toThrow(`Failed to parse config ${malformed}`);
      expect(readFileSync(fixture.userPath, 'utf8')).toBe(userBefore);
      expect(readFileSync(fixture.projectPath, 'utf8')).toBe(projectBefore);
      expect(existsSync(`${fixture.userPath}.bak`)).toBe(false);
      expect(existsSync(`${fixture.projectPath}.bak`)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('failed second publication restores exact bytes without replacing backups', () => {
    const fixture = createConfigs();
    try {
      const content = JSON.stringify({
        presets: { work: { marketplace: { agents: ['community/remove'] } } },
      });
      writeFileSync(fixture.userPath, content);
      writeFileSync(fixture.projectPath, content);
      const secondPath = [fixture.userPath, fixture.projectPath].sort()[1];
      mkdirSync(`${secondPath}.bak`);

      expect(() =>
        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/remove',
          () => {},
        ),
      ).toThrow(/EISDIR/);
      expect(readFileSync(fixture.userPath, 'utf8')).toBe(content);
      expect(readFileSync(fixture.projectPath, 'utf8')).toBe(content);
      expect(
        readFileSync(
          `${[fixture.userPath, fixture.projectPath].sort()[0]}.bak`,
          'utf8',
        ),
      ).toBe(content);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('reports rollback failure with the path and original publication error', () => {
    const fixture = createConfigs();
    try {
      const content = JSON.stringify({
        presets: { work: { marketplace: { agents: ['community/remove'] } } },
      });
      writeFileSync(fixture.userPath, content);
      writeFileSync(fixture.projectPath, content);
      const [firstPath, secondPath] = [
        fixture.userPath,
        fixture.projectPath,
      ].sort();
      let caught: unknown;
      try {
        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/remove',
          () => {
            rmSync(firstPath);
            mkdirSync(firstPath);
            throw new Error('store failure');
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).message).toContain('rollback failed');
      expect((caught as AggregateError).errors[1].message).toContain(
        `Failed to restore config ${firstPath}`,
      );
      expect(existsSync(secondPath)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('unresolved or malformed directives block all publication and operation', () => {
    const fixture = createConfigs();
    delete process.env.MARKETPLACE_MISSING_ID;
    try {
      const valid = JSON.stringify({
        presets: { work: { marketplace: { agents: ['community/remove'] } } },
      });
      writeFileSync(fixture.userPath, valid);
      writeFileSync(
        fixture.projectPath,
        JSON.stringify({
          presets: {
            work: {
              marketplace: { agents: ['{env:MARKETPLACE_MISSING_ID}'] },
            },
          },
        }),
      );
      const userBefore = readFileSync(fixture.userPath, 'utf8');
      const projectBefore = readFileSync(fixture.projectPath, 'utf8');
      let operationCalled = false;

      expect(() =>
        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/remove',
          () => {
            operationCalled = true;
          },
        ),
      ).toThrow("environment variable 'MARKETPLACE_MISSING_ID' referenced");
      expect(operationCalled).toBe(false);
      expect(readFileSync(fixture.userPath, 'utf8')).toBe(userBefore);
      expect(readFileSync(fixture.projectPath, 'utf8')).toBe(projectBefore);
      expect(existsSync(`${fixture.userPath}.bak`)).toBe(false);
      expect(existsSync(`${fixture.projectPath}.bak`)).toBe(false);

      writeFileSync(
        fixture.projectPath,
        JSON.stringify({
          presets: {
            work: { marketplace: { agents_add: 'community/remove' } },
          },
        }),
      );
      expect(() =>
        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/remove',
          () => {
            operationCalled = true;
          },
        ),
      ).toThrow('marketplace.agents_add must be an array');
      expect(operationCalled).toBe(false);
      expect(readFileSync(fixture.userPath, 'utf8')).toBe(userBefore);
      expect(existsSync(`${fixture.userPath}.bak`)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('classifies config lease release failure after commit and recovers on retry', () => {
    const fixture = createConfigs();
    try {
      writeFileSync(
        fixture.projectPath,
        JSON.stringify({
          presets: { work: { marketplace: { agents: ['community/remove'] } } },
        }),
      );
      const lockDir = join(
        dirname(fixture.projectPath),
        `.${basename(fixture.projectPath)}.write-lock`,
        'marketplace.lock',
      );
      let leasePath: string | undefined;
      let injected = false;
      const originalUnlink = fs.unlinkSync;
      const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation(((
        path: fs.PathLike,
        ...args: Parameters<typeof fs.unlinkSync>[1][]
      ) => {
        if (leasePath && !injected && resolve(path.toString()) === leasePath) {
          injected = true;
          throw Object.assign(new Error('transient lease unlink failure'), {
            code: 'EIO',
          });
        }
        return originalUnlink.call(fs, path, ...args);
      }) as typeof fs.unlinkSync);
      try {
        expect(() =>
          withMarketplaceConfigReferencesRemoved(
            fixture.project,
            'community/remove',
            (onCommitted) => {
              const leaseName = readdirSync(lockDir).find((name) =>
                name.endsWith('.lease'),
              );
              if (!leaseName) throw new Error('Config lease was not acquired');
              leasePath = join(lockDir, leaseName);
              onCommitted();
            },
          ),
        ).toThrow(/completed, but finalization failed/);
        expect(injected).toBe(true);
        expect(JSON.parse(readFileSync(fixture.projectPath, 'utf8'))).toEqual({
          presets: { work: { marketplace: { agents: [] } } },
        });

        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/remove',
          () => {},
        );
        expect(
          readdirSync(lockDir).filter((name) => name.endsWith('.lease')),
        ).toEqual([]);
      } finally {
        unlinkSpy.mockRestore();
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('keeps removed references after a post-commit finalization error', () => {
    const fixture = createConfigs();
    try {
      writeFileSync(
        fixture.projectPath,
        JSON.stringify({
          presets: { work: { marketplace: { agents: ['community/remove'] } } },
        }),
      );
      expect(() =>
        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/remove',
          (onCommitted) => {
            onCommitted();
            throw new Error('cleanup failed');
          },
        ),
      ).toThrow(/completed, but finalization failed/);
      expect(JSON.parse(readFileSync(fixture.projectPath, 'utf8'))).toEqual({
        presets: { work: { marketplace: { agents: [] } } },
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('removes env-resolved directive IDs while preserving raw placeholders and other config', () => {
    const fixture = createConfigs();
    process.env.MARKETPLACE_REFERENCE_ID = 'community/remove';
    process.env.MARKETPLACE_KEPT_ID = 'community/keep';
    try {
      const source = `\uFEFF{
  // preserve comments and unrelated custom marketplace agent
  "agents": { "my-marketplace-agent": { "marketplace": true } },
  "presets": {
    "work": { "marketplace": {
      "agents": ["{env:MARKETPLACE_REFERENCE_ID}", "community/keep"],
      "agents_add": ["{env:MARKETPLACE_REFERENCE_ID}", "{env:MARKETPLACE_KEPT_ID}"],
      "agents_remove": ["community/remove"],
    } },
  },
}\n`;
      writeFileSync(fixture.projectPath, source);
      writeFileSync(
        fixture.userPath,
        JSON.stringify({
          presets: { work: { marketplace: { agents: ['community/stale'] } } },
        }),
      );

      withMarketplaceConfigReferencesRemoved(
        fixture.project,
        'community/remove',
        () => {},
      );

      const updated = readFileSync(fixture.projectPath, 'utf8');
      expect(updated.startsWith('\uFEFF')).toBe(true);
      expect(updated).toContain(
        '// preserve comments and unrelated custom marketplace agent',
      );
      const parsed = parse(updated.replace(/^\uFEFF/, ''));
      expect(parsed.agents['my-marketplace-agent']).toEqual({
        marketplace: true,
      });
      expect(parsed.presets.work.marketplace).toEqual({
        agents: ['community/keep'],
        agents_add: ['{env:MARKETPLACE_KEPT_ID}'],
        agents_remove: [],
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('calls the operation for absent config files to allow stale store cleanup', () => {
    const fixture = createConfigs();
    try {
      let committed = false;
      withMarketplaceConfigReferencesRemoved(
        fixture.project,
        'community/absent',
        (onCommitted) => {
          committed = true;
          onCommitted();
        },
      );
      expect(committed).toBe(true);
      expect(existsSync(fixture.userPath)).toBe(false);
      expect(existsSync(fixture.projectPath)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
