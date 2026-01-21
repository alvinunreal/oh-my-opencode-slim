// LSP Utilities - Essential formatters and helpers

import { extname, resolve, dirname, join } from "path"
import { fileURLToPath } from "node:url"
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "fs"
import { lspManager } from "./client"
import type { LSPClient } from "./client"
import { findServerForExtension } from "./config"
import { SEVERITY_MAP } from "./constants"
import { applyTextEditsToFile } from "./text-editor"
import type {
  Location,
  LocationLink,
  Diagnostic,
  WorkspaceEdit,
  TextEdit,
  ServerLookupResult,
} from "./types"

/**
 * Finds the workspace root for a given file by looking for common markers like .git or package.json.
 * @param filePath - The path to the file.
 * @returns The resolved workspace root directory.
 */
export function findWorkspaceRoot(filePath: string): string {
  let dir = resolve(filePath)

  try {
    if (!statSync(dir).isDirectory()) {
      dir = dirname(dir)
    }
  } catch {
    dir = dirname(dir)
  }

  const markers = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]

  let prevDir = ""
  while (dir !== prevDir) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) {
        return dir
      }
    }
    prevDir = dir
    dir = dirname(dir)
  }

  return dirname(resolve(filePath))
}

/**
 * Converts a file URI to a local filesystem path.
 * @param uri - The file URI (e.g., 'file:///path/to/file').
 * @returns The local filesystem path.
 */
export function uriToPath(uri: string): string {
  return fileURLToPath(uri)
}

export function formatServerLookupError(result: Exclude<ServerLookupResult, { status: "found" }>): string {
  if (result.status === "not_installed") {
    return [
      `[lsp-utils] findServer: LSP server '${result.server.id}' is NOT INSTALLED.`,
      ``,
      `Command not found: ${result.server.command[0]}`,
      ``,
      `To install: ${result.installHint}`,
    ].join("\n")
  }

  return `[lsp-utils] findServer: No LSP server configured for extension: ${result.extension}`
}

/**
 * Executes a callback function with an LSP client for the given file.
 * Manages client acquisition and release automatically.
 * @param filePath - The path to the file to get a client for.
 * @param fn - The callback function to execute with the client.
 * @returns The result of the callback function.
 * @throws Error if no suitable LSP server is found or if the client times out.
 */
export async function withLspClient<T>(filePath: string, fn: (client: LSPClient) => Promise<T>): Promise<T> {
  const absPath = resolve(filePath)
  const ext = extname(absPath)
  const result = findServerForExtension(ext)

  if (result.status !== "found") {
    throw new Error(formatServerLookupError(result))
  }

  const server = result.server
  const root = findWorkspaceRoot(absPath)
  const client = await lspManager.getClient(root, server)

  try {
    return await fn(client)
  } catch (e) {
    if (e instanceof Error && e.message.includes("timeout")) {
      const isInitializing = lspManager.isServerInitializing(root, server.id)
      if (isInitializing) {
        throw new Error(`[lsp-utils] withLspClient: LSP server is still initializing. Please retry in a few seconds.`)
      }
    }
    throw e
  } finally {
    lspManager.releaseClient(root, server.id)
  }
}

/**
 * Formats an LSP location or location link into a human-readable string (path:line:char).
 * @param loc - The LSP location or location link.
 * @returns A formatted string representation.
 */
export function formatLocation(loc: Location | LocationLink): string {
  if ("targetUri" in loc) {
    const uri = uriToPath(loc.targetUri)
    const line = loc.targetRange.start.line + 1
    const char = loc.targetRange.start.character
    return `${uri}:${line}:${char}`
  }

  const uri = uriToPath(loc.uri)
  const line = loc.range.start.line + 1
  const char = loc.range.start.character
  return `${uri}:${line}:${char}`
}

export function formatSeverity(severity: number | undefined): string {
  if (!severity) return "unknown"
  return SEVERITY_MAP[severity] || `unknown(${severity})`
}

/**
 * Formats an LSP diagnostic into a human-readable string.
 * @param diag - The LSP diagnostic.
 * @returns A formatted string representation.
 */
export function formatDiagnostic(diag: Diagnostic): string {
  const severity = formatSeverity(diag.severity)
  const line = diag.range.start.line + 1
  const char = diag.range.start.character
  const source = diag.source ? `[${diag.source}]` : ""
  const code = diag.code ? ` (${diag.code})` : ""
  return `${severity}${source}${code} at ${line}:${char}: ${diag.message}`
}

export function filterDiagnosticsBySeverity(
  diagnostics: Diagnostic[],
  severityFilter?: "error" | "warning" | "information" | "hint" | "all"
): Diagnostic[] {
  if (!severityFilter || severityFilter === "all") {
    return diagnostics
  }

  const severityMap: Record<string, number> = {
    error: 1,
    warning: 2,
    information: 3,
    hint: 4,
  }

  const targetSeverity = severityMap[severityFilter]
  return diagnostics.filter((d) => d.severity === targetSeverity)
}

// WorkspaceEdit application

export interface ApplyResult {
  success: boolean
  filesModified: string[]
  totalEdits: number
  errors: string[]
}

/**
 * Applies an LSP workspace edit to the local filesystem.
 * Supports both 'changes' (TextEdits) and 'documentChanges' (Create/Rename/Delete/Edit).
 * @param edit - The workspace edit to apply.
 * @returns An object containing the success status, modified files, and any errors.
 */
export function applyWorkspaceEdit(edit: WorkspaceEdit | null): ApplyResult {
  if (!edit) {
    return { success: false, filesModified: [], totalEdits: 0, errors: ["[lsp-utils] applyWorkspaceEdit: No edit provided"] }
  }

  const result: ApplyResult = { success: true, filesModified: [], totalEdits: 0, errors: [] }

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const filePath = uriToPath(uri)
      const applyResult = applyTextEditsToFile(filePath, edits)

      if (applyResult.success) {
        result.filesModified.push(filePath)
        result.totalEdits += applyResult.editCount
      } else {
        result.success = false
        result.errors.push(`[lsp-utils] applyWorkspaceEdit: ${filePath}: ${applyResult.error?.replace("[lsp-utils] applyTextEdits: ", "")}`)
      }
    }
  }

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("kind" in change) {
        if (change.kind === "create") {
          try {
            const filePath = uriToPath(change.uri)
            writeFileSync(filePath, "", "utf-8")
            result.filesModified.push(filePath)
          } catch (err) {
            result.success = false
            const message = err instanceof Error ? err.message : String(err)
            result.errors.push(`[lsp-utils] applyWorkspaceEdit: Create ${change.uri}: ${message}`)
          }
        } else if (change.kind === "rename") {
          try {
            const oldPath = uriToPath(change.oldUri)
            const newPath = uriToPath(change.newUri)
            const content = readFileSync(oldPath, "utf-8")
            writeFileSync(newPath, content, "utf-8")
            unlinkSync(oldPath)
            result.filesModified.push(newPath)
          } catch (err) {
            result.success = false
            const message = err instanceof Error ? err.message : String(err)
            result.errors.push(`[lsp-utils] applyWorkspaceEdit: Rename ${change.oldUri}: ${message}`)
          }
        } else if (change.kind === "delete") {
          try {
            const filePath = uriToPath(change.uri)
            unlinkSync(filePath)
            result.filesModified.push(filePath)
          } catch (err) {
            result.success = false
            const message = err instanceof Error ? err.message : String(err)
            result.errors.push(`[lsp-utils] applyWorkspaceEdit: Delete ${change.uri}: ${message}`)
          }
        }
      } else {
        const filePath = uriToPath(change.textDocument.uri)
        const applyResult = applyTextEditsToFile(filePath, change.edits)

        if (applyResult.success) {
          result.filesModified.push(filePath)
          result.totalEdits += applyResult.editCount
        } else {
          result.success = false
          result.errors.push(`${filePath}: ${applyResult.error}`)
        }
      }
    }
  }

  return result
}

/**
 * Formats the result of a workspace edit application into a human-readable summary.
 * @param result - The apply result from applyWorkspaceEdit.
 * @returns A formatted summary string.
 */
export function formatApplyResult(result: ApplyResult): string {
  const lines: string[] = []

  if (result.success) {
    lines.push(`Applied ${result.totalEdits} edit(s) to ${result.filesModified.length} file(s):`)
    for (const file of result.filesModified) {
      lines.push(`  - ${file}`)
    }
  } else {
    lines.push("Failed to apply some changes:")
    for (const err of result.errors) {
      lines.push(`  Error: ${err}`)
    }
    if (result.filesModified.length > 0) {
      lines.push(`Successfully modified: ${result.filesModified.join(", ")}`)
    }
  }

  return lines.join("\n")
}
