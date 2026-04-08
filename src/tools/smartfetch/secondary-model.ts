import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { MAX_MODEL_CONTENT_CHARS } from './constants';
import type { CachedFetch, SecondaryModel } from './types';

type OpenCodeClient = PluginInput['client'];

function parseModelRef(value: string | undefined) {
  if (!value) return undefined;
  const [providerID, ...rest] = value.split('/');
  const modelID = rest.join('/');
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
}

export async function readSecondaryModelFromConfig() {
  try {
    const configPath = path.join(
      os.homedir(),
      '.config',
      'opencode',
      'opencode.json',
    );
    const content = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(content) as {
      small_model?: unknown;
      agent?: Record<string, { model?: unknown }>;
    };
    const models: SecondaryModel[] = [];
    const seen = new Set<string>();
    const pushModel = (value: unknown) => {
      if (typeof value !== 'string') return;
      const parsedModel = parseModelRef(value);
      if (!parsedModel) return;
      const key = `${parsedModel.providerID}/${parsedModel.modelID}`;
      if (seen.has(key)) return;
      seen.add(key);
      models.push(parsedModel);
    };

    pushModel(parsed.small_model);

    for (const agentID of ['explorer', 'librarian']) {
      const agent = parsed.agent?.[agentID];
      if (!agent) continue;
      pushModel(agent.model as string | undefined);
    }

    return models;
  } catch {
    return [];
  }
}

function buildPrompt(content: string, prompt: string) {
  return [
    'Use only the fetched content below.',
    'Do not use tools, outside knowledge, or unstated assumptions.',
    'Answer concisely and directly.',
    'If the requested information is missing from the content, say that clearly.',
    'Preserve code examples or exact values only when they are relevant to the task.',
    '',
    'Fetched content:',
    '---',
    content,
    '---',
    '',
    'Task:',
    prompt,
  ].join('\n');
}

export function decideSecondaryModelUse(
  fetchResult: CachedFetch,
  prompt: string | undefined,
  secondaryModels: SecondaryModel[],
) {
  if (!prompt?.trim()) return { use: false, reason: 'no_prompt' as const };
  if (!secondaryModels.length) {
    return {
      use: false,
      reason: 'no_secondary_model_configured' as const,
    };
  }
  if (!fetchResult.markdown.trim()) {
    return { use: false, reason: 'empty_content' as const };
  }
  if (fetchResult.wordCount > 0 && fetchResult.wordCount < 25) {
    return { use: false, reason: 'content_too_short' as const };
  }
  return { use: true, reason: 'prompt_present' as const };
}

function isUsableSecondaryText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^no response from secondary model\.?$/i.test(trimmed)) return false;
  return true;
}

async function runSecondaryModel(
  client: OpenCodeClient,
  directory: string,
  model: SecondaryModel,
  prompt: string,
  content: string,
) {
  const session = await client.session.create({
    responseStyle: 'data',
    throwOnError: true,
    query: { directory },
    body: { title: 'smartfetch-secondary' },
  });

  const sessionId =
    (session as { data?: { id?: string }; id?: string })?.data?.id ??
    (session as { data?: { id?: string }; id?: string })?.id;
  if (!sessionId) {
    throw new Error('Secondary model session did not return an id');
  }

  const sourceChars = content.length;
  const truncatedContent = content.slice(0, MAX_MODEL_CONTENT_CHARS);
  const inputChars = truncatedContent.length;
  const inputTruncated = inputChars < sourceChars;
  const effectivePrompt = inputTruncated
    ? `${prompt}\n\nNote: only the first ${inputChars} characters of a longer fetched document were provided.`
    : prompt;
  try {
    const toolIDsResponse = await client.tool.ids({
      responseStyle: 'data',
      throwOnError: true,
    });
    const toolIDsData = toolIDsResponse as { data?: unknown };
    const toolIDs = Array.isArray(toolIDsData.data)
      ? (toolIDsData.data as string[])
      : Array.isArray(toolIDsResponse)
        ? toolIDsResponse
        : [];
    const disabledTools = Object.fromEntries(
      (toolIDs || []).map((id: string) => [id, false]),
    );

    const result = await client.session.prompt({
      responseStyle: 'data',
      throwOnError: true,
      path: { id: sessionId },
      query: { directory },
      body: {
        model,
        system:
          'Answer only from the supplied content. Do not use tools or outside knowledge.',
        tools: disabledTools,
        parts: [
          {
            type: 'text',
            text: buildPrompt(truncatedContent, effectivePrompt),
          },
        ],
      },
    });

    const parts =
      (result as { data?: { parts?: Array<{ type?: string; text?: string }> } })
        ?.data?.parts ??
      (result as { parts?: Array<{ type?: string; text?: string }> })?.parts ??
      [];
    const text = parts
      .map((part) => (part?.type === 'text' ? part.text || '' : ''))
      .join('')
      .trim();

    return {
      text,
      inputTruncated,
      inputChars,
      sourceChars,
    };
  } finally {
    await client.session
      .delete({
        path: { id: sessionId },
        query: { directory },
      })
      .catch(() => undefined);
  }
}

export async function runSecondaryModelWithFallback(
  client: OpenCodeClient,
  directory: string,
  models: SecondaryModel[],
  prompt: string,
  content: string,
) {
  let lastError: unknown;
  for (const model of models) {
    try {
      const result = await runSecondaryModel(
        client,
        directory,
        model,
        prompt,
        content,
      );
      if (!isUsableSecondaryText(result.text)) {
        lastError = new Error('Secondary model returned no usable text');
        continue;
      }
      return { ...result, model };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? 'Secondary model failed'));
}
