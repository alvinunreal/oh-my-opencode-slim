import { describe, expect, test, mock } from "bun:test"
import { extractChannel, getLocalDevVersion, findPluginEntry } from "./checker"
import * as fs from "node:fs"
import * as path from "node:path"

// Mock the dependencies
mock.module("./constants", () => ({
    PACKAGE_NAME: "oh-my-opencode-slim",
    USER_OPENCODE_CONFIG: "/mock/config/opencode.json",
    USER_OPENCODE_CONFIG_JSONC: "/mock/config/opencode.jsonc",
    INSTALLED_PACKAGE_JSON: "/mock/cache/node_modules/oh-my-opencode-slim/package.json"
}))

mock.module("node:fs", () => ({
    existsSync: mock((p: string) => false),
    readFileSync: mock((p: string) => ""),
    statSync: mock((p: string) => ({ isDirectory: () => true })),
    writeFileSync: mock(() => { }),
}))

describe("auto-update-checker/checker", () => {
    describe("extractChannel", () => {
        test("returns latest for null or empty", () => {
            expect(extractChannel(null)).toBe("latest")
            expect(extractChannel("")).toBe("latest")
        })

        test("returns tag if version starts with non-digit", () => {
            expect(extractChannel("beta")).toBe("beta")
            expect(extractChannel("next")).toBe("next")
        })

        test("extracts channel from prerelease version", () => {
            expect(extractChannel("1.0.0-alpha.1")).toBe("alpha")
            expect(extractChannel("2.3.4-beta.5")).toBe("beta")
            expect(extractChannel("0.1.0-rc.1")).toBe("rc")
            expect(extractChannel("1.0.0-canary.0")).toBe("canary")
        })

        test("returns latest for standard versions", () => {
            expect(extractChannel("1.0.0")).toBe("latest")
        })
    })

    describe("getLocalDevVersion", () => {
        test("returns null if no local dev path in config", () => {
            // existsSync returns false by default from mock
            expect(getLocalDevVersion("/test")).toBeNull()
        })

        test("returns version from local package.json if path exists", () => {
            const existsMock = fs.existsSync as any
            const readMock = fs.readFileSync as any

            existsMock.mockImplementation((p: string) => {
                if (p.includes("opencode.json")) return true
                if (p.includes("package.json")) return true
                return false
            })

            readMock.mockImplementation((p: string) => {
                if (p.includes("opencode.json")) {
                    return JSON.stringify({ plugin: ["file:///dev/oh-my-opencode-slim"] })
                }
                if (p.includes("package.json")) {
                    return JSON.stringify({ name: "oh-my-opencode-slim", version: "1.2.3-dev" })
                }
                return ""
            })

            expect(getLocalDevVersion("/test")).toBe("1.2.3-dev")
        })
    })

    describe("findPluginEntry", () => {
        test("detects latest version entry", () => {
            const existsMock = fs.existsSync as any
            const readMock = fs.readFileSync as any

            existsMock.mockImplementation((p: string) => p.includes("opencode.json"))
            readMock.mockImplementation(() => JSON.stringify({
                plugin: ["oh-my-opencode-slim"]
            }))

            const entry = findPluginEntry("/test")
            expect(entry).not.toBeNull()
            expect(entry?.entry).toBe("oh-my-opencode-slim")
            expect(entry?.isPinned).toBe(false)
            expect(entry?.pinnedVersion).toBeNull()
        })

        test("detects pinned version entry", () => {
            const existsMock = fs.existsSync as any
            const readMock = fs.readFileSync as any

            existsMock.mockImplementation((p: string) => p.includes("opencode.json"))
            readMock.mockImplementation(() => JSON.stringify({
                plugin: ["oh-my-opencode-slim@1.0.0"]
            }))

            const entry = findPluginEntry("/test")
            expect(entry).not.toBeNull()
            expect(entry?.isPinned).toBe(true)
            expect(entry?.pinnedVersion).toBe("1.0.0")
        })
    })
})
