import { describe, it, expect, vi } from "vitest"
import { isStaleLeaseError, pushWithLeaseRetry } from "../src/dag/landing-manager.js"

describe("isStaleLeaseError", () => {
  it("detects 'stale info' on the stderr property", () => {
    const err = Object.assign(new Error("cmd failed"), {
      stderr: " ! [rejected]        minion/slim-pine -> minion/slim-pine (stale info)\n",
    })
    expect(isStaleLeaseError(err)).toBe(true)
  })

  it("detects 'fetch first' on the stderr property", () => {
    const err = Object.assign(new Error("cmd failed"), {
      stderr: "hint: Updates were rejected because the tip of your current branch is behind\nhint: (fetch first)",
    })
    expect(isStaleLeaseError(err)).toBe(true)
  })

  it("detects 'non-fast-forward' reject in the error message", () => {
    const err = new Error("git push: rejected (non-fast-forward)")
    expect(isStaleLeaseError(err)).toBe(true)
  })

  it("returns false for unrelated git errors", () => {
    const err = Object.assign(new Error("permission denied"), {
      stderr: "fatal: could not read Username",
    })
    expect(isStaleLeaseError(err)).toBe(false)
  })

  it("handles null and undefined safely", () => {
    expect(isStaleLeaseError(null)).toBe(false)
    expect(isStaleLeaseError(undefined)).toBe(false)
  })
})

describe("pushWithLeaseRetry", () => {
  const makeRunGit = (plan: Array<(args: string[]) => string | Error>) => {
    const calls: string[][] = []
    let idx = 0
    const fn = vi.fn(async (args: string[]) => {
      calls.push(args)
      const step = plan[idx++]
      if (!step) throw new Error(`unexpected runGit call ${idx}: ${args.join(" ")}`)
      const result = step(args)
      if (result instanceof Error) throw result
      return result
    })
    return { fn, calls }
  }

  const staleErr = () =>
    Object.assign(new Error("push failed"), {
      stderr: " ! [rejected]        minion/foo -> minion/foo (stale info)",
    })

  it("succeeds on first push without retry", async () => {
    const { fn, calls } = makeRunGit([
      () => "",
    ])

    await pushWithLeaseRetry("/tmp/foo", "minion/foo", fn)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(["push", "--force-with-lease", "origin", "minion/foo"])
  })

  it("retries once after stale-info and descendant check passes", async () => {
    const { fn, calls } = makeRunGit([
      () => staleErr(),              // first push
      () => "",                       // fetch
      () => "aaaaaaa1",               // rev-parse HEAD
      () => "bbbbbbb2",               // rev-parse refs/remotes/origin/minion/foo
      () => "",                       // merge-base --is-ancestor (success)
      () => "",                       // retry push
    ])

    await pushWithLeaseRetry("/tmp/foo", "minion/foo", fn)

    expect(calls).toHaveLength(6)
    expect(calls[0]).toEqual(["push", "--force-with-lease", "origin", "minion/foo"])
    expect(calls[1]).toEqual(["fetch", "origin", "minion/foo"])
    expect(calls[2]).toEqual(["rev-parse", "HEAD"])
    expect(calls[3]).toEqual(["rev-parse", "refs/remotes/origin/minion/foo"])
    expect(calls[4]).toEqual(["merge-base", "--is-ancestor", "bbbbbbb2", "HEAD"])
    expect(calls[5]).toEqual(["push", "--force-with-lease", "origin", "minion/foo"])
  })

  it("short-circuits when local HEAD already matches refreshed remote", async () => {
    const { fn, calls } = makeRunGit([
      () => staleErr(),
      () => "",                       // fetch
      () => "aaaaaaa1",               // HEAD
      () => "aaaaaaa1",               // remote HEAD — identical
    ])

    await pushWithLeaseRetry("/tmp/foo", "minion/foo", fn)

    expect(calls).toHaveLength(4)
    expect(fn).not.toHaveBeenCalledTimes(6)
  })

  it("throws when local HEAD is not a descendant of the refreshed remote", async () => {
    const { fn } = makeRunGit([
      () => staleErr(),
      () => "",                       // fetch
      () => "aaaaaaa1",               // HEAD
      () => "bbbbbbb2",               // remote HEAD — different
      () => new Error("not an ancestor"),
    ])

    await expect(
      pushWithLeaseRetry("/tmp/foo", "minion/foo", fn),
    ).rejects.toThrow(/not a descendant/)
  })

  it("rethrows non-stale-lease errors without retrying", async () => {
    const plan = [
      () => Object.assign(new Error("auth fail"), { stderr: "fatal: could not read Username" }),
    ]
    const { fn, calls } = makeRunGit(plan)

    await expect(
      pushWithLeaseRetry("/tmp/foo", "minion/foo", fn),
    ).rejects.toThrow(/auth fail/)
    expect(calls).toHaveLength(1)
  })
})
