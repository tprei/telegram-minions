import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(execFileCb)

const GH_TIMEOUT_MS = 20_000

export interface PrPreview {
  url: string
  number: number
  title: string
  body: string
  state: "OPEN" | "CLOSED" | "MERGED"
  mergeable: string | null
  isDraft: boolean
  baseRefName: string
  headRefName: string
  author: string | null
  updatedAt: string | null
  checks: { name: string; status: string; conclusion: string | null }[]
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFile("gh", args, {
    timeout: GH_TIMEOUT_MS,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  return stdout
}

/**
 * Fetch a preview card for a pull request. Single round-trip to `gh pr view`
 * plus one to `gh pr checks` for CI status.
 *
 * Caller passes the full PR URL (what we store on `TopicSession.prUrl`).
 * Throws if `gh` is missing, unauthenticated, or the PR can't be resolved.
 */
export async function fetchPrPreview(prUrl: string): Promise<PrPreview> {
  const viewRaw = await gh([
    "pr",
    "view",
    prUrl,
    "--json",
    "number,title,body,state,mergeable,isDraft,baseRefName,headRefName,author,updatedAt,url",
  ])
  const view = JSON.parse(viewRaw) as {
    number: number
    title: string
    body: string
    state: PrPreview["state"]
    mergeable: string | null
    isDraft: boolean
    baseRefName: string
    headRefName: string
    author: { login: string } | null
    updatedAt: string | null
    url: string
  }

  let checks: PrPreview["checks"] = []
  try {
    const checksRaw = await gh(["pr", "checks", prUrl, "--json", "name,status,conclusion"])
    checks = JSON.parse(checksRaw) as PrPreview["checks"]
  } catch {
    // CI data is best-effort; PR can still render without it.
  }

  return {
    url: view.url,
    number: view.number,
    title: view.title,
    body: view.body ?? "",
    state: view.state,
    mergeable: view.mergeable,
    isDraft: view.isDraft,
    baseRefName: view.baseRefName,
    headRefName: view.headRefName,
    author: view.author?.login ?? null,
    updatedAt: view.updatedAt,
    checks,
  }
}
