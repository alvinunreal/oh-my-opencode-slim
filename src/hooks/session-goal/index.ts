import * as fs from 'node:fs/promises';
import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginConfig } from '../../config';
import {
  extractSummarySection,
  extractTitle,
  resolveExistingInterviewPath,
} from '../../interview/document';
import { createInternalAgentTextPart } from '../../utils';

const COMMAND_NAME = 'goal';
const MAX_GOAL_LENGTH = 4000;

interface GoalState {
  text: string;
  source?: 'manual' | 'interview';
  sourcePath?: string;
  inheritedFrom?: string;
  createdAt: number;
}

interface StoredGoalState extends GoalState {
  inheritedFrom?: string;
}

interface SystemTransformOutput {
  system: string[];
}

function normalizeGoalText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, MAX_GOAL_LENGTH);
}

function pushText(
  output: { parts: Array<{ type: string; text?: string }> },
  text: string,
) {
  output.parts.push(createInternalAgentTextPart(text));
}

function formatGoal(state: GoalState, inherited: boolean): string {
  const tag = inherited ? 'parent_goal' : 'active_goal';
  const guidance = inherited
    ? 'This is context only. Your delegated prompt remains the bounded task.'
    : 'Use todos as the execution ledger. Keep planning, delegation, edits, and verification aligned to this goal. Do not broaden scope unless the user changes the goal.';
  return `<${tag}>\nObjective: ${state.text}\n${guidance}\n</${tag}>`;
}

async function readInterviewGoal(
  directory: string,
  outputFolder: string,
  value: string,
): Promise<{ text: string; sourcePath: string } | null> {
  try {
    const sourcePath = resolveExistingInterviewPath(
      directory,
      outputFolder,
      value,
    );
    if (!sourcePath) return null;

    const content = await fs.readFile(sourcePath, 'utf8');
    const title = extractTitle(content);
    const summary = extractSummarySection(content);
    const text = normalizeGoalText(
      [title ? `From interview: ${title}` : '', summary]
        .filter(Boolean)
        .join('\n\n'),
    );
    return text ? { text, sourcePath } : null;
  } catch {
    return null;
  }
}

function resolveGoal(
  goals: Map<string, StoredGoalState>,
  sessionID: string,
): { goal: GoalState; inherited: boolean } | null {
  const goal = goals.get(sessionID);
  if (!goal) return null;
  if (!goal.inheritedFrom) return { goal, inherited: false };

  const parentGoal = goals.get(goal.inheritedFrom);
  if (!parentGoal) {
    goals.delete(sessionID);
    return null;
  }
  return { goal: parentGoal, inherited: true };
}

export function createSessionGoalHook(
  ctx: PluginInput,
  config: PluginConfig,
  options?: { getAgentName?: (sessionID: string) => string | undefined },
): {
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => void;
  handleSystemTransform: (
    input: { sessionID?: string },
    output: SystemTransformOutput,
  ) => void;
  getGoal: (sessionID: string) => GoalState | undefined;
} {
  const goals = new Map<string, StoredGoalState>();
  const outputFolder = config.interview?.outputFolder ?? 'interview';

  return {
    registerCommand: (opencodeConfig) => {
      const commandConfig = opencodeConfig.command as
        | Record<string, unknown>
        | undefined;
      if (commandConfig?.[COMMAND_NAME]) return;
      if (!opencodeConfig.command) opencodeConfig.command = {};
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        template: 'Set or show the current session goal',
        description:
          'Pin a session objective that keeps todos, delegation, and verification aligned',
      };
    },

    handleCommandExecuteBefore: async (input, output) => {
      if (input.command !== COMMAND_NAME) return;

      output.parts.length = 0;

      const args = input.arguments.trim();
      if (!args) {
        const resolved = resolveGoal(goals, input.sessionID);
        pushText(
          output,
          resolved
            ? `Active goal:\n${resolved.goal.text}\n\nUse todos for execution steps. Auto-continuation continues only while todos remain.`
            : 'No active goal. Set one with /goal <objective>.',
        );
        return;
      }

      if (args === 'clear') {
        goals.delete(input.sessionID);
        pushText(output, 'Cleared the active goal for this session.');
        return;
      }

      if (args.startsWith('from ')) {
        const value = args.slice('from '.length).trim();
        const interviewGoal = await readInterviewGoal(
          ctx.directory,
          outputFolder,
          value,
        );
        if (!interviewGoal) {
          pushText(
            output,
            `Could not find a readable interview spec for "${value}".`,
          );
          return;
        }
        goals.set(input.sessionID, {
          text: interviewGoal.text,
          source: 'interview',
          sourcePath: interviewGoal.sourcePath,
          createdAt: Date.now(),
        });
        pushText(
          output,
          `Set active goal from interview:\n${interviewGoal.text}`,
        );
        return;
      }

      const text = normalizeGoalText(args);
      goals.set(input.sessionID, {
        text,
        source: 'manual',
        createdAt: Date.now(),
      });
      pushText(output, `Set active goal:\n${text}`);
    },

    handleEvent: (input) => {
      const event = input.event;
      if (event.type === 'session.created') {
        const info = event.properties?.info as
          | { id?: string; parentID?: string }
          | undefined;
        if (!info?.id || !info.parentID) return;
        const parentGoal = goals.get(info.parentID);
        if (!parentGoal) return;
        goals.set(info.id, {
          inheritedFrom: info.parentID,
          createdAt: Date.now(),
          text: '',
        });
        return;
      }

      if (event.type === 'session.deleted') {
        const props = event.properties as
          | { info?: { id?: string }; sessionID?: string }
          | undefined;
        const sessionID = props?.info?.id ?? props?.sessionID;
        if (sessionID) goals.delete(sessionID);
      }
    },

    handleSystemTransform: (input, output) => {
      if (!input.sessionID) return;
      const resolved = resolveGoal(goals, input.sessionID);
      if (!resolved) return;

      const agentName = options?.getAgentName?.(input.sessionID);
      const { goal, inherited } = resolved;
      if (!inherited && agentName && agentName !== 'orchestrator') return;

      const block = formatGoal(goal, inherited);
      if (output.system.some((entry) => entry.includes(block))) return;
      output.system.push(block);
    },

    getGoal: (sessionID) => resolveGoal(goals, sessionID)?.goal,
  };
}
