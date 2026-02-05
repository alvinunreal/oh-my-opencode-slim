import type { OpenCodeFreeModel } from './types';

interface OpenCodeModelVerboseRecord {
  id: string;
  providerID: string;
  name?: string;
  status?: 'alpha' | 'beta' | 'deprecated' | 'active';
  cost?: {
    input?: number;
    output?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  limit?: {
    context?: number;
    output?: number;
  };
  capabilities?: {
    reasoning?: boolean;
    toolcall?: boolean;
    attachment?: boolean;
  };
}

function isFreeModel(record: OpenCodeModelVerboseRecord): boolean {
  const inputCost = record.cost?.input ?? 0;
  const outputCost = record.cost?.output ?? 0;
  const cacheReadCost = record.cost?.cache?.read ?? 0;
  const cacheWriteCost = record.cost?.cache?.write ?? 0;

  return (
    inputCost === 0 &&
    outputCost === 0 &&
    cacheReadCost === 0 &&
    cacheWriteCost === 0
  );
}

function normalizeModel(
  record: OpenCodeModelVerboseRecord,
): OpenCodeFreeModel | null {
  if (record.providerID !== 'opencode') return null;

  const fullModel = `${record.providerID}/${record.id}`;
  if (!fullModel.startsWith('opencode/')) return null;
  if (!isFreeModel(record)) return null;

  return {
    model: fullModel,
    name: record.name ?? record.id,
    status: record.status ?? 'active',
    contextLimit: record.limit?.context ?? 0,
    outputLimit: record.limit?.output ?? 0,
    reasoning: record.capabilities?.reasoning === true,
    toolcall: record.capabilities?.toolcall === true,
    attachment: record.capabilities?.attachment === true,
  };
}

export function parseOpenCodeModelsVerboseOutput(
  output: string,
): OpenCodeFreeModel[] {
  const lines = output.split(/\r?\n/);
  const models: OpenCodeFreeModel[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim();
    if (!line || !line.includes('/')) continue;

    const isModelHeader = /^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(line);
    if (!isModelHeader) continue;

    let jsonStart = -1;
    for (let search = index + 1; search < lines.length; search++) {
      if (lines[search]?.trim().startsWith('{')) {
        jsonStart = search;
        break;
      }

      if (/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(lines[search]?.trim() ?? '')) {
        break;
      }
    }

    if (jsonStart === -1) continue;

    let braceDepth = 0;
    const jsonLines: string[] = [];
    let jsonEnd = -1;

    for (let cursor = jsonStart; cursor < lines.length; cursor++) {
      const current = lines[cursor] ?? '';
      jsonLines.push(current);

      for (const char of current) {
        if (char === '{') braceDepth++;
        if (char === '}') braceDepth--;
      }

      if (braceDepth === 0 && jsonLines.length > 0) {
        jsonEnd = cursor;
        break;
      }
    }

    if (jsonEnd === -1) continue;

    try {
      const parsed = JSON.parse(
        jsonLines.join('\n'),
      ) as OpenCodeModelVerboseRecord;
      const normalized = normalizeModel(parsed);
      if (normalized) models.push(normalized);
    } catch {
      // Ignore malformed blocks and continue parsing the next model.
    }

    index = jsonEnd;
  }

  return models;
}

export async function discoverOpenCodeFreeModels(): Promise<{
  models: OpenCodeFreeModel[];
  error?: string;
}> {
  try {
    const proc = Bun.spawn(['opencode', 'models', '--refresh', '--verbose'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
      return {
        models: [],
        error: stderr.trim() || 'Failed to fetch OpenCode models.',
      };
    }

    return { models: parseOpenCodeModelsVerboseOutput(stdout) };
  } catch {
    return {
      models: [],
      error: 'Unable to run `opencode models --refresh --verbose`.',
    };
  }
}
