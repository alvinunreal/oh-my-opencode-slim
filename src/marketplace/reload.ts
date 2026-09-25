import { crossSpawn } from '../utils/compat';

export type MarketplaceReloadStatus =
  | 'reloaded'
  | 'applied'
  | 'pending'
  | 'unsupported'
  | 'unavailable';

export interface MarketplaceReloadResult {
  status: MarketplaceReloadStatus;
  detail: string;
}

export interface MarketplaceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type MarketplaceCommandRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<MarketplaceCommandResult>;

export interface ReloadOpenCodeServiceOptions {
  cwd: string;
  command?: string;
  run?: MarketplaceCommandRunner;
}

function defaultCommandRunner(command: string): MarketplaceCommandRunner {
  return async (args, cwd) => {
    try {
      const child = crossSpawn([command, ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        child.stdout(),
        child.stderr(),
      ]);
      return { exitCode, stdout, stderr };
    } catch (error) {
      return {
        exitCode: 127,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

function majorVersion(output: string): number | undefined {
  const match = output.match(/(?:^|[^\d])v?(\d+)\.\d+(?:\.\d+)?\b/i);
  return match ? Number(match[1]) : undefined;
}

function unavailableDetail(result: MarketplaceCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail
    ? `OpenCode service unavailable: ${detail}`
    : 'OpenCode service unavailable.';
}

async function runSafely(
  run: MarketplaceCommandRunner,
  args: readonly string[],
  cwd: string,
): Promise<MarketplaceCommandResult> {
  try {
    return await run(args, cwd);
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Restart an active OpenCode v2 managed service without making mutation fail. */
export async function reloadOpenCodeService(
  options: ReloadOpenCodeServiceOptions,
): Promise<MarketplaceReloadResult> {
  const command = options.command ?? process.env.OPENCODE_BIN ?? 'opencode';
  const run = options.run ?? defaultCommandRunner(command);
  const execute = (args: readonly string[]) =>
    runSafely(run, args, options.cwd);
  const version = await execute(['--version']);
  if (version.exitCode !== 0) {
    return { status: 'unavailable', detail: unavailableDetail(version) };
  }

  const major = majorVersion(`${version.stdout}\n${version.stderr}`);
  if (major !== 2) {
    return {
      status: 'unsupported',
      detail:
        major === undefined
          ? 'OpenCode version could not be identified; configuration is ready for the next launch.'
          : `OpenCode v${major} does not support automatic marketplace service reload; configuration is ready for the next launch.`,
    };
  }

  const serviceStatus = await execute(['service', 'status']);
  if (serviceStatus.exitCode !== 0) {
    return { status: 'unavailable', detail: unavailableDetail(serviceStatus) };
  }
  if (serviceStatus.stdout.trim() === 'stopped') {
    return {
      status: 'pending',
      detail:
        'No active OpenCode service; configuration will apply on the next launch.',
    };
  }
  if (!/^https?:\/\/\S+$/i.test(serviceStatus.stdout.trim())) {
    return {
      status: 'unavailable',
      detail:
        'OpenCode service status could not be identified; configuration is ready for the next launch.',
    };
  }

  const restart = await execute(['service', 'restart']);
  if (restart.exitCode !== 0) {
    return { status: 'unavailable', detail: unavailableDetail(restart) };
  }
  return {
    status: 'reloaded',
    detail:
      'Active OpenCode v2 service restarted; marketplace configuration is applied.',
  };
}
