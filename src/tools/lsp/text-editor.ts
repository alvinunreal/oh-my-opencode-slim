import { readFileSync, writeFileSync } from "fs"
import type { TextEdit } from "./types"

/**
 * Applies a list of text edits to a file.
 *
 * @param filePath - The absolute path to the file to modify.
 * @param edits - An array of TextEdit objects to apply.
 * @returns An object indicating success, the number of edits applied, and an optional error message.
 */
export function applyTextEditsToFile(
  filePath: string,
  edits: TextEdit[]
): { success: boolean; editCount: number; error?: string } {
  try {
    const content = readFileSync(filePath, "utf-8")
    const lines = content.split("\n")

    const sortedEdits = [...edits].sort((a, b) => {
      if (b.range.start.line !== a.range.start.line) {
        return b.range.start.line - a.range.start.line
      }
      return b.range.start.character - a.range.start.character
    })

    for (const edit of sortedEdits) {
      const startLine = edit.range.start.line
      const startChar = edit.range.start.character
      const endLine = edit.range.end.line
      const endChar = edit.range.end.character

      if (startLine === endLine) {
        const line = lines[startLine] || ""
        lines[startLine] = line.substring(0, startChar) + edit.newText + line.substring(endChar)
      } else {
        const firstLine = lines[startLine] || ""
        const lastLine = lines[endLine] || ""
        const newContent = firstLine.substring(0, startChar) + edit.newText + lastLine.substring(endChar)
        lines.splice(startLine, endLine - startLine + 1, ...newContent.split("\n"))
      }
    }

    writeFileSync(filePath, lines.join("\n"), "utf-8")
    return { success: true, editCount: edits.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, editCount: 0, error: `[lsp-utils] applyTextEdits: ${message}` }
  }
}
