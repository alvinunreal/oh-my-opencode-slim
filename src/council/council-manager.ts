/**
 * Council Manager
 *
 * Orchestrates multi-LLM council sessions: launches councillors in
 * parallel and collects their results for the council agent to synthesize.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import {
  formatCouncillorPrompt,
  formatCouncillorResults,
} from '../agents/council';
import type { PluginConfig } from '../config';
import {
  COUNCILLOR_STAGGER_MS,
  TMUX_SPAWN_DELAY_MS,
} from '../config/constants';
import type { CouncillorConfig, CouncilResult } from '../config/council-schema';
import { log } from '../utils/logger';
import {
  extractSessionResult,
  type PromptBody,
  parseModelReference,
  promptWithTimeout,
  shortModelLabel,
} from '../utils/session';
import type { SubagentDepthTracker } from '../utils/subagent-depth';

type OpencodeClient = PluginInput['client'];

// ---------------------------------------------------------------------------
// CouncilManager
// ---------------------------------------------------------------------------

export class CouncilManager {
  private client: OpencodeClient;
  private directory: string;
  private config?: PluginConfig;
  private depthTracker?: SubagentDepthTracker;
  private tmuxEnabled: boolean;
  private deprecatedFields?: string[];
  private legacyMasterModel?: string;

  constructor(
    ctx: PluginInput,
    config?: PluginConfig,
    depthTracker?: SubagentDepthTracker,
    tmuxEnabled = false,
  ) {
    this.client = ctx.client;
    this.directory = ctx.directory;
    this.config = config;
    this.deprecatedFields = config?.council?._deprecated;
    this.legacyMasterModel = config?.council?._legacyMasterModel;
    this.depthTracker = depthTracker;
    this.tmuxEnabled = tmuxEnabled;
  }

  /** Return deprecated config fields detected during parsing (for tool warnings). */
  getDeprecatedFields(): string[] | undefined {
    return this.deprecatedFields;
  }

  /** Return the legacy master.model if it was used as fallback. */
  getLegacyMasterModel(): string | undefined {
    return this.legacyMasterModel;
  }

  /**
   * Run a full council session.
   *
   * 1. Look up the preset
   * 2. Launch all councillors in parallel
   * 3. Collect results (respecting timeout)
   * 4. Return formatted councillor results for synthesis
   */
  async runCouncil(
    prompt: string,
    presetName: string | undefined,
    parentSessionId: string,
  ): Promise<CouncilResult> {
    // Check depth limit before starting councillors
    if (this.depthTracker) {
      const parentDepth = this.depthTracker.getDepth(parentSessionId);
      if (parentDepth + 1 > this.depthTracker.maxDepth) {
        log('[council-manager] spawn blocked: max depth exceeded', {
          parentSessionId,
          parentDepth,
          maxDepth: this.depthTracker.maxDepth,
        });
        return {
          success: false,
          error: 'Subagent depth exceeded',
          councillorResults: [],
        };
      }
    }

    const councilConfig = this.config?.council;
    if (!councilConfig) {
      log('[council-manager] Council configuration not found');
      return {
        success: false,
        error: 'Council not configured',
        councillorResults: [],
      };
    }

    const resolvedPreset =
      presetName ?? councilConfig.default_preset ?? 'default';
    const preset = councilConfig.presets[resolvedPreset];

    if (!preset) {
      const available = Object.keys(councilConfig.presets).join(', ');
      log(`[council-manager] Preset "${resolvedPreset}" not found`);
      return {
        success: false,
        error: `Preset "${resolvedPreset}" does not exist. Omit the preset parameter to use the default, or call again with one of: ${available}`,
        councillorResults: [],
      };
    }

    if (Object.keys(preset).length === 0) {
      log(`[council-manager] Preset "${resolvedPreset}" has no councillors`);
      return {
        success: false,
        error: `Preset "${resolvedPreset}" has no councillors configured. Note: the reserved key "master" is ignored — use councillor names as keys`,
        councillorResults: [],
      };
    }

    const timeout = councilConfig.timeout ?? 180000;
    const executionMode = councilConfig.councillor_execution_mode ?? 'parallel';
    const maxRetries = councilConfig.councillor_retries ?? 3;

    const councillorCount = Object.keys(preset).length;

    log(`[council-manager] Starting council with preset "${resolvedPreset}"`, {
      councillors: Object.keys(preset),
    });

    // Notify parent session that council is starting
    this.sendStartNotification(parentSessionId, councillorCount).catch(
      (err) => {
        log('[council-manager] Failed to send start notification', {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );

    // Run councillors (parallel or serial based on config)
    const councillorResults = await this.runCouncillors(
      prompt,
      preset,
      parentSessionId,
      timeout,
      executionMode,
      maxRetries,
    );

    const completedCount = councillorResults.filter(
      (r) => r.status === 'completed',
    ).length;

    log(
      `[council-manager] Councillors completed: ${completedCount}/${councillorResults.length}`,
    );

    if (completedCount === 0) {
      return {
        success: false,
        error: 'All councillors failed or timed out',
        councillorResults,
      };
    }

    // Format councillor results for the council agent to synthesize
    const formattedCouncillorResults = formatCouncillorResults(
      prompt,
      councillorResults,
    );

    log('[council-manager] Council completed successfully');

    return {
      success: true,
      result: formattedCouncillorResults,
      councillorResults,
    };
  }

  // -------------------------------------------------------------------------
  // Parent session notification
  // -------------------------------------------------------------------------

  /**
   * Inject a start notification into the parent session so the user
   * sees immediate feedback while councillors are spinning up.
   */
  private async sendStartNotification(
    parentSessionId: string,
    councillorCount: number,
  ): Promise<void> {
    const message = [
      `⎔ Council starting — ${councillorCount} councillors launching — ctrl+x ↓ to watch`,
      '',
      '[system status: continue without acknowledging this notification]',
    ].join('\n');
    await this.client.session.prompt({
      path: { id: parentSessionId },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: message }],
      },
    });
  }

  // -------------------------------------------------------------------------
  // Shared session lifecycle
  // -------------------------------------------------------------------------

  /**
   * Run a single agent session: create → register → prompt → extract → cleanup.
   */
  private async runAgentSession(options: {
    parentSessionId: string;
    title: string;
    agent: string;
    model: string;
    promptText: string;
    variant?: string;
    timeout: number;
    includeReasoning?: boolean;
  }): Promise<string> {
    const modelRef = parseModelReference(options.model);
    if (!modelRef) {
      throw new Error(`Invalid model format: ${options.model}`);
    }

    let sessionId: string | undefined;

    try {
      const session = await this.client.session.create({
        body: {
          parentID: options.parentSessionId,
          title: options.title,
        },
        query: { directory: this.directory },
      });

      if (!session.data?.id) {
        throw new Error('Failed to create session');
      }

      sessionId = session.data.id;

      if (this.depthTracker) {
        const registered = this.depthTracker.registerChild(
          options.parentSessionId,
          sessionId,
        );
        if (!registered) {
          throw new Error('Subagent depth exceeded');
        }
      }

      if (this.tmuxEnabled) {
        await new Promise((r) => setTimeout(r, TMUX_SPAWN_DELAY_MS));
      }

      const body: PromptBody = {
        agent: options.agent,
        model: modelRef,
        tools: { task: false },
        parts: [{ type: 'text', text: options.promptText }],
      };

      if (options.variant) {
        body.variant = options.variant;
      }

      await promptWithTimeout(
        this.client,
        {
          path: { id: sessionId },
          body,
          query: { directory: this.directory },
        },
        options.timeout,
      );

      const extraction = await extractSessionResult(this.client, sessionId, {
        includeReasoning: options.includeReasoning,
      });

      if (extraction.empty) {
        const retryOnEmpty = this.config?.fallback?.retry_on_empty ?? true;
        if (retryOnEmpty) {
          throw new Error('Empty response from provider');
        }
      }

      return extraction.text;
    } finally {
      if (sessionId) {
        this.client.session.abort({ path: { id: sessionId } }).catch(() => {});
        if (this.depthTracker) {
          this.depthTracker.cleanup(sessionId);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1: Councillors
  // -------------------------------------------------------------------------

  private async runCouncillors(
    prompt: string,
    councillors: Record<string, CouncillorConfig>,
    parentSessionId: string,
    timeout: number,
    executionMode: 'parallel' | 'serial' = 'parallel',
    maxRetries: number,
  ): Promise<CouncilResult['councillorResults']> {
    const entries = Object.entries(councillors);
    const results: Array<{
      name: string;
      model: string;
      status: 'completed' | 'failed' | 'timed_out';
      result?: string;
      error?: string;
    }> = [];

    if (executionMode === 'serial') {
      // Serial execution: run each councillor one at a time
      for (const [name, config] of entries) {
        results.push(
          await this.runCouncillorWithRetry(
            name,
            config,
            prompt,
            parentSessionId,
            timeout,
            maxRetries,
          ),
        );
      }
    } else {
      // Parallel execution (default): run all councillors concurrently
      const promises = entries.map(([name, config], index) =>
        (async () => {
          // Stagger launches to avoid tmux split-window collisions
          if (index > 0) {
            await new Promise((r) =>
              setTimeout(r, index * COUNCILLOR_STAGGER_MS),
            );
          }

          return this.runCouncillorWithRetry(
            name,
            config,
            prompt,
            parentSessionId,
            timeout,
            maxRetries,
          );
        })(),
      );

      const settled = await Promise.allSettled(promises);

      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        const [name, cfg] = entries[index];

        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            name,
            model: cfg.model,
            status: 'failed' as const,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
        }
      }
    }

    return results;
  }

  /**
   * Run a single councillor with retry logic for empty responses.
   * Only retries on "Empty response from provider" errors — timeouts
   * and other failures are returned immediately.
   */
  private async runCouncillorWithRetry(
    name: string,
    config: CouncillorConfig,
    prompt: string,
    parentSessionId: string,
    timeout: number,
    maxRetries: number,
  ): Promise<{
    name: string;
    model: string;
    status: 'completed' | 'failed' | 'timed_out';
    result?: string;
    error?: string;
  }> {
    const modelLabel = shortModelLabel(config.model);
    const totalAttempts = 1 + maxRetries;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (attempt > 1) {
        log(
          `[council-manager] Retrying councillor "${name}" (${modelLabel}), attempt ${attempt}/${totalAttempts}`,
        );
      }

      try {
        const result = await this.runAgentSession({
          parentSessionId,
          title: `Council ${name} (${modelLabel})`,
          agent: 'councillor',
          model: config.model,
          promptText: formatCouncillorPrompt(prompt, config.prompt),
          variant: config.variant,
          timeout,
          includeReasoning: false,
        });

        return {
          name,
          model: config.model,
          status: 'completed' as const,
          result,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);

        // Only retry on empty responses (provider silently rate-limited)
        const isEmptyResponse = msg.includes('Empty response from provider');
        const canRetry = attempt < totalAttempts && isEmptyResponse;

        if (!canRetry) {
          return {
            name,
            model: config.model,
            status: msg.includes('timed out')
              ? ('timed_out' as const)
              : ('failed' as const),
            error: `Councillor "${name}": ${msg}`,
          };
        }
      }
    }

    // Unreachable, but satisfies TypeScript
    return {
      name,
      model: config.model,
      status: 'failed' as const,
      error: `Councillor "${name}": max retries exhausted`,
    };
  }
}
