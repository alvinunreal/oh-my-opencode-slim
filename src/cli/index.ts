#!/usr/bin/env bun
import { install } from './install';
import type { BooleanArg, InstallArgs } from './types';

function parseArgs(args: string[]): InstallArgs {
  const result: InstallArgs = {
    tui: true,
  };

  for (const arg of args) {
    if (arg === '--no-tui') {
      result.tui = false;
    } else if (arg.startsWith('--kimi=')) {
      result.kimi = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--openai=')) {
      result.openai = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--tmux=')) {
      result.tmux = arg.split('=')[1] as BooleanArg;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
oh-my-opencode-slim installer

Usage: bunx oh-my-opencode-slim install [OPTIONS]

Options:
  --kimi=yes|no          Kimi API access (yes/no)
  --openai=yes|no        OpenAI API access (yes/no)
  --tmux=yes|no          Enable tmux integration (yes/no)
  --no-tui               Non-interactive mode (requires all flags)
  -h, --help             Show this help message

Examples:
  bunx oh-my-opencode-slim install
  bunx oh-my-opencode-slim install --no-tui --kimi=yes --openai=yes --tmux=no
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'install') {
    const installArgs = parseArgs(args.slice(args[0] === 'install' ? 1 : 0));
    const exitCode = await install(installArgs);
    process.exit(exitCode);
  } else if (args[0] === '-h' || args[0] === '--help') {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unknown command: ${args[0]}`);
    console.error('Run with --help for usage information');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
