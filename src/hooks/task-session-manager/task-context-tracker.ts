import path from 'node:path';
import type { BackgroundJobBoard, ContextFile } from '../../utils';

interface PendingContextFile {
  path: string;
  lines: Set<number>;
  lastReadAt: number;
}

export interface TaskContextTracker {
  addContext(taskId: string, files: ContextFile[]): void;
  canTrack(taskId: string, backgroundJobBoard: BackgroundJobBoard): boolean;
  prune(backgroundJobBoard: BackgroundJobBoard): void;
  clearSession(sessionId: string): void;
  addManagedTaskId(taskId: string): void;
  removeManagedTaskId(taskId: string): void;
  contextFilesForPrompt(taskId: string): ContextFile[];
}

export function createTaskContextTracker(): TaskContextTracker {
  const contextByTask = new Map<string, Map<string, PendingContextFile>>();
  const pendingManagedTaskIds = new Set<string>();

  return {
    addContext(taskId: string, files: ContextFile[]) {
      if (files.length === 0) return;

      let context = contextByTask.get(taskId);
      if (!context) {
        context = new Map();
        contextByTask.set(taskId, context);
      }

      for (const file of files) {
        const pending = context.get(file.path) ?? {
          path: file.path,
          lines: new Set<number>(),
          lastReadAt: file.lastReadAt,
        };

        for (const line of file.lineNumbers ?? []) {
          pending.lines.add(line);
        }
        pending.lastReadAt = Math.max(pending.lastReadAt, file.lastReadAt);
        context.set(file.path, pending);
      }
    },

    canTrack(taskId: string, backgroundJobBoard: BackgroundJobBoard) {
      return (
        pendingManagedTaskIds.has(taskId) ||
        backgroundJobBoard.taskIDs().has(taskId)
      );
    },

    prune(backgroundJobBoard: BackgroundJobBoard) {
      const remembered = backgroundJobBoard.taskIDs();
      for (const taskId of contextByTask.keys()) {
        if (!pendingManagedTaskIds.has(taskId) && !remembered.has(taskId)) {
          contextByTask.delete(taskId);
        }
      }
    },

    clearSession(sessionId: string) {
      contextByTask.delete(sessionId);
      pendingManagedTaskIds.delete(sessionId);
    },

    addManagedTaskId(taskId: string) {
      pendingManagedTaskIds.add(taskId);
    },

    removeManagedTaskId(taskId: string) {
      pendingManagedTaskIds.delete(taskId);
    },

    contextFilesForPrompt(taskId: string): ContextFile[] {
      const context = contextByTask.get(taskId);
      if (!context) return [];

      return [...context.values()].map((file) => ({
        path: file.path,
        lineCount: file.lines.size,
        lastReadAt: file.lastReadAt,
      }));
    },
  };
}

// Pure helpers — only used by task-context-tracker
function extractPath(output: string): string | undefined {
  return /<path>([^<]+)<\/path>/.exec(output)?.[1];
}

function normalizePath(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return file;
  }
  return relative;
}

export function extractReadFiles(
  root: string,
  output: { output: unknown; metadata?: unknown },
): ContextFile[] {
  if (typeof output.output !== 'string') return [];
  const file = extractPath(output.output);
  if (!file) return [];

  return [
    {
      path: normalizePath(root, file),
      lineCount: countReadLines(output.output).length,
      lineNumbers: countReadLines(output.output),
      lastReadAt: Date.now(),
    },
  ];
}

function countReadLines(output: string): number[] {
  const lines = new Set<number>();
  for (const match of output.matchAll(/^([0-9]+):/gm)) {
    lines.add(Number(match[1]));
  }
  return [...lines];
}
