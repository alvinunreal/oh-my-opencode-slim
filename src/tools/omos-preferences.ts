import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { parseConfig, writeConfig } from '../cli/config-io';
import { rankModelsV1WithBreakdown } from '../cli/dynamic-model-selection';
import { getConfigDir } from '../cli/paths';
import { resolveAgentWithPrecedence } from '../cli/precedence-resolver';
import { rankModelsV2 } from '../cli/scoring-v2';
import type { DiscoveredModel, ScoringEngineVersion } from '../cli/types';
import {
  type AgentOverrideConfig,
  loadPluginConfig,
  ManualPlanSchema,
  type PluginConfig,
  type Preset,
} from '../config';

const AGENT_NAMES = [
  'orchestrator',
  'oracle',
  'designer',
  'explorer',
  'librarian',
  'fixer',
] as const;

type AgentName = (typeof AGENT_NAMES)[number];
type WriteTarget = 'auto' | 'global' | 'project';

type ManualAgentPlan = {
  primary: string;
  fallback1: string;
  fallback2: string;
  fallback3: string;
};

type ManualPlan = Record<AgentName, ManualAgentPlan>;

type DiffSummary = {
  changedAgents: string[];
  unchangedAgents: string[];
  details: Record<string, { before: string[]; after: string[] }>;
};

type ScoreRow = {
  model: string;
  totalScore: number;
  breakdown?: Record<string, number>;
};

type ScoreSummary = Record<AgentName, ScoreRow[]>;

const DEFAULT_CHAIN_FILL = [
  'opencode/gpt-5-nano',
  'opencode/glm-4.7-free',
  'opencode/big-pickle',
  'opencode/sonic',
];

function stringify(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function dedupe(models: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models) {
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  return result;
}

function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function getGlobalConfigPath(): string {
  const configDir = getConfigDir();
  const jsonPath = join(configDir, 'oh-my-opencode-slim.json');
  const jsoncPath = join(configDir, 'oh-my-opencode-slim.jsonc');
  return existsSync(jsoncPath) ? jsoncPath : jsonPath;
}

function getProjectConfigPath(directory: string): string {
  const jsonPath = join(directory, '.opencode', 'oh-my-opencode-slim.json');
  const jsoncPath = join(directory, '.opencode', 'oh-my-opencode-slim.jsonc');
  return existsSync(jsoncPath) ? jsoncPath : jsonPath;
}

export function resolveTargetPath(
  directory: string,
  target: WriteTarget,
): string {
  if (target === 'global') return getGlobalConfigPath();
  if (target === 'project') return getProjectConfigPath(directory);

  const projectPath = getProjectConfigPath(directory);
  if (existsSync(projectPath)) return projectPath;
  return getGlobalConfigPath();
}

function readConfigAtPath(path: string): PluginConfig {
  const parsed = parseConfig(path);
  if (parsed.error) {
    throw new Error(`Failed to parse config at ${path}: ${parsed.error}`);
  }
  return (parsed.config ?? {}) as PluginConfig;
}

function ensureParentDir(path: string): void {
  const parts = path.split('/');
  if (parts.length <= 1) return;
  const parent = parts.slice(0, -1).join('/');
  if (parent && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function getActivePresetAgents(config: PluginConfig): Record<string, unknown> {
  const presetName = config.preset;
  if (presetName && config.presets?.[presetName]) {
    return config.presets[presetName] as Record<string, unknown>;
  }
  return (config.agents ?? {}) as Record<string, unknown>;
}

function getAgentPrimary(
  config: PluginConfig,
  agentName: AgentName,
): string | undefined {
  const fromRoot = (
    config.agents?.[agentName] as { model?: string } | undefined
  )?.model;
  if (fromRoot) return fromRoot;

  const activePresetAgents = getActivePresetAgents(config);
  return (activePresetAgents[agentName] as { model?: string } | undefined)
    ?.model;
}

function deriveAgentChain(
  config: PluginConfig,
  agentName: AgentName,
): string[] {
  const primary = getAgentPrimary(config, agentName);
  const fromFallback = config.fallback?.chains?.[agentName] ?? [];
  const resolved = dedupe([primary, ...fromFallback]);
  return dedupe([...resolved, ...DEFAULT_CHAIN_FILL]).slice(0, 4);
}

export function deriveManualPlanFromConfig(config: PluginConfig): ManualPlan {
  const entries = AGENT_NAMES.map((agentName) => {
    const chain = deriveAgentChain(config, agentName);
    return [
      agentName,
      {
        primary: chain[0] ?? 'opencode/big-pickle',
        fallback1: chain[1] ?? 'opencode/gpt-5-nano',
        fallback2: chain[2] ?? 'opencode/glm-4.7-free',
        fallback3: chain[3] ?? 'opencode/sonic',
      },
    ];
  });

  return Object.fromEntries(entries) as ManualPlan;
}

function toSyntheticModel(model: string): DiscoveredModel | null {
  const [providerID, modelID] = model.split('/');
  if (!providerID || !modelID) return null;

  return {
    providerID,
    model,
    name: modelID,
    status: 'active',
    contextLimit: 200000,
    outputLimit: 32000,
    reasoning: true,
    toolcall: true,
    attachment: false,
  };
}

function extractCandidateModels(plan: ManualPlan, agent: AgentName): string[] {
  const p = plan[agent];
  return [p.primary, p.fallback1, p.fallback2, p.fallback3];
}

export function scoreManualPlan(
  plan: ManualPlan,
  engine: ScoringEngineVersion,
): ScoreSummary {
  const summary = {} as ScoreSummary;

  for (const agent of AGENT_NAMES) {
    const syntheticCatalog = dedupe(extractCandidateModels(plan, agent))
      .map(toSyntheticModel)
      .filter((m): m is DiscoveredModel => m !== null);

    if (engine === 'v2') {
      summary[agent] = rankModelsV2(syntheticCatalog, agent).map((entry) => ({
        model: entry.model.model,
        totalScore: entry.totalScore,
        breakdown: {
          ...entry.scoreBreakdown.weighted,
        },
      }));
      continue;
    }

    const v1Rows = rankModelsV1WithBreakdown(syntheticCatalog, agent).map(
      (entry) => ({
        model: entry.model,
        totalScore: entry.totalScore,
        breakdown: {
          baseScore: entry.baseScore,
          externalSignalBoost: entry.externalSignalBoost,
        },
      }),
    );

    if (engine === 'v2-shadow') {
      const v2Rows = rankModelsV2(syntheticCatalog, agent).map((entry) => ({
        model: entry.model.model,
        totalScore: entry.totalScore,
      }));
      summary[agent] = v1Rows.map((row) => {
        const v2 = v2Rows.find((candidate) => candidate.model === row.model);
        return {
          ...row,
          breakdown: {
            ...(row.breakdown ?? {}),
            shadowV2Score: v2?.totalScore ?? 0,
          },
        };
      });
      continue;
    }

    summary[agent] = v1Rows;
  }

  return summary;
}

function buildAgentConfig(
  existing: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  return {
    ...existing,
    model,
  };
}

export function compileManualPlanToConfig(
  config: PluginConfig,
  manualPlan: ManualPlan,
): PluginConfig {
  const fallbackChains: Record<string, string[]> = {};
  const rootAgents: Record<string, AgentOverrideConfig> = {
    ...(config.agents ?? {}),
  };

  const activePresetAgents = getActivePresetAgents(config);
  const manualPreset: Preset = {};

  for (const agentName of AGENT_NAMES) {
    const plan = manualPlan[agentName];
    const resolved = resolveAgentWithPrecedence({
      agentName,
      manualUserPlan: [
        plan.primary,
        plan.fallback1,
        plan.fallback2,
        plan.fallback3,
      ],
      systemDefault: ['opencode/big-pickle'],
    });

    fallbackChains[agentName] = resolved.chain;

    const existingRoot = (rootAgents[agentName] ?? {}) as Record<
      string,
      unknown
    >;
    rootAgents[agentName] = buildAgentConfig(
      existingRoot,
      plan.primary,
    ) as AgentOverrideConfig;

    const existingPreset =
      (activePresetAgents[agentName] as Record<string, unknown> | undefined) ??
      {};
    manualPreset[agentName] = buildAgentConfig(
      existingPreset,
      plan.primary,
    ) as AgentOverrideConfig;
  }

  return {
    ...config,
    preset: 'manual',
    manualPlan,
    agents: rootAgents,
    presets: {
      ...(config.presets ?? {}),
      manual: manualPreset,
    },
    fallback: {
      enabled: config.fallback?.enabled ?? true,
      timeoutMs: config.fallback?.timeoutMs ?? 15000,
      chains: {
        ...(config.fallback?.chains ?? {}),
        ...fallbackChains,
      },
    },
  };
}

export function diffManualPlans(
  before: ManualPlan,
  after: ManualPlan,
): DiffSummary {
  const changedAgents: string[] = [];
  const unchangedAgents: string[] = [];
  const details: Record<string, { before: string[]; after: string[] }> = {};

  for (const agentName of AGENT_NAMES) {
    const beforeChain = [
      before[agentName].primary,
      before[agentName].fallback1,
      before[agentName].fallback2,
      before[agentName].fallback3,
    ];
    const afterChain = [
      after[agentName].primary,
      after[agentName].fallback1,
      after[agentName].fallback2,
      after[agentName].fallback3,
    ];

    const changed = beforeChain.join(' -> ') !== afterChain.join(' -> ');
    if (changed) {
      changedAgents.push(agentName);
      details[agentName] = { before: beforeChain, after: afterChain };
    } else {
      unchangedAgents.push(agentName);
    }
  }

  return { changedAgents, unchangedAgents, details };
}

export function precedenceWarning(
  targetPath: string,
  directory: string,
): string | undefined {
  const projectPath = getProjectConfigPath(directory);
  const globalPath = getGlobalConfigPath();
  if (targetPath === globalPath && existsSync(projectPath)) {
    return `Project config exists at ${projectPath} and may override global values from ${globalPath}.`;
  }
  return undefined;
}

export function createOmosPreferencesTools(ctx: PluginInput): {
  omos_preferences: ToolDefinition;
} {
  const z = tool.schema;

  const omos_preferences = tool({
    description: `Manage OMOS model preferences.

Operations:
- show: show current effective and target plan
- plan: validate and preview diff (no write)
- apply: validate and write with confirm=true
- reset-agent: reset one agent chain on selected target
- score-plan: score manual candidates per agent for v1/v2/v2-shadow

Targets:
- auto (default): project if present, otherwise global
- project: .opencode config in current directory
- global: ~/.config/opencode config`,
    args: {
      operation: z.enum(['show', 'plan', 'apply', 'reset-agent', 'score-plan']),
      plan: z.unknown().optional(),
      agent: z.string().optional(),
      confirm: z.boolean().optional(),
      target: z.enum(['auto', 'global', 'project']).optional(),
      expectedDiffHash: z.string().optional(),
      engine: z.enum(['v1', 'v2-shadow', 'v2']).optional(),
    },
    async execute(args) {
      const operation = args.operation;
      const target = (args.target ?? 'auto') as WriteTarget;
      const targetPath = resolveTargetPath(ctx.directory, target);
      const targetConfig = readConfigAtPath(targetPath);
      const effectiveConfig = loadPluginConfig(ctx.directory);
      const effectivePlan = deriveManualPlanFromConfig(effectiveConfig);

      if (operation === 'show') {
        return stringify({
          target,
          targetPath,
          effectivePlan,
          targetPlan: deriveManualPlanFromConfig(targetConfig),
          warning: precedenceWarning(targetPath, ctx.directory),
        });
      }

      if (operation === 'score-plan') {
        const parsed = ManualPlanSchema.safeParse(args.plan);
        if (!parsed.success) {
          return `Invalid plan:\n${stringify(parsed.error.format())}`;
        }

        const engine =
          (args.engine as ScoringEngineVersion | undefined) ??
          targetConfig.scoringEngineVersion ??
          'v1';
        return stringify({
          engine,
          scores: scoreManualPlan(parsed.data, engine),
        });
      }

      if (operation === 'plan') {
        const parsed = ManualPlanSchema.safeParse(args.plan);
        if (!parsed.success) {
          return `Invalid plan:\n${stringify(parsed.error.format())}`;
        }

        const nextPlan = parsed.data;
        const targetPlan = deriveManualPlanFromConfig(targetConfig);
        const diff = diffManualPlans(targetPlan, nextPlan);
        const diffHash = hashString(stringify(diff));
        const compiled = compileManualPlanToConfig(targetConfig, nextPlan);

        return stringify({
          target,
          targetPath,
          diffHash,
          diff,
          warning: precedenceWarning(targetPath, ctx.directory),
          compiled: {
            agents: AGENT_NAMES.reduce(
              (acc, agentName) => {
                acc[agentName] = {
                  model: (compiled.agents?.[agentName] as { model?: string })
                    ?.model,
                };
                return acc;
              },
              {} as Record<string, { model?: string }>,
            ),
            fallback: compiled.fallback,
          },
        });
      }

      if (operation === 'apply') {
        if (args.confirm !== true) {
          return 'Refusing apply without confirm=true. Run plan first and review the diff.';
        }

        const parsed = ManualPlanSchema.safeParse(args.plan);
        if (!parsed.success) {
          return `Invalid plan:\n${stringify(parsed.error.format())}`;
        }

        const nextPlan = parsed.data;
        const targetPlan = deriveManualPlanFromConfig(targetConfig);
        const diff = diffManualPlans(targetPlan, nextPlan);
        const actualDiffHash = hashString(stringify(diff));
        if (args.expectedDiffHash && args.expectedDiffHash !== actualDiffHash) {
          return `Diff hash mismatch. expected=${args.expectedDiffHash} actual=${actualDiffHash}. Run plan again before apply.`;
        }

        const nextConfig = compileManualPlanToConfig(targetConfig, nextPlan);
        ensureParentDir(targetPath);
        writeConfig(targetPath, nextConfig as Record<string, unknown>);

        return stringify({
          applied: true,
          target,
          targetPath,
          diffHash: actualDiffHash,
          changedAgents: diff.changedAgents,
          warning: precedenceWarning(targetPath, ctx.directory),
          restartHint: 'Start a new session for updated models.',
        });
      }

      const agent = args.agent as AgentName | undefined;
      if (!agent || !AGENT_NAMES.includes(agent)) {
        return `Invalid agent. Expected one of: ${AGENT_NAMES.join(', ')}`;
      }

      const currentTargetPlan = deriveManualPlanFromConfig(targetConfig);
      const baselinePlan = deriveManualPlanFromConfig(effectiveConfig);
      const baselineChain = dedupe([
        baselinePlan[agent]?.primary,
        baselinePlan[agent]?.fallback1,
        baselinePlan[agent]?.fallback2,
        baselinePlan[agent]?.fallback3,
      ]).slice(0, 4);
      currentTargetPlan[agent] = {
        primary: baselineChain[0] ?? 'opencode/big-pickle',
        fallback1: baselineChain[1] ?? 'opencode/gpt-5-nano',
        fallback2: baselineChain[2] ?? 'opencode/glm-4.7-free',
        fallback3: baselineChain[3] ?? 'opencode/sonic',
      };

      const nextConfig = compileManualPlanToConfig(
        targetConfig,
        currentTargetPlan,
      );
      ensureParentDir(targetPath);
      writeConfig(targetPath, nextConfig as Record<string, unknown>);

      return stringify({
        reset: true,
        agent,
        target,
        targetPath,
        warning: precedenceWarning(targetPath, ctx.directory),
        restartHint: 'Start a new session for updated models.',
      });
    },
  });

  return { omos_preferences };
}
