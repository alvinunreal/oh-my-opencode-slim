import path from 'node:path';
import type { ContextFile } from '../../utils';

interface PendingContextFile {
  path: string;
  lines: Set<number>;
  lastReadAt: number;
}

export function createTaskContextTracker() {
  const contextByTask = new Map<string, Map<string, PendingContextFile>>();
  const pendingManagedTaskIds = new Set<string>();

  return {
    pendingManagedTaskIds,

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

    prune(backgroundJobBoard: { taskIDs(): Set<string> }) {
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

export function extractReadFiles(
  root: string,
  output: { output: unknown; metadata?: unknown },
): ContextFile[] {
  if (typeof output.output !== 'string') return [];

  const extractPath = /<path>([^<]+)<\/path>/.exec(output.output)?.[1];
  if (!extractPath) return [];

  const relative = path.relative(root, extractPath);
  const normalized =
    !relative || relative.startsWith('..') || path.isAbsolute(relative)
      ? extractPath
      : relative;

  const matchedLines = new Set<number>();
  for (const match of output.output.matchAll(/^([0-9]+):/gm)) {
    matchedLines.add(Number(match[1]));
  }
  const lineNumbers = [...matchedLines];

  return [
    {
      path: normalized,
      lineCount: lineNumbers.length,
      lineNumbers,
      lastReadAt: Date.now(),
    },
  ];
}
