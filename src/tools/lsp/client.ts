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
import { log } from '../../utils/logger';
import { getLanguageId, resolveServerCommand } from './config';
import type {
  Diagnostic,
  DocumentDiagnosticReport,
  ResolvedServer,
} from './types';

const START_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
const DIAGNOSTICS_TIMEOUT_MS = 15_000;
const OPEN_FILE_DELAY_MS = 250;
const INITIALIZE_DELAY_MS = 100;
const DIAGNOSTIC_SETTLE_DELAY_MS = 250;

export const LSP_TIMEOUTS = {
  start: START_TIMEOUT_MS,
  request: REQUEST_TIMEOUT_MS,
  diagnostics: DIAGNOSTICS_TIMEOUT_MS,
  openFileDelay: OPEN_FILE_DELAY_MS,
  initializeDelay: INITIALIZE_DELAY_MS,
  diagnosticSettleDelay: DIAGNOSTIC_SETTLE_DELAY_MS,
};

interface DiagnosticProviderCapabilities {
  identifier?: string;
  interFileDependencies?: boolean;
  workspaceDiagnostics?: boolean;
}

export function getDiagnosticsCapabilitySummary({
  diagnosticProvider,
  publishDiagnosticsObserved = false,
  workspaceConfigurationRequested = false,
}: {
  diagnosticProvider?: DiagnosticProviderCapabilities | null;
  publishDiagnosticsObserved?: boolean;
  workspaceConfigurationRequested?: boolean;
}): {
  availableModes: string[];
  preferredMode: 'push' | 'pull';
  inferredTransport: 'push' | 'pull' | 'hybrid';
  pull: boolean;
  pushObserved: boolean;
  pullResultTracking: boolean;
  workspaceDiagnostics: boolean;
  interFileDependencies: boolean;
  workspaceConfiguration: boolean;
} {
  const pull = Boolean(diagnosticProvider);
  const workspaceDiagnostics = Boolean(
    diagnosticProvider?.workspaceDiagnostics,
  );
  const interFileDependencies = Boolean(
    diagnosticProvider?.interFileDependencies,
  );

  const availableModes = [
    ...(pull ? ['pull', 'pull/full', 'pull/unchanged'] : ['push']),
    ...(workspaceDiagnostics ? ['workspace-pull'] : []),
    ...(publishDiagnosticsObserved ? ['push'] : []),
  ];

  return {
    availableModes: Array.from(new Set(availableModes)),
    preferredMode: pull ? 'pull' : 'push',
    inferredTransport:
      pull && publishDiagnosticsObserved ? 'hybrid' : pull ? 'pull' : 'push',
    pull,
    pushObserved: publishDiagnosticsObserved,
    pullResultTracking: pull,
    workspaceDiagnostics,
    interFileDependencies,
    workspaceConfiguration: workspaceConfigurationRequested,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => Promise<void> | void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      void Promise.resolve(onTimeout?.()).catch(() => {});
      reject(new Error(`${label} timeout after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function getWorkspaceConfiguration(
  items: Array<{ section?: string } | undefined>,
): Array<unknown> {
  return items.map((item) => {
    if (item?.section === 'json') {
      return { validate: { enable: true } };
    }

    return null;
  });
}

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
    log('[lsp] manager initialized');
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
        log('[lsp] getClient: waiting for init', { key, server: server.id });
        await managed.initPromise;
      }
      if (managed.client.isAlive()) {
        managed.refCount++;
        managed.lastUsedAt = Date.now();
        log('[lsp] getClient: reuse pooled client', {
          key,
          server: server.id,
          refCount: managed.refCount,
        });
        return managed.client;
      }
      log('[lsp] getClient: client dead, recreating', {
        key,
        server: server.id,
      });
      await managed.client.stop();
      this.clients.delete(key);
    }

    log('[lsp] getClient: creating new client', {
      key,
      server: server.id,
      root,
    });
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
      log('[lsp] getClient: client ready', { key, server: server.id });
    } catch (err) {
      log('[lsp] getClient: init failed', {
        key,
        server: server.id,
        error: String(err),
      });
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
      log('[lsp] releaseClient', {
        key,
        server: serverId,
        refCount: managed.refCount,
      });
    }
  }

  isServerInitializing(root: string, serverId: string): boolean {
    const key = this.getKey(root, serverId);
    const managed = this.clients.get(key);
    return managed?.isInitializing ?? false;
  }

  async stopAll(): Promise<void> {
    log('[lsp] stopAll: shutting down all clients', {
      count: this.clients.size,
    });
    for (const [key, managed] of this.clients) {
      await managed.client.stop();
      log('[lsp] stopAll: client stopped', { key });
    }
    this.clients.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    log('[lsp] stopAll: complete');
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
  private diagnosticResultIds = new Map<string, string>();
  private documents = new Map<
    string,
    { version: number; text: string; languageId: string }
  >();
  private diagnosticProvider: DiagnosticProviderCapabilities | null = null;
  private publishDiagnosticsObserved = false;
  private supportsPullDiagnostics = false;
  private workspaceConfigurationRequested = false;

  constructor(
    private root: string,
    private server: ResolvedServer,
  ) {}

  async start(): Promise<void> {
    const command = resolveServerCommand(this.server.command, this.root);
    if (!command) {
      throw new Error(
        `Failed to resolve LSP server command: ${this.server.command.join(' ')}`,
      );
    }

    log('[lsp] LSPClient.start: spawning server', {
      server: this.server.id,
      command: command.join(' '),
      root: this.root,
    });

    this.proc = spawn(command, {
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
        if (!this.publishDiagnosticsObserved) {
          this.publishDiagnosticsObserved = true;
          log('[lsp] diagnostics capabilities: publishDiagnostics observed', {
            server: this.server.id,
            ...getDiagnosticsCapabilitySummary({
              diagnosticProvider: this.diagnosticProvider,
              publishDiagnosticsObserved: this.publishDiagnosticsObserved,
              workspaceConfigurationRequested:
                this.workspaceConfigurationRequested,
            }),
          });
        }
        if (params.uri) {
          this.diagnosticsStore.set(params.uri, params.diagnostics ?? []);
        }
      },
    );

    this.connection.onRequest(
      'workspace/configuration',
      (params: { items?: unknown[] }) => {
        if (!this.workspaceConfigurationRequested) {
          this.workspaceConfigurationRequested = true;
          log(
            '[lsp] diagnostics capabilities: workspace configuration requested',
            {
              server: this.server.id,
              sections: (params.items ?? []).map((item) =>
                item && typeof item === 'object' && 'section' in item
                  ? ((item as { section?: string }).section ?? null)
                  : null,
              ),
              ...getDiagnosticsCapabilitySummary({
                diagnosticProvider: this.diagnosticProvider,
                publishDiagnosticsObserved: this.publishDiagnosticsObserved,
                workspaceConfigurationRequested:
                  this.workspaceConfigurationRequested,
              }),
            },
          );
        }
        return getWorkspaceConfiguration(
          (params.items ?? []) as Array<{ section?: string } | undefined>,
        );
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
      log('[lsp] LSPClient.start: server exited immediately', {
        server: this.server.id,
        exitCode: this.proc.exitCode,
        stderr: stderr.slice(0, 500),
      });
      throw new Error(
        `LSP server exited immediately with code ${this.proc.exitCode}` +
          (stderr ? `\nstderr: ${stderr}` : ''),
      );
    }
    log('[lsp] LSPClient.start: server spawned', { server: this.server.id });
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

    log('[lsp] LSPClient.initialize: sending initialize request', {
      server: this.server.id,
      root: this.root,
    });

    const rootUri = pathToFileURL(this.root).href;
    const result = await withTimeout(
      this.connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
        capabilities: {
          textDocument: {
            diagnostic: {},
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
      }),
      LSP_TIMEOUTS.request,
      `LSP initialize (${this.server.id})`,
    );

    const capabilities =
      result &&
      typeof result === 'object' &&
      'capabilities' in result &&
      result.capabilities &&
      typeof result.capabilities === 'object'
        ? result.capabilities
        : undefined;

    this.diagnosticProvider =
      capabilities && 'diagnosticProvider' in capabilities
        ? (capabilities.diagnosticProvider as DiagnosticProviderCapabilities)
        : null;
    this.supportsPullDiagnostics = Boolean(this.diagnosticProvider);

    log('[lsp] diagnostics capabilities negotiated', {
      server: this.server.id,
      diagnosticProvider: this.diagnosticProvider,
      ...getDiagnosticsCapabilitySummary({
        diagnosticProvider: this.diagnosticProvider,
        publishDiagnosticsObserved: this.publishDiagnosticsObserved,
        workspaceConfigurationRequested: this.workspaceConfigurationRequested,
      }),
    });

    this.connection.sendNotification('initialized', {});
    await new Promise((r) => setTimeout(r, LSP_TIMEOUTS.initializeDelay));
    log('[lsp] LSPClient.initialize: complete', { server: this.server.id });
  }

  private async waitForPublishedDiagnostics(
    uri: string,
    timeoutMs = LSP_TIMEOUTS.diagnostics,
  ): Promise<Diagnostic[] | undefined> {
    const cachedDiagnostics = this.diagnosticsStore.get(uri);
    if (cachedDiagnostics) {
      return cachedDiagnostics;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
      const diagnostics = this.diagnosticsStore.get(uri);
      if (diagnostics) {
        return diagnostics;
      }
    }

    return this.diagnosticsStore.get(uri);
  }

  async openFile(filePath: string): Promise<void> {
    await this.ensureDocumentSynced(filePath);
  }

  private async ensureDocumentSynced(filePath: string): Promise<void> {
    const absPath = resolve(filePath);
    const uri = pathToFileURL(absPath).href;

    const text = readFileSync(absPath, 'utf-8');
    const ext = extname(absPath);
    const languageId = getLanguageId(ext);

    const existing = this.documents.get(uri);

    if (!existing) {
      log('[lsp] ensureDocumentSynced: didOpen', {
        filePath: absPath,
        languageId,
        size: text.length,
      });
      this.connection?.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      });
      this.documents.set(uri, { version: 1, text, languageId });
      this.openedFiles.add(absPath);
      // allow server to settle
      await new Promise((r) => setTimeout(r, LSP_TIMEOUTS.openFileDelay));
      return;
    }

    if (existing.text !== text) {
      const newVersion = existing.version + 1;
      log('[lsp] ensureDocumentSynced: didChange', {
        filePath: absPath,
        languageId,
        oldVersion: existing.version,
        newVersion,
        size: text.length,
      });
      this.connection?.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: newVersion },
        contentChanges: [{ text }],
      });
      this.documents.set(uri, { version: newVersion, text, languageId });
      // Invalidate cached publishDiagnostics so we wait for fresh results
      this.diagnosticsStore.delete(uri);
      this.diagnosticResultIds.delete(uri);
      // allow server to settle after change
      await new Promise((r) => setTimeout(r, LSP_TIMEOUTS.openFileDelay));
    } else {
      log('[lsp] ensureDocumentSynced: already synced', { filePath: absPath });
    }
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<unknown> {
    const absPath = resolve(filePath);
    await this.openFile(absPath);
    return this.connection
      ? withTimeout(
          this.connection.sendRequest('textDocument/definition', {
            textDocument: { uri: pathToFileURL(absPath).href },
            position: { line: line - 1, character },
          }),
          LSP_TIMEOUTS.request,
          `LSP definition (${this.server.id})`,
        )
      : undefined;
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<unknown> {
    const absPath = resolve(filePath);
    await this.openFile(absPath);
    return this.connection
      ? withTimeout(
          this.connection.sendRequest('textDocument/references', {
            textDocument: { uri: pathToFileURL(absPath).href },
            position: { line: line - 1, character },
            context: { includeDeclaration },
          }),
          LSP_TIMEOUTS.request,
          `LSP references (${this.server.id})`,
        )
      : undefined;
  }

  async diagnostics(filePath: string): Promise<{ items: Diagnostic[] }> {
    const absPath = resolve(filePath);
    const uri = pathToFileURL(absPath).href;
    const startedAt = Date.now();
    await this.openFile(absPath);
    await new Promise((r) => setTimeout(r, LSP_TIMEOUTS.diagnosticSettleDelay));

    log('[lsp] diagnostics mode selected', {
      server: this.server.id,
      filePath: absPath,
      activeMode: this.supportsPullDiagnostics ? 'pull' : 'push',
      ...getDiagnosticsCapabilitySummary({
        diagnosticProvider: this.diagnosticProvider,
        publishDiagnosticsObserved: this.publishDiagnosticsObserved,
        workspaceConfigurationRequested: this.workspaceConfigurationRequested,
      }),
    });

    if (this.supportsPullDiagnostics) {
      try {
        const result = this.connection
          ? await withTimeout(
              this.connection.sendRequest('textDocument/diagnostic', {
                textDocument: { uri },
                previousResultId: this.diagnosticResultIds.get(uri),
              }),
              LSP_TIMEOUTS.diagnostics,
              `LSP diagnostics (${this.server.id})`,
            )
          : undefined;

        const report = result as DocumentDiagnosticReport | undefined;
        if (report?.kind === 'full') {
          if (report.resultId) {
            this.diagnosticResultIds.set(uri, report.resultId);
          } else {
            this.diagnosticResultIds.delete(uri);
          }
          this.diagnosticsStore.set(uri, report.items);
          return { items: report.items };
        }

        if (report?.kind === 'unchanged') {
          if (report.resultId) {
            this.diagnosticResultIds.set(uri, report.resultId);
          }
          return { items: this.diagnosticsStore.get(uri) ?? [] };
        }

        if (result && typeof result === 'object' && 'items' in result) {
          const legacyResult = result as { items: Diagnostic[] };
          this.diagnosticsStore.set(uri, legacyResult.items);
          return legacyResult;
        }
      } catch (error) {
        log('[lsp] diagnostics: falling back to cached publishDiagnostics', {
          server: this.server.id,
          error: String(error),
        });
      }
    }

    const elapsed = Date.now() - startedAt;
    const remainingTimeout = Math.max(LSP_TIMEOUTS.diagnostics - elapsed, 0);
    const cachedDiagnostics = await this.waitForPublishedDiagnostics(
      uri,
      remainingTimeout,
    );
    if (cachedDiagnostics) {
      return { items: cachedDiagnostics };
    }

    throw new Error(
      `Unable to retrieve diagnostics from ${this.server.id}: request timed out or is unsupported.`,
    );
  }

  async rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<unknown> {
    const absPath = resolve(filePath);
    await this.openFile(absPath);
    return this.connection
      ? withTimeout(
          this.connection.sendRequest('textDocument/rename', {
            textDocument: { uri: pathToFileURL(absPath).href },
            position: { line: line - 1, character },
            newName,
          }),
          LSP_TIMEOUTS.request,
          `LSP rename (${this.server.id})`,
        )
      : undefined;
  }

  isAlive(): boolean {
    return (
      this.proc !== null && !this.processExited && this.proc.exitCode === null
    );
  }

  async stop(): Promise<void> {
    log('[lsp] LSPClient.stop: stopping', { server: this.server.id });
    try {
      if (this.connection) {
        await withTimeout(
          this.connection.sendRequest('shutdown'),
          1_000,
          `LSP shutdown (${this.server.id})`,
        );
        this.connection.sendNotification('exit');
        this.connection.dispose();
      }
    } catch {}
    this.proc?.kill();
    this.proc = null;
    this.connection = null;
    this.processExited = true;
    this.diagnosticProvider = null;
    this.publishDiagnosticsObserved = false;
    this.supportsPullDiagnostics = false;
    this.workspaceConfigurationRequested = false;
    this.diagnosticsStore.clear();
    this.diagnosticResultIds.clear();
    this.documents.clear();
    log('[lsp] LSPClient.stop: complete', { server: this.server.id });
  }
}
