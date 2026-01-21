import { existsSync } from "node:fs"
import { join } from "node:path"
import { getDefaultInstallDir, ensureBinary } from "../../shared/binary-downloader"

const RG_VERSION = "14.1.1"

// Platform key format: ${process.platform}-${process.arch}
const PLATFORM_CONFIG: Record<string, { platform: string; extension: "tar.gz" | "zip" } | undefined> =
  {
    "darwin-arm64": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
    "darwin-x64": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
    "linux-arm64": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
    "linux-x64": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
    "win32-x64": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
  }

function getPlatformKey(): string {
  return `${process.platform}-${process.arch}`
}

function getRgPath(): string {
  const isWindows = process.platform === "win32"
  return join(getDefaultInstallDir(), isWindows ? "rg.exe" : "rg")
}

export async function downloadAndInstallRipgrep(): Promise<string> {
  const platformKey = getPlatformKey()
  const config = PLATFORM_CONFIG[platformKey]

  if (!config) {
    throw new Error(`[grep] download: Unsupported platform: ${platformKey}`)
  }

  const filename = `ripgrep-${RG_VERSION}-${config.platform}.${config.extension}`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${filename}`

  return ensureBinary({
    binaryName: "rg",
    version: RG_VERSION,
    url,
    installDir: getDefaultInstallDir(),
    archiveName: filename,
    isZip: config.extension === "zip",
    tarInclude: "*/rg",
  })
}

export function getInstalledRipgrepPath(): string | null {
  const rgPath = getRgPath()
  return existsSync(rgPath) ? rgPath : null
}
