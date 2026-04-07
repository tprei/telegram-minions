import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

import { execFile, type ChildProcess } from "node:child_process"
import { cleanupMergedBranch } from "../src/dag/dag.js"

const mockExecFile = vi.mocked(execFile)

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void

beforeEach(() => {
  mockExecFile.mockReset()
})

function mockExecFileSuccess() {
  mockExecFile.mockImplementation((...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as ExecFileCallback
    cb(null, "", "")
    return null as unknown as ChildProcess
  })
}

function mockExecFileSequence(implementations: Array<(cb: ExecFileCallback) => void>) {
  let callIndex = 0
  mockExecFile.mockImplementation((...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as ExecFileCallback
    const impl = implementations[callIndex++]
    if (impl) impl(cb)
    return null as unknown as ChildProcess
  })
}

describe("cleanupMergedBranch", () => {
  it("removes worktree and deletes remote branch", async () => {
    mockExecFileSuccess()

    const result = await cleanupMergedBranch("minion/test-branch", "/workspace/test-worktree", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: true, remoteBranchDeleted: true })
    expect(mockExecFile).toHaveBeenCalledTimes(2)
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/workspace/test-worktree"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
      expect.any(Function),
    )
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "--delete", "minion/test-branch"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
      expect.any(Function),
    )
  })

  it("skips worktree removal when no worktree path provided", async () => {
    mockExecFileSuccess()

    const result = await cleanupMergedBranch("minion/test-branch", undefined, "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: true })
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "--delete", "minion/test-branch"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
      expect.any(Function),
    )
  })

  it("swallows worktree removal errors", async () => {
    mockExecFileSequence([
      (cb) => cb(new Error("not a working tree"), "", ""),
      (cb) => cb(null, "", ""),
    ])

    const result = await cleanupMergedBranch("minion/test-branch", "/workspace/gone", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: true })
  })

  it("swallows remote branch delete errors", async () => {
    mockExecFileSequence([
      (cb) => cb(null, "", ""),
      (cb) => cb(new Error("remote ref does not exist"), "", ""),
    ])

    const result = await cleanupMergedBranch("minion/test-branch", "/workspace/wt", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: true, remoteBranchDeleted: false })
  })

  it("swallows both errors without throwing", async () => {
    mockExecFile.mockImplementation((...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as ExecFileCallback
      cb(new Error("everything fails"), "", "")
      return null as unknown as ChildProcess
    })

    const result = await cleanupMergedBranch("minion/test-branch", "/workspace/wt", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: false })
  })

  it("passes custom timeout", async () => {
    mockExecFileSuccess()

    await cleanupMergedBranch("minion/test-branch", undefined, "/workspace/repo", { timeout: 30_000 })

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      expect.any(Array),
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    )
  })
})
