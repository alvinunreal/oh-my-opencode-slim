import { spawn } from "bun"
import { existsSync } from "node:fs"
import {
  getSgCliPath,
  setSgCliPath,
  findSgCliPathSync,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_MATCHES,
} from "./constants"
import { ensureAstGrepBinary } from "./downloader"
import type { CliMatch, CliLanguage, SgResult } from "./types"

export interface RunOptions {
  pattern: string
  lang: CliLanguage
  paths?: string[]
  globs?: string[]
  rewrite?: string
  context?: number
  updateAll?: boolean
}

// Use a single init promise to avoid race conditions
let initPromise: Promise<string | null> | null = null

/**
 * Resolves the path to the ast-grep binary, downloading it if necessary.
 * @returns A promise resolving to the binary path, or null if it couldn't be found/downloaded.
 */
export async function getAstGrepPath(): Promise<string | null> {
  const currentPath = getSgCliPath()
  if (currentPath !== "sg" && existsSync(currentPath)) {
    return currentPath
  }

  if (initPromise) {
    return initPromise
  }

  initPromise = (async () => {
    const syncPath = findSgCliPathSync()
    if (syncPath && existsSync(syncPath)) {
      setSgCliPath(syncPath)
      return syncPath
    }

    const downloadedPath = await ensureAstGrepBinary()
    if (downloadedPath) {
      setSgCliPath(downloadedPath)
      return downloadedPath
    }

    return null
  })()

  return initPromise
}

/**
 * Starts background initialization of the ast-grep binary.
 */
export function startBackgroundInit(): void {
  if (!initPromise) {
    initPromise = getAstGrepPath()
    initPromise.catch(() => {})
  }
}

/**
 * Runs an ast-grep search or rewrite with the provided options.
 * @param options - ast-grep configuration.
 * @returns A promise resolving to the search/rewrite results.
 */
export async function runSg(options: RunOptions): Promise<SgResult> {
  const args = ["run", "-p", options.pattern, "--lang", options.lang, "--json=compact"]

  if (options.rewrite) {
    args.push("-r", options.rewrite)
    if (options.updateAll) {
      args.push("--update-all")
    }
  }

  if (options.context && options.context > 0) {
    args.push("-C", String(options.context))
  }

  if (options.globs) {
    for (const glob of options.globs) {
      args.push("--globs", glob)
    }
  }

  const paths = options.paths && options.paths.length > 0 ? options.paths : ["."]
  args.push(...paths)

  let cliPath = getSgCliPath()

  if (!existsSync(cliPath) && cliPath !== "sg") {
    const downloadedPath = await getAstGrepPath()
    if (downloadedPath) {
      cliPath = downloadedPath
    }
  }

  const timeout = DEFAULT_TIMEOUT_MS

  const proc = spawn([cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const timeoutPromise = new Promise<never>(async (_, reject) => {
    const id = setTimeout(() => {
      proc.kill()
      reject(new Error(`[ast-grep] run: Search timeout after ${timeout}ms`))
    }, timeout)
    await proc.exited
    clearTimeout(id)
  })

  let stdout: string
  let stderr: string
  let exitCode: number

  try {
    stdout = await Promise.race([new Response(proc.stdout).text(), timeoutPromise])
    stderr = await new Response(proc.stderr).text()
    exitCode = await proc.exited
  } catch (e) {
    const error = e as Error
    if (error.message?.includes("timeout")) {
      return {
        matches: [],
        totalMatches: 0,
        truncated: true,
        truncatedReason: "timeout",
        error: `[ast-grep] run: ${error.message}`,
      }
    }

    const nodeError = e as NodeJS.ErrnoException
    if (
      nodeError.code === "ENOENT" ||
      nodeError.message?.includes("ENOENT") ||
      nodeError.message?.includes("not found")
    ) {
      const downloadedPath = await ensureAstGrepBinary()
      if (downloadedPath) {
        setSgCliPath(downloadedPath)
        return runSg(options)
      } else {
        return {
          matches: [],
          totalMatches: 0,
          truncated: false,
          error:
            `[ast-grep] run: ast-grep CLI binary not found.\n\n` +
            `Auto-download failed. Manual install options:\n` +
            `  bun add -D @ast-grep/cli\n` +
            `  cargo install ast-grep --locked\n` +
            `  brew install ast-grep`,
        }
      }
    }

    return {
      matches: [],
      totalMatches: 0,
      truncated: false,
      error: `[ast-grep] run: Failed to spawn ast-grep: ${error.message}`,
    }
  }

  if (exitCode !== 0 && stdout.trim() === "") {
    if (stderr.includes("No files found")) {
      return { matches: [], totalMatches: 0, truncated: false }
    }
    if (stderr.trim()) {
      return { matches: [], totalMatches: 0, truncated: false, error: `[ast-grep] run: ${stderr.trim()}` }
    }
    return { matches: [], totalMatches: 0, truncated: false }
  }

  if (!stdout.trim()) {
    return { matches: [], totalMatches: 0, truncated: false }
  }

  const outputTruncated = stdout.length >= DEFAULT_MAX_OUTPUT_BYTES
  const outputToProcess = outputTruncated ? stdout.substring(0, DEFAULT_MAX_OUTPUT_BYTES) : stdout

  let matches: CliMatch[] = []
  try {
    matches = JSON.parse(outputToProcess) as CliMatch[]
  } catch {
    if (outputTruncated) {
      try {
        const lastValidIndex = outputToProcess.lastIndexOf("}")
        if (lastValidIndex > 0) {
          const bracketIndex = outputToProcess.lastIndexOf("},", lastValidIndex)
          if (bracketIndex > 0) {
            const truncatedJson = outputToProcess.substring(0, bracketIndex + 1) + "]"
            matches = JSON.parse(truncatedJson) as CliMatch[]
          }
        }
      } catch {
        return {
          matches: [],
          totalMatches: 0,
          truncated: true,
          truncatedReason: "max_output_bytes",
          error: "[ast-grep] run: Output too large and could not be parsed",
        }
      }
    } else {
      return { matches: [], totalMatches: 0, truncated: false }
    }
  }

  const totalMatches = matches.length
  const matchesTruncated = totalMatches > DEFAULT_MAX_MATCHES
  const finalMatches = matchesTruncated ? matches.slice(0, DEFAULT_MAX_MATCHES) : matches

  return {
    matches: finalMatches,
    totalMatches,
    truncated: outputTruncated || matchesTruncated,
    truncatedReason: outputTruncated
      ? "max_output_bytes"
      : matchesTruncated
        ? "max_matches"
        : undefined,
  }
}

/**
 * Checks if the ast-grep CLI is available on the system.
 * @returns True if the CLI is available, false otherwise.
 */
export function isCliAvailable(): boolean {
  const path = findSgCliPathSync()
  return path !== null && existsSync(path)
}

/**
 * Ensures that the ast-grep CLI is available, downloading it if necessary.
 * @returns A promise resolving to true if available, false otherwise.
 */
export async function ensureCliAvailable(): Promise<boolean> {
  const path = await getAstGrepPath()
  return path !== null && existsSync(path)
}
