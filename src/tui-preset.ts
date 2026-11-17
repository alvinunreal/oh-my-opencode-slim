import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { normalizeModelOption } from './v2/preset-manager';

interface ModelOption {
  /** Full `providerID/modelID` string used in the preset config. */
  value: string;
  title: string;
  description: string;
  /** Variant names available for this model, if any. */
  variants: string[];
}

async function fetchModelOptions(api: TuiPluginApi): Promise<ModelOption[]> {
  // Guard: the TUI's client may not expose config.providers in all builds.
  if (!api.client?.config?.providers) {
    return [];
  }
  const res = (await api.client.config.providers()) as {
    data?: {
      providers?: Array<{
        id: string;
        models: Record<
          string,
          { name?: string; variants?: Record<string, unknown> }
        >;
      }>;
    };
  };
  const providers = res.data?.providers ?? [];
  const options: ModelOption[] = [];
  for (const provider of providers) {
    if (!provider?.models) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model) continue;
      options.push({
        value: `${provider.id}/${modelId}`,
        title: model.name ?? modelId,
        description: provider.id,
        variants: model.variants ? Object.keys(model.variants) : [],
      });
    }
  }
  return options;
}

/** provider/model-id -> configured display name, for sidebar rendering. */
export async function fetchModelNameMap(api: {
  client?: unknown;
  directory?: string;
}): Promise<Record<string, string>> {
  const client = api.client as
    | {
        config?: { providers?: unknown };
        model?: {
          list?: (input: {
            location?: { directory: string };
          }) => Promise<unknown>;
        };
      }
    | undefined;
  if (
    typeof client?.config?.providers !== 'function' &&
    typeof client?.model?.list === 'function'
  ) {
    const response = await client.model.list({
      ...(api.directory ? { location: { directory: api.directory } } : {}),
    });
    const entries = Array.isArray(response)
      ? response
      : (response as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(entries)) return {};
    const names: Record<string, string> = {};
    for (const entry of entries) {
      const option = normalizeModelOption(entry);
      if (option) names[option.value] = option.title;
    }
    return names;
  }
  const options = await fetchModelOptions(api as TuiPluginApi);
  return Object.fromEntries(options.map((o) => [o.value, o.title]));
}
