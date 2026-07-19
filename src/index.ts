import type { Plugin } from '@opencode-ai/plugin';
import { createAgents, getAgentConfigs, getDisabledAgents } from './agents';
import { buildOrchestratorPrompt } from './agents/orchestrator';
import { CompanionManager } from './companion/manager';
import { ensureCompanionVersion } from './companion/updater';
import {
  type AgentOverrideConfig,
  deepMerge,
  loadPluginConfig,
  type MultiplexerConfig,
} from './config';
import { parseList } from './config/agent-mcps';
import {
  AGENT_ALIASES,
  DEFAULT_MAX_SESSIONS_PER_AGENT,
  DEFAULT_READ_CONTEXT_MAX_FILES,
  DEFAULT_READ_CONTEXT_MIN_LINES,
  resolveImageRouting,
} from './config/constants';
import {
  getActiveRuntimePreset,
  getPreviousRuntimePreset,
  setActiveRuntimePreset,
} from './config/runtime-preset';
import { applyOrchestratorModelConfig } from './config/strip-orchestrator-model';
import {
  createApplyPatchHook,
  createAutoUpdateCheckerHook,
  createCacheMonitorHook,
  createChatHeadersHook,
  createDeepworkCommandHook,
  createDelegateTaskRetryHook,
  createFilterAvailableSkillsHook,
  createJsonErrorRecoveryHook,
  createLoopCommandHook,
  createPhaseReminderHook,
  createPostFileToolNudgeHook,
  createReflectCommandHook,
  createTaskSessionManagerHook,
  ForegroundFallbackManager,
  SessionLifecycle,
} from './hooks';
import { createHookRegistry } from './hooks/hook-registry';
import { processImageAttachments } from './hooks/image-hook';
import { isMessageWithParts } from './hooks/types';
import { handleTaskSessionEvent } from './index-event';
import { createInterviewManager } from './interview';
import { createBuiltinMcps } from './mcp';
import {
  getMultiplexer,
  MultiplexerSessionManager,
  startAvailabilityCheck,
} from './multiplexer';
import { createPluginComposer } from './plugin-composer';
import {
  ast_grep_replace,
  ast_grep_search,
  createAcpRunTool,
  createCancelTaskTool,
  createPresetManager,
  createWebfetchTool,
} from './tools';
import { recordTuiAgentModel, recordTuiAgentModels } from './tui-state';
import {
  BackgroundJobBoard,
  BackgroundJobCoordinator,
  createDisplayNameMentionRewriter,
  resolveRuntimeAgentName,
} from './utils';
import { isPluginDisabledByEnv } from './utils/env';
import { initLogger, log } from './utils/logger';
import { appLog, HEALTH_CHECK, probeJSDOM } from './utils/plugin-init';
import { collapseSystemInPlace } from './utils/system-collapse';

const composer = createPluginComposer({
  agentFactory: createAgents,
  getAgentConfigs,
  getDisabledAgents,
  buildOrchestratorPrompt,
  applyOrchestratorModelConfig,
  agentDefsGetter: createAgents,
  hookRegistry: createHookRegistry(),
  createCancelTaskTool,
  createAcpRunTool,
  createWebfetchTool,
  astGrepSearch: ast_grep_search,
  astGrepReplace: ast_grep_replace,
  getMultiplexer,
  MultiplexerSessionManager,
  startAvailabilityCheck,
  BackgroundJobBoard,
  BackgroundJobCoordinator,
  SessionLifecycle,
  createInterviewManager,
  createPresetManager,
  CompanionManager,
  ensureCompanionVersion,
  loadPluginConfig,
  deepMerge,
  parseList,
  resolveImageRouting,
  AGENT_ALIASES,
  DEFAULT_MAX_SESSIONS_PER_AGENT,
  DEFAULT_READ_CONTEXT_MIN_LINES,
  DEFAULT_READ_CONTEXT_MAX_FILES,
  createAutoUpdateCheckerHook,
  createCacheMonitorHook,
  createChatHeadersHook,
  createDeepworkCommandHook,
  createReflectCommandHook,
  createLoopCommandHook,
  createTaskSessionManagerHook,
  createPhaseReminderHook,
  createFilterAvailableSkillsHook,
  createPostFileToolNudgeHook,
  createDelegateTaskRetryHook,
  createApplyPatchHook,
  createJsonErrorRecoveryHook,
  createDisplayNameMentionRewriter,
  processImageAttachments,
  isMessageWithParts,
  handleTaskSessionEvent,
  recordTuiAgentModel,
  recordTuiAgentModels,
  resolveRuntimeAgentName,
  collapseSystemInPlace,
  getActiveRuntimePreset,
  getPreviousRuntimePreset,
  setActiveRuntimePreset,
  ForegroundFallbackManager,
  isPluginDisabledByEnv,
  initLogger,
  log,
  appLog,
  probeJSDOM,
  HEALTH_CHECK,
  createBuiltinMcps,
});

export default async (ctx: Parameters<Plugin>[0]) => composer.compose(ctx);

export type {
  AgentName,
  AgentOverrideConfig,
  McpName,
  MultiplexerConfig,
  MultiplexerLayout,
  MultiplexerType,
  PluginConfig,
} from './config';
export type { RemoteMcpConfig } from './mcp';
