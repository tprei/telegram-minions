import { describe, it, expect } from "vitest"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const assetsDir = join(root, "assets")
const skillsDir = join(assetsDir, ".goose", "skills")

const EXPECTED_SKILLS = [
  "pr-workflow",
  "testing",
  "ci-diagnosis",
  "code-exploration",
  "secure-coding",
]

describe("Goose skills", () => {
  it("skills directory exists", () => {
    expect(existsSync(skillsDir)).toBe(true)
  })

  it("contains all expected skill directories", () => {
    const dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    expect(dirs).toEqual([...EXPECTED_SKILLS].sort())
  })

  for (const skill of EXPECTED_SKILLS) {
    describe(`skill: ${skill}`, () => {
      const skillPath = join(skillsDir, skill, "SKILL.md")

      it("has a SKILL.md file", () => {
        expect(existsSync(skillPath)).toBe(true)
      })

      it("has valid YAML frontmatter with name and description", () => {
        const content = readFileSync(skillPath, "utf-8")
        const match = content.match(/^---\n([\s\S]*?)\n---/)
        expect(match).not.toBeNull()

        const frontmatter = match![1]
        const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
        const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

        expect(nameMatch).not.toBeNull()
        expect(descMatch).not.toBeNull()
        expect(nameMatch![1].trim()).toBe(skill)
        expect(descMatch![1].trim().length).toBeGreaterThan(10)
      })

      it("has markdown content after frontmatter", () => {
        const content = readFileSync(skillPath, "utf-8")
        const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "")
        expect(body.trim().length).toBeGreaterThan(50)
      })

      it("contains a top-level heading", () => {
        const content = readFileSync(skillPath, "utf-8")
        expect(content).toMatch(/^# .+/m)
      })
    })
  }
})

describe("Goose hints", () => {
  const hintsPath = join(assetsDir, ".goosehints")

  it(".goosehints file exists in assets/", () => {
    expect(existsSync(hintsPath)).toBe(true)
  })

  it("is non-empty", () => {
    const content = readFileSync(hintsPath, "utf-8")
    expect(content.trim().length).toBeGreaterThan(100)
  })

  it("contains key project guidance sections", () => {
    const content = readFileSync(hintsPath, "utf-8")
    expect(content).toContain("Development commands")
    expect(content).toContain("Key conventions")
    expect(content).toContain("Dependencies")
  })

  it("does not contain secrets or env values", () => {
    const content = readFileSync(hintsPath, "utf-8")
    expect(content).not.toMatch(/TELEGRAM_BOT_TOKEN\s*=/)
    expect(content).not.toMatch(/ANTHROPIC_API_KEY\s*=/)
    expect(content).not.toMatch(/sk-[a-zA-Z0-9]{20,}/)
  })
})
