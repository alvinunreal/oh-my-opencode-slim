import type { TuiPluginModule } from '@opencode-ai/plugin/tui';
import type { JSX } from '@opentui/solid';
import { createElement, insert, setProp } from '@opentui/solid';
import { DEFAULT_DISABLED_AGENTS, SUBAGENT_NAMES } from './config/constants';
import { loadPluginConfig } from './config/loader';
import {
  readTuiSnapshot,
  readTuiSnapshotAsync,
  type TuiSnapshot,
} from './tui-state';
import { isPluginDisabledByEnv } from './utils/env';

const PLUGIN_NAME = 'oh-my-opencode-slim';
const CONFIG_WARNING_COLOR = 'orange';
const FALLBACK_SIDEBAR_AGENTS = SUBAGENT_NAMES.filter(
  (agent) =>
    agent !== 'councillor' &&
    agent !== 'council' &&
    !DEFAULT_DISABLED_AGENTS.includes(agent),
);
const BORDER = { type: 'single' };

type Child = JSX.Element | string | number | null | undefined | false;

async function readPackageVersion(): Promise<string | undefined> {
  try {
    const packageJson = (await Bun.file(
      new URL('../package.json', import.meta.url),
    ).json()) as { version?: unknown };

    return typeof packageJson.version === 'string'
      ? packageJson.version
      : undefined;
  } catch {
    return undefined;
  }
}

function element(
  tag: string,
  props: Record<string, unknown>,
  children: Child[] = [],
) {
  const node = createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    insert(node, child);
  }

  return node as JSX.Element;
}

function text(props: Record<string, unknown>, children: Child[]) {
  return element('text', props, children);
}

function box(props: Record<string, unknown>, children: Child[] = []) {
  return element('box', props, children);
}

function getTuiDirectory(api: {
  state?: { path?: { directory?: string } };
}): string {
  return api.state?.path?.directory ?? process.cwd();
}

export function splitSidebarModelId(model: string): {
  provider?: string;
  model: string;
} {
  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) {
    return { model };
  }

  return {
    provider: model.slice(0, slashIndex),
    model: model.slice(slashIndex + 1),
  };
}

export function getSidebarAgentNames(snapshot: TuiSnapshot): string[] {
  const configuredAgents = Object.keys(snapshot.agentModels);
  return configuredAgents.length > 0
    ? configuredAgents
    : FALLBACK_SIDEBAR_AGENTS;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? `${str.slice(0, maxLen - 1)}…` : str;
}

function agentRow(
  label: string,
  model: string,
  variant: string | undefined,
  theme: { textMuted: unknown },
): JSX.Element {
  const modelParts = splitSidebarModelId(model);
  const detailRows: JSX.Element[] = [];

  if (modelParts.provider) {
    detailRows.push(agentDetailRow('provider', modelParts.provider, theme));
  }
  detailRows.push(agentDetailRow('model', modelParts.model, theme));
  if (variant) {
    detailRows.push(agentDetailRow('variant', variant, theme));
  }

  return box({ width: '100%', flexDirection: 'column', marginBottom: 1 }, [
    text({ fg: theme.textMuted }, [label]),
    ...detailRows,
  ]);
}

function compactAgentRow(
  label: string,
  model: string,
  variant: string | undefined,
  theme: { textMuted: unknown },
): JSX.Element {
  const value = variant ? `${model}  ${variant}` : model;
  return box(
    {
      width: '100%',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 0,
    },
    [
      text({ fg: theme.textMuted }, [label]),
      text({ fg: theme.textMuted }, [truncate(value, 40)]),
    ],
  );
}

function agentDetailRow(
  label: string,
  value: string,
  theme: { textMuted: unknown },
): JSX.Element {
  return box({ width: '100%', flexDirection: 'row', paddingLeft: 2 }, [
    text({ fg: theme.textMuted, width: 9 }, [label]),
    text({ fg: theme.textMuted }, [value]),
  ]);
}

function renderSidebar(
  snapshot: TuiSnapshot,
  version: string,
  theme: {
    accent: unknown;
    background: unknown;
    borderActive: unknown;
    text: unknown;
    textMuted: unknown;
  },
  configInvalid: boolean,
  compactSidebar: boolean,
  agentsExpanded: boolean,
  setAgentsExpanded: (expanded: boolean) => void,
): JSX.Element {
  const configStatusRow = buildConfigStatusRow(configInvalid, theme);
  const agentNames = getSidebarAgentNames(snapshot);
  const hasAgents = agentNames.length > 0;
  const formatAgentsHeader = (expanded: boolean) =>
    `${hasAgents ? (expanded ? '▼ ' : '▶ ') : ''}Agents`;
  let expanded = agentsExpanded;
  const agentRows = agentNames.map((agentName) => {
    const model = snapshot.agentModels[agentName] ?? 'pending';
    const variant = snapshot.agentVariants[agentName];
    const row = compactSidebar
      ? compactAgentRow(agentName, model, variant, theme)
      : agentRow(agentName, model, variant, theme);

    setProp(row, 'visible', expanded);
    return row;
  });
  const agentsHeader = text(
    { fg: theme.text, content: formatAgentsHeader(expanded) },
    [],
  );

  return box(
    {
      width: '100%',
      flexDirection: 'column',
      border: BORDER,
      borderColor: theme.borderActive,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 1,
      paddingRight: 1,
    },
    [
      box(
        {
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        },
        [
          box(
            { paddingLeft: 1, paddingRight: 1, backgroundColor: theme.accent },
            [text({ fg: theme.background }, ['OMO-Slim'])],
          ),
          text({ fg: theme.textMuted }, [`v${version}`]),
        ],
      ),
      configStatusRow,
      box(
        {
          width: '100%',
          flexDirection: 'row',
          marginTop: 1,
          onMouseDown: hasAgents
            ? () => {
                expanded = !expanded;
                setAgentsExpanded(expanded);
                setProp(agentsHeader, 'content', formatAgentsHeader(expanded));
                for (const row of agentRows) {
                  setProp(row, 'visible', expanded);
                }
              }
            : undefined,
        },
        [agentsHeader],
      ),
      ...agentRows,
    ],
  );
}

function buildConfigStatusRow(
  configInvalid: boolean,
  theme: { textMuted: unknown },
): JSX.Element | null {
  if (!configInvalid) return null;

  return box(
    {
      width: '100%',
      flexDirection: 'column',
      marginTop: 1,
      marginBottom: 1,
    },
    [
      text({ fg: CONFIG_WARNING_COLOR }, ['Config invalid']),
      text({ fg: theme.textMuted }, ['Run doctor for details']),
    ],
  );
}

function readConfigState(directory: string): {
  configInvalid: boolean;
  compactSidebar: boolean;
} {
  let configInvalid = false;
  const config = loadPluginConfig(directory, {
    silent: true,
    onWarning: () => {
      configInvalid = true;
    },
  });
  return { configInvalid, compactSidebar: config.compactSidebar ?? false };
}

export function readConfigInvalid(directory: string): boolean {
  return readConfigState(directory).configInvalid;
}

const plugin: TuiPluginModule & { id: string } = {
  id: `${PLUGIN_NAME}:tui`,
  tui: async (api, _options, meta) => {
    if (isPluginDisabledByEnv()) return;

    const version = meta.version ?? (await readPackageVersion()) ?? 'dev';
    let configDirectory = getTuiDirectory(api);
    let { configInvalid, compactSidebar } = readConfigState(configDirectory);
    let agentsExpanded = true;
    let snapshot = readTuiSnapshot();
    const renderTimer = setInterval(async () => {
      try {
        snapshot = await readTuiSnapshotAsync();
        const currentDirectory = getTuiDirectory(api);
        if (currentDirectory !== configDirectory) {
          configDirectory = currentDirectory;
          ({ configInvalid, compactSidebar } =
            readConfigState(configDirectory));
        }
        api.renderer.requestRender();
      } catch {
        // Ignore render errors; this is best-effort live status.
      }
    }, 1000);

    api.lifecycle.onDispose(() => {
      clearInterval(renderTimer);
    });

    api.slots.register({
      order: 900,
      slots: {
        sidebar_content() {
          return renderSidebar(
            snapshot,
            version,
            api.theme.current,
            configInvalid,
            compactSidebar,
            agentsExpanded,
            (expanded) => {
              agentsExpanded = expanded;
              api.renderer.requestRender();
            },
          );
        },
      },
    });
  },
};

export default plugin;
