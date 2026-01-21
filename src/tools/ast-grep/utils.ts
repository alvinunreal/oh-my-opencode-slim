import type { SgResult, CliLanguage } from "./types"

/**
 * Formats an ast-grep search result into a human-readable summary.
 * @param result - The SgResult containing matches or error.
 * @returns A formatted string summary.
 */
export function formatSearchResult(result: SgResult): string {
  if (result.error) {
    return `Error: ${result.error}`
  }

  if (result.matches.length === 0) {
    return "No matches found."
  }

  const lines: string[] = []

  // Group matches by file
  const byFile = new Map<string, typeof result.matches>()
  for (const match of result.matches) {
    const existing = byFile.get(match.file) || []
    existing.push(match)
    byFile.set(match.file, existing)
  }

  for (const [file, matches] of byFile) {
    lines.push(`\n${file}:`)
    for (const match of matches) {
      const startLine = match.range.start.line + 1
      const text = match.text.length > 100 ? match.text.substring(0, 100) + "..." : match.text
      lines.push(`  ${startLine}: ${text.replace(/\n/g, "\\n")}`)
    }
  }

  const fileCount = byFile.size
  const summary = `Found ${result.totalMatches} matches in ${fileCount} files`
  if (result.truncated) {
    lines.push(`\n${summary} (output truncated: ${result.truncatedReason})`)
  } else {
    lines.push(`\n${summary}`)
  }

  return lines.join("\n")
}

/**
 * Formats an ast-grep replacement result into a human-readable summary.
 * @param result - The SgResult containing matches/replacements.
 * @param isDryRun - Whether this was a dry run.
 * @returns A formatted string summary.
 */
export function formatReplaceResult(result: SgResult, isDryRun: boolean): string {
  if (result.error) {
    return `Error: ${result.error}`
  }

  if (result.matches.length === 0) {
    return "No matches found for replacement."
  }

  const lines: string[] = []
  const mode = isDryRun ? "[DRY RUN]" : "[APPLIED]"

  // Group by file
  const byFile = new Map<string, typeof result.matches>()
  for (const match of result.matches) {
    const existing = byFile.get(match.file) || []
    existing.push(match)
    byFile.set(match.file, existing)
  }

  for (const [file, matches] of byFile) {
    lines.push(`\n${file}:`)
    for (const match of matches) {
      const startLine = match.range.start.line + 1
      const original = match.text.length > 60 ? match.text.substring(0, 60) + "..." : match.text
      const replacement = match.replacement
        ? match.replacement.length > 60
          ? match.replacement.substring(0, 60) + "..."
          : match.replacement
        : "[no replacement]"
      lines.push(`  ${startLine}: "${original.replace(/\n/g, "\\n")}" → "${replacement.replace(/\n/g, "\\n")}"`)
    }
  }

  const fileCount = byFile.size
  lines.push(`\n${mode} ${result.totalMatches} replacements in ${fileCount} files`)

  if (isDryRun) {
    lines.push("\nTo apply changes, run with dryRun=false")
  }

  return lines.join("\n")
}

/**
 * Provides helpful hints for common mistakes when an ast-grep search returns no results.
 * @param pattern - The pattern that was searched.
 * @param lang - The language used for the search.
 * @returns A hint string if a common mistake is detected, otherwise null.
 */
export function getEmptyResultHint(pattern: string, lang: CliLanguage): string | null {
  const src = pattern.trim()

  if (lang === "python") {
    if (src.startsWith("class ") && src.endsWith(":")) {
      const withoutColon = src.slice(0, -1)
      return `Hint: Remove trailing colon. Try: "${withoutColon}"`
    }
    if ((src.startsWith("def ") || src.startsWith("async def ")) && src.endsWith(":")) {
      const withoutColon = src.slice(0, -1)
      return `Hint: Remove trailing colon. Try: "${withoutColon}"`
    }
  }

  if (["javascript", "typescript", "tsx"].includes(lang)) {
    if (/^(export\s+)?(async\s+)?function\s+\$[A-Z_]+\s*$/i.test(src)) {
      return `Hint: Function patterns need params and body. Try "function $NAME($$$) { $$$ }"`
    }
  }

  return null
}
