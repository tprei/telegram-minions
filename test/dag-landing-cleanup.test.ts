import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

import { execFileSync } from "node:child_process"
import { cleanupMergedBranch } from "../src/dag/dag.js"

const mockExecFileSync = vi.mocked(execFileSync)

beforeEach(() => {
  mockExecFileSync.mockReset()
})

describe("cleanupMergedBranch", () => {
  it("removes worktree and deletes remote branch", () => {
    mockExecFileSync.mockReturnValue("")

    const result = cleanupMergedBranch("minion/test-branch", "/workspace/test-worktree", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: true, remoteBranchDeleted: true })
    expect(mockExecFileSync).toHaveBeenCalledTimes(2)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/workspace/test-worktree"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
    )
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "--delete", "minion/test-branch"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
    )
  })

  it("skips worktree removal when no worktree path provided", () => {
    mockExecFileSync.mockReturnValue("")

    const result = cleanupMergedBranch("minion/test-branch", undefined, "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: true })
    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "--delete", "minion/test-branch"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
    )
  })

  it("swallows worktree removal errors", () => {
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error("not a working tree") })
      .mockReturnValueOnce("")

    const result = cleanupMergedBranch("minion/test-branch", "/workspace/gone", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: true })
  })

  it("swallows remote branch delete errors", () => {
    mockExecFileSync
      .mockReturnValueOnce("")
      .mockImplementationOnce(() => { throw new Error("remote ref does not exist") })

    const result = cleanupMergedBranch("minion/test-branch", "/workspace/wt", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: true, remoteBranchDeleted: false })
  })

  it("swallows both errors without throwing", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("everything fails") })

    const result = cleanupMergedBranch("minion/test-branch", "/workspace/wt", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: false })
  })

  it("passes custom timeout", () => {
    mockExecFileSync.mockReturnValue("")

    cleanupMergedBranch("minion/test-branch", undefined, "/workspace/repo", { timeout: 30_000 })

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      expect.any(Array),
      expect.objectContaining({ timeout: 30_000 }),
    )
  })
})
