import { PLUGIN_ID } from './config/constants';
import { createV2Setup } from './v2/setup';

export default { id: PLUGIN_ID, setup: createV2Setup() };

export type {
  AgentName,
  AgentOverrideConfig,
  McpName,
  MultiplexerConfig,
  MultiplexerLayout,
  MultiplexerType,
  PluginConfig,
} from './config';
export type { RemoteMcpConfig } from './mcp';
