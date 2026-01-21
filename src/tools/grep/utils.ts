import { groupByFile } from "../../shared"
import type { GrepResult } from "./types"

export function formatGrepResult(result: GrepResult): string {
  if (result.error) {
    return `Error: ${result.error}`
  }

  if (result.matches.length === 0) {
    return "No matches found."
  }

  const lines: string[] = []

  // Group matches by file
  const byFile = groupByFile(result.matches)

  for (const [file, matches] of byFile) {
    lines.push(`\n${file}:`)
    for (const match of matches) {
      lines.push(`  ${match.line}: ${match.text}`)
    }
  }

  const summary = `Found ${result.totalMatches} matches in ${result.filesSearched} files`
  if (result.truncated) {
    lines.push(`\n${summary} (output truncated)`)
  } else {
    lines.push(`\n${summary}`)
  }

  return lines.join("\n")
}
