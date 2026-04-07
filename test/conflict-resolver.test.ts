import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const mock = vi.fn() as ReturnType<typeof vi.fn> & Record<symbol, unknown>
  const customSym = Symbol.for("nodejs.util.promisify.custom")
  mock[customSym] = (...args: unknown[]) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mock(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(Object.assign(err, { stdout, stderr }))
        else resolve({ stdout, stderr })
      })
    })
  }
  return { ...actual, execFile: mock }
})

import { execFile, type ChildProcess } from "node:child_process"
import { buildConflictResolutionPrompt, parseUnmergedEntries, resolvePhantomConflicts } from "../src/conflict-resolver.js"

const mockExecFile = vi.mocked(execFile)

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void

describe("buildConflictResolutionPrompt", () => {
  it("includes branch names and conflict files", () => {
    const prompt = buildConflictResolutionPrompt(
      "minion/feature",
      "main",
      ["src/auth.ts", "src/config.ts"],
    )

    expect(prompt).toContain("minion/feature")
    expect(prompt).toContain("main")
    expect(prompt).toContain("src/auth.ts")
    expect(prompt).toContain("src/config.ts")
  })

  it("includes resolution instructions", () => {
    const prompt = buildConflictResolutionPrompt("feat", "main", ["file.ts"])

    expect(prompt).toContain("git add")
    expect(prompt).toContain("conflict markers")
    expect(prompt).toContain("Do NOT run `git rebase --continue`")
  })

  it("includes typecheck instruction", () => {
    const prompt = buildConflictResolutionPrompt("feat", "main", ["file.ts"])
    expect(prompt).toContain("npx tsc --noEmit")
  })

  it("lists all conflict files", () => {
    const files = ["a.ts", "b.ts", "c.ts"]
    const prompt = buildConflictResolutionPrompt("feat", "main", files)

    for (const f of files) {
      expect(prompt).toContain(f)
    }
  })

  it("includes file contents when provided", () => {
    const contents = new Map([
      ["src/auth.ts", "<<<<<<< HEAD\nimport { foo } from './old'\n=======\nimport { foo } from './new'\n>>>>>>>"],
    ])
    const prompt = buildConflictResolutionPrompt("feat", "main", ["src/auth.ts"], contents)

    expect(prompt).toContain("Current file contents")
    expect(prompt).toContain("<<<<<<< HEAD")
    expect(prompt).toContain("import { foo } from './new'")
  })

  it("omits file contents section when not provided", () => {
    const prompt = buildConflictResolutionPrompt("feat", "main", ["src/auth.ts"])
    expect(prompt).not.toContain("Current file contents")
  })
})

describe("parseUnmergedEntries", () => {
  it("parses three-stage content conflict", () => {
    const raw = [
      "100644 aaa111 1\tsrc/file.ts",
      "100644 bbb222 2\tsrc/file.ts",
      "100644 ccc333 3\tsrc/file.ts",
    ].join("\n")

    const result = parseUnmergedEntries(raw)
    expect(result.size).toBe(1)
    expect(result.get("src/file.ts")).toEqual({
      base: "aaa111",
      ours: "bbb222",
      theirs: "ccc333",
    })
  })

  it("parses modify/delete conflict (no stage 2)", () => {
    const raw = [
      "100644 aaa111 1\ttest/helpers.ts",
      "100644 ccc333 3\ttest/helpers.ts",
    ].join("\n")

    const result = parseUnmergedEntries(raw)
    expect(result.get("test/helpers.ts")).toEqual({
      base: "aaa111",
      theirs: "ccc333",
    })
  })

  it("parses delete/modify conflict (no stage 3)", () => {
    const raw = [
      "100644 aaa111 1\ttest/helpers.ts",
      "100644 bbb222 2\ttest/helpers.ts",
    ].join("\n")

    const result = parseUnmergedEntries(raw)
    expect(result.get("test/helpers.ts")).toEqual({
      base: "aaa111",
      ours: "bbb222",
    })
  })

  it("parses multiple files", () => {
    const raw = [
      "100644 aaa111 1\ta.ts",
      "100644 bbb222 2\ta.ts",
      "100644 ccc333 3\ta.ts",
      "100644 ddd444 1\tb.ts",
      "100644 eee555 3\tb.ts",
    ].join("\n")

    const result = parseUnmergedEntries(raw)
    expect(result.size).toBe(2)
    expect(result.get("a.ts")!.base).toBe("aaa111")
    expect(result.get("b.ts")!.theirs).toBe("eee555")
  })

  it("returns empty map for empty input", () => {
    expect(parseUnmergedEntries("").size).toBe(0)
  })

  it("skips malformed lines", () => {
    const raw = "garbage\n100644 aaa111 1\tfile.ts"
    const result = parseUnmergedEntries(raw)
    expect(result.size).toBe(1)
  })
})

describe("resolvePhantomConflicts", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  function mockGitCalls(responses: Record<string, string | Error>) {
    mockExecFile.mockImplementation((...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as ExecFileCallback
      const args = allArgs[1] as string[]
      const key = args.join(" ")

      for (const [pattern, response] of Object.entries(responses)) {
        if (key.includes(pattern)) {
          if (response instanceof Error) {
            cb(response, "", "")
          } else {
            cb(null, response, "")
          }
          return null as unknown as ChildProcess
        }
      }

      cb(null, "", "")
      return null as unknown as ChildProcess
    })
  }

  it("returns empty when no unmerged files", async () => {
    mockGitCalls({ "ls-files --unmerged": "" })

    const result = await resolvePhantomConflicts("/tmp/test")
    expect(result).toEqual({ resolved: [], remaining: [] })
  })

  it("resolves modify/delete phantom when HEAD has matching blob", async () => {
    const unmerged = [
      "100644 abc123 1\ttest/helpers.ts",
      "100644 def456 3\ttest/helpers.ts",
    ].join("\n")

    mockGitCalls({
      "ls-files --unmerged": unmerged,
      "rev-parse --verify HEAD:test/helpers.ts": "abc123",
    })

    const result = await resolvePhantomConflicts("/tmp/test")
    expect(result.resolved).toEqual(["test/helpers.ts"])
    expect(result.remaining).toEqual([])
  })

  it("marks modify/delete as real conflict when HEAD blob differs", async () => {
    const unmerged = [
      "100644 abc123 1\ttest/helpers.ts",
      "100644 def456 3\ttest/helpers.ts",
    ].join("\n")

    mockGitCalls({
      "ls-files --unmerged": unmerged,
      "rev-parse --verify HEAD:test/helpers.ts": "different999",
    })

    const result = await resolvePhantomConflicts("/tmp/test")
    expect(result.resolved).toEqual([])
    expect(result.remaining).toEqual(["test/helpers.ts"])
  })

  it("marks modify/delete as real conflict when file absent from HEAD", async () => {
    const unmerged = [
      "100644 abc123 1\ttest/helpers.ts",
      "100644 def456 3\ttest/helpers.ts",
    ].join("\n")

    mockGitCalls({
      "ls-files --unmerged": unmerged,
      "rev-parse --verify HEAD:test/helpers.ts": new Error("not found"),
    })

    const result = await resolvePhantomConflicts("/tmp/test")
    expect(result.resolved).toEqual([])
    expect(result.remaining).toEqual(["test/helpers.ts"])
  })

  it("resolves content phantom when base == ours", async () => {
    const unmerged = [
      "100644 aaa111 1\tsrc/config.ts",
      "100644 aaa111 2\tsrc/config.ts",
      "100644 bbb222 3\tsrc/config.ts",
    ].join("\n")

    mockGitCalls({ "ls-files --unmerged": unmerged })

    const result = await resolvePhantomConflicts("/tmp/test")
    expect(result.resolved).toEqual(["src/config.ts"])
    expect(result.remaining).toEqual([])
  })

  it("marks content conflict as real when base != ours", async () => {
    const unmerged = [
      "100644 aaa111 1\tsrc/config.ts",
      "100644 bbb222 2\tsrc/config.ts",
      "100644 ccc333 3\tsrc/config.ts",
    ].join("\n")

    mockGitCalls({ "ls-files --unmerged": unmerged })

    const result = await resolvePhantomConflicts("/tmp/test")
    expect(result.resolved).toEqual([])
    expect(result.remaining).toEqual(["src/config.ts"])
  })

  it("handles mixed phantom and real conflicts", async () => {
    const unmerged = [
      "100644 aaa111 1\tphantom.ts",
      "100644 aaa111 2\tphantom.ts",
      "100644 bbb222 3\tphantom.ts",
      "100644 ccc333 1\treal.ts",
      "100644 ddd444 2\treal.ts",
      "100644 eee555 3\treal.ts",
    ].join("\n")

    mockGitCalls({ "ls-files --unmerged": unmerged })

    const result = await resolvePhantomConflicts("/tmp/test")
    expect(result.resolved).toEqual(["phantom.ts"])
    expect(result.remaining).toEqual(["real.ts"])
  })

  it("does not resolve delete/modify (no stage 3)", async () => {
    const unmerged = [
      "100644 aaa111 1\tdeleted.ts",
      "100644 bbb222 2\tdeleted.ts",
    ].join("\n")

    mockGitCalls({ "ls-files --unmerged": unmerged })

    const result = await resolvePhantomConflicts("/tmp/test")
    expect(result.resolved).toEqual([])
    expect(result.remaining).toEqual(["deleted.ts"])
  })

  it("calls git checkout --theirs for content phantoms before git add", async () => {
    const unmerged = [
      "100644 aaa111 1\tsrc/file.ts",
      "100644 aaa111 2\tsrc/file.ts",
      "100644 bbb222 3\tsrc/file.ts",
    ].join("\n")

    const calls: string[][] = []
    mockExecFile.mockImplementation((...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as ExecFileCallback
      const args = allArgs[1] as string[]
      calls.push(args)
      cb(null, args.includes("ls-files") ? unmerged : "", "")
      return null as unknown as ChildProcess
    })

    await resolvePhantomConflicts("/tmp/test")

    const checkoutCall = calls.find((a) => a.includes("checkout") && a.includes("--theirs"))
    const addCall = calls.find((a) => a[0] === "add")
    expect(checkoutCall).toBeDefined()
    expect(addCall).toBeDefined()

    const checkoutIdx = calls.indexOf(checkoutCall!)
    const addIdx = calls.indexOf(addCall!)
    expect(checkoutIdx).toBeLessThan(addIdx)
  })

  it("skips git checkout --theirs for modify/delete phantoms", async () => {
    const unmerged = [
      "100644 abc123 1\ttest/helpers.ts",
      "100644 def456 3\ttest/helpers.ts",
    ].join("\n")

    const calls: string[][] = []
    mockExecFile.mockImplementation((...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as ExecFileCallback
      const args = allArgs[1] as string[]
      calls.push(args)

      if (args.includes("ls-files")) {
        cb(null, unmerged, "")
      } else if (args.includes("rev-parse") && args.includes("--verify")) {
        cb(null, "abc123", "")
      } else {
        cb(null, "", "")
      }
      return null as unknown as ChildProcess
    })

    await resolvePhantomConflicts("/tmp/test")

    const checkoutCall = calls.find((a) => a.includes("checkout") && a.includes("--theirs"))
    expect(checkoutCall).toBeUndefined()

    const addCall = calls.find((a) => a[0] === "add")
    expect(addCall).toBeDefined()
  })
})
