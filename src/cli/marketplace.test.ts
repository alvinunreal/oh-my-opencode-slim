import { describe, expect, test } from 'bun:test';
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
      await runMarketplaceCommand(['install', 'author/package', '--user'], io),
    ).toBe(1);
    expect(errors).toHaveLength(5);
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
