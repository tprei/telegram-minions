import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ProfileStore } from "../src/profile-store.js"
import type { ProviderProfile } from "../src/config-types.js"

const DEFAULT_PROFILE: ProviderProfile = {
  id: "claude-acp",
  name: "Claude Code (default)",
}

function makeProfile(id: string, name: string, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return { id, name, ...overrides }
}

describe("ProfileStore", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-store-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("basic operations", () => {
    it("initializes with default profile when no file exists", () => {
      const store = new ProfileStore(tmpDir)
      const profiles = store.list()
      expect(profiles).toHaveLength(1)
      expect(profiles[0].id).toBe(DEFAULT_PROFILE.id)
    })

    it("saves and loads profiles", () => {
      const store = new ProfileStore(tmpDir)
      store.add(makeProfile("custom-1", "Custom Profile 1"))

      const store2 = new ProfileStore(tmpDir)
      const profiles = store2.list()
      expect(profiles).toHaveLength(2)
      expect(profiles.some((p) => p.id === "custom-1")).toBe(true)
    })

    it("prevents duplicate profile ids", () => {
      const store = new ProfileStore(tmpDir)
      expect(store.add(makeProfile("custom-1", "Profile 1"))).toBe(true)
      expect(store.add(makeProfile("custom-1", "Profile 2"))).toBe(false)
      expect(store.list()).toHaveLength(2) // default + 1
    })

    it("updates existing profiles", () => {
      const store = new ProfileStore(tmpDir)
      store.add(makeProfile("custom-1", "Original Name"))
      store.update("custom-1", { name: "Updated Name", apiEndpoint: "https://api.example.com" })

      const profile = store.get("custom-1")
      expect(profile?.name).toBe("Updated Name")
      expect(profile?.apiEndpoint).toBe("https://api.example.com")
    })

    it("removes profiles", () => {
      const store = new ProfileStore(tmpDir)
      store.add(makeProfile("custom-1", "Custom Profile"))
      expect(store.remove("custom-1")).toBe(true)
      expect(store.list()).toHaveLength(1) // only default
    })

    it("cannot remove default profile", () => {
      const store = new ProfileStore(tmpDir)
      expect(store.remove(DEFAULT_PROFILE.id)).toBe(false)
      expect(store.list()).toHaveLength(1)
    })
  })

  describe("default profile", () => {
    it("getDefaultId returns undefined when no default set", () => {
      const store = new ProfileStore(tmpDir)
      expect(store.getDefaultId()).toBeUndefined()
    })

    it("setDefaultId sets the default profile", () => {
      const store = new ProfileStore(tmpDir)
      store.add(makeProfile("custom-1", "Custom Profile"))
      expect(store.setDefaultId("custom-1")).toBe(true)
      expect(store.getDefaultId()).toBe("custom-1")
    })

    it("setDefaultId fails for non-existent profile", () => {
      const store = new ProfileStore(tmpDir)
      expect(store.setDefaultId("non-existent")).toBe(false)
      expect(store.getDefaultId()).toBeUndefined()
    })

    it("setDefaultId can set default to built-in profile", () => {
      const store = new ProfileStore(tmpDir)
      expect(store.setDefaultId(DEFAULT_PROFILE.id)).toBe(true)
      expect(store.getDefaultId()).toBe(DEFAULT_PROFILE.id)
    })

    it("clearDefault removes the default profile setting", () => {
      const store = new ProfileStore(tmpDir)
      store.add(makeProfile("custom-1", "Custom Profile"))
      store.setDefaultId("custom-1")
      expect(store.getDefaultId()).toBe("custom-1")

      store.clearDefault()
      expect(store.getDefaultId()).toBeUndefined()
    })

    it("persists default profile through save/load", () => {
      const store = new ProfileStore(tmpDir)
      store.add(makeProfile("custom-1", "Custom Profile"))
      store.setDefaultId("custom-1")

      const store2 = new ProfileStore(tmpDir)
      expect(store2.getDefaultId()).toBe("custom-1")
    })

    it("clearing default persists through save/load", () => {
      const store = new ProfileStore(tmpDir)
      store.add(makeProfile("custom-1", "Custom Profile"))
      store.setDefaultId("custom-1")
      store.clearDefault()

      const store2 = new ProfileStore(tmpDir)
      expect(store2.getDefaultId()).toBeUndefined()
    })

    it("removing profile clears its default status", () => {
      const store = new ProfileStore(tmpDir)
      store.add(makeProfile("custom-1", "Custom Profile"))
      store.setDefaultId("custom-1")
      store.remove("custom-1")

      expect(store.getDefaultId()).toBeUndefined()
    })

    it("removing profile clears default and persists", () => {
      const store = new ProfileStore(tmpDir)
      store.add(makeProfile("custom-1", "Custom Profile"))
      store.setDefaultId("custom-1")
      store.remove("custom-1")

      const store2 = new ProfileStore(tmpDir)
      expect(store2.getDefaultId()).toBeUndefined()
    })
  })

  describe("backwards compatibility", () => {
    it("loads old format (array) without default profile", () => {
      const oldData: ProviderProfile[] = [makeProfile("custom-1", "Custom")]
      fs.writeFileSync(path.join(tmpDir, "profiles.json"), JSON.stringify(oldData))

      const store = new ProfileStore(tmpDir)
      const profiles = store.list()
      expect(profiles).toHaveLength(2) // default + custom
      expect(profiles.some((p) => p.id === DEFAULT_PROFILE.id)).toBe(true)
      expect(store.getDefaultId()).toBeUndefined()
    })

    it("loads new format with default profile id", () => {
      const newData = {
        profiles: [makeProfile("custom-1", "Custom")],
        defaultProfileId: "custom-1",
      }
      fs.writeFileSync(path.join(tmpDir, "profiles.json"), JSON.stringify(newData))

      const store = new ProfileStore(tmpDir)
      expect(store.getDefaultId()).toBe("custom-1")
    })
  })
})
