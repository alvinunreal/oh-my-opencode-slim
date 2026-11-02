#!/usr/bin/env node
import { runCompanionCommand } from './companion';
import { doctor, parseDoctorArgs } from './doctor';
import { install } from './install';
import { runMarketplaceCommand } from './marketplace';
import { getGeneratedPresetNames, isGeneratedPresetName } from './providers';
import type { BackgroundSubagentsArg, InstallArgs } from './types';

export function parseArgs(args: string[]): InstallArgs {
  const result: InstallArgs = {
    tui: true,
  };

  for (const arg of args) {
    if (arg === '--no-tui') {
      result.tui = false;
    } else if (arg === '--companion' || arg.startsWith('--companion=')) {
      console.warn(
        'The --companion option was removed from install. ' +
          'Run "bunx oh-my-opencode-slim companion install" instead.',
      );
    } else if (arg.startsWith('--preset=')) {
      const preset = arg.slice('--preset='.length);
      if (!isGeneratedPresetName(preset)) {
        console.error(
          `Unsupported preset: ${preset}. Available presets: ${getGeneratedPresetNames().join(', ')}`,
        );
        process.exit(1);
      }
      result.preset = preset;
    } else if (arg.startsWith('--background-subagents=')) {
      const mode = arg.slice(
        '--background-subagents='.length,
      ) as BackgroundSubagentsArg;
      if (!['ask', 'yes', 'no'].includes(mode)) {
        console.error(
          'Unsupported --background-subagents value: use ask, yes, or no',
        );
        process.exit(1);
      }
      result.backgroundSubagents = mode;
    } else if (arg.startsWith('--background-subagents-target=')) {
      result.backgroundSubagentsTarget = arg.slice(
        '--background-subagents-target='.length,
      );
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--reset') {
      result.reset = true;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown install option: ${arg}`);
      process.exit(1);
    }
  }

  result.backgroundSubagents ??= result.tui ? 'ask' : 'no';

  return result;
}

function printHelp(): void {
  console.log(`
oh-my-opencode-slim installer

Usage:
  bunx oh-my-opencode-slim install [OPTIONS]
  bunx oh-my-opencode-slim doctor [OPTIONS]
  bunx oh-my-opencode-slim marketplace <command> [target]
  bunx oh-my-opencode-slim companion install [--dry-run]

Options:
  --preset=<name>        Active generated config preset (default: openai)
  --background-subagents=ask|yes|no
                          Persist required OpenCode background subagent env
                          (default: ask; prompt defaults to yes)
  --background-subagents-target=<path>
                          Shell startup file to update
  --no-tui               Non-interactive mode
  --dry-run              Simulate install without writing files
  --reset                Force overwrite of existing configuration
  -h, --help             Show this help message

Doctor options:
  --json                 Print diagnostics as JSON

Available presets: ${getGeneratedPresetNames().join(', ')}

The installer generates OpenAI and OpenCode Go presets by default.
OpenAI is active unless --preset selects another generated preset.
For the full config reference, see docs/configuration.md.

Examples:
  bunx oh-my-opencode-slim install
  bunx oh-my-opencode-slim install --no-tui
  bunx oh-my-opencode-slim install --background-subagents=yes
  bunx oh-my-opencode-slim install --preset=opencode-go
  bunx oh-my-opencode-slim install --reset
  bunx oh-my-opencode-slim doctor
  bunx oh-my-opencode-slim companion install
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'install') {
    const hasSubcommand = args[0] === 'install';
    const installArgs = parseArgs(args.slice(hasSubcommand ? 1 : 0));
    const exitCode = await install(installArgs);
    process.exit(exitCode);
  } else if (args[0] === 'doctor') {
    const doctorArgs = parseDoctorArgs(args.slice(1));
    const exitCode = await doctor(doctorArgs);
    process.exit(exitCode);
  } else if (args[0] === 'companion') {
    process.exit(await runCompanionCommand(args.slice(1)));
  } else if (args[0] === 'marketplace') {
    process.exit(await runMarketplaceCommand(args.slice(1)));
  } else if (args[0] === '-h' || args[0] === '--help') {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unknown command: ${args[0]}`);
    console.error('Run with --help for usage information');
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
