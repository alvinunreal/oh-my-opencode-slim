import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  AGENT_ALIASES,
  type AgentOverrideConfig,
  ALL_AGENT_NAMES,
  DEFAULT_DISABLED_AGENTS,
  DEFAULT_MODELS,
  loadAgentPrompt,
  type PluginConfig,
  PROTECTED_AGENTS,
  SUBAGENT_NAMES,
} from '../config';
import { getAgentMcpList } from '../config/agent-mcps';
import type { RuntimeConfig } from '../config/runtime';
import { escapeRegExp, normalizeAgentName } from '../utils/agent-variant';

import { createCouncilAgent } from './council';
import { buildCouncillorAgents, getCouncillorSeatName } from './council-agents';
import { createCouncillorAgent } from './councillor';
import { createDesignerAgent } from './designer';
import { createExplorerAgent } from './explorer';
import { createFixerAgent } from './fixer';
import { createLibrarianAgent } from './librarian';
import { createObserverAgent } from './observer';
import { createOracleAgent } from './oracle';
import {
  type AgentDefinition,
  createOrchestratorAgent,
  resolvePrompt,
} from './orchestrator';
import { appendTaskRejectionInstruction } from './task-rejection';

export type { AgentDefinition } from './orchestrator';

type AgentFactory = (
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
) => AgentDefinition;

const TASK_CONTROL_TOOL_NAMES = [
  'task_cancel',
  'task_message',
  'task_revive',
  'task_steer',
  'task_status',
  'task_result',
] as const;
const SAFE_AGENT_ALIAS_RE = /^[a-z][a-z0-9_-]*$/i;

function getPrimaryModelFromOverride(
  override: AgentOverrideConfig | undefined,
): string | undefined {
  const model = override?.model;
  if (typeof model === 'string') {
    return model;
  }
  if (Array.isArray(model) && model.length > 0) {
    const first = model[0];
    return typeof first === 'string' ? first : first?.id;
  }
  return undefined;
}

/**
 * Alias-aware override lookup inside a merged (preset-aware) agents record.
 * Mirrors getAgentOverride semantics without the host layer, which the
 * config hook applies separately at merge time.
 */
function getOverrideFromAgents(
  agents: Record<string, AgentOverrideConfig>,
  name: string,
): AgentOverrideConfig | undefined {
  return (
    agents[name] ??
    agents[
      Object.keys(AGENT_ALIASES).find((key) => AGENT_ALIASES[key] === name) ??
        ''
    ]
  );
}

function buildAcpAgentDefinition(
  name: string,
  config: NonNullable<PluginConfig['acpAgents']>[string],
  fallbackModel?: string,
): AgentDefinition {
  const description =
    config.description ?? `External ACP agent '${name}' via ${config.command}`;
  const prompt =
    config.prompt ??
    [
      `You are the ${name} ACP wrapper agent.`,
      '',
      'Your only job is to send the user task to the configured external ACP agent using the acp_run tool, then return the ACP agent result.',
      `Always call acp_run with agent: ${JSON.stringify(
        name,
      )} and pass the full user task as prompt.`,
      'Do not edit files yourself unless the ACP result explicitly asks you to report a local follow-up to the orchestrator.',
    ].join('\n');

  return {
    name,
    description,
    config: {
      model: config.wrapperModel ?? fallbackModel ?? DEFAULT_MODELS.oracle,
      prompt,
      permission: {
        read: 'deny',
        edit: 'deny',
        bash: 'deny',
        task: 'deny',
        glob: 'deny',
        grep: 'deny',
        list: 'deny',
        webfetch: 'deny',
        question: 'deny',
        skill: 'deny',
        acp_run: 'allow',
      },
    },
  } as AgentDefinition;
}

function isSafeDisplayName(displayName: string): boolean {
  return SAFE_AGENT_ALIAS_RE.test(displayName);
}

// Agent Configuration Helpers

/**
 * Apply user-provided overrides to an agent's configuration.
 * Supports overriding model (string or priority array), variant, and temperature.
 * When model is an array, stores it as _modelArray for runtime fallback resolution
 * and selects its primary entry for ephemeral subagents. The orchestrator leaves
 * config.model unset so its live runtime selection is not overwritten.
 */
function applyOverrides(
  agent: AgentDefinition,
  override: AgentOverrideConfig,
): void {
  if (override.model) {
    if (Array.isArray(override.model)) {
      agent._modelArray = override.model.map((m) =>
        typeof m === 'string' ? { id: m } : m,
      );
      const primaryModel = agent._modelArray[0];
      // Subagents are ephemeral, freshly-created sessions with no prior
      // runtime state to preserve, so giving them a concrete config.model
      // at launch time (the array's primary entry) is safe — see #9100e59.
      // ForegroundFallbackManager handles runtime failover to the
      // remaining entries in _modelArray.
      //
      // The orchestrator is different: it's a long-lived, foreground
      // session where a user's runtime `/model` selection must survive
      // across plugin re-inits (triggered by client.config.update() ->
      // Instance.dispose(), e.g. on every subagent dispatch). Setting
      // config.model here unconditionally would stomp that live
      // selection every time this function re-runs, because it runs
      // BEFORE the config() hook's merge with the live
      // opencodeConfig.agent.orchestrator.model (see src/index.ts:524-528,
      // added by #639). Leaving it undefined for the orchestrator lets
      // that later, precedence-aware guard be the sole source of truth.
      agent.config.model =
        agent.name === 'orchestrator' ? undefined : primaryModel.id;
      // Subagents launch with the primary model, so carry its inline variant
      // into the OpenCode config too. An explicit agent-level variant below
      // intentionally takes precedence.
      if (
        agent.name !== 'orchestrator' &&
        override.variant === undefined &&
        primaryModel.variant !== undefined
      ) {
        agent.config.variant = primaryModel.variant;
      }
    } else {
      agent.config.model = override.model;
    }
  }
  if (override.variant) agent.config.variant = override.variant;
  if (override.temperature !== undefined)
    agent.config.temperature = override.temperature;
  if (override.options) {
    agent.config.options = {
      ...agent.config.options,
      ...override.options,
    };
  }
  if (override.displayName) {
    agent.displayName = override.displayName;
  }
  if (override.description) {
    agent.description = override.description;
  }
  if (override.permission) {
    agent.config.permission = override.permission;
  }
}

function isKnownAgentName(name: string): boolean {
  return (ALL_AGENT_NAMES as readonly string[]).includes(name);
}

function normalizeCustomAgentName(name: string): string {
  return name.trim();
}

function isSafeCustomAgentName(name: string): boolean {
  return SAFE_AGENT_ALIAS_RE.test(name) && !isKnownAgentName(name);
}

function hasCustomAgentModel(
  override: AgentOverrideConfig | undefined,
): override is AgentOverrideConfig & {
  model: NonNullable<AgentOverrideConfig['model']>;
} {
  if (!override?.model) {
    return false;
  }

  return !Array.isArray(override.model) || override.model.length > 0;
}

function buildCustomAgentDefinition(
  name: string,
  override: AgentOverrideConfig,
  filePrompt?: string,
  fileAppendPrompt?: string,
): AgentDefinition {
  const defaultPrompt = appendTaskRejectionInstruction(
    `You are the ${name} specialist.`,
  );
  const primaryModel = getPrimaryModelFromOverride(override);
  const description = override.description ?? `Custom subagent '${name}'`;

  return {
    name,
    description,
    config: {
      model: primaryModel ?? DEFAULT_MODELS.oracle,
      prompt: resolvePrompt(
        name,
        override.prompt,
        filePrompt,
        defaultPrompt,
        fileAppendPrompt,
      ),
    },
  } as AgentDefinition;
}

function injectDisplayNames(
  orchestrator: AgentDefinition,
  nameMap: Map<string, string>,
): void {
  if (nameMap.size === 0) return;
  let prompt = orchestrator.config.prompt;
  if (!prompt) return;

  for (const [internalName, displayName] of nameMap) {
    prompt = prompt.replace(
      new RegExp(`@${escapeRegExp(internalName)}\\b`, 'g'),
      `@${normalizeAgentName(displayName)}`,
    );
  }

  orchestrator.config.prompt = prompt;
}

/**
 * Apply default permissions to an agent.
 * Sets 'question' permission to 'allow' and includes skill permission presets.
 * If configuredSkills is provided, it honors that list instead of defaults.
 *
 * Note: If the agent already explicitly sets question to 'deny', that is
 * respected (e.g. councillor should not ask questions).
 */
function applyDefaultPermissions(
  agent: AgentDefinition,
  configuredSkills?: readonly string[],
  disabledSkills?: readonly string[],
): void {
  // If the user supplied a shorthand string permission (e.g. "ask"),
  // it already applies to all tools — preserve it as-is and skip the
  // object merge, which would corrupt it by spreading the string.
  if (typeof agent.config.permission === 'string') {
    return;
  }

  const existing = (agent.config.permission ?? {}) as Record<
    string,
    'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>
  >;

  // Get skill-specific permissions for this agent
  const skillPermissions = getSkillPermissionsForAgent(
    agent.name,
    configuredSkills,
    disabledSkills,
  );

  // Respect explicit deny on question (councillor)
  const questionPerm = existing.question === 'deny' ? 'deny' : 'allow';
  const taskControlPermissions = Object.fromEntries(
    TASK_CONTROL_TOOL_NAMES.map((toolName) => [
      toolName,
      existing[toolName] ?? (agent.name === 'orchestrator' ? 'allow' : 'deny'),
    ]),
  );
  const waitForUserPerm =
    agent.name === 'orchestrator'
      ? (existing.wait_for_user ?? 'allow')
      : 'deny';

  agent.config.permission = {
    ...existing,
    question: questionPerm,
    ...taskControlPermissions,
    wait_for_user: waitForUserPerm,
    // Apply skill permissions as nested object under 'skill' key
    skill: {
      ...(typeof existing.skill === 'object' ? existing.skill : {}),
      ...skillPermissions,
    },
  } as SDKAgentConfig['permission'];
}

// Agent Classification

export type SubagentName = (typeof SUBAGENT_NAMES)[number];

export function isSubagent(name: string): name is SubagentName {
  return (SUBAGENT_NAMES as readonly string[]).includes(name);
}

// Agent Factories

const SUBAGENT_FACTORIES: Record<SubagentName, AgentFactory> = {
  explorer: createExplorerAgent,
  librarian: createLibrarianAgent,
  oracle: createOracleAgent,
  designer: createDesignerAgent,
  fixer: createFixerAgent,
  observer: createObserverAgent,
  council: createCouncilAgent,
  councillor: createCouncillorAgent,
};

// Public API

/**
 * Create all agent definitions with optional configuration overrides.
 * Instantiates the orchestrator and all subagents, applying user config and defaults.
 *
 * @param runtime - Runtime configuration interface (plugin layer, preset-aware)
 * @returns Array of agent definitions (orchestrator first, then subagents)
 */
export function createAgents(
  runtime: RuntimeConfig,
  options?: { projectDirectory?: string },
): AgentDefinition[] {
  const mergedAgents = runtime.agents();
  const disabled = new Set(runtime.disabledAgents);
  if (!runtime.council) {
    disabled.add('council');
  }

  const primaryModel = runtime.primaryModel;

  // TEMP: If fixer has no config, inherit from librarian's model to avoid breaking
  // existing users who don't have fixer in their config yet
  const getModelForAgent = (name: SubagentName): string => {
    if (
      name === 'fixer' &&
      !getOverrideFromAgents(mergedAgents, 'fixer')?.model
    ) {
      const librarianOverride = getOverrideFromAgents(
        mergedAgents,
        'librarian',
      )?.model;
      let librarianModel: string | undefined;
      if (Array.isArray(librarianOverride)) {
        const first = librarianOverride[0];
        librarianModel = typeof first === 'string' ? first : first?.id;
      } else {
        librarianModel = librarianOverride;
      }
      return (
        librarianModel ?? primaryModel ?? (DEFAULT_MODELS.librarian as string)
      );
    }
    return primaryModel ?? (DEFAULT_MODELS[name] as string);
  };

  // 1. Gather all sub-agent definitions with custom prompts
  const protoSubAgents = (
    Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]
  )
    .filter(([name]) => !disabled.has(name))
    .map(([name, factory]) => {
      // Get base agent definition using the subagent factory with undefined prompts
      const agent = factory(getModelForAgent(name), undefined, undefined);

      const customPrompts = loadAgentPrompt(name, {
        preset: runtime.preset,
        projectDirectory: options?.projectDirectory,
      });

      const override = getOverrideFromAgents(mergedAgents, name);
      const inlinePrompt = override?.prompt;
      const defaultPrompt = appendTaskRejectionInstruction(
        agent.config.prompt ?? '',
      );

      agent.config.prompt = resolvePrompt(
        name,
        inlinePrompt,
        customPrompts.prompt,
        defaultPrompt,
        customPrompts.appendPrompt,
      );

      return agent;
    });

  // 1b. Discover unknown keys in config.agents as custom subagents.
  const customAgentNames = runtime.customAgentNames
    .map(normalizeCustomAgentName)
    .filter((name) => name.length > 0)
    .filter((name) => {
      if (!isSafeCustomAgentName(name)) {
        throw new Error(`Unsafe custom agent name '${name}'`);
      }
      if (disabled.has(name)) {
        return false;
      }
      return true;
    });

  const protoCustomAgents = customAgentNames.flatMap((name) => {
    const override = getOverrideFromAgents(mergedAgents, name);
    if (!hasCustomAgentModel(override)) {
      console.warn(
        `[oh-my-opencode] Custom agent '${name}' skipped: 'model' is required`,
      );
      return [];
    }

    const customPrompts = loadAgentPrompt(name, {
      preset: runtime.preset,
      projectDirectory: options?.projectDirectory,
    });

    return [
      buildCustomAgentDefinition(
        name,
        override,
        customPrompts.prompt,
        customPrompts.appendPrompt,
      ),
    ];
  });

  const acpAgentNames = Object.keys(runtime.acpAgents)
    .map(normalizeCustomAgentName)
    .filter((name) => name.length > 0)
    .filter((name) => {
      if (!SAFE_AGENT_ALIAS_RE.test(name)) {
        throw new Error(
          `ACP agent name '${name}' must match /^[a-z][a-z0-9_-]*$/i`,
        );
      }
      if (isKnownAgentName(name) || AGENT_ALIASES[name] !== undefined) {
        throw new Error(
          `ACP agent '${name}' conflicts with a built-in agent name or alias`,
        );
      }
      if (customAgentNames.includes(name)) {
        throw new Error(
          `ACP agent '${name}' conflicts with a custom agent of the same name`,
        );
      }
      return !disabled.has(name);
    });

  const protoAcpAgents = acpAgentNames.map((name) => {
    const acp = runtime.acpAgents[name];
    if (!acp) throw new Error(`ACP agent '${name}' is missing config`);
    return buildAcpAgentDefinition(name, acp, primaryModel);
  });

  // 2. Apply overrides and default permissions to built-in subagents
  const builtInSubAgents = protoSubAgents.map((agent) => {
    const override = getOverrideFromAgents(mergedAgents, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    applyDefaultPermissions(agent, override?.skills, runtime.disabledSkills);
    return agent;
  });

  const customSubAgents = protoCustomAgents.map((agent) => {
    const override = getOverrideFromAgents(mergedAgents, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    applyDefaultPermissions(agent, override?.skills, runtime.disabledSkills);
    return agent;
  });

  const acpSubAgents = protoAcpAgents.map((agent) => {
    applyDefaultPermissions(agent, undefined, runtime.disabledSkills);
    return agent;
  });

  // Build dynamic councillor agents from council config (flatten mode).
  // Each councillor becomes a dispatchable subagent with its own model,
  // so the orchestrator can task() them with native panes at depth 1.
  const councillorAgents = buildCouncillorAgents(runtime, disabled).map(
    (agent) => {
      applyDefaultPermissions(agent, undefined, runtime.disabledSkills);
      return agent;
    },
  );

  const allSubAgents = [
    ...builtInSubAgents,
    ...customSubAgents,
    ...acpSubAgents,
    ...councillorAgents,
  ];

  for (const agent of [...acpSubAgents, ...councillorAgents]) {
    agent.config.prompt = appendTaskRejectionInstruction(
      agent.config.prompt ?? '',
    );
  }

  // 3. Create Orchestrator (with its own overrides and custom prompts)
  // DEFAULT_MODELS.orchestrator is undefined; model is resolved via override or
  // left unset so the runtime chat.message hook can pick it from _modelArray.
  const orchestratorOverride = getOverrideFromAgents(
    mergedAgents,
    'orchestrator',
  );
  const orchestratorModel =
    orchestratorOverride?.model ?? DEFAULT_MODELS.orchestrator;
  const orchestratorPrompts = loadAgentPrompt('orchestrator', {
    preset: runtime.preset,
    projectDirectory: options?.projectDirectory,
  });
  const orchestrator = createOrchestratorAgent(
    orchestratorModel,
    undefined,
    undefined,
    disabled,
    councillorAgents.length > 0 ? ['council'] : undefined,
    !runtime.disabledTools.includes('wait_for_user'),
    runtime.backgroundJobs.orchestratorWake.enabled,
  );

  const inlineOrchestratorPrompt = orchestratorOverride?.prompt;
  const defaultOrchestratorPrompt = orchestrator.config.prompt ?? '';

  orchestrator.config.prompt = resolvePrompt(
    'orchestrator',
    inlineOrchestratorPrompt,
    orchestratorPrompts.prompt,
    defaultOrchestratorPrompt,
    orchestratorPrompts.appendPrompt,
  );

  if (orchestratorOverride) {
    applyOverrides(orchestrator, orchestratorOverride);
  }
  applyDefaultPermissions(
    orchestrator,
    orchestratorOverride?.skills,
    runtime.disabledSkills,
  );

  // Collect all display names from orchestrator and all subagents
  const displayNameMap = new Map<string, string>();
  if (orchestrator.displayName) {
    displayNameMap.set('orchestrator', orchestrator.displayName);
  }
  for (const agent of allSubAgents) {
    if (agent.displayName) {
      displayNameMap.set(agent.name, agent.displayName);
    }
  }

  // 3b. Append custom orchestrator hints from built-in and custom agent overrides.
  const extraOrchestratorPromptsList = [...builtInSubAgents, ...customSubAgents]
    .map((agent) => {
      const override = getOverrideFromAgents(mergedAgents, agent.name);
      return override?.orchestratorPrompt;
    })
    .filter((prompt): prompt is string => Boolean(prompt));

  const acpOrchestratorPrompts = acpSubAgents.map((agent) => {
    const acp = runtime.acpAgents[agent.name];
    if (acp?.orchestratorPrompt) return acp.orchestratorPrompt;
    return [
      `@${agent.name}`,
      `- Lane: External ACP-connected agent (${
        acp?.command ?? 'unknown command'
      })`,
      `- Role: ${agent.description ?? `External ACP agent ${agent.name}`}`,
      '- **Delegate when:** The user explicitly asks for this ACP-backed agent, or the task matches its role and benefits from software/subscription-specific capabilities outside OpenCode.',
      '- **Do not delegate when:** The built-in specialists can handle the task more directly or local file ownership would conflict with another writer lane.',
      '- **Result handling:** Treat returned output as external-agent work. Reconcile any reported file changes before continuing.',
    ].join('\n');
  });

  // Validate display names
  const usedDisplayNames = new Set<string>();
  for (const [, displayName] of displayNameMap) {
    const normalizedDisplayName = normalizeAgentName(displayName);
    if (!isSafeDisplayName(normalizedDisplayName)) {
      throw new Error(
        `displayName '${normalizedDisplayName}' must match /^[a-z][a-z0-9_-]*$/i`,
      );
    }
    if (usedDisplayNames.has(normalizedDisplayName)) {
      throw new Error(
        `Duplicate displayName '${normalizedDisplayName}' assigned to multiple agents`,
      );
    }
    usedDisplayNames.add(normalizedDisplayName);
  }
  for (const displayName of usedDisplayNames) {
    if (
      (ALL_AGENT_NAMES as readonly string[]).includes(displayName) ||
      customAgentNames.includes(displayName) ||
      acpAgentNames.includes(displayName)
    ) {
      throw new Error(
        `displayName '${displayName}' conflicts with an agent name`,
      );
    }
  }

  // Inject display names into orchestrator prompt (complete map)
  injectDisplayNames(orchestrator, displayNameMap);

  const rewritePrompt = (promptText: string) => {
    let text = promptText;
    for (const [internalName, displayName] of displayNameMap) {
      text = text.replace(
        new RegExp(`@${escapeRegExp(internalName)}\\b`, 'g'),
        `@${normalizeAgentName(displayName)}`,
      );
    }
    return text;
  };

  const rewrittenOverrides = extraOrchestratorPromptsList.map(rewritePrompt);
  const rewrittenAcps = acpOrchestratorPrompts.map(rewritePrompt);

  let updatedPrompt = orchestrator.config.prompt ?? '';

  if (rewrittenOverrides.length > 0) {
    updatedPrompt = `${updatedPrompt}\n\n# Project-specific routing guidance\n\n${rewrittenOverrides.join(
      '\n\n',
    )}`;
  }

  if (rewrittenAcps.length > 0) {
    updatedPrompt = `${updatedPrompt}\n\n${rewrittenAcps.join('\n\n')}`;
  }

  // Inject council-dispatch block if dynamic councillors exist (flatten mode)
  if (councillorAgents.length > 0) {
    const dispatchList = councillorAgents
      .map(
        (a: AgentDefinition) =>
          `   - task(subagent_type='${a.name}', description='Councillor ${getCouncillorSeatName(a.name)} on <brief topic>', prompt=<user's question>)`,
      )
      .join('\n');
    updatedPrompt = `${updatedPrompt}\n\n## Council Mode\n\nWhen you need to run a council or the user asks for consensus/multiple opinions, use this procedure INSTEAD of delegating to @council:\n\n1. If the question references an external resource (PR, URL, issue, doc), fetch its content FIRST using your own tools (webfetch/bash/gh), then embed a concise summary in the prompt you send to each councillor — councillors have read-only codebase access only and cannot fetch external content themselves.\n2. Dispatch the user's question (with any fetched context) to each councillor in PARALLEL via task():\n${dispatchList}\n3. Collect ALL councillor responses. If any councillor returns empty or does not respond within 3 minutes, proceed without it — do not wait indefinitely. If a councillor's response is empty, retry that councillor once before continuing.\n4. Call task(subagent_type='council', description='Synthesize council report') with a prompt that includes the original user question AND all councillor responses. For each councillor, label its response with its seat name AND its model (e.g. "alpha (gpt-5.6-luna)"). Format each councillor's seat name and response clearly separated. If a councillor failed or timed out, include that status explicitly (e.g. "beta (gemini-3-pro): FAILED/TIMED OUT") instead of omitting it. Skip only councillors that returned empty after one retry.\n5. Present the council's synthesized report.\n\nThis ensures each councillor runs with its own model and the council agent synthesizes the full multi-model consensus.`;
  }

  orchestrator.config.prompt = updatedPrompt;

  return [orchestrator, ...allSubAgents];
}

/**
 * Get agent configurations formatted for the OpenCode SDK.
 * Converts agent definitions to SDK config format and applies classification metadata.
 *
 * @param runtime - Runtime configuration interface (plugin layer, preset-aware)
 * @param options - Optional options including projectDirectory
 * @returns Record mapping agent names to their SDK configurations
 */
export function getAgentConfigs(
  runtime: RuntimeConfig,
  options?: { projectDirectory?: string },
): Record<string, SDKAgentConfig> {
  const agents = createAgents(runtime, options);

  const applyClassification = (
    name: string,
    sdkConfig: SDKAgentConfig & {
      mcps?: string[];
      displayName?: string;
      hidden?: boolean;
    },
  ): void => {
    if (name === 'council') {
      // Council is callable both as a primary agent (user-facing)
      // and as a subagent (orchestrator can delegate to it)
      sdkConfig.mode = 'all';
    } else if (name === 'councillor' || name.startsWith('councillor-')) {
      // Internal agent - subagent mode, hidden from @ autocomplete.
      // Dynamic councillors are named councillor-<seat> (see council-agents.ts).
      sdkConfig.mode = 'subagent';
      sdkConfig.hidden = true;
    } else if (isSubagent(name)) {
      sdkConfig.mode = 'subagent';
    } else if (name === 'orchestrator') {
      sdkConfig.mode = 'primary';
    } else {
      sdkConfig.mode = 'subagent';
    }
  };

  const isInternalOnly = (name: string): boolean =>
    name === 'councillor' || name.startsWith('councillor-');

  const entries: Array<[string, SDKAgentConfig]> = [];

  for (const a of agents) {
    const sdkConfig: SDKAgentConfig & {
      mcps?: string[];
      displayName?: string;
      hidden?: boolean;
    } = {
      ...a.config,
      description: a.description,
      mcps: getAgentMcpList(a.name, runtime),
    };

    if (a.displayName) {
      sdkConfig.displayName = a.displayName;
    }

    applyClassification(a.name, sdkConfig);

    const normalizedDisplayName = a.displayName
      ? normalizeAgentName(a.displayName)
      : undefined;

    if (normalizedDisplayName && !isInternalOnly(a.name)) {
      entries.push([normalizedDisplayName, sdkConfig]);
      entries.push([a.name, { ...sdkConfig, hidden: true }]);
      continue;
    }

    entries.push([a.name, sdkConfig]);
  }

  return Object.fromEntries(entries);
}

/**
 * Get the set of disabled agent names from config, applying protection rules.
 */
export function getDisabledAgents(config?: PluginConfig): Set<string> {
  const userDisabled = config?.disabled_agents;
  const disabledSource = Array.isArray(userDisabled)
    ? userDisabled
    : DEFAULT_DISABLED_AGENTS;
  const disabled = new Set<string>();
  for (const name of disabledSource) {
    if (!PROTECTED_AGENTS.has(name)) {
      disabled.add(name);
    }
  }
  return disabled;
}
