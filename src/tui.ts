import type { TuiPluginModule } from '@opencode-ai/plugin/tui';
import type { JSX } from '@opentui/solid';
import { createElement, insert, setProp } from '@opentui/solid';

const PLUGIN_NAME = 'oh-my-opencode-slim';
const PLUGIN_LABEL = 'OMOS';

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

const plugin: TuiPluginModule & { id: string } = {
  id: `${PLUGIN_NAME}:tui`,
  tui: async (api, _options, meta) => {
    const version = meta.version ?? (await readPackageVersion()) ?? 'dev';
    const versionText = `${PLUGIN_LABEL} ${version}`;

    api.slots.register({
      order: 900,
      slots: {
        home_prompt_right() {
          const theme = api.theme.current;

          return text({ fg: theme.textMuted }, [versionText]);
        },
        session_prompt_right() {
          const theme = api.theme.current;

          return text({ fg: theme.textMuted }, [versionText]);
        },
      },
    });
  },
};

export default plugin;
