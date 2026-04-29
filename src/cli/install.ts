import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  addPluginToOpenCodeConfig,
  addPluginToOpenCodeTuiConfig,
  detectCurrentConfig,
  disableDefaultAgents,
  enableLspByDefault,
  generateLiteConfig,
  getOpenCodePath,
  getOpenCodeVersion,
  isOpenCodeInstalled,
  writeLiteConfig,
} from './config-manager';
import { CUSTOM_SKILLS, installCustomSkill } from './custom-skills';
import { getExistingLiteConfigPath } from './paths';
import { installSkill, RECOMMENDED_SKILLS } from './skills';
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
    printError('OpenCode is not installed on this system.');
    printInfo('Install it with:');
    console.log(
      `     ${BLUE}curl -fsSL https://opencode.ai/install | bash${RESET}`,
    );
    console.log();
    printInfo('Or if already installed, add it to your PATH:');
    console.log(`     ${BLUE}export PATH="$HOME/.local/bin:$PATH"${RESET}`);
    console.log(`     ${BLUE}export PATH="$HOME/.opencode/bin:$PATH"${RESET}`);
    return { ok: false };
  }
  const version = await getOpenCodeVersion();
  const path = getOpenCodePath();
  const detectedVersion = version ?? '';
  const pathInfo = path ? ` (${DIM}${path}${RESET})` : '';
  printSuccess(`OpenCode ${detectedVersion} detected${pathInfo}`);
  return { ok: true, version: version ?? undefined, path: path ?? undefined };
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

  let totalSteps = 6;
  if (config.installSkills) totalSteps += 1;
  if (config.installCustomSkills) totalSteps += 1;

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

  printStep(step++, totalSteps, 'Disabling OpenCode default agents...');
  if (config.dryRun) {
    printInfo('Dry run mode - skipping agent disabling');
  } else {
    const agentResult = disableDefaultAgents();
    if (!handleStepResult(agentResult, 'Default agents disabled')) return 1;
  }

  printStep(step++, totalSteps, 'Enabling OpenCode LSP integration...');
  if (config.dryRun) {
    printInfo('Dry run mode - skipping LSP configuration');
  } else {
    const lspResult = enableLspByDefault();
    if (!handleStepResult(lspResult, 'LSP enabled')) return 1;
  }

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
      const liteResult = writeLiteConfig(
        config,
        configExists ? configPath : undefined,
      );
      if (
        !handleStepResult(
          liteResult,
          configExists ? 'Config reset' : 'Config written',
        )
      )
        return 1;
    }
  }

  // Install skills if requested
  if (config.installSkills) {
    printStep(step++, totalSteps, 'Installing recommended skills...');
    if (config.dryRun) {
      printInfo('Dry run mode - would install skills:');
      for (const skill of RECOMMENDED_SKILLS) {
        printInfo(`  - ${skill.name}`);
      }
    } else {
      let skillsInstalled = 0;
      for (const skill of RECOMMENDED_SKILLS) {
        printInfo(`Installing ${skill.name}...`);
        if (installSkill(skill)) {
          printSuccess(`Installed: ${skill.name}`);
          skillsInstalled++;
        } else {
          printInfo(`Skipped: ${skill.name} (already installed)`);
        }
      }
      printSuccess(
        `${skillsInstalled}/${RECOMMENDED_SKILLS.length} skills processed`,
      );
    }
  }

  // Install custom skills if requested
  if (config.installCustomSkills) {
    printStep(step++, totalSteps, 'Installing custom skills...');
    if (config.dryRun) {
      printInfo('Dry run mode - would install custom skills:');
      for (const skill of CUSTOM_SKILLS) {
        printInfo(`  - ${skill.name}`);
      }
    } else {
      let customSkillsInstalled = 0;
      for (const skill of CUSTOM_SKILLS) {
        printInfo(`Installing ${skill.name}...`);
        if (installCustomSkill(skill)) {
          printSuccess(`Installed: ${skill.name}`);
          customSkillsInstalled++;
        } else {
          printInfo(`Skipped: ${skill.name} (already installed)`);
        }
      }
      const totalCustom = CUSTOM_SKILLS.length;
      printSuccess(
        `${customSkillsInstalled}/${totalCustom} custom skills processed`,
      );
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
  console.log(`     ${BLUE}$ opencode${RESET}`);
  console.log();
  console.log('  5. Verify the agents are responding:');
  console.log(`     ${BLUE}> ping all agents${RESET}`);
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
    hasTmux: false,
    installSkills: args.skills === 'yes',
    installCustomSkills: args.skills === 'yes',
    preset: args.preset,
    promptForStar: args.tui,
    dryRun: args.dryRun,
    reset: args.reset ?? false,
  };

  return runInstall(config);
}
