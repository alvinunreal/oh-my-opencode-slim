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

const PLUGIN_NAME = 'oh-my-opencode-slim';
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

function truncate(value: string, max = 24): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function getTuiDirectory(api: {
  state?: { path?: { directory?: string } };
}): string {
  return api.state?.path?.directory ?? process.cwd();
}

export function formatSidebarModelName(model: string): string {
  const lastSlash = model.lastIndexOf('/');
  return lastSlash === -1 ? model : model.slice(lastSlash + 1);
}

export function getSidebarAgentNames(snapshot: TuiSnapshot): string[] {
  const configuredAgents = Object.keys(snapshot.agentModels);
  return configuredAgents.length > 0
    ? configuredAgents
    : FALLBACK_SIDEBAR_AGENTS;
}

function row(
  label: string,
  value: string,
  theme: { textMuted: unknown; text: unknown },
  valueColor?: unknown,
): JSX.Element {
  return box(
    { width: '100%', flexDirection: 'row', justifyContent: 'space-between' },
    [
      text({ fg: theme.textMuted }, [label]),
      text({ fg: valueColor ?? theme.text }, [value]),
    ],
  );
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
): JSX.Element {
  const configStatusRow = buildConfigStatusRow(configInvalid, theme);

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
      box({ width: '100%', marginTop: 1 }, [
        text({ fg: theme.text }, ['Agents']),
      ]),
      ...getSidebarAgentNames(snapshot).map((agentName) => {
        const model = snapshot.agentModels[agentName] ?? 'pending';
        return row(
          agentName,
          truncate(formatSidebarModelName(model), 26),
          theme,
          theme.textMuted,
        );
      }),
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
      text({ fg: 'yellow' }, ['Config invalid']),
      text({ fg: theme.textMuted }, ['Run doctor for details']),
    ],
  );
}

export function readConfigInvalid(directory: string): boolean {
  let configInvalid = false;
  loadPluginConfig(directory, {
    silent: true,
    onWarning: () => {
      configInvalid = true;
    },
  });
  return configInvalid;
}

const plugin: TuiPluginModule & { id: string } = {
  id: `${PLUGIN_NAME}:tui`,
  tui: async (api, _options, meta) => {
    const version = meta.version ?? (await readPackageVersion()) ?? 'dev';
    let configDirectory = getTuiDirectory(api);
    let configInvalid = readConfigInvalid(configDirectory);
    let snapshot = readTuiSnapshot();
    const renderTimer = setInterval(async () => {
      try {
        snapshot = await readTuiSnapshotAsync();
        const currentDirectory = getTuiDirectory(api);
        if (currentDirectory !== configDirectory) {
          configDirectory = currentDirectory;
          configInvalid = readConfigInvalid(configDirectory);
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
          );
        },
      },
    });
  },
};

export default plugin;
