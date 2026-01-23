// LSP Client - Full implementation with connection pooling

import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { type Subprocess, spawn } from 'bun';
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { getLanguageId } from './config';
import type { Diagnostic, ResolvedServer } from './types';

interface ManagedClient {
  client: LSPClient;
  lastUsedAt: number;
  refCount: number;
  initPromise?: Promise<void>;
  isInitializing: boolean;
}

class LSPServerManager {
  private static instance: LSPServerManager;
  private clients = new Map<string, ManagedClient>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000;

  private constructor() {
    this.startCleanupTimer();
    this.registerProcessCleanup();
  }

  private registerProcessCleanup(): void {
    const cleanup = () => {
      for (const [, managed] of this.clients) {
        try {
          managed.client.stop();
        } catch {}
      }
      this.clients.clear();
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
    };

    process.on('exit', cleanup);
    process.on('SIGINT', () => {
      cleanup();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      cleanup();
      process.exit(0);
    });
  }

  static getInstance(): LSPServerManager {
    if (!LSPServerManager.instance) {
      LSPServerManager.instance = new LSPServerManager();
    }
    return LSPServerManager.instance;
  }

  private getKey(root: string, serverId: string): string {
    return `${root}::${serverId}`;
  }

  private startCleanupTimer(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleClients();
    }, 60000);
  }

  private cleanupIdleClients(): void {
    const now = Date.now();
    for (const [key, managed] of this.clients) {
      if (
        managed.refCount === 0 &&
        now - managed.lastUsedAt > this.IDLE_TIMEOUT
      ) {
        managed.client.stop();
        this.clients.delete(key);
      }
    }
  }

  async getClient(root: string, server: ResolvedServer): Promise<LSPClient> {
    const key = this.getKey(root, server.id);

    const managed = this.clients.get(key);
    if (managed) {
      if (managed.initPromise) {
        await managed.initPromise;
      }
      if (managed.client.isAlive()) {
        managed.refCount++;
        managed.lastUsedAt = Date.now();
        return managed.client;
      }
      await managed.client.stop();
      this.clients.delete(key);
    }

    const client = new LSPClient(root, server);
    const initPromise = (async () => {
      await client.start();
      await client.initialize();
    })();

    this.clients.set(key, {
      client,
      lastUsedAt: Date.now(),
      refCount: 1,
      initPromise,
      isInitializing: true,
    });

    try {
      await initPromise;
      const m = this.clients.get(key);
      if (m) {
        m.initPromise = undefined;
        m.isInitializing = false;
      }
    } catch (err) {
      this.clients.delete(key);
      throw err;
    }

    return client;
  }

  releaseClient(root: string, serverId: string): void {
    const key = this.getKey(root, serverId);
    const managed = this.clients.get(key);
    if (managed && managed.refCount > 0) {
      managed.refCount--;
      managed.lastUsedAt = Date.now();
    }
  }

  isServerInitializing(root: string, serverId: string): boolean {
    const key = this.getKey(root, serverId);
    const managed = this.clients.get(key);
    return managed?.isInitializing ?? false;
  }

  async stopAll(): Promise<void> {
    for (const [, managed] of this.clients) {
      await managed.client.stop();
    }
    this.clients.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

export const lspManager = LSPServerManager.getInstance();

export class LSPClient {
  private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null;
  private connection: MessageConnection | null = null;
  private openedFiles = new Set<string>();
  private stderrBuffer: string[] = [];
  private processExited = false;
  private diagnosticsStore = new Map<string, Diagnostic[]>();

  constructor(
    private root: string,
    private server: ResolvedServer,
  ) {}

  async start(): Promise<void> {
    this.proc = spawn(this.server.command, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: this.root,
      env: {
        ...process.env,
        ...this.server.env,
      },
    });

    if (!this.proc) {
      throw new Error(
        `Failed to spawn LSP server: ${this.server.command.join(' ')}`,
      );
    }

    this.startStderrReading();

    // Create JSON-RPC connection
    const stdoutReader = this.proc.stdout.getReader();
    const nodeReadable = new Readable({
      async read() {
        try {
          const { done, value } = await stdoutReader.read();
          if (done) {
            this.push(null);
          } else {
            this.push(value);
          }
        } catch (err) {
          this.destroy(err as Error);
        }
      },
    });

    const stdin = this.proc.stdin;
    const nodeWritable = new Writable({
      write(chunk, _encoding, callback) {
        try {
          stdin.write(chunk);
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
      final(callback) {
        try {
          stdin.end();
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
    });

    this.connection = createMessageConnection(
      new StreamMessageReader(nodeReadable),
      new StreamMessageWriter(nodeWritable),
    );

    this.connection.onNotification(
      'textDocument/publishDiagnostics',
      (params: { uri?: string; diagnostics?: Diagnostic[] }) => {
        if (params.uri) {
          this.diagnosticsStore.set(params.uri, params.diagnostics ?? []);
        }
      },
    );

    this.connection.onRequest(
      'workspace/configuration',
      (params: { items?: unknown[] }) => {
        const items = params.items ?? [];
        return items.map((item: unknown) => {
          const configItem = item as { section?: string };
          if (configItem.section === 'json')
            return { validate: { enable: true } };
          return {};
        });
      },
    );

    this.connection.onRequest('client/registerCapability', () => null);
    this.connection.onRequest('window/workDoneProgress/create', () => null);

    this.connection.onClose(() => {
      this.processExited = true;
    });

    this.connection.listen();

    await new Promise((resolve) => setTimeout(resolve, 100));

    if (this.proc.exitCode !== null) {
      const stderr = this.stderrBuffer.join('\n');
      throw new Error(
        `LSP server exited immediately with code ${this.proc.exitCode}` +
          (stderr ? `\nstderr: ${stderr}` : ''),
      );
    }
  }

  private startStderrReading(): void {
    if (!this.proc) return;

    const reader = this.proc.stderr.getReader();
    const read = async () => {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          this.stderrBuffer.push(text);
          if (this.stderrBuffer.length > 100) {
            this.stderrBuffer.shift();
          }
        }
      } catch {}
    };
    read();
  }

  async initialize(): Promise<void> {
    if (!this.connection) throw new Error('LSP connection not established');

    const rootUri = pathToFileURL(this.root).href;
    await this.connection.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
          rename: {
            prepareSupport: true,
            prepareSupportDefaultBehavior: 1,
            honorsChangeAnnotations: true,
          },
        },
        workspace: {
          symbol: {},
          workspaceFolders: true,
          configuration: true,
          applyEdit: true,
          workspaceEdit: { documentChanges: true },
        },
      },
      ...this.server.initialization,
    });
    this.connection.sendNotification('initialized');
    await new Promise((r) => setTimeout(r, 300));
  }

  async openFile(filePath: string): Promise<void> {
    const absPath = resolve(filePath);
    if (this.openedFiles.has(absPath)) return;

    const text = readFileSync(absPath, 'utf-8');
    const ext = extname(absPath);
    const languageId = getLanguageId(ext);

    this.connection?.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(absPath).href,
        languageId,
        version: 1,
        text,
      },
    });
    this.openedFiles.add(absPath);

    await new Promise((r) => setTimeout(r, 1000));
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<unknown> {
    const absPath = resolve(filePath);
    await this.openFile(absPath);
    return this.connection?.sendRequest('textDocument/definition', {
      textDocument: { uri: pathToFileURL(absPath).href },
      position: { line: line - 1, character },
    });
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<unknown> {
    const absPath = resolve(filePath);
    await this.openFile(absPath);
    return this.connection?.sendRequest('textDocument/references', {
      textDocument: { uri: pathToFileURL(absPath).href },
      position: { line: line - 1, character },
      context: { includeDeclaration },
    });
  }

  async diagnostics(filePath: string): Promise<{ items: Diagnostic[] }> {
    const absPath = resolve(filePath);
    const uri = pathToFileURL(absPath).href;
    await this.openFile(absPath);
    await new Promise((r) => setTimeout(r, 500));

    try {
      const result = await this.connection?.sendRequest(
        'textDocument/diagnostic',
        {
          textDocument: { uri },
        },
      );
      if (result && typeof result === 'object' && 'items' in result) {
        return result as { items: Diagnostic[] };
      }
    } catch {}

    return { items: this.diagnosticsStore.get(uri) ?? [] };
  }

  async rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<unknown> {
    const absPath = resolve(filePath);
    await this.openFile(absPath);
    return this.connection?.sendRequest('textDocument/rename', {
      textDocument: { uri: pathToFileURL(absPath).href },
      position: { line: line - 1, character },
      newName,
    });
  }

  isAlive(): boolean {
    return (
      this.proc !== null && !this.processExited && this.proc.exitCode === null
    );
  }

  async stop(): Promise<void> {
    try {
      if (this.connection) {
        await this.connection.sendRequest('shutdown');
        this.connection.sendNotification('exit');
        this.connection.dispose();
      }
    } catch {}
    this.proc?.kill();
    this.proc = null;
    this.connection = null;
    this.processExited = true;
    this.diagnosticsStore.clear();
  }
}
