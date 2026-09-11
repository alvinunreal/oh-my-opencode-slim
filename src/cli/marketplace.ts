import {
  MarketplaceService,
  type MarketplaceServiceOptions,
} from '../marketplace';
import {
  disableMarketplacePackage,
  enableMarketplaceAgent,
  setMarketplaceProfile,
} from '../marketplace/activation-config';
import {
  collectMarketplaceStatus,
  formatMarketplaceStatus,
  mutationReloadNotice,
} from '../marketplace/status';

export type MarketplaceCommandName =
  | 'install'
  | 'import'
  | 'list'
  | 'show'
  | 'verify'
  | 'update'
  | 'remove'
  | 'enable'
  | 'disable'
  | 'profile'
  | 'status';

export interface MarketplaceArgs {
  command: MarketplaceCommandName;
  value?: string;
  role?: string;
  force: boolean;
  json: boolean;
  clear: boolean;
  update?: boolean;
}

function commandSet(): readonly string[] {
  return [
    'install',
    'import',
    'list',
    'show',
    'verify',
    'update',
    'remove',
    'enable',
    'disable',
    'profile',
    'status',
  ];
}

export function parseMarketplaceArgs(args: string[]): MarketplaceArgs {
  const rawCommand = args[0];
  if (!rawCommand || !commandSet().includes(rawCommand)) {
    throw new Error(
      'Usage: marketplace install|import|list|show|verify|update|remove|enable|disable|profile|status [value] [options]',
    );
  }
  const command = rawCommand as MarketplaceCommandName;
  const force = args.includes('--force');
  const json = args.includes('--json');
  const clear = args.includes('--clear');
  const update = args.includes('--update');
  const options = args.filter((arg) => arg.startsWith('--'));
  const allowedOptions = new Set(
    command === 'remove'
      ? ['--force']
      : command === 'verify' || command === 'show' || command === 'status'
        ? ['--json']
        : command === 'profile'
          ? ['--clear']
          : command === 'import'
            ? ['--update']
            : [],
  );
  for (const option of options) {
    if (!allowedOptions.has(option)) {
      throw new Error(
        `Option ${option} is not valid for marketplace ${rawCommand}`,
      );
    }
  }

  const positional = args.slice(1).filter((arg) => !arg.startsWith('--'));
  if (command === 'profile') {
    if (!positional[0]) {
      throw new Error('marketplace profile requires a specialist role');
    }
    if (clear) {
      if (positional.length > 1) {
        throw new Error('marketplace profile --clear accepts only a role');
      }
      return {
        command,
        role: positional[0],
        force,
        json,
        clear,
      };
    }
    if (!positional[1] || positional.length > 2) {
      throw new Error('marketplace profile requires a role and package ID');
    }
    return {
      command,
      role: positional[0],
      value: positional[1],
      force,
      json,
      clear,
    };
  }
  const needsValue = [
    'install',
    'import',
    'show',
    'update',
    'remove',
    'enable',
    'disable',
  ].includes(command);
  const allowsValue = needsValue || command === 'verify';
  if (positional.length > (allowsValue ? 1 : 0)) {
    throw new Error(
      `marketplace ${rawCommand} accepts ${needsValue ? 'one' : 'no more than one'} value`,
    );
  }
  if (needsValue && !positional[0]) {
    throw new Error(`marketplace ${rawCommand} requires a value`);
  }
  if (
    (command === 'install' || command === 'update' || command === 'import') &&
    force
  ) {
    throw new Error(
      `Option --force is not valid for marketplace ${rawCommand}`,
    );
  }
  if (command !== 'import' && update) {
    throw new Error('Option --update is only valid for marketplace import');
  }
  return {
    command,
    value: positional[0],
    force,
    json,
    clear,
    ...(command === 'import' && update ? { update: true } : {}),
  };
}

export async function marketplaceCommand(
  args: string[],
  options: MarketplaceServiceOptions = {},
): Promise<number> {
  try {
    const parsed = parseMarketplaceArgs(args);
    const service = new MarketplaceService(options);
    const projectDir = options.projectDir ?? process.cwd();
    switch (parsed.command) {
      case 'install': {
        const pkg = await service.installRemote(parsed.value as string);
        console.log(
          mutationReloadNotice(
            `Installed ${pkg.manifest.id}@${pkg.manifest.version}`,
            'unknown',
          ),
        );
        return 0;
      }
      case 'import': {
        const pkg = parsed.update
          ? service.importFileUpdate(parsed.value as string)
          : service.importFile(parsed.value as string);
        console.log(
          mutationReloadNotice(
            `${parsed.update ? 'Updated' : 'Imported'} ${pkg.manifest.id}@${pkg.manifest.version}`,
            'unknown',
          ),
        );
        return 0;
      }
      case 'update': {
        const pkg = await service.updateRemote(parsed.value as string);
        console.log(
          mutationReloadNotice(
            `Updated ${pkg.manifest.id}@${pkg.manifest.version}`,
            'unknown',
          ),
        );
        return 0;
      }
      case 'list':
        for (const pkg of service.list()) {
          console.log(
            `${pkg.manifest.id}@${pkg.manifest.version}\t${pkg.manifest.kind}\t${pkg.manifest.displayName}`,
          );
        }
        return 0;
      case 'show': {
        const pkg = service.show(parsed.value as string);
        console.log(
          parsed.json
            ? JSON.stringify(pkg, null, 2)
            : `${pkg.manifest.id}@${pkg.manifest.version}\n${pkg.manifest.description}\nsource: ${JSON.stringify(pkg.source)}`,
        );
        return 0;
      }
      case 'verify': {
        const results = service.verify(parsed.value);
        if (parsed.json) console.log(JSON.stringify(results, null, 2));
        else {
          for (const result of results) {
            console.log(`${result.valid ? 'OK' : 'FAIL'} ${result.message}`);
          }
        }
        return results.every((result) => result.valid) ? 0 : 1;
      }
      case 'remove':
        service.remove(parsed.value as string, { force: parsed.force });
        console.log(mutationReloadNotice(`Removed ${parsed.value}`, 'unknown'));
        return 0;
      case 'enable':
        enableMarketplaceAgent(
          projectDir,
          parsed.value as string,
          service.store,
        );
        console.log(
          mutationReloadNotice(
            `Enabled ${parsed.value} in the active preset`,
            'unknown',
          ),
        );
        return 0;
      case 'disable':
        disableMarketplacePackage(projectDir, parsed.value as string);
        console.log(
          mutationReloadNotice(
            `Disabled ${parsed.value} in the active preset`,
            'unknown',
          ),
        );
        return 0;
      case 'profile':
        setMarketplaceProfile(
          projectDir,
          parsed.role as string,
          parsed.clear ? null : (parsed.value as string),
          service.store,
        );
        console.log(
          mutationReloadNotice(
            parsed.clear
              ? `Cleared the ${parsed.role} profile`
              : `Selected ${parsed.value} for ${parsed.role}`,
            'unknown',
          ),
        );
        return 0;
      case 'status': {
        const report = collectMarketplaceStatus({
          service,
          projectDir,
        });
        console.log(
          parsed.json
            ? JSON.stringify(report, null, 2)
            : formatMarketplaceStatus(report),
        );
        return 0;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
