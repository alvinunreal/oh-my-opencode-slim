export function groupByFile<T extends { file: string }>(items: T[]): Map<string, T[]> {
  const byFile = new Map<string, T[]>()
  for (const item of items) {
    const existing = byFile.get(item.file) || []
    existing.push(item)
    byFile.set(item.file, existing)
  }
  return byFile
}

export function formatSimpleResults<T extends { line: number; text: string }>(
  file: string,
  matches: T[],
  limit = 100
): string[] {
  const lines: string[] = [`\n${file}:`]
  for (const match of matches) {
    const text = match.text.length > limit ? match.text.substring(0, limit) + "..." : match.text
    lines.push(`  ${match.line}: ${text.replace(/\n/g, "\\n")}`)
  }
  return lines
}
