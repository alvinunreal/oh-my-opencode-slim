import { existsSync, mkdirSync, chmodSync, unlinkSync, readdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { spawn } from "bun"
import { extractZip } from "../../shared"
import { log } from "../../shared/logger"

export interface DownloadOptions {
  binaryName: string
  version: string
  url: string
  installDir: string
  archiveName: string
  isZip: boolean
  tarInclude?: string
}

/**
 * Downloads a file from a URL to a local destination path.
 * Supports redirects.
 * @param url - The URL to download from.
 * @param destPath - The local path to save the file to.
 * @returns A promise that resolves when the download is complete.
 * @throws Error if the download fails.
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`)
  }
  const buffer = await response.arrayBuffer()
  await Bun.write(destPath, buffer)
}

/**
 * Extracts a .tar.gz archive using the system 'tar' command.
 * @param archivePath - Path to the archive file.
 * @param destDir - Directory to extract into.
 * @param include - Optional pattern of files to include.
 * @returns A promise that resolves when extraction is complete.
 * @throws Error if extraction fails.
 */
export async function extractTarGz(archivePath: string, destDir: string, include?: string): Promise<void> {
  const args = ["tar", "-xzf", archivePath, "--strip-components=1"]
  
  if (include) {
    if (process.platform === "darwin") {
      args.push(`--include=${include}`)
    } else if (process.platform === "linux") {
      args.push("--wildcards", include)
    }
  }

  const proc = spawn(args, {
    cwd: destDir,
    stdout: "pipe",
    stderr: "pipe",
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`Failed to extract tar.gz: ${stderr}`)
  }
}

/**
 * Recursively searches for a file with a specific name within a directory.
 * @param dir - The directory to search in.
 * @param filename - The name of the file to find.
 * @returns The full path to the found file, or null if not found.
 */
export function findFileRecursive(dir: string, filename: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name === filename) {
        // Bun 1.1+ supports entry.parentPath, fallback to dir if not available
        return join((entry as any).parentPath ?? dir, entry.name)
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Gets the default installation directory for binaries based on the OS.
 * @returns The absolute path to the default installation directory.
 */
export function getDefaultInstallDir(): string {
  const home = homedir()
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA
    const base = localAppData || join(home, "AppData", "Local")
    return join(base, "oh-my-opencode-slim", "bin")
  }

  const xdgCache = process.env.XDG_CACHE_HOME
  const base = xdgCache || join(home, ".cache")
  return join(base, "oh-my-opencode-slim", "bin")
}

/**
 * Ensures a binary is available locally, downloading and extracting it if necessary.
 * @param options - Download and installation options.
 * @returns A promise resolving to the absolute path of the binary.
 * @throws Error if download or extraction fails, or if the binary is not found.
 */
export async function ensureBinary(options: DownloadOptions): Promise<string> {
  const { binaryName, url, installDir, archiveName, isZip, tarInclude } = options
  const isWindows = process.platform === "win32"
  const fullBinaryName = isWindows ? `${binaryName}.exe` : binaryName
  const binaryPath = join(installDir, fullBinaryName)

  if (existsSync(binaryPath)) {
    return binaryPath
  }

  if (!existsSync(installDir)) {
    mkdirSync(installDir, { recursive: true })
  }

  const archivePath = join(installDir, archiveName)

  try {
    log(`[oh-my-opencode-slim] Downloading ${binaryName}...`)
    await downloadFile(url, archivePath)

    if (isZip) {
      await extractZip(archivePath, installDir)
      
      // Some zips have nested structures, try to find the binary and move it to the root of installDir
      const foundPath = findFileRecursive(installDir, fullBinaryName)
      if (foundPath && foundPath !== binaryPath) {
        renameSync(foundPath, binaryPath)
      }
    } else {
      await extractTarGz(archivePath, installDir, tarInclude)
    }

    if (!isWindows && existsSync(binaryPath)) {
      chmodSync(binaryPath, 0o755)
    }

    if (!existsSync(binaryPath)) {
      throw new Error(`${binaryName} binary not found after extraction`)
    }

    log(`[oh-my-opencode-slim] ${binaryName} ready.`)
    return binaryPath
  } finally {
    if (existsSync(archivePath)) {
      try {
        unlinkSync(archivePath)
      } catch {
        // Cleanup failures are non-critical
      }
    }
  }
}
