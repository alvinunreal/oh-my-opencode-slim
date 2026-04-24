import type { AgentName } from '../config';

export interface ContextFile {
  path: string;
  lineCount: number;
  lastReadAt: number;
}

export interface RememberedTaskSession {
  alias: string;
  taskId: string;
  agentType: AgentName;
  label: string;
  contextFiles: ContextFile[];
  createdAt: number;
  lastUsedAt: number;
}

type SessionGroupMap = Map<AgentName, RememberedTaskSession[]>;

const MIN_CONTEXT_FILE_LINES = 10;
const MAX_CONTEXT_FILES_PER_SESSION = 8;

function aliasPrefix(agentType: AgentName): string {
  switch (agentType) {
    case 'explorer':
      return 'exp';
    case 'librarian':
      return 'lib';
    case 'oracle':
      return 'ora';
    case 'designer':
      return 'des';
    case 'fixer':
      return 'fix';
    case 'observer':
      return 'obs';
    case 'council':
      return 'cnc';
    case 'councillor':
      return 'clr';
    case 'orchestrator':
      return 'orc';
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function deriveTaskSessionLabel(input: {
  description?: string;
  prompt?: string;
  agentType: AgentName;
}): string {
  const preferred = normalizeWhitespace(input.description ?? '');
  if (preferred) {
    return preferred.slice(0, 48);
  }

  const firstPromptLine = (input.prompt ?? '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);

  if (firstPromptLine) {
    return firstPromptLine.slice(0, 48);
  }

  return `recent ${input.agentType} task`;
}

export class SessionManager {
  private readonly maxSessionsPerAgent: number;
  private readonly sessionsByParent = new Map<string, SessionGroupMap>();
  private readonly nextAliasIndexByParent = new Map<
    string,
    Map<AgentName, number>
  >();
  private orderCounter = 0;

  constructor(maxSessionsPerAgent: number) {
    this.maxSessionsPerAgent = maxSessionsPerAgent;
  }

  remember(input: {
    parentSessionId: string;
    taskId: string;
    agentType: AgentName;
    label: string;
  }): RememberedTaskSession {
    const now = this.nextOrder();
    const group = this.getAgentGroup(
      input.parentSessionId,
      input.agentType,
      true,
    );
    if (!group) {
      throw new Error('Failed to initialize session group');
    }
    const existing = group.find((entry) => entry.taskId === input.taskId);

    if (existing) {
      existing.label = input.label;
      existing.lastUsedAt = this.nextOrder();
      return existing;
    }

    const remembered: RememberedTaskSession = {
      alias: this.nextAlias(input.parentSessionId, input.agentType),
      taskId: input.taskId,
      agentType: input.agentType,
      label: input.label,
      contextFiles: [],
      createdAt: now,
      lastUsedAt: now,
    };

    group.push(remembered);
    this.trimGroup(group);
    return remembered;
  }

  markUsed(parentSessionId: string, agentType: AgentName, key: string): void {
    const group = this.getAgentGroup(parentSessionId, agentType, false);
    const match = group?.find(
      (entry) => entry.alias === key || entry.taskId === key,
    );

    if (match) {
      match.lastUsedAt = this.nextOrder();
    }
  }

  resolve(parentSessionId: string, agentType: AgentName, key: string) {
    const group = this.getAgentGroup(parentSessionId, agentType, false);
    return group?.find((entry) => entry.alias === key || entry.taskId === key);
  }

  drop(parentSessionId: string, agentType: AgentName, key: string): void {
    const group = this.getAgentGroup(parentSessionId, agentType, false);
    if (!group) return;

    const next = group.filter(
      (entry) => entry.alias !== key && entry.taskId !== key,
    );
    this.setAgentGroup(parentSessionId, agentType, next);
  }

  dropTask(taskId: string): void {
    for (const [parentSessionId, groups] of this.sessionsByParent.entries()) {
      for (const [agentType, group] of groups.entries()) {
        const next = group.filter((entry) => entry.taskId !== taskId);
        this.setAgentGroup(parentSessionId, agentType, next);
      }
    }
  }

  addContext(taskId: string, files: ContextFile[]): void {
    if (files.length === 0) return;

    for (const groups of this.sessionsByParent.values()) {
      for (const group of groups.values()) {
        const match = group.find((entry) => entry.taskId === taskId);
        if (!match) continue;

        const existing = new Map(
          match.contextFiles.map((file) => [file.path, file]),
        );
        for (const file of files) {
          const previous = existing.get(file.path);
          if (previous) {
            previous.lineCount = Math.max(previous.lineCount, file.lineCount);
            previous.lastReadAt = Math.max(
              previous.lastReadAt,
              file.lastReadAt,
            );
            continue;
          }
          match.contextFiles.push({ ...file });
        }
      }
    }
  }

  clearParent(parentSessionId: string): void {
    this.sessionsByParent.delete(parentSessionId);
    this.nextAliasIndexByParent.delete(parentSessionId);
  }

  formatForPrompt(parentSessionId: string): string | undefined {
    const groups = this.sessionsByParent.get(parentSessionId);
    if (!groups || groups.size === 0) return undefined;

    const lines = [...groups.entries()]
      .map(
        ([agentType, entries]) =>
          [
            agentType,
            [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
          ] as const,
      )
      .filter(([, entries]) => entries.length > 0)
      .sort((a, b) => b[1][0].lastUsedAt - a[1][0].lastUsedAt)
      .map(([agentType, entries]) =>
        [
          `- ${agentType}: ${entries
            .map((entry) => `${entry.alias} ${entry.label}`)
            .join('; ')}`,
          ...entries
            .map(
              (entry) =>
                [entry, formatContextFiles(entry.contextFiles)] as const,
            )
            .filter(([, context]) => context.length > 0)
            .map(
              ([entry, context]) =>
                `  Context read by ${entry.alias}: ${context}`,
            ),
        ].join('\n'),
      );

    if (lines.length === 0) return undefined;

    return [
      '### Resumable Sessions',
      'Reuse only for clear continuation of the same thread. Otherwise start fresh.',
      '',
      ...lines,
    ].join('\n');
  }

  private getAgentGroup(
    parentSessionId: string,
    agentType: AgentName,
    create: boolean,
  ): RememberedTaskSession[] | undefined {
    let groups = this.sessionsByParent.get(parentSessionId);
    if (!groups && create) {
      groups = new Map();
      this.sessionsByParent.set(parentSessionId, groups);
    }

    let group = groups?.get(agentType);
    if (!group && create && groups) {
      group = [];
      groups.set(agentType, group);
    }

    return group;
  }

  private setAgentGroup(
    parentSessionId: string,
    agentType: AgentName,
    entries: RememberedTaskSession[],
  ): void {
    const groups = this.sessionsByParent.get(parentSessionId);
    if (!groups) return;

    if (entries.length === 0) {
      groups.delete(agentType);
      if (groups.size === 0) {
        this.sessionsByParent.delete(parentSessionId);
        this.nextAliasIndexByParent.delete(parentSessionId);
      }
      return;
    }

    groups.set(agentType, entries);
  }

  private nextAlias(parentSessionId: string, agentType: AgentName): string {
    let counters = this.nextAliasIndexByParent.get(parentSessionId);
    if (!counters) {
      counters = new Map();
      this.nextAliasIndexByParent.set(parentSessionId, counters);
    }

    const next = (counters.get(agentType) ?? 0) + 1;
    counters.set(agentType, next);
    return `${aliasPrefix(agentType)}-${next}`;
  }

  private trimGroup(group: RememberedTaskSession[]): void {
    group.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    if (group.length > this.maxSessionsPerAgent) {
      group.length = this.maxSessionsPerAgent;
    }
  }

  private nextOrder(): number {
    this.orderCounter += 1;
    return this.orderCounter;
  }
}

function formatContextFiles(files: ContextFile[]): string {
  const eligible = files
    .filter((file) => file.lineCount >= MIN_CONTEXT_FILE_LINES)
    .sort((a, b) => b.lastReadAt - a.lastReadAt);
  const shown = eligible.slice(0, MAX_CONTEXT_FILES_PER_SESSION);
  const rest = eligible.length - shown.length;
  const rendered = shown.map(
    (file) => `${file.path} (${file.lineCount} lines)`,
  );
  return `${rendered.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}
