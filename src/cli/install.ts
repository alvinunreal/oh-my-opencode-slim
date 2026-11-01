import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { getExistingLiteConfigPath } from '../config/paths';
import {
  detectBackgroundSubagentsTarget,
  expandHomePath,
  getBackgroundSubagentsBlock,
  isBackgroundSubagentsEnabled,
  manualBackgroundSubagentsInstructions,
  writeBackgroundSubagentsBlock,
} from './background-subagents';
import {
  addPluginToOpenCodeConfig,
  addPluginToOpenCodeTuiConfig,
  detectCurrentConfig,
  generateLiteConfig,
  getOpenCodePath,
  getOpenCodeVersion,
  isOpenCodeInstalled,
  warmOpenCodePluginCache,
  writeLiteConfig,
} from './config-manager';
import type { ConfigMergeResult, InstallArgs, InstallConfig } from './types';

// Colors
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const SYMBOLS = {
  check: `${GREEN}[ok]${RESET}`,
  cross: `${RED}[x]${RESET}`,
  arrow: `${BLUE}->${RESET}`,
  bullet: `${DIM}-${RESET}`,
  info: `${BLUE}[i]${RESET}`,
  warn: `${YELLOW}[!]${RESET}`,
  star: `${YELLOW}★${RESET}`,
};

const GITHUB_REPO = 'alvinunreal/oh-my-opencode-slim';
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

function printHeader(isUpdate: boolean): void {
  console.log();
  console.log(
    `${BOLD}oh-my-opencode-slim ${isUpdate ? 'Update' : 'Install'}${RESET}`,
  );
  console.log('='.repeat(30));
  console.log();
}

function printStep(step: number, total: number, message: string): void {
  console.log(`${DIM}[${step}/${total}]${RESET} ${message}`);
}

function printSuccess(message: string): void {
  console.log(`${SYMBOLS.check} ${message}`);
}

function printError(message: string): void {
  console.log(`${SYMBOLS.cross} ${RED}${message}${RESET}`);
}

function printInfo(message: string): void {
  console.log(`${SYMBOLS.info} ${message}`);
}

async function confirm(message: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? ' (Y/n) ' : ' (y/N) ';
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = (await rl.question(`${message}${suffix}`))
      .trim()
      .toLowerCase();
    if (!answer) return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function askToStarRepo(config: InstallConfig): Promise<void> {
  if (!config.promptForStar || config.dryRun || !process.stdin.isTTY) return;

  console.log();
  const shouldStar = await confirm(
    `${SYMBOLS.star} Star the repo on GitHub?`,
    true,
  );
  if (!shouldStar) return;

  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync(
      'gh',
      ['api', '--silent', '--method', 'PUT', `/user/starred/${GITHUB_REPO}`],
      { stdio: 'ignore', timeout: 10_000 },
    );
    printSuccess('Thanks for starring! ★');
  } catch {
    printInfo(
      `Couldn't star automatically. You can star manually:\n  ${BLUE}${GITHUB_URL}${RESET}`,
    );
  }
}

async function checkOpenCodeInstalled(): Promise<{
  ok: boolean;
  version?: string;
  path?: string;
}> {
  const installed = await isOpenCodeInstalled();
  if (!installed) {
    const isWindows = process.platform === 'win32';
    printError('OpenCode is not installed on this system.');
    printInfo('Install it with:');
    if (isWindows) {
      console.log(
        `     ${BLUE}powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://opencode.ai/install.ps1 | iex"${RESET}`,
      );
      console.log();
      printInfo('Or with winget:');
      console.log(`     ${BLUE}winget install opencode${RESET}`);
      console.log();
      printInfo('Or if already installed, add it to your PATH:');
      console.log(
        `     ${BLUE}setx PATH "%PATH%;%LOCALAPPDATA%\\Programs\\opencode"${RESET}`,
      );
    } else {
      console.log(
        `     ${BLUE}curl -fsSL https://opencode.ai/install | bash${RESET}`,
      );
      console.log();
      printInfo('Or if already installed, add it to your PATH:');
      console.log(`     ${BLUE}export PATH="$HOME/.local/bin:$PATH"${RESET}`);
      console.log(
        `     ${BLUE}export PATH="$HOME/.opencode/bin:$PATH"${RESET}`,
      );
    }
    return { ok: false };
  }
  const version = await getOpenCodeVersion();
  const path = getOpenCodePath();
  const detectedVersion = version ?? '';
  const pathInfo = path ? ` (${DIM}${path}${RESET})` : '';
  printSuccess(`OpenCode ${detectedVersion} detected${pathInfo}`);
  return { ok: true, version: version ?? undefined, path: path ?? undefined };
}

export async function configureBackgroundSubagents(
  config: InstallConfig,
): Promise<{ enabledNow: boolean; configuredTarget?: string }> {
  const backgroundSubagentsEnabled = isBackgroundSubagentsEnabled(
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS,
  );
  const exaEnabled = ['true', '1'].includes(
    process.env.OPENCODE_ENABLE_EXA?.toLowerCase() ?? '',
  );
  if (backgroundSubagentsEnabled && exaEnabled) {
    printSuccess(
      'OpenCode background subagents and Exa websearch already enabled in environment',
    );
    return { enabledNow: true };
  }

  const target =
    config.backgroundSubagentsTarget !== undefined
      ? expandHomePath(config.backgroundSubagentsTarget)
      : detectBackgroundSubagentsTarget();

  if (config.backgroundSubagents === 'no') {
    printInfo('OpenCode background subagents shell setup skipped.');
    console.log(manualBackgroundSubagentsInstructions({ targetPath: target }));
    return { enabledNow: false };
  }

  if (!target) {
    printInfo('No safe shell startup file detected.');
    console.log(manualBackgroundSubagentsInstructions());
    return { enabledNow: false };
  }

  const block = getBackgroundSubagentsBlock(target);

  if (config.dryRun) {
    printInfo(
      'Dry run mode - background subagents block that would be written:',
    );
    console.log(`Target: ${target}`);
    console.log(`\n${block}\n`);
    return { enabledNow: false, configuredTarget: target };
  }

  if (config.backgroundSubagents === 'ask') {
    if (!process.stdin.isTTY) {
      printInfo('Skipped background subagents shell setup in non-TTY mode.');
      console.log(
        manualBackgroundSubagentsInstructions({ targetPath: target }),
      );
      return { enabledNow: false };
    }

    console.log();
    printInfo(
      'V2 requires OpenCode background subagents for default orchestration.',
    );
    printInfo(
      `The installer can add the required environment exports to ${target}.`,
    );
    const shouldWrite = await confirm(
      'Enable background subagents and Exa websearch now?',
      true,
    );
    if (!shouldWrite) {
      printInfo('Skipped background subagents shell setup.');
      console.log(
        manualBackgroundSubagentsInstructions({ targetPath: target }),
      );
      return { enabledNow: false };
    }
  }

  try {
    writeBackgroundSubagentsBlock(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printError(`Could not write background subagents shell config: ${message}`);
    printInfo('Add the setting manually instead:');
    console.log(manualBackgroundSubagentsInstructions({ targetPath: target }));
    return { enabledNow: false };
  }

  printSuccess(
    `Background subagents and Exa websearch enabled ${SYMBOLS.arrow} ${DIM}${target}${RESET}`,
  );
  return { enabledNow: false, configuredTarget: target };
}

function handleStepResult(
  result: ConfigMergeResult,
  successMsg: string,
): boolean {
  if (!result.success) {
    printError(`Failed: ${result.error}`);
    return false;
  }
  printSuccess(
    `${successMsg} ${SYMBOLS.arrow} ${DIM}${result.configPath}${RESET}`,
  );
  return true;
}

async function runInstall(config: InstallConfig): Promise<number> {
  const detected = detectCurrentConfig();
  const isUpdate = detected.isInstalled;

  printHeader(isUpdate);

  const totalSteps = 6;

  let step = 1;

  printStep(step++, totalSteps, 'Checking OpenCode installation...');
  if (config.dryRun) {
    printInfo('Dry run mode - skipping OpenCode check');
  } else {
    const { ok } = await checkOpenCodeInstalled();
    if (!ok) return 1;
  }
  printStep(step++, totalSteps, 'Adding oh-my-opencode-slim plugin...');
  if (config.dryRun) {
    printInfo('Dry run mode - skipping plugin installation');
  } else {
    const pluginResult = await addPluginToOpenCodeConfig();
    if (!handleStepResult(pluginResult, 'Plugin added')) return 1;
  }

  printStep(step++, totalSteps, 'Adding TUI version badge...');
  if (config.dryRun) {
    printInfo('Dry run mode - skipping TUI plugin installation');
  } else {
    const tuiResult = await addPluginToOpenCodeTuiConfig();
    if (!tuiResult.success) {
      printInfo(`Skipped TUI badge: ${tuiResult.error}`);
    } else {
      handleStepResult(tuiResult, 'TUI badge added');
    }
  }

  printStep(step++, totalSteps, 'Warming OpenCode plugin cache...');
  if (config.dryRun) {
    printInfo('Dry run mode - skipping cache warm-up');
  } else {
    const cacheResult = await warmOpenCodePluginCache();
    if (cacheResult === null) {
      printInfo('Local development install - cache warm-up not required');
    } else if (!cacheResult.success) {
      printInfo(`Skipped cache warm-up: ${cacheResult.error}`);
    } else {
      handleStepResult(cacheResult, 'OpenCode cache warmed');
    }
  }

  printStep(step++, totalSteps, 'Configuring OpenCode background subagents...');
  const backgroundSubagents = await configureBackgroundSubagents(config);

  printStep(step++, totalSteps, 'Writing oh-my-opencode-slim configuration...');
  if (config.dryRun) {
    const liteConfig = generateLiteConfig(config);
    printInfo('Dry run mode - configuration that would be written:');
    console.log(`\n${JSON.stringify(liteConfig, null, 2)}\n`);
  } else {
    const configPath = getExistingLiteConfigPath();
    const configExists = existsSync(configPath);

    if (configExists && !config.reset) {
      printInfo(
        `Configuration already exists at ${configPath}. ` +
          'Use --reset to overwrite.',
      );
    } else {
      const liteResult = writeLiteConfig(config, configPath);
      if (
        !handleStepResult(
          liteResult,
          configExists ? 'Config reset' : 'Config written',
        )
      )
        return 1;
    }
  }

  const statusMsg = isUpdate
    ? 'Configuration updated!'
    : 'Installation complete!';
  console.log(`${SYMBOLS.star} ${BOLD}${GREEN}${statusMsg}${RESET}`);
  console.log();
  console.log(`${BOLD}Next steps:${RESET}`);
  console.log();

  const configPath = getExistingLiteConfigPath();

  console.log('  1. Log in to the provider(s) you want to use:');
  console.log(`     ${BLUE}$ opencode auth login${RESET}`);
  console.log();
  console.log('  2. Refresh the models OpenCode can see:');
  console.log(`     ${BLUE}$ opencode models --refresh${RESET}`);
  console.log();
  console.log('  3. Review your generated config:');
  console.log(`     ${BLUE}${configPath}${RESET}`);
  console.log();
  console.log('  4. Start OpenCode:');
  if (backgroundSubagents.enabledNow) {
    console.log(`     ${BLUE}$ opencode${RESET}`);
  } else if (backgroundSubagents.configuredTarget) {
    console.log(
      `     ${BLUE}$ source ${backgroundSubagents.configuredTarget}${RESET}`,
    );
    console.log(`     ${BLUE}$ opencode${RESET}`);
    console.log(
      `     ${DIM}Or restart your terminal before running opencode.${RESET}`,
    );
  } else {
    console.log(
      `     ${BLUE}$ OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true OPENCODE_ENABLE_EXA=1 opencode${RESET}`,
    );
  }
  console.log();
  console.log('  5. Verify the agents are responding:');
  console.log(`     ${BLUE}> ping all agents${RESET}`);
  console.log();
  console.log(
    `${DIM}Optional: install the desktop companion with ` +
      `bunx oh-my-opencode-slim companion install${RESET}`,
  );
  console.log();

  const modelsInfo =
    config.preset && config.preset !== 'openai'
      ? `Generated OpenAI and OpenCode Go presets; ${config.preset} is active.`
      : 'Generated OpenAI and OpenCode Go presets; OpenAI is active by default.';
  console.log(`${modelsInfo}`);
  const altProviders = 'For the full configuration reference, see:';
  console.log(altProviders);
  const docsUrl =
    'https://github.com/alvinunreal/oh-my-opencode-slim/' +
    'blob/master/docs/configuration.md';
  console.log(`  ${BLUE}${docsUrl}${RESET}`);
  console.log();

  await askToStarRepo(config);

  return 0;
}

export async function install(args: InstallArgs): Promise<number> {
  const config: InstallConfig = {
    preset: args.preset,
    promptForStar: args.tui,
    dryRun: args.dryRun,
    reset: args.reset ?? false,
    backgroundSubagents: args.backgroundSubagents ?? 'ask',
    backgroundSubagentsTarget: args.backgroundSubagentsTarget,
  };

  return runInstall(config);
}
