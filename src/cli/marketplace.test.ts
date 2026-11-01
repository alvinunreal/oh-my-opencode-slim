import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMarketplaceCommand } from './marketplace';

function fakeService() {
  const calls: unknown[][] = [];
  const service = {
    installRemote: async (...args: unknown[]) => {
      calls.push(['install', ...args]);
      return { id: 'installed' };
    },
    importFile: (...args: unknown[]) => {
      calls.push(['import', ...args]);
      return { id: 'imported' };
    },
    updateRemote: async (...args: unknown[]) => {
      calls.push(['update', ...args]);
      return { id: 'updated' };
    },
    updateFile: (...args: unknown[]) => {
      calls.push(['update-file', ...args]);
      return { id: 'updated-file' };
    },
    list: () => [],
    show: (...args: unknown[]) => ({ args }),
    verify: () => [{ valid: true }],
    enable: (...args: unknown[]) => calls.push(['enable', ...args]),
    disable: (...args: unknown[]) => calls.push(['disable', ...args]),
    uninstallGlobal: (...args: unknown[]) => {
      calls.push(['uninstall', ...args]);
      return { uninstalled: true };
    },
    status: () => ({
      liveAvailable: false,
      livePackages: null,
      reloadRequired: null,
      diagnostics: [],
    }),
    requestReload: () => ({ accepted: false, reloadRequired: null }),
  };
  return { calls, service: service as never };
}

describe('marketplace CLI', () => {
  test('v2 status and disable use inherited config above the git root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-cli-v2-'));
    const project = join(root, 'repo', 'app');
    const previousData = process.env.XDG_DATA_HOME;
    const previousConfig = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_DATA_HOME = join(root, 'data');
      process.env.XDG_CONFIG_HOME = join(root, 'config');
      mkdirSync(join(root, '.opencode'), { recursive: true });
      mkdirSync(join(root, 'repo', '.git'), { recursive: true });
      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(root, '.opencode', 'oh-my-opencode-slim.json'),
        JSON.stringify({
          preset: 'work',
          presets: { work: { marketplace: { agents: ['team/cli'] } } },
        }),
      );
      const bundlePath = join(root, 'bundle.json');
      writeFileSync(
        bundlePath,
        JSON.stringify({
          manifest: {
            schemaVersion: 2,
            id: 'team/cli',
            version: '1.0.0',
            displayName: 'CLI',
            description: 'CLI fixture',
            agentName: 'cli-agent',
            prompt: 'Test.',
            skills: [],
            mcps: [],
            tools: [],
            author: { name: 'Test' },
            tags: [],
            license: 'MIT',
            compatibility: { plugin: '*' },
            model: { source: 'session' },
            routing: { description: 'CLI', when: 'Testing.', keywords: [] },
          },
        }),
      );
      const output: string[] = [];
      const errors: string[] = [];
      const io = {
        cwd: project,
        stdout: (value: string) => output.push(value),
        stderr: (value: string) => errors.push(value),
      };
      expect(await runMarketplaceCommand(['import', bundlePath], io)).toBe(0);
      expect(await runMarketplaceCommand(['status'], io)).toBe(0);
      expect(JSON.parse(output.at(-1) ?? '{}').desiredPackageIds).toEqual([]);
      expect(
        await runMarketplaceCommand(['status', '--host-flavor', 'v2'], io),
      ).toBe(0);
      expect(JSON.parse(output.at(-1) ?? '{}').desiredPackageIds).toEqual([
        'team/cli',
      ]);
      expect(
        await runMarketplaceCommand(
          ['disable', 'team/cli', '--host-flavor', 'v2'],
          io,
        ),
      ).toBe(0);
      expect(
        await runMarketplaceCommand(['status', '--host-flavor', 'v2'], io),
      ).toBe(0);
      expect(JSON.parse(output.at(-1) ?? '{}').desiredPackageIds).toEqual([]);
      expect(
        await runMarketplaceCommand(
          ['enable', 'team/cli', '--host-flavor', 'v2'],
          io,
        ),
      ).toBe(0);
      expect(
        await runMarketplaceCommand(['status', '--host-flavor', 'v2'], io),
      ).toBe(0);
      expect(JSON.parse(output.at(-1) ?? '{}').desiredPackageIds).toEqual([
        'team/cli',
      ]);
      expect(errors).toEqual([]);
    } finally {
      if (previousData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousData;
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfig;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves bundle paths relative to cwd and routes subcommands', async () => {
    const { calls, service } = fakeService();
    const out: string[] = [];
    expect(
      await runMarketplaceCommand(['import', 'fixtures/a.json'], {
        cwd: '/repo/project',
        service,
        stdout: (text) => out.push(text),
      }),
    ).toBe(0);
    expect(calls).toEqual([['import', '/repo/project/fixtures/a.json']]);
    expect(out).toHaveLength(1);
    expect(
      await runMarketplaceCommand(['enable', 'author/package'], {
        service,
        stdout: () => {},
      }),
    ).toBe(0);
    expect(calls[1]).toEqual(['enable', 'author/package', 'project']);
    expect(
      await runMarketplaceCommand(['disable', 'author/package', '--user'], {
        service,
        stdout: () => {},
      }),
    ).toBe(0);
    expect(calls[2]).toEqual(['disable', 'author/package', 'user']);
  });

  test('rejects unknown commands, flags, missing targets, and extra args', async () => {
    const errors: string[] = [];
    const io = {
      ...fakeService(),
      stderr: (text: string) => errors.push(text),
      stdout: () => {},
    };
    expect(await runMarketplaceCommand(['unknown'], io)).toBe(2);
    expect(await runMarketplaceCommand(['show', '--bad'], io)).toBe(1);
    expect(await runMarketplaceCommand(['list', 'extra'], io)).toBe(1);
    expect(await runMarketplaceCommand(['install'], io)).toBe(1);
    expect(
      await runMarketplaceCommand(['status', '--host-flavor', 'v3'], io),
    ).toBe(1);
    expect(
      await runMarketplaceCommand(['install', 'author/package', '--user'], io),
    ).toBe(1);
    expect(errors).toHaveLength(6);
  });

  test('standalone status preserves unavailable live registry state', async () => {
    const { service } = fakeService();
    const out: string[] = [];
    expect(
      await runMarketplaceCommand(['status'], {
        service,
        stdout: (text) => out.push(text),
      }),
    ).toBe(0);
    expect(JSON.parse(out[0] ?? '{}')).toMatchObject({
      liveAvailable: false,
      livePackages: null,
      reloadRequired: null,
    });
  });

  test('shows incompatibility diagnostics for exact install selectors and updates', async () => {
    const diagnostic =
      'Marketplace package alvin/janitor@1.0.0 is incompatible: requires plugin version >=3.0.0-beta.11; current plugin version is 2.2.25';
    const errors: string[] = [];
    const service = {
      ...fakeService().service,
      installRemote: async () => {
        throw new Error(diagnostic);
      },
      updateRemote: async () => {
        throw new Error(diagnostic);
      },
    } as never;
    const io = { service, stderr: (message: string) => errors.push(message) };

    expect(
      await runMarketplaceCommand(['install', 'alvin/janitor@1.0.0'], io),
    ).toBe(1);
    expect(await runMarketplaceCommand(['update', 'alvin/janitor'], io)).toBe(
      1,
    );
    expect(errors).toEqual([diagnostic, diagnostic]);
    expect(errors.every((message) => !message.includes('not found'))).toBe(
      true,
    );
  });

  test('requires the exact global uninstall flag and has no remove command', async () => {
    const { calls, service } = fakeService();
    const errors: string[] = [];
    const io = {
      service,
      stdout: () => {},
      stderr: (text: string) => errors.push(text),
    };

    expect(await runMarketplaceCommand(['remove', 'author/package'], io)).toBe(
      2,
    );
    expect(
      await runMarketplaceCommand(['uninstall', 'author/package'], io),
    ).toBe(1);
    expect(
      await runMarketplaceCommand(
        ['uninstall', 'author/package', '--project'],
        io,
      ),
    ).toBe(1);
    expect(
      await runMarketplaceCommand(
        ['uninstall', 'author/package', '--global'],
        io,
      ),
    ).toBe(0);
    expect(calls).toEqual([['uninstall', 'author/package', true]]);
    expect(errors).toHaveLength(3);
  });
});
