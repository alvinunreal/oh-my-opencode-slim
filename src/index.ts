import type { Plugin } from '@opencode-ai/plugin';
import { createPluginComposer } from './plugin-composer';

const OhMyOpenCodeLite: Plugin = (ctx) => createPluginComposer().compose(ctx);

export default OhMyOpenCodeLite;

export type {
  AgentName,
  AgentOverrideConfig,
  McpName,
  MultiplexerConfig,
  MultiplexerLayout,
  MultiplexerType,
  PluginConfig,
  TmuxConfig,
  TmuxLayout,
} from './config';
export type { RemoteMcpConfig } from './mcp';
