import {
  addPluginToOpenCodeConfig,
  detectCurrentConfig,
  disableDefaultAgents,
  generateLiteConfig,
  getOpenCodePath,
  getOpenCodeVersion,
  isOpenCodeInstalled,
  writeLiteConfig,
} from './config-manager';
import { CUSTOM_SKILLS, installCustomSkill } from './custom-skills';
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
  check: `${GREEN}✓${RESET}`,
  cross: `${RED}✗${RESET}`,
  arrow: `${BLUE}→${RESET}`,
  bullet: `${DIM}•${RESET}`,
  info: `${BLUE}ℹ${RESET}`,
  warn: `${YELLOW}⚠${RESET}`,
  star: `${YELLOW}★${RESET}`,
};

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
  printSuccess(
    `OpenCode ${version ?? ''} detected${path ? ` (${DIM}${path}${RESET})` : ''}`,
  );
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

function formatConfigSummary(): string {
  const lines: string[] = [];
  lines.push(`${BOLD}Configuration Summary${RESET}`);
  lines.push('');
  lines.push(`  ${BOLD}Preset:${RESET} ${BLUE}openai${RESET}`);
  lines.push(`  ${SYMBOLS.check} OpenAI (default)`);
  lines.push(`  ${DIM}○ Kimi — see docs/provider-configurations.md${RESET}`);
  lines.push(
    `  ${DIM}○ GitHub Copilot — see docs/provider-configurations.md${RESET}`,
  );
  lines.push(
    `  ${DIM}○ ZAI Coding Plan — see docs/provider-configurations.md${RESET}`,
  );
  return lines.join('\n');
}

async function runInstall(config: InstallConfig): Promise<number> {
  const detected = detectCurrentConfig();
  const isUpdate = detected.isInstalled;

  printHeader(isUpdate);


  let totalSteps = 4;
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

  {
    printStep(step++, totalSteps, 'Adding oh-my-opencode-slim plugin...');
    if (config.dryRun) {
      printInfo('Dry run mode - skipping plugin installation');
    } else {
      const pluginResult = await addPluginToOpenCodeConfig();
      if (!handleStepResult(pluginResult, 'Plugin added')) return 1;
    }
  }

  {
    printStep(step++, totalSteps, 'Disabling OpenCode default agents...');
    if (config.dryRun) {
      printInfo('Dry run mode - skipping agent disabling');
    } else {
      const agentResult = disableDefaultAgents();
      if (!handleStepResult(agentResult, 'Default agents disabled')) return 1;
    }
  }

  printStep(step++, totalSteps, 'Writing oh-my-opencode-slim configuration...');
  if (config.dryRun) {
    const liteConfig = generateLiteConfig(config);
    printInfo('Dry run mode - configuration that would be written:');
    console.log(`\n${JSON.stringify(liteConfig, null, 2)}\n`);
  } else {
    const liteResult = writeLiteConfig(config);
    if (!handleStepResult(liteResult, 'Config written')) return 1;
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
      printSuccess(
        `${customSkillsInstalled}/${CUSTOM_SKILLS.length} custom skills processed`,
      );
    }
  }

  // Summary
  console.log();
  console.log(formatConfigSummary());
  console.log();

  console.log(
    `${SYMBOLS.star} ${BOLD}${GREEN}${isUpdate ? 'Configuration updated!' : 'Installation complete!'}${RESET}`,
  );
  console.log();
  console.log(`${BOLD}Next steps:${RESET}`);
  console.log();

  console.log(`  1. Start OpenCode:`);
  console.log(`     ${BLUE}$ opencode${RESET}`);
  console.log();
  console.log(
    `${BOLD}Default configuration uses OpenAI models (gpt-5.4 / gpt-5-codex).${RESET}`,
  );
  console.log(
    `${BOLD}For alternative providers (Kimi, GitHub Copilot, ZAI Coding Plan), see:${RESET}`,
  );
  console.log(
    `  ${BLUE}https://github.com/alvinunreal/oh-my-opencode-slim/blob/main/docs/provider-configurations.md${RESET}`,
  );
  console.log();

  return 0;
}

export async function install(args: InstallArgs): Promise<number> {
  const config: InstallConfig = {
    hasTmux: args.tmux === 'yes',
    installSkills: args.skills === 'yes',
    installCustomSkills: args.skills === 'yes',
    dryRun: args.dryRun,
  };

  return runInstall(config);
}
