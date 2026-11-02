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
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parse } from 'jsonc-parser';
import { withMarketplaceConfigReferencesRemoved } from './config-references';
import { acquireMarketplaceLease } from './lease';
import { getMarketplacePaths } from './paths';

const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const previousReferenceId = process.env.MARKETPLACE_REFERENCE_ID;
const previousKeptId = process.env.MARKETPLACE_KEPT_ID;
const previousMissingId = process.env.MARKETPLACE_MISSING_ID;

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  if (previousOpenCodeConfigDir === undefined)
    delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousOpenCodeConfigDir;
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
              leasePath = join(fs.realpathSync(lockDir), leaseName);
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
          existsSync(lockDir)
            ? readdirSync(lockDir).filter((name) => name.endsWith('.lease'))
            : [],
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

  test('does not lock the unused default config directory when a custom config is selected', () => {
    const fixture = createConfigs();
    const defaultConfigDir = join(fixture.root, 'config', 'opencode');
    const customConfigDir = join(fixture.root, 'custom', 'opencode');
    const customConfigPath = join(customConfigDir, 'oh-my-opencode-slim.jsonc');
    const originalMkdir = fs.mkdirSync;
    try {
      process.env.OPENCODE_CONFIG_DIR = customConfigDir;
      mkdirSync(customConfigDir, { recursive: true });
      writeFileSync(
        customConfigPath,
        JSON.stringify({
          presets: {
            work: { marketplace: { agents: ['community/remove'] } },
          },
        }),
      );
      const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation(((
        path: fs.PathLike,
        ...args: Parameters<typeof fs.mkdirSync>[1][]
      ) => {
        const resolvedPath = resolve(path.toString());
        if (
          resolvedPath.startsWith(`${resolve(defaultConfigDir)}${sep}`) &&
          resolvedPath.includes('.oh-my-opencode-slim.')
        ) {
          throw Object.assign(
            new Error('default config directory is read-only'),
            {
              code: 'EACCES',
            },
          );
        }
        return originalMkdir.call(fs, path, ...args);
      }) as typeof fs.mkdirSync);
      try {
        let committed = false;
        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/remove',
          (onCommitted) => {
            committed = true;
            onCommitted();
          },
        );
        expect(committed).toBe(true);
        expect(
          parse(readFileSync(customConfigPath, 'utf8')).presets.work.marketplace
            .agents,
        ).toEqual([]);
        expect(
          readdirSync(defaultConfigDir).some((name) =>
            name.includes('.oh-my-opencode-slim.'),
          ),
        ).toBe(false);
      } finally {
        mkdirSpy.mockRestore();
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('uninstalls through writable user config when the project config directory is read-only', () => {
    const fixture = createConfigs();
    const projectConfigDir = dirname(fixture.projectPath);
    const originalAccess = fs.accessSync;
    const originalMkdir = fs.mkdirSync;
    try {
      writeFileSync(
        fixture.userPath,
        JSON.stringify({
          presets: {
            work: { marketplace: { agents: ['community/remove'] } },
          },
        }),
      );
      const accessSpy = spyOn(fs, 'accessSync').mockImplementation(((
        path: fs.PathLike,
        mode?: number,
      ) => {
        if (resolve(path.toString()) === resolve(projectConfigDir)) {
          throw Object.assign(
            new Error('project config directory is read-only'),
            {
              code: 'EACCES',
            },
          );
        }
        return originalAccess.call(fs, path, mode);
      }) as typeof fs.accessSync);
      const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation(((
        path: fs.PathLike,
        ...args: Parameters<typeof fs.mkdirSync>[1][]
      ) => {
        if (
          resolve(path.toString()).startsWith(
            `${resolve(projectConfigDir)}${sep}`,
          ) &&
          resolve(path.toString()).includes('.oh-my-opencode-slim.')
        ) {
          throw Object.assign(new Error('unexpected project config lock'), {
            code: 'EACCES',
          });
        }
        return originalMkdir.call(fs, path, ...args);
      }) as typeof fs.mkdirSync);
      try {
        let storeMutationCommitted = false;
        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/remove',
          (onCommitted) => {
            storeMutationCommitted = true;
            onCommitted();
          },
        );

        expect(storeMutationCommitted).toBe(true);
        expect(
          parse(readFileSync(fixture.userPath, 'utf8')).presets.work.marketplace
            .agents,
        ).toEqual([]);
        expect(readdirSync(projectConfigDir)).toEqual([]);
      } finally {
        mkdirSpy.mockRestore();
        accessSpy.mockRestore();
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test.each(['json', 'jsonc'] as const)(
    'waits for and rediscovers a project .%s config created during uninstall',
    async (extension) => {
      const fixture = createConfigs();
      const projectConfigPath = fixture.projectPath.replace(
        /\.jsonc$/,
        `.${extension}`,
      );
      const lockRoot = join(
        dirname(projectConfigPath),
        `.${basename(projectConfigPath)}.write-lock`,
      );
      const heldLease = acquireMarketplaceLease(getMarketplacePaths(lockRoot));
      const readyPath = join(fixture.root, 'uninstall.ready');
      const resultPath = join(fixture.root, 'uninstall.result');
      let worker: ReturnType<typeof Bun.spawn> | undefined;
      let released = false;
      try {
        const script = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { withMarketplaceConfigReferencesRemoved } from './src/marketplace/config-references.ts';
const { project, id, configPath, readyPath, resultPath } = JSON.parse(process.argv[1]);
writeFileSync(readyPath, 'ready');
withMarketplaceConfigReferencesRemoved(project, id, (onCommitted) => {
  writeFileSync(resultPath, existsSync(configPath) ? readFileSync(configPath, 'utf8') : 'missing');
  onCommitted();
});`;
        worker = Bun.spawn(
          [
            'bun',
            '-e',
            script,
            JSON.stringify({
              project: fixture.project,
              id: 'community/remove',
              configPath: projectConfigPath,
              readyPath,
              resultPath,
            }),
          ],
          { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
        );

        const deadline = Date.now() + 10_000;
        while (!existsSync(readyPath)) {
          if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for uninstall worker to start');
          }
          await Bun.sleep(10);
        }
        await Bun.sleep(100);
        expect(existsSync(resultPath)).toBe(false);

        writeFileSync(
          projectConfigPath,
          JSON.stringify({
            presets: {
              work: { marketplace: { agents: ['community/remove'] } },
            },
          }),
        );
        heldLease.release();
        released = true;

        expect(await worker.exited).toBe(0);
        expect(await new Response(worker.stderr).text()).toBe('');
        expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual({
          presets: { work: { marketplace: { agents: [] } } },
        });
        expect(JSON.parse(readFileSync(projectConfigPath, 'utf8'))).toEqual({
          presets: { work: { marketplace: { agents: [] } } },
        });
      } finally {
        if (!released) heldLease.release();
        if (worker) await worker.exited;
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});
