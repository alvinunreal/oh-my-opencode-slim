import { describe, expect, test } from "bun:test"
import { stripJsonComments } from "./config-manager"

describe("stripJsonComments", () => {
  test("returns unchanged JSON without comments", () => {
    const json = '{"key": "value"}'
    expect(stripJsonComments(json)).toBe(json)
  })

  test("strips single-line comments", () => {
    const json = `{
  "key": "value" // this is a comment
}`
    expect(JSON.parse(stripJsonComments(json))).toEqual({ key: "value" })
  })

  test("strips multi-line comments", () => {
    const json = `{
  /* this is a
     multi-line comment */
  "key": "value"
}`
    expect(JSON.parse(stripJsonComments(json))).toEqual({ key: "value" })
  })

  test("strips trailing commas", () => {
    const json = `{
  "key": "value",
}`
    expect(JSON.parse(stripJsonComments(json))).toEqual({ key: "value" })
  })

  test("strips trailing commas in arrays", () => {
    const json = `{
  "arr": [1, 2, 3,]
}`
    expect(JSON.parse(stripJsonComments(json))).toEqual({ arr: [1, 2, 3] })
  })

  test("preserves URLs with double slashes", () => {
    const json = '{"url": "https://example.com"}'
    expect(JSON.parse(stripJsonComments(json))).toEqual({ url: "https://example.com" })
  })

  test("preserves strings containing comment-like patterns", () => {
    const json = '{"code": "// not a comment", "block": "/* also not */"}'
    expect(JSON.parse(stripJsonComments(json))).toEqual({
      code: "// not a comment",
      block: "/* also not */",
    })
  })

  test("handles complex JSONC with mixed comments and trailing commas", () => {
    const json = `{
  // Configuration for the plugin
  "plugin": ["oh-my-opencode-slim"],
  /* Provider settings
     with multiple lines */
  "provider": {
    "google": {
      "name": "Google", // inline comment
    },
  },
}`
    const result = JSON.parse(stripJsonComments(json))
    expect(result).toEqual({
      plugin: ["oh-my-opencode-slim"],
      provider: {
        google: {
          name: "Google",
        },
      },
    })
  })

  test("handles escaped quotes in strings", () => {
    const json = '{"message": "He said \\"hello\\""}'
    expect(JSON.parse(stripJsonComments(json))).toEqual({ message: 'He said "hello"' })
  })

  test("handles empty input", () => {
    expect(stripJsonComments("")).toBe("")
  })

  test("handles whitespace-only input", () => {
    expect(stripJsonComments("   ")).toBe("   ")
  })

  test("handles single-line comment at start of file", () => {
    const json = `// comment at start
{"key": "value"}`
    expect(JSON.parse(stripJsonComments(json))).toEqual({ key: "value" })
  })

  test("handles comment-only lines between properties", () => {
    const json = `{
  "a": 1,
  // comment line
  "b": 2
}`
    expect(JSON.parse(stripJsonComments(json))).toEqual({ a: 1, b: 2 })
  })

  test("handles multiple trailing commas in nested structures", () => {
    const json = `{"nested": {"a": 1,},}`
    expect(JSON.parse(stripJsonComments(json))).toEqual({ nested: { a: 1 } })
  })

  test("handles unclosed string gracefully without throwing", () => {
    const json = '{"key": "unclosed'
    expect(() => stripJsonComments(json)).not.toThrow()
  })

  test("preserves comma-bracket patterns inside strings", () => {
    const json = '{"script": "test [,]", "json": "{,}"}'
    const result = JSON.parse(stripJsonComments(json))
    expect(result.script).toBe("test [,]")
    expect(result.json).toBe("{,}")
  })

  test("preserves comma-brace patterns inside strings", () => {
    const json = '{"glob": "*.{js,ts}", "arr": "[a,]"}'
    const result = JSON.parse(stripJsonComments(json))
    expect(result.glob).toBe("*.{js,ts}")
    expect(result.arr).toBe("[a,]")
  })

  test("handles Windows CRLF line endings", () => {
    const json = '{\r\n  "key": "value", // comment\r\n}'
    const result = JSON.parse(stripJsonComments(json))
    expect(result).toEqual({ key: "value" })
  })
})

describe("JSONC file handling", () => {
  test("stripJsonComments enables JSONC to be parsed as JSON", () => {
    const jsoncContent = `{
  // Single-line comment
  "plugin": ["oh-my-opencode-slim"],
  /* Multi-line
     comment */
  "provider": {
    "google": {
      "name": "Google", // inline comment
    },
  },
}`

    const result = JSON.parse(stripJsonComments(jsoncContent))
    
    expect(result).toEqual({
      plugin: ["oh-my-opencode-slim"],
      provider: {
        google: {
          name: "Google",
        },
      },
    })
  })

  test("stripJsonComments handles real-world JSONC config format", () => {
    const jsoncConfig = `{
  // OpenCode plugin configuration
  "plugin": [
    "oh-my-opencode-slim"
  ],
  
  /* Provider settings for Antigravity
     with model definitions */
  "provider": {
    "google": {
      "name": "Google",
      "models": ["claude-opus-4-5", "gemini-3-flash"],
    }
  },
  
  // Server configuration for tmux integration
  "server": {
    "port": 4096, // default port
  }
}`

    const result = JSON.parse(stripJsonComments(jsoncConfig))
    
    expect(result.plugin).toEqual(["oh-my-opencode-slim"])
    expect(result.provider.google.name).toBe("Google")
    expect(result.provider.google.models).toEqual(["claude-opus-4-5", "gemini-3-flash"])
    expect(result.server.port).toBe(4096)
  })
})
