#!/usr/bin/env bun
import type { AgentName } from '../config/constants';
import {
  createDefaultConfig,
  getAllAgentModels,
  getModelCost,
  getTokenDisciplineSettings,
  loadConfig,
  saveConfig,
  setModelForAgent,
  validatePluginConfig,
} from '../config/model-helpers';
import { MODEL_COSTS } from '../token-discipline/model-config';

function printHelp(): void {
  console.log(`
omoslim model configuration CLI

Usage: bunx omoslim model <command> [OPTIONS]

Commands:
  list                List current model assignments
  set <agent> <model> Set model for a specific agent
  validate            Validate omoslim.json configuration
  costs               Show estimated costs for current model assignments
  init                Create default omoslim.json configuration
  settings            Show token discipline settings

Agents:
  orchestrator        Primary decision-maker
  librarian           External docs and library research (researcher)
  explorer            Codebase analysis and file finding (repo_scout)
  fixer               Code generation and changes (implementer)
  oracle              Testing and code review (validator)
  designer            UI/UX and styling work
  summarizer          Emergency packet compression fallback

Examples:
  bunx omoslim model list
  bunx omoslim model set orchestrator anthropic/claude-opus-4
  bunx omoslim model set librarian openai/gpt-4o-mini
  bunx omoslim model validate
  bunx omoslim model costs
`);
}

export async function modelCommand(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    printHelp();
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case 'list':
      return listModels();
    case 'set':
      return setModel(rest);
    case 'validate':
      return validateModel();
    case 'costs':
      return showCosts();
    case 'init':
      return initConfig();
    case 'settings':
      return showSettings();
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help for usage information');
      return 1;
  }
}

async function listModels(): Promise<number> {
  const config = loadConfig();
  const models = getAllAgentModels(config);

  console.log('\n📋 Current Model Assignments:\n');

  if (config.preset) {
    console.log(`Active preset: ${config.preset}\n`);
  }

  const agentOrder: AgentName[] = [
    'orchestrator',
    'librarian',
    'explorer',
    'fixer',
    'oracle',
    'designer',
    'summarizer',
  ];

  for (const agent of agentOrder) {
    const model = models[agent];
    if (model) {
      console.log(`  ${agent.padEnd(15)} → ${model}`);
    }
  }

  console.log();

  return 0;
}

async function setModel(args: string[]): Promise<number> {
  if (args.length < 2) {
    console.error('Usage: bunx omoslim model set <agent> <model>');
    return 1;
  }

  const agentName = args[0].toLowerCase() as AgentName;
  const model = args[1];

  const validAgents: AgentName[] = [
    'orchestrator',
    'librarian',
    'explorer',
    'fixer',
    'oracle',
    'designer',
    'summarizer',
  ];

  if (!validAgents.includes(agentName)) {
    console.error(`Unknown agent: ${agentName}`);
    console.error(`Valid agents: ${validAgents.join(', ')}`);
    return 1;
  }

  try {
    const config = loadConfig();
    const updatedConfig = setModelForAgent(config, agentName, model);
    saveConfig(updatedConfig);
    console.log(`✅ Updated ${agentName} → ${model}`);
    return 0;
  } catch (error) {
    console.error(
      `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

async function validateModel(): Promise<number> {
  const config = loadConfig();
  const result = validatePluginConfig(config);

  if (result.valid) {
    console.log('✅ Configuration is valid');
    return 0;
  }

  console.log('❌ Configuration errors found:\n');
  for (const error of result.errors) {
    console.log(`  • ${error}`);
  }
  return 1;
}

async function showCosts(): Promise<number> {
  const config = loadConfig();
  const models = getAllAgentModels(config);

  console.log('\n💰 Cost Estimates (per 1M tokens):\n');

  const agentOrder: AgentName[] = [
    'orchestrator',
    'librarian',
    'explorer',
    'fixer',
    'oracle',
    'designer',
    'summarizer',
  ];

  for (const agent of agentOrder) {
    const model = models[agent];
    if (model) {
      const costs = getModelCost(model);

      console.log(`  ${agent.padEnd(15)} (${model})`);
      if (costs.input > 0) {
        console.log(`  ${' '.repeat(15)} Input:  $${costs.input.toFixed(2)}`);
        console.log(`  ${' '.repeat(15)} Output: $${costs.output.toFixed(2)}`);
      } else {
        console.log(`  ${' '.repeat(15)} (cost data not available)`);
      }
      console.log();
    }
  }

  console.log('\n📊 Available Model Costs:\n');
  const sortedModels = Object.entries(MODEL_COSTS).sort(
    ([, a], [, b]) => a.input - b.input,
  );

  for (const [model, costs] of sortedModels) {
    console.log(
      `  ${model.padEnd(30)} $${costs.input.toFixed(2)} / $${costs.output.toFixed(2)}`,
    );
  }

  return 0;
}

async function initConfig(): Promise<number> {
  createDefaultConfig();
  console.log('✅ Created default omoslim.json configuration');
  return 0;
}

async function showSettings(): Promise<number> {
  const config = loadConfig();
  const settings = getTokenDisciplineSettings(config);

  console.log('\n⚙️  Token Discipline Settings:\n');
  console.log(`  Enforce Isolation:     ${settings.enforceIsolation}`);
  console.log(`  Max Packet Size:       ${settings.maxPacketSize} chars`);
  console.log(`  Max Resolutions/Task:  ${settings.maxResolutionsPerTask}`);
  console.log(`  Thread Archive Hours:  ${settings.threadArchiveHours}h`);

  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === 'model') {
    const exitCode = await modelCommand(args.slice(1));
    process.exit(exitCode);
  } else {
    const exitCode = await modelCommand(args);
    process.exit(exitCode);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
