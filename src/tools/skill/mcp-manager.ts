import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, Resource, Prompt } from "@modelcontextprotocol/sdk/types.js";
import type {
  ConnectionType,
  ManagedClient,
  ManagedHttpClient,
  ManagedStdioClient,
  McpServerConfig,
  SkillMcpClientInfo,
} from "./types";

function getConnectionType(config: McpServerConfig): ConnectionType {
  return "url" in config ? "http" : "stdio";
}

export class SkillMcpManager {
  private static instance: SkillMcpManager;
  private clients: Map<string, ManagedClient> = new Map();
  private pendingConnections: Map<string, Promise<Client>> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000;

  private constructor() {
    this.startCleanupTimer();
    this.registerProcessCleanup();
  }

  static getInstance(): SkillMcpManager {
    if (!SkillMcpManager.instance) {
      SkillMcpManager.instance = new SkillMcpManager();
    }
    return SkillMcpManager.instance;
  }

  private registerProcessCleanup(): void {
    const cleanup = () => {
      for (const [, managed] of this.clients) {
        try {
          managed.client.close();
        } catch {}
        try {
          managed.transport.close();
        } catch {}
      }
      this.clients.clear();
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
  }

  private getClientKey(info: SkillMcpClientInfo): string {
    return `${info.sessionId}:${info.skillName}:${info.serverName}`;
  }

  private async createClient(
    info: SkillMcpClientInfo,
    config: McpServerConfig
  ): Promise<Client> {
    const connectionType = getConnectionType(config);

    if (connectionType === "http") {
      return this.createHttpClient(info, config);
    }

    return this.createStdioClient(info, config);
  }

  private async createHttpClient(
    info: SkillMcpClientInfo,
    config: McpServerConfig
  ): Promise<Client> {
    if (!("url" in config)) {
      throw new Error(
        `MCP server "${info.serverName}" missing url for HTTP connection.`
      );
    }

    const url = new URL(config.url);
    const requestInit: RequestInit = {};
    if (config.headers && Object.keys(config.headers).length > 0) {
      requestInit.headers = config.headers;
    }

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: Object.keys(requestInit).length > 0 ? requestInit : undefined,
    });

    const client = new Client(
      { name: `skill-mcp-${info.skillName}-${info.serverName}`, version: "1.0.0" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
    } catch (error) {
      try {
        await transport.close();
      } catch {
        // ignore transport close errors
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to connect to MCP server "${info.serverName}". ${errorMessage}`
      );
    }

    const managedClient: ManagedHttpClient = {
      client,
      transport,
      skillName: info.skillName,
      lastUsedAt: Date.now(),
      connectionType: "http",
    };

    this.clients.set(this.getClientKey(info), managedClient);
    this.startCleanupTimer();
    return client;
  }

  private async createStdioClient(
    info: SkillMcpClientInfo,
    config: McpServerConfig
  ): Promise<Client> {
    if (!("command" in config)) {
      throw new Error(
        `MCP server "${info.serverName}" missing command for stdio connection.`
      );
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: config.env,
      stderr: "ignore",
    });

    const client = new Client(
      { name: `skill-mcp-${info.skillName}-${info.serverName}`, version: "1.0.0" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
    } catch (error) {
      try {
        await transport.close();
      } catch {
        // ignore transport close errors
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to connect to MCP server "${info.serverName}". ${errorMessage}`
      );
    }

    const managedClient: ManagedStdioClient = {
      client,
      transport,
      skillName: info.skillName,
      lastUsedAt: Date.now(),
      connectionType: "stdio",
    };

    this.clients.set(this.getClientKey(info), managedClient);
    this.startCleanupTimer();
    return client;
  }

  private async getOrCreateClient(
    info: SkillMcpClientInfo,
    config: McpServerConfig
  ): Promise<Client> {
    const key = this.getClientKey(info);
    const existing = this.clients.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }

    const pending = this.pendingConnections.get(key);
    if (pending) {
      return pending;
    }

    const connectionPromise = this.createClient(info, config);
    this.pendingConnections.set(key, connectionPromise);

    try {
      return await connectionPromise;
    } finally {
      this.pendingConnections.delete(key);
    }
  }

  async listTools(
    info: SkillMcpClientInfo,
    config: McpServerConfig
  ): Promise<Tool[]> {
    const client = await this.getOrCreateClient(info, config);
    const result = await client.listTools();
    return result.tools;
  }

  async listResources(
    info: SkillMcpClientInfo,
    config: McpServerConfig
  ): Promise<Resource[]> {
    const client = await this.getOrCreateClient(info, config);
    const result = await client.listResources();
    return result.resources;
  }

  async listPrompts(
    info: SkillMcpClientInfo,
    config: McpServerConfig
  ): Promise<Prompt[]> {
    const client = await this.getOrCreateClient(info, config);
    const result = await client.listPrompts();
    return result.prompts;
  }

  async callTool(
    info: SkillMcpClientInfo,
    config: McpServerConfig,
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const client = await this.getOrCreateClient(info, config);
    const result = await client.callTool({ name, arguments: args });
    return result.content;
  }

  async readResource(
    info: SkillMcpClientInfo,
    config: McpServerConfig,
    uri: string
  ): Promise<unknown> {
    const client = await this.getOrCreateClient(info, config);
    const result = await client.readResource({ uri });
    return result.contents;
  }

  async getPrompt(
    info: SkillMcpClientInfo,
    config: McpServerConfig,
    name: string,
    args: Record<string, string>
  ): Promise<unknown> {
    const client = await this.getOrCreateClient(info, config);
    const result = await client.getPrompt({ name, arguments: args });
    return result.messages;
  }

  private startCleanupTimer(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleClients();
    }, 60_000);
    this.cleanupInterval.unref();
  }

  private async cleanupIdleClients(): Promise<void> {
    const now = Date.now();
    for (const [key, managed] of this.clients) {
      if (now - managed.lastUsedAt > this.IDLE_TIMEOUT) {
        this.clients.delete(key);
        try {
          await managed.client.close();
        } catch {
          // ignore close errors
        }
        try {
          await managed.transport.close();
        } catch {
          // ignore transport close errors
        }
      }
    }
  }
}
