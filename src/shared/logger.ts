import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const logFile = path.join(os.tmpdir(), "oh-my-opencode-slim.log")

export function log(message: string, data?: unknown): void {
  try {
    const timestamp = new Date().toISOString()
    const logEntry = `[${timestamp}] ${message} ${data ? JSON.stringify(data) : ""}\n`
    fs.appendFileSync(logFile, logEntry)
  } catch {
    // Silently ignore logging errors
  }
}
