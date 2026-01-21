import { existsSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { getDefaultInstallDir, ensureBinary } from "../../shared/binary-downloader"

export function getCacheDir(): string {
  return getDefaultInstallDir()
}

const REPO = "ast-grep/ast-grep"

// IMPORTANT: Update this when bumping @ast-grep/cli in package.json
// This is only used as fallback when @ast-grep/cli package.json cannot be read
const DEFAULT_VERSION = "0.40.0"

function getAstGrepVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require("@ast-grep/cli/package.json")
    return pkg.version
  } catch {
    return DEFAULT_VERSION
  }
}

interface PlatformInfo {
  arch: string
  os: string
}

const PLATFORM_MAP: Record<string, PlatformInfo> = {
  "darwin-arm64": { arch: "aarch64", os: "apple-darwin" },
  "darwin-x64": { arch: "x86_64", os: "apple-darwin" },
  "linux-arm64": { arch: "aarch64", os: "unknown-linux-gnu" },
  "linux-x64": { arch: "x86_64", os: "unknown-linux-gnu" },
  "win32-x64": { arch: "x86_64", os: "pc-windows-msvc" },
  "win32-arm64": { arch: "aarch64", os: "pc-windows-msvc" },
  "win32-ia32": { arch: "i686", os: "pc-windows-msvc" },
}

export function getBinaryName(): string {
  return process.platform === "win32" ? "sg.exe" : "sg"
}

export function getCachedBinaryPath(): string | null {
  const binaryPath = join(getDefaultInstallDir(), getBinaryName())
  return existsSync(binaryPath) ? binaryPath : null
}

export async function downloadAstGrep(version: string = DEFAULT_VERSION): Promise<string | null> {
  const platformKey = `${process.platform}-${process.arch}`
  const platformInfo = PLATFORM_MAP[platformKey]

  if (!platformInfo) {
    return null
  }

  const { arch, os } = platformInfo
  const assetName = `app-${arch}-${os}.zip`
  const url = `https://github.com/${REPO}/releases/download/${version}/${assetName}`

  try {
    return await ensureBinary({
      binaryName: "sg",
      version,
      url,
      installDir: getDefaultInstallDir(),
      archiveName: assetName,
      isZip: true,
    })
  } catch {
    return null
  }
}

export async function ensureAstGrepBinary(): Promise<string | null> {
  const cachedPath = getCachedBinaryPath()
  if (cachedPath) {
    return cachedPath
  }

  const version = getAstGrepVersion()
  return downloadAstGrep(version)
}
