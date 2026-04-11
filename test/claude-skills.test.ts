import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const SKILLS_DIR = path.resolve("assets/.claude/skills")

const REQUIRED_SKILLS = ["commit", "explore", "review-dag", "review-pr", "update-config"]

const REQUIRED_FRONTMATTER_FIELDS = ["name", "description", "user_invocable"]

function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const fields: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0) {
      fields[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
    }
  }
  return fields
}

function skillMdPath(skill: string): string {
  return path.join(SKILLS_DIR, skill, `${skill}.md`)
}

describe("Claude Code skills", () => {
  it("skills directory exists", () => {
    expect(fs.existsSync(SKILLS_DIR)).toBe(true)
    expect(fs.statSync(SKILLS_DIR).isDirectory()).toBe(true)
  })

  for (const skill of REQUIRED_SKILLS) {
    describe(`${skill}`, () => {
      const filePath = skillMdPath(skill)

      it("exists as a directory with a .md file", () => {
        expect(fs.existsSync(path.join(SKILLS_DIR, skill))).toBe(true)
        expect(fs.existsSync(filePath)).toBe(true)
      })

      it("has valid frontmatter with required fields", () => {
        const content = fs.readFileSync(filePath, "utf-8")
        const frontmatter = parseSkillFrontmatter(content)

        for (const field of REQUIRED_FRONTMATTER_FIELDS) {
          expect(frontmatter[field], `missing frontmatter field: ${field}`).toBeDefined()
          expect(frontmatter[field].length, `empty frontmatter field: ${field}`).toBeGreaterThan(0)
        }
      })

      it("has name matching directory name", () => {
        const content = fs.readFileSync(filePath, "utf-8")
        const frontmatter = parseSkillFrontmatter(content)
        expect(frontmatter["name"]).toBe(skill)
      })

      it("is user-invocable", () => {
        const content = fs.readFileSync(filePath, "utf-8")
        const frontmatter = parseSkillFrontmatter(content)
        expect(frontmatter["user_invocable"]).toBe("true")
      })

      it("has substantive content after frontmatter", () => {
        const content = fs.readFileSync(filePath, "utf-8")
        const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "")
        expect(body.trim().length).toBeGreaterThan(100)
      })

      it("contains a markdown heading", () => {
        const content = fs.readFileSync(filePath, "utf-8")
        expect(content).toMatch(/^#+ .+/m)
      })
    })
  }

  it("skill names are unique", () => {
    const dirs = fs.readdirSync(SKILLS_DIR).filter(f =>
      fs.statSync(path.join(SKILLS_DIR, f)).isDirectory(),
    )
    const names = dirs.map(d => {
      const mdFile = path.join(SKILLS_DIR, d, `${d}.md`)
      if (!fs.existsSync(mdFile)) return undefined
      const content = fs.readFileSync(mdFile, "utf-8")
      return parseSkillFrontmatter(content)["name"]
    }).filter(Boolean)
    expect(new Set(names).size).toBe(names.length)
  })

  it("no skill contains secrets or .env references to read", () => {
    const dirs = fs.readdirSync(SKILLS_DIR).filter(f =>
      fs.statSync(path.join(SKILLS_DIR, f)).isDirectory(),
    )
    for (const dir of dirs) {
      const mdFile = path.join(SKILLS_DIR, dir, `${dir}.md`)
      if (!fs.existsSync(mdFile)) continue
      const content = fs.readFileSync(mdFile, "utf-8")
      expect(content).not.toMatch(/cat \.env/)
      expect(content).not.toMatch(/echo \$\w*TOKEN/)
      expect(content).not.toMatch(/echo \$\w*KEY/)
      expect(content).not.toMatch(/echo \$\w*SECRET/)
    }
  })
})
