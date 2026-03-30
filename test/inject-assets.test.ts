import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { injectAgentFiles, resolvePackageAssetsDir } from "../src/session/inject-assets.js"

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inject-assets-test-"))
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

describe("resolvePackageAssetsDir", () => {
  it("returns a path ending with assets/", () => {
    const dir = resolvePackageAssetsDir()
    expect(dir).toMatch(/assets$/)
  })

  it("points to an existing directory", () => {
    const dir = resolvePackageAssetsDir()
    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe("injectAgentFiles", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    cleanup(tmpDir)
  })

  describe("agent injection from default assets", () => {
    it("copies agent .md files into .claude/agents/", () => {
      const result = injectAgentFiles(tmpDir)

      const agentsDir = path.join(tmpDir, ".claude", "agents")
      expect(fs.existsSync(agentsDir)).toBe(true)
      expect(result.agents).toBeGreaterThan(0)

      const files = fs.readdirSync(agentsDir)
      expect(files.length).toBeGreaterThan(0)
      expect(files.every((f) => f.endsWith(".md"))).toBe(true)
    })

    it("includes known default agents", () => {
      injectAgentFiles(tmpDir)

      const agentsDir = path.join(tmpDir, ".claude", "agents")
      const files = fs.readdirSync(agentsDir)
      expect(files).toContain("post-task-router.md")
      expect(files).toContain("git-commit-specialist.md")
    })
  })

  describe("no-overwrite policy", () => {
    it("does not overwrite existing agent files", () => {
      const agentsDir = path.join(tmpDir, ".claude", "agents")
      fs.mkdirSync(agentsDir, { recursive: true })
      fs.writeFileSync(path.join(agentsDir, "post-task-router.md"), "custom content")

      injectAgentFiles(tmpDir)

      const content = fs.readFileSync(path.join(agentsDir, "post-task-router.md"), "utf8")
      expect(content).toBe("custom content")
    })

    it("does not overwrite existing .goosehints", () => {
      fs.writeFileSync(path.join(tmpDir, ".goosehints"), "existing hints")

      // Create a custom goosehints source
      const customDir = makeTmpDir()
      fs.writeFileSync(path.join(customDir, "goosehints"), "new hints")

      injectAgentFiles(tmpDir, { goosehintsPath: path.join(customDir, "goosehints") })

      const content = fs.readFileSync(path.join(tmpDir, ".goosehints"), "utf8")
      expect(content).toBe("existing hints")

      cleanup(customDir)
    })

    it("does not overwrite existing CLAUDE.md", () => {
      const claudeDir = path.join(tmpDir, ".claude")
      fs.mkdirSync(claudeDir, { recursive: true })
      fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), "custom CLAUDE.md")

      const srcDir = makeTmpDir()
      fs.writeFileSync(path.join(srcDir, "CLAUDE.md"), "injected")

      injectAgentFiles(tmpDir, { claudeMd: path.join(srcDir, "CLAUDE.md") })

      const content = fs.readFileSync(path.join(claudeDir, "CLAUDE.md"), "utf8")
      expect(content).toBe("custom CLAUDE.md")

      cleanup(srcDir)
    })
  })

  describe("custom agentDefs paths", () => {
    it("uses custom agentsDir when provided", () => {
      const customAgentsDir = makeTmpDir()
      fs.writeFileSync(path.join(customAgentsDir, "custom-agent.md"), "# Custom Agent")
      fs.writeFileSync(path.join(customAgentsDir, "another.md"), "# Another")
      fs.writeFileSync(path.join(customAgentsDir, "not-md.txt"), "ignored")

      const result = injectAgentFiles(tmpDir, { agentsDir: customAgentsDir })

      expect(result.agents).toBe(2)
      const files = fs.readdirSync(path.join(tmpDir, ".claude", "agents"))
      expect(files).toContain("custom-agent.md")
      expect(files).toContain("another.md")
      expect(files).not.toContain("not-md.txt")

      cleanup(customAgentsDir)
    })

    it("uses custom goosehintsPath when provided", () => {
      const hintsDir = makeTmpDir()
      const hintsPath = path.join(hintsDir, "my-hints")
      fs.writeFileSync(hintsPath, "custom goose hints content")

      const result = injectAgentFiles(tmpDir, { goosehintsPath: hintsPath })

      expect(result.goosehints).toBe(true)
      const content = fs.readFileSync(path.join(tmpDir, ".goosehints"), "utf8")
      expect(content).toBe("custom goose hints content")

      cleanup(hintsDir)
    })

    it("uses custom claudeMd path when provided", () => {
      const mdDir = makeTmpDir()
      const mdPath = path.join(mdDir, "custom-claude.md")
      fs.writeFileSync(mdPath, "# Custom CLAUDE guidance")

      const result = injectAgentFiles(tmpDir, { claudeMd: mdPath })

      expect(result.claudeMd).toBe(true)
      const content = fs.readFileSync(path.join(tmpDir, ".claude", "CLAUDE.md"), "utf8")
      expect(content).toBe("# Custom CLAUDE guidance")

      cleanup(mdDir)
    })

    it("injects settingsJson as JSON file", () => {
      const settings = { permissions: { allow: ["Bash(*)"] } }

      const result = injectAgentFiles(tmpDir, { settingsJson: settings })

      expect(result.settingsJson).toBe(true)
      const content = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf8"))
      expect(content).toEqual(settings)
    })
  })

  describe("skills injection", () => {
    it("copies skill subdirectories into .claude/skills/", () => {
      const skillsDir = makeTmpDir()
      const commitDir = path.join(skillsDir, "commit")
      const exploreDir = path.join(skillsDir, "explore")
      fs.mkdirSync(commitDir)
      fs.mkdirSync(exploreDir)
      fs.writeFileSync(path.join(commitDir, "commit.md"), "# Commit Skill")
      fs.writeFileSync(path.join(exploreDir, "explore.md"), "# Explore Skill")
      fs.writeFileSync(path.join(skillsDir, "not-md.txt"), "ignored")

      const result = injectAgentFiles(tmpDir, { skillsDir })

      expect(result.skills).toBe(2)
      const injectedDir = path.join(tmpDir, ".claude", "skills")
      expect(fs.existsSync(injectedDir)).toBe(true)
      expect(fs.readFileSync(path.join(injectedDir, "commit", "commit.md"), "utf8")).toBe("# Commit Skill")
      expect(fs.readFileSync(path.join(injectedDir, "explore", "explore.md"), "utf8")).toBe("# Explore Skill")
      expect(fs.existsSync(path.join(injectedDir, "not-md.txt"))).toBe(false)

      cleanup(skillsDir)
    })

    it("does not overwrite existing skill directories", () => {
      const skillsDir = makeTmpDir()
      const srcCommit = path.join(skillsDir, "commit")
      fs.mkdirSync(srcCommit)
      fs.writeFileSync(path.join(srcCommit, "commit.md"), "new content")

      // Pre-create the skill directory in the workspace
      const existingDir = path.join(tmpDir, ".claude", "skills")
      fs.mkdirSync(path.join(existingDir, "commit"), { recursive: true })
      fs.writeFileSync(path.join(existingDir, "commit", "commit.md"), "existing content")

      const result = injectAgentFiles(tmpDir, { skillsDir })

      expect(result.skills).toBe(0)
      const content = fs.readFileSync(path.join(existingDir, "commit", "commit.md"), "utf8")
      expect(content).toBe("existing content")

      cleanup(skillsDir)
    })

    it("injects default skills from assets/.claude/skills/", () => {
      const result = injectAgentFiles(tmpDir)

      expect(result.skills).toBeGreaterThan(0)
      const skillsDir = path.join(tmpDir, ".claude", "skills")
      const entries = fs.readdirSync(skillsDir)
      expect(entries).toContain("commit")
      expect(entries).toContain("explore")
    })
  })

  describe("missing source paths", () => {
    it("handles non-existent agentsDir gracefully", () => {
      const result = injectAgentFiles(tmpDir, { agentsDir: "/nonexistent/path" })
      expect(result.agents).toBe(0)
    })

    it("handles non-existent skillsDir gracefully", () => {
      const result = injectAgentFiles(tmpDir, { skillsDir: "/nonexistent/path" })
      expect(result.skills).toBe(0)
    })

    it("handles non-existent goosehintsPath gracefully", () => {
      const result = injectAgentFiles(tmpDir, { goosehintsPath: "/nonexistent/hints" })
      expect(result.goosehints).toBe(false)
    })

    it("handles non-existent claudeMd gracefully", () => {
      const result = injectAgentFiles(tmpDir, { claudeMd: "/nonexistent/CLAUDE.md" })
      expect(result.claudeMd).toBe(false)
    })
  })

  describe("default settings.json injection", () => {
    it("does not inject settings.json when no agentDefs provided", () => {
      const result = injectAgentFiles(tmpDir)
      expect(result.settingsJson).toBe(false)
      const settingsPath = path.join(tmpDir, ".claude", "settings.json")
      expect(fs.existsSync(settingsPath)).toBe(false)
    })
  })

  describe("idempotency", () => {
    it("produces same result when called twice", () => {
      const first = injectAgentFiles(tmpDir)
      const second = injectAgentFiles(tmpDir)

      // Second call should inject nothing since files already exist
      expect(second.agents).toBe(0)
      expect(second.skills).toBe(0)
      expect(second.claudeMd).toBe(false)
      expect(second.settingsJson).toBe(false)

      // First call should have injected something
      expect(first.agents).toBeGreaterThan(0)
      expect(first.skills).toBeGreaterThan(0)
    })
  })

  describe("settings.json no-overwrite", () => {
    it("does not overwrite existing settings.json", () => {
      const claudeDir = path.join(tmpDir, ".claude")
      fs.mkdirSync(claudeDir, { recursive: true })
      fs.writeFileSync(path.join(claudeDir, "settings.json"), '{"existing": true}')

      const result = injectAgentFiles(tmpDir, {
        settingsJson: { injected: true },
      })

      expect(result.settingsJson).toBe(false)
      const content = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"))
      expect(content).toEqual({ existing: true })
    })
  })

  describe("multiple skills", () => {
    it("copies multiple skill directories", () => {
      const skillsDir = makeTmpDir()

      for (const name of ["skill-a", "skill-b", "skill-c"]) {
        const skillPath = path.join(skillsDir, name)
        fs.mkdirSync(skillPath, { recursive: true })
        fs.writeFileSync(path.join(skillPath, "skill.md"), `# ${name}`)
      }

      const result = injectAgentFiles(tmpDir, { skillsDir })

      expect(result.skills).toBe(3)
      for (const name of ["skill-a", "skill-b", "skill-c"]) {
        expect(fs.existsSync(path.join(tmpDir, ".claude", "skills", name, "skill.md"))).toBe(true)
      }

      cleanup(skillsDir)
    })

    it("skips loose files in skills source directory", () => {
      const skillsDir = makeTmpDir()
      fs.writeFileSync(path.join(skillsDir, "README.md"), "loose file")

      const skillPath = path.join(skillsDir, "real-skill")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.writeFileSync(path.join(skillPath, "skill.md"), "# Real Skill")

      const result = injectAgentFiles(tmpDir, { skillsDir })

      expect(result.skills).toBe(1)
      expect(fs.existsSync(path.join(tmpDir, ".claude", "skills", "README.md"))).toBe(false)

      cleanup(skillsDir)
    })

    it("copies all file types within a skill directory", () => {
      const skillsDir = makeTmpDir()
      const skillPath = path.join(skillsDir, "my-skill")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.writeFileSync(path.join(skillPath, "skill.md"), "# Skill")
      fs.writeFileSync(path.join(skillPath, "config.json"), "{}")
      fs.writeFileSync(path.join(skillPath, "helper.sh"), "#!/bin/bash")

      const result = injectAgentFiles(tmpDir, { skillsDir })

      expect(result.skills).toBe(1)
      const injected = path.join(tmpDir, ".claude", "skills", "my-skill")
      expect(fs.readFileSync(path.join(injected, "skill.md"), "utf8")).toBe("# Skill")
      expect(fs.readFileSync(path.join(injected, "config.json"), "utf8")).toBe("{}")
      expect(fs.readFileSync(path.join(injected, "helper.sh"), "utf8")).toBe("#!/bin/bash")

      cleanup(skillsDir)
    })
  })

  describe("combined injection", () => {
    it("injects agents, skills, CLAUDE.md, goosehints, and settings together", () => {
      const srcDir = makeTmpDir()

      // Set up custom agents
      const agentsDir = path.join(srcDir, "agents")
      fs.mkdirSync(agentsDir)
      fs.writeFileSync(path.join(agentsDir, "my-agent.md"), "# Agent")

      // Set up custom skills
      const skillsDir = path.join(srcDir, "skills")
      const skillPath = path.join(skillsDir, "my-skill")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.writeFileSync(path.join(skillPath, "skill.md"), "# Skill")

      // Set up custom CLAUDE.md and goosehints
      fs.writeFileSync(path.join(srcDir, "CLAUDE.md"), "# Custom guidance")
      fs.writeFileSync(path.join(srcDir, "goosehints"), "custom hints")

      const result = injectAgentFiles(tmpDir, {
        agentsDir,
        skillsDir,
        claudeMd: path.join(srcDir, "CLAUDE.md"),
        goosehintsPath: path.join(srcDir, "goosehints"),
        settingsJson: { permissions: { allow: ["Read"] } },
      })

      expect(result.agents).toBe(1)
      expect(result.skills).toBe(1)
      expect(result.claudeMd).toBe(true)
      expect(result.goosehints).toBe(true)
      expect(result.settingsJson).toBe(true)

      cleanup(srcDir)
    })
  })

  describe("empty source directories", () => {
    it("handles empty agents directory", () => {
      const emptyDir = makeTmpDir()
      const result = injectAgentFiles(tmpDir, { agentsDir: emptyDir })
      expect(result.agents).toBe(0)
      cleanup(emptyDir)
    })

    it("handles empty skills directory", () => {
      const emptyDir = makeTmpDir()
      const result = injectAgentFiles(tmpDir, { skillsDir: emptyDir })
      expect(result.skills).toBe(0)
      cleanup(emptyDir)
    })
  })

  describe("settings.json format", () => {
    it("writes pretty-printed JSON with 2-space indent", () => {
      const settings = { a: 1, b: { c: 2 } }
      injectAgentFiles(tmpDir, { settingsJson: settings })

      const raw = fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf8")
      expect(raw).toBe(JSON.stringify(settings, null, 2))
    })
  })

  describe("no agentDefs provided", () => {
    it("falls back to default assets for all injection types", () => {
      const result = injectAgentFiles(tmpDir)

      // Agents should come from default assets
      expect(result.agents).toBeGreaterThan(0)
      const agentsDir = path.join(tmpDir, ".claude", "agents")
      expect(fs.readdirSync(agentsDir)).toContain("post-task-router.md")

      // settingsJson requires explicit config, so should be false
      expect(result.settingsJson).toBe(false)
    })
  })
})
