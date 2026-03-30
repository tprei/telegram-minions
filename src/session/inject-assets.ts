/**
 * Inject agent definitions, skills, and goosehints into session workspaces.
 *
 * Resolves assets from:
 * 1. Custom paths provided via AgentDefinitions config
 * 2. Default package assets (works for both repo-local dev and npm consumers)
 *
 * Never overwrites existing files — the target repo's own config takes precedence.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentDefinitions } from "../config/config-types.js"
import { loggers } from "../logger.js"

const log = loggers.session

/**
 * Resolve the package's assets/ directory.
 * Works both in development (repo root) and when installed as an npm package.
 */
export function resolvePackageAssetsDir(): string {
  const thisFile = fileURLToPath(import.meta.url)
  const thisDir = path.dirname(thisFile)

  // In dev: src/session/inject-assets.ts -> src/ -> repo root -> assets/
  // In dist: dist/session/inject-assets.js -> dist/ -> repo root -> assets/
  const repoRoot = path.resolve(thisDir, "../..")
  const assetsDir = path.join(repoRoot, "assets")

  if (fs.existsSync(assetsDir)) {
    return assetsDir
  }

  log.debug({ thisDir, assetsDir }, "assets directory not found")
  return assetsDir
}

/**
 * Copy all .md files from a source directory into a destination directory.
 * Skips files that already exist in the destination (no-overwrite policy).
 * Returns the number of files injected.
 */
function copyMdFiles(srcDir: string, dstDir: string): number {
  if (!fs.existsSync(srcDir)) return 0

  fs.mkdirSync(dstDir, { recursive: true })

  let count = 0
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const dst = path.join(dstDir, entry.name)
    if (fs.existsSync(dst)) continue
    fs.copyFileSync(path.join(srcDir, entry.name), dst)
    count++
  }
  return count
}

/**
 * Copy skill subdirectories from a source directory into a destination directory.
 * Each skill is a subdirectory — loose files at the top level are ignored.
 * All file types within each skill subdirectory are copied recursively.
 * Skips skill directories that already exist in the destination (no-overwrite policy).
 * Returns the number of skill directories injected.
 */
function copySkillsDir(srcDir: string, dstDir: string): number {
  if (!fs.existsSync(srcDir)) return 0

  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  let count = 0

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dst = path.join(dstDir, entry.name)
    if (fs.existsSync(dst)) continue
    fs.cpSync(path.join(srcDir, entry.name), dst, { recursive: true })
    count++
  }
  return count
}

/**
 * Copy a single file to a destination path.
 * Skips if the destination already exists (no-overwrite policy).
 * Returns true if the file was copied.
 */
function copySingleFile(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false
  if (fs.existsSync(dst)) return false
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  return true
}

export interface InjectionResult {
  agents: number
  skills: number
  claudeMd: boolean
  goosehints: boolean
  settingsJson: boolean
}

/**
 * Inject agent files, skills, CLAUDE.md, goosehints, and settings.json into a
 * session workspace. Existing files are never overwritten.
 *
 * @param cwd - The workspace root directory (git worktree)
 * @param agentDefs - Optional custom paths from MinionConfig.agentDefs
 * @returns Summary of what was injected
 */
export function injectAgentFiles(
  cwd: string,
  agentDefs?: AgentDefinitions,
): InjectionResult {
  const assetsDir = resolvePackageAssetsDir()
  const result: InjectionResult = {
    agents: 0,
    skills: 0,
    claudeMd: false,
    goosehints: false,
    settingsJson: false,
  }

  // 1. Inject Claude agents
  const agentsSrc = agentDefs?.agentsDir ?? path.join(assetsDir, "agents")
  const agentsDst = path.join(cwd, ".claude", "agents")
  result.agents = copyMdFiles(agentsSrc, agentsDst)

  // 2. Inject Claude skills (subdirectory-based)
  const skillsSrc = agentDefs?.skillsDir ?? path.join(assetsDir, ".claude", "skills")
  const skillsDst = path.join(cwd, ".claude", "skills")
  result.skills = copySkillsDir(skillsSrc, skillsDst)

  // 3. Inject CLAUDE.md
  if (agentDefs?.claudeMd) {
    result.claudeMd = copySingleFile(agentDefs.claudeMd, path.join(cwd, ".claude", "CLAUDE.md"))
  } else {
    const defaultClaudeMd = path.join(assetsDir, "templates", ".claude", "CLAUDE.md")
    result.claudeMd = copySingleFile(defaultClaudeMd, path.join(cwd, ".claude", "CLAUDE.md"))
  }

  // 4. Inject .goosehints
  if (agentDefs?.goosehintsPath) {
    result.goosehints = copySingleFile(agentDefs.goosehintsPath, path.join(cwd, ".goosehints"))
  } else {
    const defaultGoosehints = path.join(assetsDir, ".goosehints")
    result.goosehints = copySingleFile(defaultGoosehints, path.join(cwd, ".goosehints"))
  }

  // 5. Inject settings.json into .claude/ (only when explicitly provided)
  if (agentDefs?.settingsJson) {
    const settingsDst = path.join(cwd, ".claude", "settings.json")
    if (!fs.existsSync(settingsDst)) {
      fs.mkdirSync(path.dirname(settingsDst), { recursive: true })
      fs.writeFileSync(settingsDst, JSON.stringify(agentDefs.settingsJson, null, 2))
      result.settingsJson = true
    }
  }

  const total = result.agents + result.skills + (result.claudeMd ? 1 : 0) + (result.goosehints ? 1 : 0) + (result.settingsJson ? 1 : 0)
  if (total > 0) {
    log.debug({ cwd, ...result }, "injected agent files into workspace")
  }

  return result
}
