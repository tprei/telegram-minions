import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execSync } from "node:child_process"
import { bootstrapDependencies, bootstrapPythonDependencies, cleanBuildArtifacts } from "../src/session/session-manager.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "python-bootstrap-test-"))
})

afterEach(() => {
  try {
    execSync(`chmod -R u+w ${JSON.stringify(tmpDir)}`, { stdio: "ignore" })
  } catch { /* best-effort */ }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("bootstrapPythonDependencies", () => {
  it("skips when no pyproject.toml or requirements.txt exists", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)

    bootstrapPythonDependencies(workDir, reposDir, "test-repo")

    expect(fs.existsSync(path.join(workDir, ".venv"))).toBe(false)
  })

  it("hardlinks cached .venv when uv.lock hash matches (pyproject.toml)", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)

    fs.writeFileSync(path.join(workDir, "pyproject.toml"), '[project]\nname = "test"')
    const lockContent = '# uv lockfile\nversion = 1'
    fs.writeFileSync(path.join(workDir, "uv.lock"), lockContent)

    // Create cached .venv with matching hash
    const cacheDir = path.join(reposDir, "test-repo-venv")
    fs.mkdirSync(path.join(cacheDir, "lib", "python3.13", "site-packages", "some_pkg"), { recursive: true })
    fs.writeFileSync(
      path.join(cacheDir, "lib", "python3.13", "site-packages", "some_pkg", "__init__.py"),
      "# cached",
    )

    const hash = crypto.createHash("sha256").update(lockContent).digest("hex")
    fs.writeFileSync(path.join(reposDir, "test-repo-uvlock.hash"), hash)

    bootstrapPythonDependencies(workDir, reposDir, "test-repo")

    expect(
      fs.existsSync(path.join(workDir, ".venv", "lib", "python3.13", "site-packages", "some_pkg", "__init__.py")),
    ).toBe(true)
    expect(
      fs.readFileSync(
        path.join(workDir, ".venv", "lib", "python3.13", "site-packages", "some_pkg", "__init__.py"),
        "utf8",
      ),
    ).toBe("# cached")
  })

  it("does not hardlink when uv.lock hash differs", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)

    fs.writeFileSync(path.join(workDir, "pyproject.toml"), '[project]\nname = "test"')
    fs.writeFileSync(path.join(workDir, "uv.lock"), "version = 2")

    const cacheDir = path.join(reposDir, "test-repo-venv")
    fs.mkdirSync(path.join(cacheDir, "lib"), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, "lib", "stale.py"), "old")
    fs.writeFileSync(path.join(reposDir, "test-repo-uvlock.hash"), "wrong-hash")

    // uv sync will fail (not installed), but that's non-fatal
    bootstrapPythonDependencies(workDir, reposDir, "test-repo")

    // Should NOT have hardlinked the stale cache
    expect(fs.existsSync(path.join(workDir, ".venv", "lib", "stale.py"))).toBe(false)
  })

  it("hardlinks cached .venv when requirements.txt hash matches", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)

    const reqContent = "flask==3.0.0\nrequests>=2.31"
    fs.writeFileSync(path.join(workDir, "requirements.txt"), reqContent)

    const cacheDir = path.join(reposDir, "test-repo-venv")
    fs.mkdirSync(path.join(cacheDir, "lib"), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, "lib", "flask.py"), "# flask")

    const hash = crypto.createHash("sha256").update(reqContent).digest("hex")
    fs.writeFileSync(path.join(reposDir, "test-repo-req.hash"), hash)

    bootstrapPythonDependencies(workDir, reposDir, "test-repo")

    expect(fs.existsSync(path.join(workDir, ".venv", "lib", "flask.py"))).toBe(true)
  })

  it("prefers pyproject.toml over requirements.txt when both exist", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)

    fs.writeFileSync(path.join(workDir, "pyproject.toml"), '[project]\nname = "test"')
    fs.writeFileSync(path.join(workDir, "requirements.txt"), "flask==3.0.0")
    const lockContent = "version = 1"
    fs.writeFileSync(path.join(workDir, "uv.lock"), lockContent)

    // Cache for pyproject.toml path (uses -uvlock.hash)
    const cacheDir = path.join(reposDir, "test-repo-venv")
    fs.mkdirSync(path.join(cacheDir, "lib"), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, "lib", "from-pyproject.py"), "yes")

    const hash = crypto.createHash("sha256").update(lockContent).digest("hex")
    fs.writeFileSync(path.join(reposDir, "test-repo-uvlock.hash"), hash)

    bootstrapPythonDependencies(workDir, reposDir, "test-repo")

    expect(fs.existsSync(path.join(workDir, ".venv", "lib", "from-pyproject.py"))).toBe(true)
  })

  it("multiple worktrees share the same .venv cache", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })

    const lockContent = "version = 1"
    const hash = crypto.createHash("sha256").update(lockContent).digest("hex")

    const cacheDir = path.join(reposDir, "test-repo-venv")
    fs.mkdirSync(path.join(cacheDir, "lib"), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, "lib", "shared.py"), "shared")
    fs.writeFileSync(path.join(reposDir, "test-repo-uvlock.hash"), hash)

    const worktrees = ["child-1", "child-2", "child-3"].map((name) => {
      const dir = path.join(tmpDir, name)
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "test"')
      fs.writeFileSync(path.join(dir, "uv.lock"), lockContent)
      return dir
    })

    for (const dir of worktrees) {
      bootstrapPythonDependencies(dir, reposDir, "test-repo")
    }

    for (const dir of worktrees) {
      expect(fs.readFileSync(path.join(dir, ".venv", "lib", "shared.py"), "utf8")).toBe("shared")
    }

    // Verify hardlinks share inodes
    const cacheInode = fs.statSync(path.join(cacheDir, "lib", "shared.py")).ino
    for (const dir of worktrees) {
      expect(fs.statSync(path.join(dir, ".venv", "lib", "shared.py")).ino).toBe(cacheInode)
    }
  })
})

describe("bootstrapDependencies - Python integration", () => {
  it("bootstraps Python deps alongside Node deps", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)

    // Node project
    fs.writeFileSync(path.join(workDir, "package.json"), '{"name":"test"}')

    // Python project
    fs.writeFileSync(path.join(workDir, "pyproject.toml"), '[project]\nname = "test"')
    const lockContent = "version = 1"
    fs.writeFileSync(path.join(workDir, "uv.lock"), lockContent)

    // Pre-populate Python cache
    const cacheDir = path.join(reposDir, "test-repo-venv")
    fs.mkdirSync(path.join(cacheDir, "lib"), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, "lib", "cached.py"), "yes")
    const hash = crypto.createHash("sha256").update(lockContent).digest("hex")
    fs.writeFileSync(path.join(reposDir, "test-repo-uvlock.hash"), hash)

    bootstrapDependencies(workDir, reposDir, "test-repo")

    expect(fs.existsSync(path.join(workDir, ".venv", "lib", "cached.py"))).toBe(true)
  })

  it("bootstraps nested Python project at depth 1", () => {
    const reposDir = path.join(tmpDir, ".repos")
    fs.mkdirSync(reposDir, { recursive: true })
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)

    const backendDir = path.join(workDir, "backend")
    fs.mkdirSync(backendDir)
    fs.writeFileSync(path.join(backendDir, "pyproject.toml"), '[project]\nname = "backend"')
    const lockContent = "version = 1"
    fs.writeFileSync(path.join(backendDir, "uv.lock"), lockContent)

    const cacheDir = path.join(reposDir, "test-repo-backend-venv")
    fs.mkdirSync(path.join(cacheDir, "lib"), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, "lib", "backend.py"), "backend")
    const hash = crypto.createHash("sha256").update(lockContent).digest("hex")
    fs.writeFileSync(path.join(reposDir, "test-repo-backend-uvlock.hash"), hash)

    bootstrapDependencies(workDir, reposDir, "test-repo")

    expect(fs.existsSync(path.join(backendDir, ".venv", "lib", "backend.py"))).toBe(true)
  })
})

describe("cleanBuildArtifacts - Python", () => {
  it("removes .venv directory", () => {
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(workDir)
    const venv = path.join(workDir, ".venv")
    fs.mkdirSync(path.join(venv, "lib"), { recursive: true })
    fs.writeFileSync(path.join(venv, "lib", "site.py"), "data")

    cleanBuildArtifacts(workDir)

    expect(fs.existsSync(venv)).toBe(false)
  })

  it("removes __pycache__ directories recursively", () => {
    const workDir = path.join(tmpDir, "work")
    fs.mkdirSync(path.join(workDir, "src", "pkg", "__pycache__"), { recursive: true })
    fs.writeFileSync(path.join(workDir, "src", "pkg", "__pycache__", "mod.cpython-313.pyc"), "bytecode")
    fs.mkdirSync(path.join(workDir, "__pycache__"), { recursive: true })
    fs.writeFileSync(path.join(workDir, "__pycache__", "main.cpython-313.pyc"), "bytecode")

    cleanBuildArtifacts(workDir)

    expect(fs.existsSync(path.join(workDir, "src", "pkg", "__pycache__"))).toBe(false)
    expect(fs.existsSync(path.join(workDir, "__pycache__"))).toBe(false)
    // Source files should remain
    expect(fs.existsSync(path.join(workDir, "src", "pkg"))).toBe(true)
  })

  it("removes nested .venv at depth 1", () => {
    const workDir = path.join(tmpDir, "work")
    const backendVenv = path.join(workDir, "backend", ".venv", "lib")
    fs.mkdirSync(backendVenv, { recursive: true })
    fs.writeFileSync(path.join(backendVenv, "site.py"), "data")

    cleanBuildArtifacts(workDir)

    expect(fs.existsSync(path.join(workDir, "backend", ".venv"))).toBe(false)
    expect(fs.existsSync(path.join(workDir, "backend"))).toBe(true)
  })

  it("removes .home/.cache/uv directory", () => {
    const workDir = path.join(tmpDir, "work")
    const uvCache = path.join(workDir, ".home", ".cache", "uv")
    fs.mkdirSync(uvCache, { recursive: true })
    fs.writeFileSync(path.join(uvCache, "cache.json"), "{}")

    cleanBuildArtifacts(workDir)

    expect(fs.existsSync(uvCache)).toBe(false)
    expect(fs.existsSync(path.join(workDir, ".home", ".cache"))).toBe(true)
  })
})
