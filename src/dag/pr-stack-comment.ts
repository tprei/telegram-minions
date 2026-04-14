import { spawn, execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { loggers } from "../logger.js"
import { topologicalSort, type DagGraph, type DagNode, type DagNodeStatus } from "./dag.js"

const log = loggers.dispatcher
const execFile = promisify(execFileCb)
const GH_LIST_TIMEOUT = 90_000
const GH_PATCH_TIMEOUT = 90_000
const GH_POST_TIMEOUT = 90_000

const SENTINEL_START = "<!-- tm-stack-comment-start -->"
const SENTINEL_END = "<!-- tm-stack-comment-end -->"

export { SENTINEL_START, SENTINEL_END }

const ICON: Record<DagNodeStatus, string> = {
  pending: "⏸",
  ready: "🟢",
  running: "🔵",
  done: "🟢",
  failed: "❌",
  skipped: "⏭",
  "ci-pending": "🟡",
  "ci-failed": "⚠️",
  landed: "✅",
}

const STATE_LABEL: Record<DagNodeStatus, string> = {
  pending: "pending",
  ready: "ready",
  running: "running",
  done: "ready to land",
  failed: "failed",
  skipped: "skipped",
  "ci-pending": "CI running",
  "ci-failed": "CI failed",
  landed: "landed",
}

function shortRepo(prUrl?: string): { owner: string; repo: string } | undefined {
  if (!prUrl) return undefined
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//)
  if (!m) return undefined
  return { owner: m[1], repo: m[2] }
}

function prNumberFromUrl(prUrl?: string): string | undefined {
  return prUrl?.match(/\/pull\/(\d+)/)?.[1]
}

/**
 * Render the stack markdown comment body. Wrapped in sentinels so we can
 * find and edit "our" comment on later updates.
 *
 * @param graph - the DAG
 * @param currentNodeId - the node whose PR this comment is being rendered on; highlighted in the output
 */
export function renderStackComment(graph: DagGraph, currentNodeId?: string): string {
  const sorted = topologicalSort(graph)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const orderedNodes = sorted.map((id) => byId.get(id)!).filter((n): n is DagNode => n != null)

  const total = orderedNodes.length
  const landed = orderedNodes.filter((n) => n.status === "landed").length
  const running = orderedNodes.filter((n) => n.status === "running" || n.status === "ci-pending").length
  const ready = orderedNodes.filter((n) => n.status === "done").length
  const blocked = orderedNodes.filter((n) => n.status === "pending" || n.status === "ready").length
  const failed = orderedNodes.filter((n) => n.status === "failed" || n.status === "ci-failed" || n.status === "skipped").length

  const label = graph.id.replace(/^dag-/, "")
  const lines: string[] = []
  lines.push(SENTINEL_START)
  lines.push("")
  lines.push(`### 🕸 Stack: \`${label}\` (${total} node${total === 1 ? "" : "s"})`)
  lines.push("")
  lines.push("```text")

  const prefix = (i: number) => {
    if (total === 1) return "─"
    if (i === 0) return "┌"
    if (i === total - 1) return "└"
    return "├"
  }

  for (let i = 0; i < orderedNodes.length; i++) {
    const node = orderedNodes[i]
    const icon = ICON[node.status]
    const prNum = prNumberFromUrl(node.prUrl)
    const prLabel = prNum ? `#${prNum}` : "—".padEnd(4)
    const title = node.title.length > 40 ? node.title.slice(0, 37) + "..." : node.title
    const state = STATE_LABEL[node.status]
    const isCurrent = currentNodeId != null && node.id === currentNodeId
    const arrow = isCurrent ? "  ← this PR" : ""
    const paddedState = state.padEnd(12)
    lines.push(`${prefix(i)}─ ${icon} ${prLabel.padEnd(5)} ${title.padEnd(40)} ${paddedState}${arrow}`)
  }

  lines.push("```")
  lines.push("")
  const parts: string[] = []
  parts.push(`**${landed}/${total} landed**`)
  if (running > 0) parts.push(`${running} in progress`)
  if (ready > 0) parts.push(`${ready} ready`)
  if (blocked > 0) parts.push(`${blocked} blocked`)
  if (failed > 0) parts.push(`${failed} failed`)
  lines.push(parts.join(" · "))
  lines.push("")
  lines.push("_Run `/land` from the parent thread to land this stack._")
  lines.push("")
  lines.push(SENTINEL_END)

  return lines.join("\n")
}

interface ExistingComment {
  id: number
  body: string
}

async function findOurComment(
  prNumber: string,
  owner: string,
  repo: string,
): Promise<ExistingComment | undefined> {
  try {
    const { stdout } = await execFile(
      "gh",
      ["api", `repos/${owner}/${repo}/issues/${prNumber}/comments`, "--paginate"],
      { timeout: GH_LIST_TIMEOUT, encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    )
    const parsed = JSON.parse(stdout) as Array<{ id: number; body: string }>
    for (const c of parsed) {
      if (typeof c.body === "string" && c.body.includes(SENTINEL_START)) {
        return { id: c.id, body: c.body }
      }
    }
  } catch (err) {
    log.warn({ err, prNumber }, "failed to list PR comments for stack-comment lookup")
  }
  return undefined
}

async function patchComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/issues/comments/${commentId}`,
        "-X",
        "PATCH",
        "--input",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    )
    let stderr = ""
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    proc.stdin.end(JSON.stringify({ body }))
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("gh api PATCH timed out")) }, GH_PATCH_TIMEOUT)
    proc.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`gh api PATCH exited ${code}: ${stderr.trim()}`))
    })
    proc.on("error", (err) => { clearTimeout(timer); reject(err) })
  })
}

async function postNewComment(
  owner: string,
  repo: string,
  prNumber: string,
  body: string,
  cwd?: string,
): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve, reject) => {
    const proc = spawn(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/issues/${prNumber}/comments`,
        "--input",
        "-",
      ],
      { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    )
    let stdout = ""
    let stderr = ""
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    proc.stdin.end(JSON.stringify({ body }))
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("gh api POST timed out")) }, GH_POST_TIMEOUT)
    proc.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) { reject(new Error(`gh api POST exited ${code}: ${stderr.trim()}`)); return }
      try {
        const parsed = JSON.parse(stdout) as { id?: number }
        resolve(typeof parsed.id === "number" ? parsed.id : undefined)
      } catch { resolve(undefined) }
    })
    proc.on("error", (err) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * Post or update the stack comment for a single PR in the DAG.
 * Uses the node's cached prCommentId for fast updates, falling back to
 * a sentinel-based lookup if the cached id is gone.
 *
 * Returns the comment id on success (for caching on the node).
 */
export async function postOrUpdateStackComment(
  graph: DagGraph,
  node: DagNode,
  opts?: { cwd?: string },
): Promise<number | undefined> {
  if (!node.prUrl) return undefined
  const repo = shortRepo(node.prUrl)
  const prNumber = prNumberFromUrl(node.prUrl)
  if (!repo || !prNumber) return undefined

  const body = renderStackComment(graph, node.id)

  if (node.prCommentId != null) {
    try {
      await patchComment(repo.owner, repo.repo, node.prCommentId, body)
      return node.prCommentId
    } catch (err) {
      log.warn({ err, prUrl: node.prUrl, commentId: node.prCommentId }, "cached stack-comment id failed to PATCH, will search")
    }
  }

  const existing = await findOurComment(prNumber, repo.owner, repo.repo)
  if (existing) {
    try {
      await patchComment(repo.owner, repo.repo, existing.id, body)
      return existing.id
    } catch (err) {
      log.warn({ err, prUrl: node.prUrl }, "failed to PATCH existing stack comment, will post new")
    }
  }

  try {
    const newId = await postNewComment(repo.owner, repo.repo, prNumber, body, opts?.cwd)
    return newId
  } catch (err) {
    log.error({ err, prUrl: node.prUrl }, "failed to post stack comment")
    return undefined
  }
}

/**
 * Fan out: update the stack comment on every PR in the DAG. Independent nodes
 * are updated in parallel with a small concurrency cap.
 *
 * Mutates graph.nodes[i].prCommentId when a new comment is posted so later
 * updates can fast-path via PATCH.
 */
export async function updateAllStackComments(
  graph: DagGraph,
  opts?: { cwd?: string; concurrency?: number },
): Promise<void> {
  const cwd = opts?.cwd
  const concurrency = opts?.concurrency ?? 3
  const nodesWithPr = graph.nodes.filter((n) => n.prUrl)
  if (nodesWithPr.length === 0) return

  let idx = 0
  const worker = async () => {
    while (idx < nodesWithPr.length) {
      const mine = idx++
      if (mine >= nodesWithPr.length) return
      const node = nodesWithPr[mine]
      try {
        const commentId = await postOrUpdateStackComment(graph, node, { cwd })
        if (commentId != null && node.prCommentId !== commentId) {
          node.prCommentId = commentId
        }
      } catch (err) {
        log.warn({ err, nodeId: node.id }, "stack comment update failed")
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, nodesWithPr.length) }, () => worker())
  await Promise.all(workers)
}
