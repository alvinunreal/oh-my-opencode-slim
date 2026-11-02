import { resolve } from 'node:path';
import { MarketplaceService } from '../marketplace/service';

const COMMANDS = [
  'install',
  'import',
  'update',
  'update-file',
  'list',
  'show',
  'verify',
  'enable',
  'disable',
  'uninstall',
  'status',
  'request-reload',
] as const;

export type MarketplaceCommandIO = {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly cwd?: string;
  readonly service?: MarketplaceService;
};

function usage(): string {
  return [
    'Usage: oh-my-opencode-slim marketplace <command> [target]',
    `Commands: ${COMMANDS.join(', ')}`,
    'Targets are package IDs/selectors or bundle file paths as appropriate.',
    'enable/disable accept optional --user; default activation scope is project.',
    'All commands accept --host-flavor v1|v2; default is v1.',
  ].join('\n');
}

function requireTarget(command: string, args: readonly string[]): string {
  if (args.length !== 1 || !args[0]?.trim() || args[0].startsWith('--')) {
    throw new Error(`${command} requires exactly one nonblank target`);
  }
  return args[0];
}

function requireNoArgs(command: string, args: readonly string[]): void {
  if (args.length !== 0)
    throw new Error(`${command} does not accept arguments`);
}

function requireActivationArgs(
  command: string,
  args: readonly string[],
): { target: string; scope: 'project' | 'user' } {
  if (
    (args.length !== 1 && args.length !== 2) ||
    !args[0]?.trim() ||
    args[0].startsWith('--') ||
    (args.length === 2 && args[1] !== '--user')
  ) {
    throw new Error(`${command} requires <package-id> [--user]`);
  }
  return { target: args[0], scope: args[1] === '--user' ? 'user' : 'project' };
}

/** Run a strict marketplace CLI command; all package/config operations use the service. */
export async function runMarketplaceCommand(
  args: readonly string[],
  io: MarketplaceCommandIO = {},
): Promise<number> {
  const stdout = io.stdout ?? console.log;
  const stderr = io.stderr ?? console.error;
  const cwd = io.cwd ?? process.cwd();
  const [command, ...rest] = args;

  if (command === '--help' || command === '-h' || command === undefined) {
    if (rest.length > 0) {
      stderr('Marketplace help does not accept extra arguments');
      return 2;
    }
    stdout(usage());
    return command ? 0 : 2;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    stderr(`Unknown marketplace command: ${command}\n${usage()}`);
    return 2;
  }

  try {
    let hostFlavor: 'v1' | 'v2' = 'v1';
    const flavorIndex = rest.indexOf('--host-flavor');
    if (flavorIndex !== -1) {
      const value = rest[flavorIndex + 1];
      if (
        (value !== 'v1' && value !== 'v2') ||
        rest.lastIndexOf('--host-flavor') !== flavorIndex
      ) {
        throw new Error('--host-flavor requires exactly one value: v1 or v2');
      }
      hostFlavor = value;
      rest.splice(flavorIndex, 2);
    }
    const service =
      io.service ?? new MarketplaceService({ projectDir: cwd, hostFlavor });
    if (
      rest.includes('--user') &&
      command !== 'enable' &&
      command !== 'disable'
    ) {
      throw new Error('--user is only supported by enable and disable');
    }
    let result: unknown;
    switch (command) {
      case 'install':
        result = await service.installRemote(requireTarget(command, rest));
        break;
      case 'import':
        result = service.importFile(resolve(cwd, requireTarget(command, rest)));
        break;
      case 'update':
        result = await service.updateRemote(requireTarget(command, rest));
        break;
      case 'update-file':
        result = service.updateFile(resolve(cwd, requireTarget(command, rest)));
        break;
      case 'list':
        requireNoArgs(command, rest);
        result = service.list();
        break;
      case 'show':
        result = service.show(requireTarget(command, rest));
        break;
      case 'verify': {
        const target = rest.length ? requireTarget(command, rest) : undefined;
        result = service.verify(target);
        stdout(JSON.stringify(result, null, 2));
        return (result as ReturnType<typeof service.verify>).some(
          ({ valid }) => !valid,
        )
          ? 1
          : 0;
      }
      case 'enable':
        {
          const { target, scope } = requireActivationArgs(command, rest);
          service.enable(target, scope);
        }
        result = { enabled: true };
        break;
      case 'disable':
        {
          const { target, scope } = requireActivationArgs(command, rest);
          service.disable(target, scope);
        }
        result = { enabled: false };
        break;
      case 'uninstall': {
        if (
          rest.length !== 2 ||
          !rest[0]?.trim() ||
          rest[0].startsWith('--') ||
          rest[1] !== '--global'
        ) {
          throw new Error(
            'uninstall requires exactly <package-id> --global; this removes the shared store and does not inspect other projects',
          );
        }
        result = service.uninstallGlobal(rest[0], true);
        break;
      }
      case 'status':
        requireNoArgs(command, rest);
        result = service.status();
        stdout(JSON.stringify(result, null, 2));
        return (result as ReturnType<typeof service.status>).diagnostics.length
          ? 1
          : 0;
      case 'request-reload':
        requireNoArgs(command, rest);
        result = service.requestReload();
        stdout(JSON.stringify(result, null, 2));
        return (result as ReturnType<typeof service.requestReload>).diagnostics
          ?.length
          ? 1
          : 0;
    }
    stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
