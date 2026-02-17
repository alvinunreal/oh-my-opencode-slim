import * as readline from 'node:readline/promises';
import {
  addAntigravityPlugin,
  addChutesProvider,
  addGoogleProvider,
  addPluginToOpenCodeConfig,
  buildDynamicModelPlan,
  detectCurrentConfig,
  disableDefaultAgents,
  discoverModelCatalog,
  discoverOpenCodeFreeModels,
  discoverProviderModels,
  fetchExternalModelSignals,
  generateLiteConfig,
  getOpenCodePath,
  getOpenCodeVersion,
  isOpenCodeInstalled,
  pickBestCodingChutesModel,
  pickBestCodingOpenCodeModel,
  pickSupportChutesModel,
  pickSupportOpenCodeModel,
  writeLiteConfig,
} from './config-manager';
import { CUSTOM_SKILLS, installCustomSkill } from './custom-skills';
import { installSkill, RECOMMENDED_SKILLS } from './skills';
import type {
  BooleanArg,
  ConfigMergeResult,
  DetectedConfig,
  DiscoveredModel,
  InstallArgs,
  InstallConfig,
  ManualAgentConfig,
  OpenCodeFreeModel,
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

function formatConfigSummary(config: InstallConfig): string {
  const liteConfig = generateLiteConfig(config);
  const preset = (liteConfig.preset as string) || 'unknown';

  const lines: string[] = [];
  lines.push(`${BOLD}Configuration Summary${RESET}`);
  lines.push('');
  lines.push(`  ${BOLD}Preset:${RESET} ${BLUE}${preset}${RESET}`);
  lines.push(`  ${config.hasKimi ? SYMBOLS.check : `${DIM}○${RESET}`} Kimi`);
  lines.push(
    `  ${config.hasOpenAI ? SYMBOLS.check : `${DIM}○${RESET}`} OpenAI`,
  );
  lines.push(
    `  ${config.hasAnthropic ? SYMBOLS.check : `${DIM}○${RESET}`} Anthropic`,
  );
  lines.push(
    `  ${config.hasCopilot ? SYMBOLS.check : `${DIM}○${RESET}`} GitHub Copilot`,
  );
  lines.push(
    `  ${config.hasZaiPlan ? SYMBOLS.check : `${DIM}○${RESET}`} ZAI Coding Plan`,
  );
  lines.push(
    `  ${config.hasAntigravity ? SYMBOLS.check : `${DIM}○${RESET}`} Antigravity (Google)`,
  );
  lines.push(
    `  ${config.hasChutes ? SYMBOLS.check : `${DIM}○${RESET}`} Chutes`,
  );
  lines.push(`  ${SYMBOLS.check} Opencode Zen`);
  lines.push(
    `  ${config.balanceProviderUsage ? SYMBOLS.check : `${DIM}○${RESET}`} Balanced provider spend`,
  );
  if (config.useOpenCodeFreeModels && config.selectedOpenCodePrimaryModel) {
    lines.push(
      `  ${SYMBOLS.check} OpenCode Free Primary: ${BLUE}${config.selectedOpenCodePrimaryModel}${RESET}`,
    );
  }
  if (config.useOpenCodeFreeModels && config.selectedOpenCodeSecondaryModel) {
    lines.push(
      `  ${SYMBOLS.check} OpenCode Free Support: ${BLUE}${config.selectedOpenCodeSecondaryModel}${RESET}`,
    );
  }
  if (config.hasChutes && config.selectedChutesPrimaryModel) {
    lines.push(
      `  ${SYMBOLS.check} Chutes Primary: ${BLUE}${config.selectedChutesPrimaryModel}${RESET}`,
    );
  }
  if (config.hasChutes && config.selectedChutesSecondaryModel) {
    lines.push(
      `  ${SYMBOLS.check} Chutes Support: ${BLUE}${config.selectedChutesSecondaryModel}${RESET}`,
    );
  }
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
    hasKimi: args.kimi === 'yes',
    hasOpenAI: args.openai === 'yes',
    hasAnthropic: args.anthropic === 'yes',
    hasCopilot: args.copilot === 'yes',
    hasZaiPlan: args.zaiPlan === 'yes',
    hasAntigravity: args.antigravity === 'yes',
    hasChutes: args.chutes === 'yes',
    hasOpencodeZen: true, // Always enabled - free models available to all users
    useOpenCodeFreeModels: args.opencodeFree === 'yes',
    preferredOpenCodeModel:
      args.opencodeFreeModel && args.opencodeFreeModel !== 'auto'
        ? args.opencodeFreeModel
        : undefined,
    artificialAnalysisApiKey: args.aaKey,
    openRouterApiKey: args.openrouterKey,
    balanceProviderUsage: args.balancedSpend === 'yes',
    hasTmux: args.tmux === 'yes',
    installSkills: args.skills === 'yes',
    installCustomSkills: args.skills === 'yes', // Install custom skills when skills=yes
    setupMode: 'quick', // Non-interactive mode defaults to quick setup
    dryRun: args.dryRun,
    modelsOnly: args.modelsOnly,
  };
}

import { getEnv } from '../utils';

async function askModelSelection(
  rl: readline.Interface,
  models: OpenCodeFreeModel[],
  defaultModel: string,
  prompt: string,
): Promise<string> {
  const defaultIndex = Math.max(
    0,
    models.findIndex((model) => model.model === defaultModel),
  );

  for (const [index, model] of models.entries()) {
    const marker =
      model.model === defaultModel ? `${BOLD}(recommended)${RESET}` : '';
    console.log(
      `  ${DIM}${index + 1}.${RESET} ${BLUE}${model.model}${RESET} ${DIM}${model.name}${RESET} ${marker}`,
    );
  }

  const answer = (
    await rl.question(
      `${BLUE}${prompt}${RESET} ${DIM}[default: ${defaultIndex + 1}]${RESET}: `,
    )
  )
    .trim()
    .toLowerCase();

  if (!answer) return defaultModel;

  const asNumber = Number.parseInt(answer, 10);
  if (Number.isFinite(asNumber)) {
    const chosen = models[asNumber - 1];
    if (chosen) return chosen.model;
  }

  const byId = models.find((model) => model.model.toLowerCase() === answer);
  return byId?.model ?? defaultModel;
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

async function askOptionalApiKey(
  rl: readline.Interface,
  prompt: string,
  fromEnv?: string,
): Promise<string | undefined> {
  const hint = fromEnv ? '[optional, Enter keeps env value]' : '[optional]';
  const answer = (
    await rl.question(`${BLUE}${prompt}${RESET} ${DIM}${hint}${RESET}: `)
  ).trim();

  if (!answer) return fromEnv;
  return answer;
}

async function askSetupMode(
  rl: readline.Interface,
): Promise<'quick' | 'manual'> {
  console.log(`${BOLD}Choose setup mode:${RESET}`);
  console.log(
    `  ${DIM}1.${RESET} Quick setup - you choose providers, we auto-pick models`,
  );
  console.log(
    `  ${DIM}2.${RESET} Manual setup - you choose providers and models per agent`,
  );
  console.log();

  const answer = (
    await rl.question(`${BLUE}Selection${RESET} ${DIM}[default: 1]${RESET}: `)
  )
    .trim()
    .toLowerCase();

  if (answer === '2' || answer === 'manual') return 'manual';
  return 'quick';
}

async function askModelByNumber(
  rl: readline.Interface,
  models: Array<{ model: string; name?: string }>,
  prompt: string,
  allowEmpty = false,
): Promise<string | undefined> {
  let showAll = false;

  while (true) {
    console.log(`${BOLD}${prompt}${RESET}`);
    console.log(`${DIM}Available models:${RESET}`);

    const modelsToShow = showAll ? models : models.slice(0, 5);
    const remainingCount = models.length - modelsToShow.length;

    for (const [index, model] of modelsToShow.entries()) {
      const displayIndex = showAll ? index + 1 : index + 1;
      const name = model.name ? ` ${DIM}(${model.name})${RESET}` : '';
      console.log(
        `  ${DIM}${displayIndex}.${RESET} ${BLUE}${model.model}${RESET}${name}`,
      );
    }

    if (!showAll && remainingCount > 0) {
      console.log(`${DIM}  ... and ${remainingCount} more${RESET}`);
      console.log(`${DIM}  (type "all" to show the full list)${RESET}`);
    }
    console.log(`${DIM}  (or type any model ID directly)${RESET}`);
    console.log();

    const answer = (await rl.question(`${BLUE}Selection${RESET}: `))
      .trim()
      .toLowerCase();

    if (!answer) {
      if (allowEmpty) return undefined;
      return models[0]?.model;
    }

    if (answer === 'all') {
      showAll = true;
      console.log();
      continue;
    }

    const asNumber = Number.parseInt(answer, 10);
    if (
      Number.isFinite(asNumber) &&
      asNumber >= 1 &&
      asNumber <= models.length
    ) {
      return models[asNumber - 1]?.model;
    }

    const byId = models.find((m) => m.model.toLowerCase() === answer);
    if (byId) return byId.model;

    if (answer.includes('/')) return answer;

    printWarning(
      `Invalid selection: "${answer}". Using first available model.`,
    );
    return models[0]?.model;
  }
}

async function configureAgentManually(
  rl: readline.Interface,
  agentName: string,
  allModels: Array<{ model: string; name?: string }>,
): Promise<ManualAgentConfig> {
  console.log();
  console.log(`${BOLD}Configure ${agentName}:${RESET}`);
  console.log();

  // Keep track of selected models to exclude them from subsequent choices
  const selectedModels = new Set<string>();

  // Primary model selection - show all models
  const primary =
    (await askModelByNumber(rl, allModels, 'Primary model')) ??
    allModels[0]?.model ??
    'opencode/big-pickle';
  selectedModels.add(primary);

  // Filter out selected models for subsequent choices
  const availableForFallback1 = allModels.filter(
    (m) => !selectedModels.has(m.model),
  );

  const fallback1 =
    availableForFallback1.length > 0
      ? ((await askModelByNumber(
          rl,
          availableForFallback1,
          'Fallback 1 (optional, press Enter to skip)',
          true,
        )) ?? primary)
      : primary;
  if (fallback1 !== primary) selectedModels.add(fallback1);

  // Filter again for fallback 2
  const availableForFallback2 = allModels.filter(
    (m) => !selectedModels.has(m.model),
  );

  const fallback2 =
    availableForFallback2.length > 0
      ? ((await askModelByNumber(
          rl,
          availableForFallback2,
          'Fallback 2 (optional, press Enter to skip)',
          true,
        )) ?? fallback1)
      : fallback1;
  if (fallback2 !== fallback1) selectedModels.add(fallback2);

  // Filter again for fallback 3
  const availableForFallback3 = allModels.filter(
    (m) => !selectedModels.has(m.model),
  );

  const fallback3 =
    availableForFallback3.length > 0
      ? ((await askModelByNumber(
          rl,
          availableForFallback3,
          'Fallback 3 (optional, press Enter to skip)',
          true,
        )) ?? fallback2)
      : fallback2;

  return {
    primary,
    fallback1,
    fallback2,
    fallback3,
  };
}

async function runManualSetupMode(
  rl: readline.Interface,
  detected: DetectedConfig,
  modelsOnly = false,
): Promise<InstallConfig> {
  console.log();
  console.log(`${BOLD}Manual Setup Mode${RESET}`);
  console.log('='.repeat(20));
  console.log();

  // Step 1: Ask for providers (same as quick mode)
  const existingAaKey = getEnv('ARTIFICIAL_ANALYSIS_API_KEY');
  const existingOpenRouterKey = getEnv('OPENROUTER_API_KEY');

  const artificialAnalysisApiKey = await askOptionalApiKey(
    rl,
    'Artificial Analysis API key for better ranking signals',
    existingAaKey,
  );
  if (existingAaKey && !artificialAnalysisApiKey) {
    printInfo('Using existing ARTIFICIAL_ANALYSIS_API_KEY from environment.');
  }
  console.log();

  const openRouterApiKey = await askOptionalApiKey(
    rl,
    'OpenRouter API key for pricing/metadata signals',
    existingOpenRouterKey,
  );
  if (existingOpenRouterKey && !openRouterApiKey) {
    printInfo('Using existing OPENROUTER_API_KEY from environment.');
  }
  console.log();

  const useOpenCodeFree = await askYesNo(
    rl,
    'Use Opencode Free models (opencode/*)?',
    'yes',
  );
  console.log();

  let availableOpenCodeFreeModels: OpenCodeFreeModel[] | undefined;
  let availableChutesModels: DiscoveredModel[] | undefined;

  if (useOpenCodeFree === 'yes') {
    printInfo('Refreshing models with: opencode models --refresh --verbose');
    const discovery = await discoverOpenCodeFreeModels();

    if (discovery.models.length === 0) {
      printWarning(
        discovery.error ??
          'No OpenCode free models found. Continuing without OpenCode free-model assignment.',
      );
    } else {
      availableOpenCodeFreeModels = discovery.models;
      printSuccess(`Found ${discovery.models.length} OpenCode free models`);
    }
    console.log();
  }

  // Ask for providers
  const kimi = await askYesNo(
    rl,
    'Enable Kimi provider?',
    detected.hasKimi ? 'yes' : 'no',
  );
  console.log();

  const openai = await askYesNo(
    rl,
    'Enable OpenAI provider?',
    detected.hasOpenAI ? 'yes' : 'no',
  );
  console.log();

  const anthropic = await askYesNo(
    rl,
    'Enable Anthropic provider?',
    detected.hasAnthropic ? 'yes' : 'no',
  );
  console.log();

  const copilot = await askYesNo(
    rl,
    'Enable GitHub Copilot provider?',
    detected.hasCopilot ? 'yes' : 'no',
  );
  console.log();

  const zaiPlan = await askYesNo(
    rl,
    'Enable ZAI Coding Plan provider?',
    detected.hasZaiPlan ? 'yes' : 'no',
  );
  console.log();

  const antigravity = await askYesNo(
    rl,
    'Enable Antigravity (Google) provider?',
    detected.hasAntigravity ? 'yes' : 'no',
  );
  console.log();

  const chutes = await askYesNo(
    rl,
    'Enable Chutes provider?',
    detected.hasChutes ? 'yes' : 'no',
  );
  console.log();

  if (chutes === 'yes') {
    printInfo(
      'Refreshing Chutes model list with: opencode models --refresh --verbose',
    );
    const discovery = await discoverProviderModels('chutes');

    if (discovery.models.length === 0) {
      printWarning(
        discovery.error ??
          'No Chutes models found. Continuing without Chutes dynamic assignment.',
      );
    } else {
      availableChutesModels = discovery.models;
      printSuccess(`Found ${discovery.models.length} Chutes models`);
    }
    console.log();
  }

  // Build list of available models from all enabled providers
  const availableModels: Array<{ model: string; name?: string }> = [];

  if (useOpenCodeFree === 'yes' && availableOpenCodeFreeModels) {
    for (const model of availableOpenCodeFreeModels) {
      availableModels.push({ model: model.model, name: model.name });
    }
  }

  if (kimi === 'yes') {
    availableModels.push({ model: 'kimi-for-coding/k2p5', name: 'Kimi K2.5' });
  }

  if (openai === 'yes') {
    availableModels.push({
      model: 'openai/gpt-5.3-codex',
      name: 'GPT-5.3 Codex',
    });
    availableModels.push({
      model: 'openai/gpt-5.1-codex-mini',
      name: 'GPT-5.1 Codex Mini',
    });
  }

  if (anthropic === 'yes') {
    availableModels.push({
      model: 'anthropic/claude-opus-4-6',
      name: 'Claude Opus 4.6',
    });
    availableModels.push({
      model: 'anthropic/claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
    });
    availableModels.push({
      model: 'anthropic/claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
    });
  }

  if (copilot === 'yes') {
    availableModels.push({
      model: 'github-copilot/grok-code-fast-1',
      name: 'Grok Code Fast',
    });
  }

  if (zaiPlan === 'yes') {
    availableModels.push({ model: 'zai-coding-plan/glm-4.7', name: 'GLM 4.7' });
  }

  if (antigravity === 'yes') {
    availableModels.push({
      model: 'google/antigravity-gemini-3-pro',
      name: 'Gemini 3 Pro',
    });
    availableModels.push({
      model: 'google/antigravity-gemini-3-flash',
      name: 'Gemini 3 Flash',
    });
  }

  if (chutes === 'yes' && availableChutesModels) {
    for (const model of availableChutesModels) {
      availableModels.push({ model: model.model, name: model.name });
    }
  }

  // Always include zen fallback
  availableModels.push({
    model: 'opencode/big-pickle',
    name: 'OpenCode Big Pickle',
  });

  if (availableModels.length === 0) {
    printWarning('No models available. Please enable at least one provider.');
    availableModels.push({
      model: 'opencode/big-pickle',
      name: 'OpenCode Big Pickle',
    });
  }

  // Configure each agent manually
  const manualAgentConfigs: Record<string, ManualAgentConfig> = {};
  const agentNames = [
    'orchestrator',
    'oracle',
    'designer',
    'explorer',
    'librarian',
    'fixer',
  ];

  for (const agentName of agentNames) {
    manualAgentConfigs[agentName] = await configureAgentManually(
      rl,
      agentName,
      availableModels,
    );
  }

  // Ask for remaining options
  const balancedSpend = await askYesNo(
    rl,
    'Do you have subscriptions or pay per API? If yes, we will distribute assignments evenly across selected providers so your subscriptions last longer.',
    'no',
  );
  console.log();

  let skills: BooleanArg = 'no';
  let customSkills: BooleanArg = 'no';
  if (!modelsOnly) {
    // Skills prompt
    console.log(`${BOLD}Recommended Skills:${RESET}`);
    for (const skill of RECOMMENDED_SKILLS) {
      console.log(
        `  ${SYMBOLS.bullet} ${BOLD}${skill.name}${RESET}: ${skill.description}`,
      );
    }
    console.log();
    skills = await askYesNo(rl, 'Install recommended skills?', 'yes');
    console.log();

    // Custom skills prompt
    console.log(`${BOLD}Custom Skills:${RESET}`);
    for (const skill of CUSTOM_SKILLS) {
      console.log(
        `  ${SYMBOLS.bullet} ${BOLD}${skill.name}${RESET}: ${skill.description}`,
      );
    }
    console.log();
    customSkills = await askYesNo(rl, 'Install custom skills?', 'yes');
    console.log();
  } else {
    printInfo(
      'Models-only mode: skipping plugin/auth setup and skills prompts.',
    );
    console.log();
  }

  return {
    hasKimi: kimi === 'yes',
    hasOpenAI: openai === 'yes',
    hasAnthropic: anthropic === 'yes',
    hasCopilot: copilot === 'yes',
    hasZaiPlan: zaiPlan === 'yes',
    hasAntigravity: antigravity === 'yes',
    hasChutes: chutes === 'yes',
    hasOpencodeZen: true,
    useOpenCodeFreeModels:
      useOpenCodeFree === 'yes' && availableOpenCodeFreeModels !== undefined,
    availableOpenCodeFreeModels,
    availableChutesModels,
    artificialAnalysisApiKey,
    openRouterApiKey,
    balanceProviderUsage: balancedSpend === 'yes',
    hasTmux: false,
    installSkills: skills === 'yes',
    installCustomSkills: customSkills === 'yes',
    setupMode: 'manual',
    manualAgentConfigs,
    modelsOnly,
  };
}

async function runInteractiveMode(
  detected: DetectedConfig,
  modelsOnly = false,
): Promise<InstallConfig> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // Ask for setup mode first
    console.log();
    console.log(`${BOLD}oh-my-opencode-slim Setup${RESET}`);
    console.log('='.repeat(25));
    console.log();

    const setupMode = await askSetupMode(rl);

    if (setupMode === 'manual') {
      const config = await runManualSetupMode(rl, detected, modelsOnly);
      rl.close();
      return config;
    }

    // Continue with quick setup mode
    // TODO: tmux has a bug, disabled for now
    // const tmuxInstalled = await isTmuxInstalled()
    // const totalQuestions = tmuxInstalled ? 3 : 2
    const totalQuestions = 11;

    const existingAaKey = getEnv('ARTIFICIAL_ANALYSIS_API_KEY');
    const existingOpenRouterKey = getEnv('OPENROUTER_API_KEY');

    console.log(`${BOLD}Question 1/${totalQuestions}:${RESET}`);
    const artificialAnalysisApiKey = await askOptionalApiKey(
      rl,
      'Artificial Analysis API key for better ranking signals',
      existingAaKey,
    );
    if (existingAaKey && !artificialAnalysisApiKey) {
      printInfo('Using existing ARTIFICIAL_ANALYSIS_API_KEY from environment.');
    }
    console.log();

    console.log(`${BOLD}Question 2/${totalQuestions}:${RESET}`);
    const openRouterApiKey = await askOptionalApiKey(
      rl,
      'OpenRouter API key for pricing/metadata signals',
      existingOpenRouterKey,
    );
    if (existingOpenRouterKey && !openRouterApiKey) {
      printInfo('Using existing OPENROUTER_API_KEY from environment.');
    }
    console.log();

    console.log(`${BOLD}Question 3/${totalQuestions}:${RESET}`);
    const useOpenCodeFree = await askYesNo(
      rl,
      'Use Opencode Free models (opencode/*)?',
      'yes',
    );
    console.log();

    let availableOpenCodeFreeModels: OpenCodeFreeModel[] | undefined;
    let selectedOpenCodePrimaryModel: string | undefined;
    let selectedOpenCodeSecondaryModel: string | undefined;
    let availableChutesModels: DiscoveredModel[] | undefined;
    let selectedChutesPrimaryModel: string | undefined;
    let selectedChutesSecondaryModel: string | undefined;

    if (useOpenCodeFree === 'yes') {
      printInfo('Refreshing models with: opencode models --refresh --verbose');
      const discovery = await discoverOpenCodeFreeModels();

      if (discovery.models.length === 0) {
        printWarning(
          discovery.error ??
            'No OpenCode free models found. Continuing without OpenCode free-model assignment.',
        );
      } else {
        availableOpenCodeFreeModels = discovery.models;

        const recommendedPrimary =
          pickBestCodingOpenCodeModel(discovery.models)?.model ??
          discovery.models[0]?.model;

        if (recommendedPrimary) {
          printInfo(
            'This step configures only OpenCode Free primary/support models.',
          );
          console.log(`${BOLD}OpenCode Free Models:${RESET}`);
          selectedOpenCodePrimaryModel = await askModelSelection(
            rl,
            discovery.models,
            recommendedPrimary,
            'Choose primary model for orchestrator/oracle',
          );
        }

        if (selectedOpenCodePrimaryModel) {
          const recommendedSecondary =
            pickSupportOpenCodeModel(
              discovery.models,
              selectedOpenCodePrimaryModel,
            )?.model ?? selectedOpenCodePrimaryModel;

          const openCodeSupportList = discovery.models.filter(
            (model) => model.model !== selectedOpenCodePrimaryModel,
          );
          const openCodeSupportDefault =
            recommendedSecondary === selectedOpenCodePrimaryModel
              ? (openCodeSupportList[0]?.model ?? recommendedSecondary)
              : recommendedSecondary;

          selectedOpenCodeSecondaryModel = await askModelSelection(
            rl,
            openCodeSupportList,
            openCodeSupportDefault,
            'Choose support model for explorer/librarian/fixer',
          );
        }

        console.log();
      }
    }

    console.log(`${BOLD}Question 4/${totalQuestions}:${RESET}`);
    const kimi = await askYesNo(
      rl,
      'Enable Kimi provider?',
      detected.hasKimi ? 'yes' : 'no',
    );
    console.log();

    console.log(`${BOLD}Question 5/${totalQuestions}:${RESET}`);
    const openai = await askYesNo(
      rl,
      'Enable OpenAI provider?',
      detected.hasOpenAI ? 'yes' : 'no',
    );
    console.log();

    console.log(`${BOLD}Question 6/${totalQuestions}:${RESET}`);
    const anthropic = await askYesNo(
      rl,
      'Enable Anthropic provider?',
      detected.hasAnthropic ? 'yes' : 'no',
    );
    console.log();

    console.log(`${BOLD}Question 7/${totalQuestions}:${RESET}`);
    const copilot = await askYesNo(
      rl,
      'Enable GitHub Copilot provider?',
      detected.hasCopilot ? 'yes' : 'no',
    );
    console.log();

    console.log(`${BOLD}Question 8/${totalQuestions}:${RESET}`);
    const zaiPlan = await askYesNo(
      rl,
      'Enable ZAI Coding Plan provider?',
      detected.hasZaiPlan ? 'yes' : 'no',
    );
    console.log();

    console.log(`${BOLD}Question 9/${totalQuestions}:${RESET}`);
    const antigravity = await askYesNo(
      rl,
      'Enable Antigravity (Google) provider?',
      detected.hasAntigravity ? 'yes' : 'no',
    );
    console.log();

    console.log(`${BOLD}Question 10/${totalQuestions}:${RESET}`);
    const chutes = await askYesNo(
      rl,
      'Enable Chutes provider?',
      detected.hasChutes ? 'yes' : 'no',
    );
    console.log();

    if (chutes === 'yes') {
      printInfo(
        'Refreshing Chutes model list with: opencode models --refresh --verbose',
      );
      const discovery = await discoverProviderModels('chutes');

      if (discovery.models.length === 0) {
        printWarning(
          discovery.error ??
            'No Chutes models found. Continuing without Chutes dynamic assignment.',
        );
      } else {
        availableChutesModels = discovery.models;

        const recommendedPrimary =
          pickBestCodingChutesModel(discovery.models)?.model ??
          discovery.models[0]?.model;

        if (recommendedPrimary) {
          console.log(`${BOLD}Chutes Models:${RESET}`);
          selectedChutesPrimaryModel = await askModelSelection(
            rl,
            discovery.models,
            recommendedPrimary,
            'Choose Chutes primary model for orchestrator/oracle/designer',
          );
        }

        if (selectedChutesPrimaryModel) {
          const recommendedSecondary =
            pickSupportChutesModel(discovery.models, selectedChutesPrimaryModel)
              ?.model ?? selectedChutesPrimaryModel;

          const chutesSupportList = discovery.models.filter(
            (model) => model.model !== selectedChutesPrimaryModel,
          );
          const chutesSupportDefault =
            recommendedSecondary === selectedChutesPrimaryModel
              ? (chutesSupportList[0]?.model ?? recommendedSecondary)
              : recommendedSecondary;

          selectedChutesSecondaryModel = await askModelSelection(
            rl,
            chutesSupportList,
            chutesSupportDefault,
            'Choose Chutes support model for explorer/librarian/fixer',
          );
        }

        console.log();
      }
    }

    console.log(`${BOLD}Question 11/${totalQuestions}:${RESET}`);
    const balancedSpend = await askYesNo(
      rl,
      'Do you have subscriptions or pay per API? If yes, we will distribute assignments evenly across selected providers so your subscriptions last longer.',
      'no',
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

    let skills: BooleanArg = 'no';
    let customSkills: BooleanArg = 'no';
    if (!modelsOnly) {
      // Skills prompt
      console.log(`${BOLD}Recommended Skills:${RESET}`);
      for (const skill of RECOMMENDED_SKILLS) {
        console.log(
          `  ${SYMBOLS.bullet} ${BOLD}${skill.name}${RESET}: ${skill.description}`,
        );
      }
      console.log();
      skills = await askYesNo(rl, 'Install recommended skills?', 'yes');
      console.log();

      // Custom skills prompt
      console.log(`${BOLD}Custom Skills:${RESET}`);
      for (const skill of CUSTOM_SKILLS) {
        console.log(
          `  ${SYMBOLS.bullet} ${BOLD}${skill.name}${RESET}: ${skill.description}`,
        );
      }
      console.log();
      customSkills = await askYesNo(rl, 'Install custom skills?', 'yes');
      console.log();
    } else {
      printInfo(
        'Models-only mode: skipping plugin/auth setup and skills prompts.',
      );
      console.log();
    }

    return {
      hasKimi: kimi === 'yes',
      hasOpenAI: openai === 'yes',
      hasAnthropic: anthropic === 'yes',
      hasCopilot: copilot === 'yes',
      hasZaiPlan: zaiPlan === 'yes',
      hasAntigravity: antigravity === 'yes',
      hasChutes: chutes === 'yes',
      hasOpencodeZen: true,
      useOpenCodeFreeModels:
        useOpenCodeFree === 'yes' && selectedOpenCodePrimaryModel !== undefined,
      selectedOpenCodePrimaryModel,
      selectedOpenCodeSecondaryModel,
      availableOpenCodeFreeModels,
      selectedChutesPrimaryModel,
      selectedChutesSecondaryModel,
      availableChutesModels,
      artificialAnalysisApiKey,
      openRouterApiKey,
      balanceProviderUsage: balancedSpend === 'yes',
      hasTmux: false,
      installSkills: skills === 'yes',
      installCustomSkills: customSkills === 'yes',
      setupMode: 'quick',
      modelsOnly,
    };
  } finally {
    rl.close();
  }
}

async function runInstall(config: InstallConfig): Promise<number> {
  const resolvedConfig: InstallConfig = {
    ...config,
  };

  const detected = detectCurrentConfig();
  const isUpdate = detected.isInstalled;

  printHeader(isUpdate);

  const hasAnyEnabledProvider =
    resolvedConfig.hasKimi ||
    resolvedConfig.hasOpenAI ||
    resolvedConfig.hasAnthropic ||
    resolvedConfig.hasCopilot ||
    resolvedConfig.hasZaiPlan ||
    resolvedConfig.hasAntigravity ||
    resolvedConfig.hasChutes ||
    resolvedConfig.useOpenCodeFreeModels;

  const modelsOnly = resolvedConfig.modelsOnly === true;

  // Calculate total steps dynamically
  let totalSteps = modelsOnly ? 2 : 4; // Models-only: check + write
  if (resolvedConfig.useOpenCodeFreeModels) totalSteps += 1;
  if (!modelsOnly && resolvedConfig.hasAntigravity) totalSteps += 2; // antigravity plugin + google provider
  if (!modelsOnly && resolvedConfig.hasChutes) totalSteps += 1; // chutes provider
  if (hasAnyEnabledProvider) totalSteps += 1; // dynamic model resolution
  if (!modelsOnly && resolvedConfig.installSkills) totalSteps += 1; // skills installation
  if (!modelsOnly && resolvedConfig.installCustomSkills) totalSteps += 1; // custom skills installation

  let step = 1;

  if (modelsOnly) {
    printInfo(
      'Models-only mode: updating model assignments without reinstalling plugins/skills.',
    );
  }

  printStep(step++, totalSteps, 'Checking OpenCode installation...');
  if (resolvedConfig.dryRun) {
    printInfo('Dry run mode - skipping OpenCode check');
  } else {
    const { ok } = await checkOpenCodeInstalled();
    if (!ok) return 1;
  }

  if (
    resolvedConfig.useOpenCodeFreeModels &&
    (resolvedConfig.availableOpenCodeFreeModels?.length ?? 0) === 0
  ) {
    printStep(
      step++,
      totalSteps,
      'Refreshing OpenCode free models (opencode/*)...',
    );
    const discovery = await discoverOpenCodeFreeModels();
    if (discovery.models.length === 0) {
      printWarning(
        discovery.error ??
          'No OpenCode free models found. Continuing without dynamic OpenCode assignment.',
      );
      resolvedConfig.useOpenCodeFreeModels = false;
    } else {
      resolvedConfig.availableOpenCodeFreeModels = discovery.models;

      const selectedPrimary =
        resolvedConfig.preferredOpenCodeModel &&
        discovery.models.some(
          (model) => model.model === resolvedConfig.preferredOpenCodeModel,
        )
          ? resolvedConfig.preferredOpenCodeModel
          : (resolvedConfig.selectedOpenCodePrimaryModel ??
            pickBestCodingOpenCodeModel(discovery.models)?.model);

      resolvedConfig.selectedOpenCodePrimaryModel =
        selectedPrimary ?? discovery.models[0]?.model;
      resolvedConfig.selectedOpenCodeSecondaryModel =
        resolvedConfig.selectedOpenCodeSecondaryModel ??
        pickSupportOpenCodeModel(
          discovery.models,
          resolvedConfig.selectedOpenCodePrimaryModel,
        )?.model ??
        resolvedConfig.selectedOpenCodePrimaryModel;

      printSuccess(
        `OpenCode free models ready (${discovery.models.length} models found)`,
      );
    }
  } else if (
    resolvedConfig.useOpenCodeFreeModels &&
    (resolvedConfig.availableOpenCodeFreeModels?.length ?? 0) > 0
  ) {
    const availableModels = resolvedConfig.availableOpenCodeFreeModels ?? [];
    resolvedConfig.selectedOpenCodePrimaryModel =
      resolvedConfig.selectedOpenCodePrimaryModel ??
      pickBestCodingOpenCodeModel(availableModels)?.model;
    resolvedConfig.selectedOpenCodeSecondaryModel =
      resolvedConfig.selectedOpenCodeSecondaryModel ??
      pickSupportOpenCodeModel(
        availableModels,
        resolvedConfig.selectedOpenCodePrimaryModel,
      )?.model ??
      resolvedConfig.selectedOpenCodePrimaryModel;

    printStep(
      step++,
      totalSteps,
      'Using previously refreshed OpenCode free model list...',
    );
    printSuccess(
      `OpenCode free models ready (${availableModels.length} models found)`,
    );
  }

  if (
    resolvedConfig.hasChutes &&
    (resolvedConfig.availableChutesModels?.length ?? 0) === 0
  ) {
    printStep(step++, totalSteps, 'Refreshing Chutes models (chutes/*)...');
    const discovery = await discoverProviderModels('chutes');
    if (discovery.models.length === 0) {
      printWarning(
        discovery.error ??
          'No Chutes models found. Continuing with fallback Chutes mapping.',
      );
    } else {
      resolvedConfig.availableChutesModels = discovery.models;
      resolvedConfig.selectedChutesPrimaryModel =
        resolvedConfig.selectedChutesPrimaryModel ??
        pickBestCodingChutesModel(discovery.models)?.model ??
        discovery.models[0]?.model;
      resolvedConfig.selectedChutesSecondaryModel =
        resolvedConfig.selectedChutesSecondaryModel ??
        pickSupportChutesModel(
          discovery.models,
          resolvedConfig.selectedChutesPrimaryModel,
        )?.model ??
        resolvedConfig.selectedChutesPrimaryModel;

      printSuccess(
        `Chutes models ready (${discovery.models.length} models found)`,
      );
    }
  } else if (
    resolvedConfig.hasChutes &&
    (resolvedConfig.availableChutesModels?.length ?? 0) > 0
  ) {
    const availableChutes = resolvedConfig.availableChutesModels ?? [];
    resolvedConfig.selectedChutesPrimaryModel =
      resolvedConfig.selectedChutesPrimaryModel ??
      pickBestCodingChutesModel(availableChutes)?.model;
    resolvedConfig.selectedChutesSecondaryModel =
      resolvedConfig.selectedChutesSecondaryModel ??
      pickSupportChutesModel(
        availableChutes,
        resolvedConfig.selectedChutesPrimaryModel,
      )?.model ??
      resolvedConfig.selectedChutesPrimaryModel;

    printStep(
      step++,
      totalSteps,
      'Using previously refreshed Chutes model list...',
    );
    printSuccess(
      `Chutes models ready (${availableChutes.length} models found)`,
    );
  }

  if (!modelsOnly) {
    printStep(step++, totalSteps, 'Adding oh-my-opencode-slim plugin...');
    if (resolvedConfig.dryRun) {
      printInfo('Dry run mode - skipping plugin installation');
    } else {
      const pluginResult = await addPluginToOpenCodeConfig();
      if (!handleStepResult(pluginResult, 'Plugin added')) return 1;
    }
  }

  // Add Antigravity support if requested
  if (!modelsOnly && resolvedConfig.hasAntigravity) {
    printStep(step++, totalSteps, 'Adding Antigravity plugin...');
    if (resolvedConfig.dryRun) {
      printInfo('Dry run mode - skipping Antigravity plugin');
    } else {
      const antigravityPluginResult = addAntigravityPlugin();
      if (
        !handleStepResult(antigravityPluginResult, 'Antigravity plugin added')
      )
        return 1;
    }

    printStep(step++, totalSteps, 'Configuring Google Provider...');
    if (resolvedConfig.dryRun) {
      printInfo('Dry run mode - skipping Google Provider setup');
    } else {
      const googleProviderResult = addGoogleProvider();
      if (!handleStepResult(googleProviderResult, 'Google Provider configured'))
        return 1;
    }
  }

  if (!modelsOnly && resolvedConfig.hasChutes) {
    printStep(step++, totalSteps, 'Enabling Chutes auth flow...');
    if (resolvedConfig.dryRun) {
      printInfo('Dry run mode - skipping Chutes auth flow');
    } else {
      const chutesProviderResult = addChutesProvider();
      if (!handleStepResult(chutesProviderResult, 'Chutes auth flow ready'))
        return 1;
    }
  }

  if (hasAnyEnabledProvider) {
    printStep(step++, totalSteps, 'Resolving dynamic model assignments...');
    const catalogDiscovery = await discoverModelCatalog();
    if (catalogDiscovery.models.length === 0) {
      printWarning(
        catalogDiscovery.error ??
          'Unable to discover model catalog. Falling back to static mappings.',
      );
    } else {
      const { signals, warnings } = await fetchExternalModelSignals({
        artificialAnalysisApiKey: resolvedConfig.artificialAnalysisApiKey,
        openRouterApiKey: resolvedConfig.openRouterApiKey,
      });
      for (const warning of warnings) {
        printInfo(warning);
      }

      const dynamicPlan = buildDynamicModelPlan(
        catalogDiscovery.models,
        resolvedConfig,
        signals,
      );
      if (!dynamicPlan) {
        printWarning(
          'Dynamic planner found no suitable models. Using static mappings.',
        );
      } else {
        resolvedConfig.dynamicModelPlan = dynamicPlan;
        printSuccess(
          `Dynamic assignments ready (${Object.keys(dynamicPlan.agents).length} agents)`,
        );
      }
    }
  }

  if (!modelsOnly) {
    printStep(step++, totalSteps, 'Disabling OpenCode default agents...');
    if (resolvedConfig.dryRun) {
      printInfo('Dry run mode - skipping agent disabling');
    } else {
      const agentResult = disableDefaultAgents();
      if (!handleStepResult(agentResult, 'Default agents disabled')) return 1;
    }
  }

  printStep(step++, totalSteps, 'Writing oh-my-opencode-slim configuration...');
  if (resolvedConfig.dryRun) {
    const liteConfig = generateLiteConfig(resolvedConfig);
    printInfo('Dry run mode - configuration that would be written:');
    console.log(`\n${JSON.stringify(liteConfig, null, 2)}\n`);
  } else {
    const liteResult = writeLiteConfig(resolvedConfig);
    if (!handleStepResult(liteResult, 'Config written')) return 1;
  }

  // Install skills if requested
  if (!modelsOnly && resolvedConfig.installSkills) {
    printStep(step++, totalSteps, 'Installing recommended skills...');
    if (resolvedConfig.dryRun) {
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
          printWarning(`Failed to install: ${skill.name}`);
        }
      }
      printSuccess(
        `${skillsInstalled}/${RECOMMENDED_SKILLS.length} skills installed`,
      );
    }
  }

  // Install custom skills if requested
  if (!modelsOnly && resolvedConfig.installCustomSkills) {
    printStep(step++, totalSteps, 'Installing custom skills...');
    if (resolvedConfig.dryRun) {
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
          printWarning(`Failed to install: ${skill.name}`);
        }
      }
      printSuccess(
        `${customSkillsInstalled}/${CUSTOM_SKILLS.length} custom skills installed`,
      );
    }
  }

  // Summary
  console.log();
  console.log(formatConfigSummary(resolvedConfig));
  console.log();

  printAgentModels(resolvedConfig);

  if (
    !resolvedConfig.hasKimi &&
    !resolvedConfig.hasOpenAI &&
    !resolvedConfig.hasAnthropic &&
    !resolvedConfig.hasCopilot &&
    !resolvedConfig.hasZaiPlan &&
    !resolvedConfig.hasAntigravity &&
    !resolvedConfig.hasChutes
  ) {
    printWarning(
      'No providers configured. Zen Big Pickle models will be used as fallback.',
    );
  }

  console.log(
    `${SYMBOLS.star} ${BOLD}${GREEN}${isUpdate ? 'Configuration updated!' : 'Installation complete!'}${RESET}`,
  );
  console.log();
  console.log(`${BOLD}Next steps:${RESET}`);
  console.log();

  let nextStep = 1;

  if (
    resolvedConfig.hasKimi ||
    resolvedConfig.hasOpenAI ||
    resolvedConfig.hasAnthropic ||
    resolvedConfig.hasCopilot ||
    resolvedConfig.hasZaiPlan ||
    resolvedConfig.hasAntigravity ||
    resolvedConfig.hasChutes
  ) {
    console.log(`  ${nextStep++}. Authenticate with your providers:`);
    console.log(`     ${BLUE}$ opencode auth login${RESET}`);
    if (resolvedConfig.hasKimi) {
      console.log();
      console.log(`     Then select ${BOLD}Kimi For Coding${RESET} provider.`);
    }
    if (resolvedConfig.hasAntigravity) {
      console.log();
      console.log(`     Then select ${BOLD}google${RESET} provider.`);
    }
    if (resolvedConfig.hasAnthropic) {
      console.log();
      console.log(`     Then select ${BOLD}anthropic${RESET} provider.`);
    }
    if (resolvedConfig.hasCopilot) {
      console.log();
      console.log(`     Then select ${BOLD}github-copilot${RESET} provider.`);
    }
    if (resolvedConfig.hasZaiPlan) {
      console.log();
      console.log(`     Then select ${BOLD}zai-coding-plan${RESET} provider.`);
    }
    if (resolvedConfig.hasChutes) {
      console.log();
      console.log(`     Then select ${BOLD}chutes${RESET} provider.`);
    }
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
    const requiredArgs = [
      'kimi',
      'openai',
      'anthropic',
      'copilot',
      'zaiPlan',
      'antigravity',
      'chutes',
      'tmux',
    ] as const;
    const errors = requiredArgs.filter((key) => {
      const value = args[key];
      return value === undefined || !['yes', 'no'].includes(value);
    });

    if (errors.length > 0) {
      printHeader(false);
      printError('Missing or invalid arguments:');
      for (const key of errors) {
        const flagName = key === 'zaiPlan' ? 'zai-plan' : key;
        console.log(`  ${SYMBOLS.bullet} --${flagName}=<yes|no>`);
      }
      console.log();
      printInfo(
        'Usage: bunx oh-my-opencode-slim install --no-tui --kimi=<yes|no> --openai=<yes|no> --anthropic=<yes|no> --copilot=<yes|no> --zai-plan=<yes|no> --antigravity=<yes|no> --chutes=<yes|no> --balanced-spend=<yes|no> --tmux=<yes|no>',
      );
      console.log();
      return 1;
    }

    const nonInteractiveConfig = argsToConfig(args);
    return runInstall(nonInteractiveConfig);
  }

  // Interactive mode
  const detected = detectCurrentConfig();

  printHeader(detected.isInstalled);

  printStep(1, 1, 'Checking OpenCode installation...');
  if (args.dryRun) {
    printInfo('Dry run mode - skipping OpenCode check');
  } else {
    const { ok } = await checkOpenCodeInstalled();
    if (!ok) return 1;
  }
  console.log();

  const config = await runInteractiveMode(detected, args.modelsOnly === true);
  // Pass dryRun through to the config
  config.dryRun = args.dryRun;
  config.modelsOnly = args.modelsOnly;
  return runInstall(config);
}
