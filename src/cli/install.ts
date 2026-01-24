import * as readline from 'node:readline/promises';
import {
  addPluginToOpenCodeConfig,
  addProviderConfig,
  detectCurrentConfig,
  disableDefaultAgents,
  generateLiteConfig,
  getOpenCodeVersion,
  isOpenCodeInstalled,
  writeLiteConfig,
} from './config-manager';
import type {
  BooleanArg,
  ConfigMergeResult,
  DetectedConfig,
  InstallArgs,
  InstallConfig,
} from './types';

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

function printWarning(message: string): void {
  console.log(`${SYMBOLS.warn} ${YELLOW}${message}${RESET}`);
}

async function checkOpenCodeInstalled(): Promise<{
  ok: boolean;
  version?: string;
}> {
  const installed = await isOpenCodeInstalled();
  if (!installed) {
    printError('OpenCode is not installed on this system.');
    printInfo('Install it with:');
    console.log(
      `     ${BLUE}curl -fsSL https://opencode.ai/install | bash${RESET}`,
    );
    return { ok: false };
  }
  const version = await getOpenCodeVersion();
  printSuccess(`OpenCode ${version ?? ''} detected`);
  return { ok: true, version: version ?? undefined };
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

function formatConfigSummary(config: InstallConfig): string {
  const liteConfig = generateLiteConfig(config);
  const preset = (liteConfig.preset as string) || 'unknown';

  const lines: string[] = [];
  lines.push(`${BOLD}Configuration Summary${RESET}`);
  lines.push('');
  lines.push(`  ${BOLD}Preset:${RESET} ${BLUE}${preset}${RESET}`);
  lines.push(
    `  ${config.hasAntigravity ? SYMBOLS.check : `${DIM}○${RESET}`} Antigravity`,
  );
  lines.push(
    `  ${config.hasOpenAI ? SYMBOLS.check : `${DIM}○${RESET}`} OpenAI`,
  );
  lines.push(`  ${SYMBOLS.check} Opencode Zen (Grok)`); // Always enabled
  lines.push(
    `  ${config.hasTmux ? SYMBOLS.check : `${DIM}○${RESET}`} Tmux Integration`,
  );
  return lines.join('\n');
}

function printAgentModels(config: InstallConfig): void {
  const liteConfig = generateLiteConfig(config);
  const presetName = (liteConfig.preset as string) || 'unknown';
  const presets = liteConfig.presets as Record<string, unknown>;
  const agents = presets?.[presetName] as Record<
    string,
    { model: string; skills: string[] }
  >;

  if (!agents || Object.keys(agents).length === 0) return;

  console.log(
    `${BOLD}Agent Configuration (Preset: ${BLUE}${presetName}${RESET}):${RESET}`,
  );
  console.log();

  const maxAgentLen = Math.max(...Object.keys(agents).map((a) => a.length));

  for (const [agent, info] of Object.entries(agents)) {
    const padding = ' '.repeat(maxAgentLen - agent.length);
    const skillsStr =
      info.skills.length > 0
        ? ` ${DIM}[${info.skills.join(', ')}]${RESET}`
        : '';
    console.log(
      `  ${DIM}${agent}${RESET}${padding} ${SYMBOLS.arrow} ${BLUE}${info.model}${RESET}${skillsStr}`,
    );
  }
  console.log();
}

function argsToConfig(args: InstallArgs): InstallConfig {
  return {
    hasAntigravity: args.antigravity === 'yes',
    hasOpenAI: args.openai === 'yes',
    hasOpencodeZen: true, // Always enabled - free models available to all users
    hasTmux: args.tmux === 'yes',
  };
}

async function askYesNo(
  rl: readline.Interface,
  prompt: string,
  defaultValue: BooleanArg = 'no',
): Promise<BooleanArg> {
  const hint = defaultValue === 'yes' ? '[Y/n]' : '[y/N]';
  const answer = (await rl.question(`${BLUE}${prompt}${RESET} ${hint}: `))
    .trim()
    .toLowerCase();

  if (answer === '') return defaultValue;
  if (answer === 'y' || answer === 'yes') return 'yes';
  if (answer === 'n' || answer === 'no') return 'no';
  return defaultValue;
}

async function runInteractiveMode(
  detected: DetectedConfig,
): Promise<InstallConfig> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // TODO: tmux has a bug, disabled for now
  // const tmuxInstalled = await isTmuxInstalled()
  // const totalQuestions = tmuxInstalled ? 3 : 2
  const totalQuestions = 2;

  try {
    console.log(`${BOLD}Question 1/${totalQuestions}:${RESET}`);
    const antigravity = await askYesNo(
      rl,
      'Do you have an Antigravity subscription (via cliproxy)?',
      'yes',
    );
    console.log();

    console.log(`${BOLD}Question 2/${totalQuestions}:${RESET}`);
    const openai = await askYesNo(
      rl,
      'Do you have access to OpenAI API?',
      detected.hasOpenAI ? 'yes' : 'no',
    );
    console.log();

    // TODO: tmux has a bug, disabled for now
    // let tmux: BooleanArg = "no"
    // if (tmuxInstalled) {
    //   console.log(`${BOLD}Question 3/3:${RESET}`)
    //   printInfo(`${BOLD}Tmux detected!${RESET} We can enable tmux integration for you.`)
    //   printInfo("This will spawn new panes for sub-agents, letting you watch them work in real-time.")
    //   tmux = await askYesNo(rl, "Enable tmux integration?", detected.hasTmux ? "yes" : "no")
    //   console.log()
    // }

    return {
      hasAntigravity: antigravity === 'yes',
      hasOpenAI: openai === 'yes',
      hasOpencodeZen: true,
      hasTmux: false,
    };
  } finally {
    rl.close();
  }
}

async function runInstall(config: InstallConfig): Promise<number> {
  const detected = detectCurrentConfig();
  const isUpdate = detected.isInstalled;

  printHeader(isUpdate);

  // Calculate total steps dynamically
  let totalSteps = 4; // Base: check opencode, add plugin, disable default agents, write lite config
  if (config.hasAntigravity) totalSteps += 1; // provider config only (no auth plugin needed)

  let step = 1;

  printStep(step++, totalSteps, 'Checking OpenCode installation...');
  const { ok } = await checkOpenCodeInstalled();
  if (!ok) return 1;

  printStep(step++, totalSteps, 'Adding oh-my-opencode-slim plugin...');
  const pluginResult = await addPluginToOpenCodeConfig();
  if (!handleStepResult(pluginResult, 'Plugin added')) return 1;

  printStep(step++, totalSteps, 'Disabling OpenCode default agents...');
  const agentResult = disableDefaultAgents();
  if (!handleStepResult(agentResult, 'Default agents disabled')) return 1;

  if (config.hasAntigravity) {
    printStep(step++, totalSteps, 'Adding cliproxy provider configuration...');
    const providerResult = addProviderConfig(config);
    if (!handleStepResult(providerResult, 'Cliproxy provider configured'))
      return 1;
  }

  printStep(step++, totalSteps, 'Writing oh-my-opencode-slim configuration...');
  const liteResult = writeLiteConfig(config);
  if (!handleStepResult(liteResult, 'Config written')) return 1;

  // Summary
  console.log();
  console.log(formatConfigSummary(config));
  console.log();

  printAgentModels(config);

  if (!config.hasAntigravity && !config.hasOpenAI) {
    printWarning(
      'No providers configured. Zen Grok models will be used as fallback.',
    );
  }

  console.log(
    `${SYMBOLS.star} ${BOLD}${GREEN}${isUpdate ? 'Configuration updated!' : 'Installation complete!'}${RESET}`,
  );
  console.log();
  console.log(`${BOLD}Next steps:${RESET}`);
  console.log();

  let nextStep = 1;

  if (config.hasAntigravity) {
    console.log(`  ${nextStep++}. Install cliproxy:`);
    console.log(`     ${DIM}macOS:${RESET}`);
    console.log(`       ${BLUE}$ brew install cliproxyapi${RESET}`);
    console.log(`       ${BLUE}$ brew services start cliproxyapi${RESET}`);
    console.log(`     ${DIM}Linux:${RESET}`);
    console.log(
      `       ${BLUE}$ curl -fsSL https://raw.githubusercontent.com/brokechubb/cliproxyapi-installer/refs/heads/master/cliproxyapi-installer | bash${RESET}`,
    );
    console.log();
    console.log(`  ${nextStep++}. Authenticate with Antigravity via OAuth:`);
    console.log(`     ${BLUE}$ ./cli-proxy-api --antigravity-login${RESET}`);
    console.log(
      `     ${DIM}(Add --no-browser to print login URL instead of opening browser)${RESET}`,
    );
    console.log();
  }

  if (config.hasOpenAI || !config.hasAntigravity) {
    console.log(`  ${nextStep++}. Authenticate with your providers:`);
    console.log(`     ${BLUE}$ opencode auth login${RESET}`);
    console.log();
  }

  // TODO: tmux has a bug, disabled for now
  // if (config.hasTmux) {
  //   console.log(`  ${nextStep++}. Run OpenCode inside tmux:`)
  //   console.log(`     ${BLUE}$ tmux${RESET}`)
  //   console.log(`     ${BLUE}$ opencode${RESET}`)
  // } else {
  console.log(`  ${nextStep++}. Start OpenCode:`);
  console.log(`     ${BLUE}$ opencode${RESET}`);
  // }
  console.log();

  return 0;
}

export async function install(args: InstallArgs): Promise<number> {
  // Non-interactive mode: all args must be provided
  if (!args.tui) {
    const requiredArgs = ['antigravity', 'openai', 'tmux'] as const;
    const errors = requiredArgs.filter((key) => {
      const value = args[key];
      return value === undefined || !['yes', 'no'].includes(value);
    });

    if (errors.length > 0) {
      printHeader(false);
      printError('Missing or invalid arguments:');
      for (const key of errors) {
        console.log(`  ${SYMBOLS.bullet} --${key}=<yes|no>`);
      }
      console.log();
      printInfo(
        'Usage: bunx oh-my-opencode-slim install --no-tui --antigravity=<yes|no> --openai=<yes|no> --tmux=<yes|no>',
      );
      console.log();
      return 1;
    }

    return runInstall(argsToConfig(args));
  }

  // Interactive mode
  const detected = detectCurrentConfig();

  printHeader(detected.isInstalled);

  printStep(1, 1, 'Checking OpenCode installation...');
  const { ok } = await checkOpenCodeInstalled();
  if (!ok) return 1;
  console.log();

  const config = await runInteractiveMode(detected);
  return runInstall(config);
}
