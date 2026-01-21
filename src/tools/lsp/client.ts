// LSP Client - Full implementation with connection pooling

import { spawn, type Subprocess } from "bun"
import { readFileSync } from "fs"
import { extname, resolve } from "path"
import { pathToFileURL } from "node:url"
import { getLanguageId } from "./config"
import type { Diagnostic, ResolvedServer } from "./types"
import { parseMessages } from "./protocol-parser"
import { sleep } from "../../utils/polling"

interface ManagedClient {
  client: LSPClient
  lastUsedAt: number
  refCount: number
  initPromise?: Promise<void>
  isInitializing: boolean
}

class LSPServerManager {
  private static instance: LSPServerManager
  private clients = new Map<string, ManagedClient>()
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000

  private constructor() {
    this.startCleanupTimer()
    this.registerProcessCleanup()
  }

  private registerProcessCleanup(): void {
    const cleanup = () => {
      for (const [, managed] of this.clients) {
        try {
          managed.client.stop()
        } catch {}
      }
      this.clients.clear()
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval)
        this.cleanupInterval = null
      }
    }

    process.on("exit", cleanup)
    process.on("SIGINT", () => {
      cleanup()
      process.exit(0)
    })
    process.on("SIGTERM", () => {
      cleanup()
      process.exit(0)
    })
  }

  static getInstance(): LSPServerManager {
    if (!LSPServerManager.instance) {
      LSPServerManager.instance = new LSPServerManager()
    }
    return LSPServerManager.instance
  }

  private getKey(root: string, serverId: string): string {
    return `${root}::${serverId}`
  }

  private startCleanupTimer(): void {
    if (this.cleanupInterval) return
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleClients()
    }, 60000)
  }

  private cleanupIdleClients(): void {
    const now = Date.now()
    for (const [key, managed] of this.clients) {
      if (managed.refCount === 0 && now - managed.lastUsedAt > this.IDLE_TIMEOUT) {
        managed.client.stop()
        this.clients.delete(key)
      }
    }
  }

  async getClient(root: string, server: ResolvedServer): Promise<LSPClient> {
    const key = this.getKey(root, server.id)

    let managed = this.clients.get(key)
    if (managed) {
      if (managed.initPromise) {
        await managed.initPromise
      }
      if (managed.client.isAlive()) {
        managed.refCount++
        managed.lastUsedAt = Date.now()
        return managed.client
      }
      await managed.client.stop()
      this.clients.delete(key)
    }

    const client = new LSPClient(root, server)
    const initPromise = (async () => {
      await client.start()
      await client.initialize()
    })()

    this.clients.set(key, {
      client,
      lastUsedAt: Date.now(),
      refCount: 1,
      initPromise,
      isInitializing: true,
    })

    try {
      await initPromise
      const m = this.clients.get(key)
      if (m) {
        m.initPromise = undefined
        m.isInitializing = false
      }
    } catch (err) {
      this.clients.delete(key)
      throw new Error(`[lsp-client] getClient: ${err instanceof Error ? err.message : String(err)}`)
    }

    return client
  }

  releaseClient(root: string, serverId: string): void {
    const key = this.getKey(root, serverId)
    const managed = this.clients.get(key)
    if (managed && managed.refCount > 0) {
      managed.refCount--
      managed.lastUsedAt = Date.now()
    }
  }

  isServerInitializing(root: string, serverId: string): boolean {
    const key = this.getKey(root, serverId)
    const managed = this.clients.get(key)
    return managed?.isInitializing ?? false
  }

  async stopAll(): Promise<void> {
    for (const [, managed] of this.clients) {
      await managed.client.stop()
    }
    this.clients.clear()
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

export const lspManager = LSPServerManager.getInstance()

export class LSPClient {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  private buffer: Uint8Array = new Uint8Array(0)
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private requestIdCounter = 0
  private openedFiles = new Set<string>()
  private stderrBuffer: string[] = []
  private processExited = false
  private diagnosticsStore = new Map<string, Diagnostic[]>()

  constructor(
    private root: string,
    private server: ResolvedServer
  ) {}

  async start(): Promise<void> {
    this.proc = spawn(this.server.command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.root,
      env: {
        ...process.env,
        ...this.server.env,
      },
    })

    if (!this.proc) {
      throw new Error(`[lsp-client] start: Failed to spawn LSP server: ${this.server.command.join(" ")}`)
    }

    this.startReading()
    this.startStderrReading()

    await sleep(100)

    if (this.proc.exitCode !== null) {
      const stderr = this.stderrBuffer.join("\n")
      throw new Error(
        `[lsp-client] start: LSP server exited immediately with code ${this.proc.exitCode}` +
          (stderr ? `\nstderr: ${stderr}` : "")
      )
    }
  }

  private startReading(): void {
    if (!this.proc) return

    const reader = this.proc.stdout.getReader()
    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            this.processExited = true
            this.rejectAllPending("[lsp-client] startReading: LSP server stdout closed")
            break
          }
          const newBuf = new Uint8Array(this.buffer.length + value.length)
          newBuf.set(this.buffer)
          newBuf.set(value, this.buffer.length)
          this.buffer = newBuf
          this.processBuffer()
        }
      } catch (err) {
        this.processExited = true
        const message = err instanceof Error ? err.message : String(err)
        this.rejectAllPending(`[lsp-client] startReading: ${message}`)
      }
    }
    read()
  }

  private startStderrReading(): void {
    if (!this.proc) return

    const reader = this.proc.stderr.getReader()
    const read = async () => {
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value)
          this.stderrBuffer.push(text)
          if (this.stderrBuffer.length > 100) {
            this.stderrBuffer.shift()
          }
        }
      } catch {}
    }
    read()
  }

  private rejectAllPending(reason: string): void {
    for (const [id, handler] of this.pending) {
      handler.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  private processBuffer(): void {
    const { messages, remainingBuffer } = parseMessages(this.buffer)
    this.buffer = remainingBuffer

    for (const msg of messages) {
      try {
        if ("method" in msg && !("id" in msg)) {
          if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
            this.diagnosticsStore.set(msg.params.uri, msg.params.diagnostics ?? [])
          }
        } else if ("id" in msg && "method" in msg) {
          this.handleServerRequest(msg.id, msg.method, msg.params)
        } else if ("id" in msg && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if ("error" in msg) {
            handler.reject(new Error(`[lsp-client] response: ${msg.error.message}`))
          } else {
            handler.resolve(msg.result)
          }
        }
      } catch (err) {
        console.error(`[lsp-client] Error handling message: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private send(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc) throw new Error("[lsp-client] send: LSP client not started")

    if (this.processExited || this.proc.exitCode !== null) {
      const stderr = this.stderrBuffer.slice(-10).join("\n")
      throw new Error(
        `[lsp-client] send: LSP server already exited (code: ${this.proc.exitCode})` + (stderr ? `\nstderr: ${stderr}` : "")
      )
    }

    const id = ++this.requestIdCounter
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`
    this.proc.stdin.write(header + msg)

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          const stderr = this.stderrBuffer.slice(-5).join("\n")
          reject(
            new Error(
              `[lsp-client] send: LSP request timeout (method: ${method})` + (stderr ? `\nrecent stderr: ${stderr}` : "")
            )
          )
        }
      }, 15000)
    })
  }

  private notify(method: string, params?: unknown): void {
    if (!this.proc) throw new Error("[lsp-client] notify: LSP client not started")
    if (this.processExited || this.proc.exitCode !== null) {
      throw new Error("[lsp-client] notify: LSP server already exited")
    }

    const msg = JSON.stringify({ jsonrpc: "2.0", method, params })
    try {
      this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`)
    } catch (err) {
      throw new Error(`[lsp-client] notify: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private respond(id: number | string, result: unknown): void {
    if (!this.proc) return
    if (this.processExited || this.proc.exitCode !== null) return

    const msg = JSON.stringify({ jsonrpc: "2.0", id, result })
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`)
  }

  private handleServerRequest(id: number | string, method: string, params?: unknown): void {
    if (method === "workspace/configuration") {
      const items = (params as { items?: Array<{ section?: string }> })?.items ?? []
      const result = items.map((item) => {
        if (item.section === "json") return { validate: { enable: true } }
        return {}
      })
      this.respond(id, result)
    } else if (method === "client/registerCapability") {
      this.respond(id, null)
    } else if (method === "window/workDoneProgress/create") {
      this.respond(id, null)
    }
  }

  async initialize(): Promise<void> {
    try {
      const rootUri = pathToFileURL(this.root).href
      await this.send("initialize", {
        processId: process.pid,
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: "workspace" }],
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
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
      })
      this.notify("initialized")
      await sleep(300)
    } catch (err) {
      throw new Error(`[lsp-client] initialize: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async openFile(filePath: string): Promise<void> {
    const absPath = resolve(filePath)
    if (this.openedFiles.has(absPath)) return

    const text = readFileSync(absPath, "utf-8")
    const ext = extname(absPath)
    const languageId = getLanguageId(ext)

    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(absPath).href,
        languageId,
        version: 1,
        text,
      },
    })
    this.openedFiles.add(absPath)

    await sleep(1000)
  }

  async definition(filePath: string, line: number, character: number): Promise<unknown> {
    const absPath = resolve(filePath)
    await this.openFile(absPath)
    return this.send("textDocument/definition", {
      textDocument: { uri: pathToFileURL(absPath).href },
      position: { line: line - 1, character },
    })
  }

  async references(filePath: string, line: number, character: number, includeDeclaration = true): Promise<unknown> {
    const absPath = resolve(filePath)
    await this.openFile(absPath)
    return this.send("textDocument/references", {
      textDocument: { uri: pathToFileURL(absPath).href },
      position: { line: line - 1, character },
      context: { includeDeclaration },
    })
  }

  async diagnostics(filePath: string): Promise<{ items: Diagnostic[] }> {
    const absPath = resolve(filePath)
    const uri = pathToFileURL(absPath).href
    await this.openFile(absPath)
    await sleep(500)

    try {
      const result = await this.send("textDocument/diagnostic", {
        textDocument: { uri },
      })
      if (result && typeof result === "object" && "items" in result) {
        return result as { items: Diagnostic[] }
      }
    } catch {}

    return { items: this.diagnosticsStore.get(uri) ?? [] }
  }

  async rename(filePath: string, line: number, character: number, newName: string): Promise<unknown> {
    const absPath = resolve(filePath)
    await this.openFile(absPath)
    return this.send("textDocument/rename", {
      textDocument: { uri: pathToFileURL(absPath).href },
      position: { line: line - 1, character },
      newName,
    })
  }

  isAlive(): boolean {
    return this.proc !== null && !this.processExited && this.proc.exitCode === null
  }

  async stop(): Promise<void> {
    try {
      try {
        this.notify("shutdown", {})
        this.notify("exit")
      } catch {}
      this.proc?.kill()
      this.proc = null
      this.processExited = true
      this.diagnosticsStore.clear()
    } catch (err) {
      throw new Error(`[lsp-client] stop: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
