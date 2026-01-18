import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Stdio MCP server configuration (local process)
 */
export interface StdioMcpServer {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * HTTP MCP server configuration (remote server)
 */
export interface HttpMcpServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

/**
 * MCP server configuration - either stdio or http
 */
export type McpServerConfig = StdioMcpServer | HttpMcpServer;

/**
 * Skill MCP configuration - map of server names to their configs
 */
export type SkillMcpConfig = Record<string, McpServerConfig>;

/**
 * Skill definition
 */
export interface SkillDefinition {
  name: string;
  description: string;
  template: string;
  mcpConfig?: SkillMcpConfig;
}

/**
 * Info for identifying a managed MCP client
 */
export interface SkillMcpClientInfo {
  serverName: string;
  skillName: string;
  sessionId: string;
}

/**
 * Connection type for managed clients
 */
export type ConnectionType = "stdio" | "http";

/**
 * Base interface for managed MCP clients
 */
interface ManagedClientBase {
  client: Client;
  skillName: string;
  lastUsedAt: number;
  connectionType: ConnectionType;
}

/**
 * Managed stdio client
 */
export interface ManagedStdioClient extends ManagedClientBase {
  connectionType: "stdio";
  transport: StdioClientTransport;
}

/**
 * Managed HTTP client
 */
export interface ManagedHttpClient extends ManagedClientBase {
  connectionType: "http";
  transport: StreamableHTTPClientTransport;
}

/**
 * Managed client - either stdio or http
 */
export type ManagedClient = ManagedStdioClient | ManagedHttpClient;

/**
 * Args for the skill tool
 */
export interface SkillArgs {
  name: string;
}

/**
 * Args for the skill_mcp tool
 */
export interface SkillMcpArgs {
  skillName: string;
  mcpName: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
}
