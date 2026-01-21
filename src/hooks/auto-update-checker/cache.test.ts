import { describe, expect, test, mock, beforeEach } from "bun:test"
import { invalidatePackage } from "./cache"
import * as fs from "node:fs"
import * as path from "node:path"

// Mock internal dependencies
mock.module("./constants", () => ({
    CACHE_DIR: "/mock/cache",
    PACKAGE_NAME: "oh-my-opencode-slim"
}))

mock.module("../../shared/logger", () => ({
    log: mock(() => { })
}))

// Mock fs and path
mock.module("node:fs", () => ({
    existsSync: mock(() => false),
    rmSync: mock(() => { }),
    readFileSync: mock(() => ""),
    writeFileSync: mock(() => { }),
}))

mock.module("../../cli/config-manager", () => ({
    stripJsonComments: (s: string) => s
}))

describe("auto-update-checker/cache", () => {
    describe("invalidatePackage", () => {
        test("returns false when nothing to invalidate", () => {
            const existsMock = fs.existsSync as any
            existsMock.mockReturnValue(false)

            const result = invalidatePackage()
            expect(result).toBe(false)
        })

        test("returns true and removes directory if node_modules path exists", () => {
            const existsMock = fs.existsSync as any
            const rmSyncMock = fs.rmSync as any

            existsMock.mockImplementation((p: string) => p.includes("node_modules"))

            const result = invalidatePackage()

            expect(rmSyncMock).toHaveBeenCalled()
            expect(result).toBe(true)
        })

        test("removes dependency from package.json if present", () => {
            const existsMock = fs.existsSync as any
            const readMock = fs.readFileSync as any
            const writeMock = fs.writeFileSync as any

            existsMock.mockImplementation((p: string) => p.includes("package.json"))
            readMock.mockReturnValue(JSON.stringify({
                dependencies: {
                    "oh-my-opencode-slim": "1.0.0",
                    "other-pkg": "1.0.0"
                }
            }))

            const result = invalidatePackage()

            expect(result).toBe(true)
            const callArgs = writeMock.mock.calls[0]
            const savedJson = JSON.parse(callArgs[1])
            expect(savedJson.dependencies["oh-my-opencode-slim"]).toBeUndefined()
            expect(savedJson.dependencies["other-pkg"]).toBe("1.0.0")
        })
    })
})
