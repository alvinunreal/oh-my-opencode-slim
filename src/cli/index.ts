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
    } else if (arg.startsWith('--anthropic=')) {
      result.anthropic = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--copilot=')) {
      result.copilot = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--zai-plan=')) {
      result.zaiPlan = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--antigravity=')) {
      result.antigravity = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--chutes=')) {
      result.chutes = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--tmux=')) {
      result.tmux = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--skills=')) {
      result.skills = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--opencode-free=')) {
      result.opencodeFree = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--balanced-spend=')) {
      result.balancedSpend = arg.split('=')[1] as BooleanArg;
    } else if (arg.startsWith('--opencode-free-model=')) {
      result.opencodeFreeModel = arg.split('=')[1];
    } else if (arg.startsWith('--aa-key=')) {
      result.aaKey = arg.slice('--aa-key='.length);
    } else if (arg.startsWith('--openrouter-key=')) {
      result.openrouterKey = arg.slice('--openrouter-key='.length);
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--models-only') {
      result.modelsOnly = true;
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
       bunx oh-my-opencode-slim models [OPTIONS]

Options:
  --kimi=yes|no          Kimi API access (yes/no)
  --openai=yes|no        OpenAI API access (yes/no)
  --anthropic=yes|no     Anthropic access (yes/no)
  --copilot=yes|no       GitHub Copilot access (yes/no)
  --zai-plan=yes|no      ZAI Coding Plan access (yes/no)
  --antigravity=yes|no   Antigravity/Google models (yes/no)
  --chutes=yes|no        Chutes models (yes/no)
  --opencode-free=yes|no Use OpenCode free models (opencode/*)
  --balanced-spend=yes|no Evenly spread usage across selected providers when score gaps are within tolerance
  --opencode-free-model  Preferred OpenCode model id or "auto"
  --aa-key               Artificial Analysis API key (optional)
  --openrouter-key       OpenRouter API key (optional)
  --tmux=yes|no          Enable tmux integration (yes/no)
  --skills=yes|no        Install recommended skills (yes/no)
  --no-tui               Non-interactive mode (requires all flags)
  --dry-run              Simulate install without writing files or requiring OpenCode
  --models-only          Update model assignments only (skip plugin/auth/skills)
  -h, --help             Show this help message

Examples:
  bunx oh-my-opencode-slim install
  bunx oh-my-opencode-slim models
  bunx oh-my-opencode-slim install --no-tui --kimi=yes --openai=yes --anthropic=yes --copilot=no --zai-plan=no --antigravity=yes --chutes=no --opencode-free=yes --balanced-spend=yes --opencode-free-model=auto --aa-key=YOUR_AA_KEY --openrouter-key=YOUR_OR_KEY --tmux=no --skills=yes
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'install' || args[0] === 'models') {
    const hasSubcommand = args[0] === 'install' || args[0] === 'models';
    const installArgs = parseArgs(args.slice(hasSubcommand ? 1 : 0));
    if (args[0] === 'models') {
      installArgs.modelsOnly = true;
    }
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
