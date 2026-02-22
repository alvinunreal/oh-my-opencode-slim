#!/usr/bin/env bun
import { MODEL_COSTS } from '../token-discipline/model-config';
import {
  clearCache,
  createDefaultConfig,
  getAllAssignments,
  getModelCost,
  getTokenDisciplineSettings,
  updateModelForRole,
  validateConfig,
} from '../token-discipline/model-config-loader';

function printHelp(): void {
  console.log(`
omoslim model configuration CLI

Usage: bunx omoslim model <command> [OPTIONS]

Commands:
  list              List current model assignments
  set <role> <model> Set model for a specific role
  validate          Validate omoslim.json configuration
  costs             Show estimated costs for current model assignments
  init              Create default omoslim.json configuration
  settings          Show token discipline settings

Roles:
  orchestrator      Primary decision-maker
  researcher        External docs and library research
  repo_scout        Codebase analysis and file finding
  implementer       Code generation and changes
  validator         Testing and code review
  designer          UI/UX and styling work
  summarizer        Emergency packet compression fallback

Examples:
  bunx omoslim model list
  bunx omoslim model set orchestrator anthropic/claude-opus-4
  bunx omoslim model set researcher openai/gpt-4o-mini
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
  const assignments = await getAllAssignments();

  console.log('\n📋 Current Model Assignments:\n');

  const roleOrder = [
    'orchestrator',
    'researcher',
    'repo_scout',
    'implementer',
    'validator',
    'designer',
    'summarizer',
  ];

  for (const role of roleOrder) {
    const assignment = assignments[role];
    if (assignment) {
      console.log(
        `  ${role.padEnd(15)} → ${(assignment.model ?? 'unknown').padEnd(25)} (${assignment.tier ?? 'unknown'})`,
      );
      if (assignment.description) {
        console.log(`  ${' '.repeat(15)}   ${assignment.description}`);
      }
      console.log();
    }
  }

  return 0;
}

async function setModel(args: string[]): Promise<number> {
  if (args.length < 2) {
    console.error('Usage: bunx omoslim model set <role> <model>');
    return 1;
  }

  const role = args[0].toLowerCase();
  const model = args[1];

  const validRoles = [
    'orchestrator',
    'researcher',
    'repo_scout',
    'implementer',
    'validator',
    'designer',
    'summarizer',
  ];

  if (!validRoles.includes(role)) {
    console.error(`Unknown role: ${role}`);
    console.error(`Valid roles: ${validRoles.join(', ')}`);
    return 1;
  }

  try {
    await updateModelForRole(role, model);
    console.log(`✅ Updated ${role} → ${model}`);
    return 0;
  } catch (error) {
    console.error(
      `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

async function validateModel(): Promise<number> {
  const result = await validateConfig();

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
  const assignments = await getAllAssignments();

  console.log('\n💰 Cost Estimates (per 1M tokens):\n');

  const roleOrder = [
    'orchestrator',
    'researcher',
    'repo_scout',
    'implementer',
    'validator',
    'designer',
    'summarizer',
  ];

  for (const role of roleOrder) {
    const assignment = assignments[role];
    if (assignment) {
      const model = assignment.model ?? 'unknown';
      const costs = getModelCost(model);

      console.log(`  ${role.padEnd(15)} (${model})`);
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
  clearCache();
  await createDefaultConfig();
  console.log('✅ Created default omoslim.json configuration');
  return 0;
}

async function showSettings(): Promise<number> {
  const settings = await getTokenDisciplineSettings();

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
