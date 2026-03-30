import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execSync: vi.fn(actual.execSync) }
})

import { execSync } from "node:child_process"
import { cleanupMergedBranch } from "../src/dag/dag.js"

const mockExecSync = vi.mocked(execSync)

beforeEach(() => {
  mockExecSync.mockReset()
})

describe("cleanupMergedBranch", () => {
  it("removes worktree and deletes remote branch", () => {
    mockExecSync.mockReturnValue(Buffer.from(""))

    const result = cleanupMergedBranch("minion/test-branch", "/workspace/test-worktree", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: true, remoteBranchDeleted: true })
    expect(mockExecSync).toHaveBeenCalledTimes(2)
    expect(mockExecSync).toHaveBeenCalledWith(
      'git worktree remove --force "/workspace/test-worktree"',
      expect.objectContaining({ cwd: "/workspace/repo" }),
    )
    expect(mockExecSync).toHaveBeenCalledWith(
      'git push origin --delete "minion/test-branch"',
      expect.objectContaining({ cwd: "/workspace/repo" }),
    )
  })

  it("skips worktree removal when no worktree path provided", () => {
    mockExecSync.mockReturnValue(Buffer.from(""))

    const result = cleanupMergedBranch("minion/test-branch", undefined, "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: true })
    expect(mockExecSync).toHaveBeenCalledTimes(1)
    expect(mockExecSync).toHaveBeenCalledWith(
      'git push origin --delete "minion/test-branch"',
      expect.objectContaining({ cwd: "/workspace/repo" }),
    )
  })

  it("swallows worktree removal errors", () => {
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("not a working tree") })
      .mockReturnValueOnce(Buffer.from(""))

    const result = cleanupMergedBranch("minion/test-branch", "/workspace/gone", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: true })
  })

  it("swallows remote branch delete errors", () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from(""))
      .mockImplementationOnce(() => { throw new Error("remote ref does not exist") })

    const result = cleanupMergedBranch("minion/test-branch", "/workspace/wt", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: true, remoteBranchDeleted: false })
  })

  it("swallows both errors without throwing", () => {
    mockExecSync.mockImplementation(() => { throw new Error("everything fails") })

    const result = cleanupMergedBranch("minion/test-branch", "/workspace/wt", "/workspace/repo")

    expect(result).toEqual({ worktreeRemoved: false, remoteBranchDeleted: false })
  })

  it("passes custom timeout", () => {
    mockExecSync.mockReturnValue(Buffer.from(""))

    cleanupMergedBranch("minion/test-branch", undefined, "/workspace/repo", { timeout: 30_000 })

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 30_000 }),
    )
  })
})
