import fs from "node:fs"
import path from "node:path"
import type { ProviderProfile } from "./config-types.js"
import { captureException } from "./sentry.js"

const STORE_FILENAME = "profiles.json"

const DEFAULT_PROFILE: ProviderProfile = {
  id: "claude-acp",
  name: "Claude Code (default)",
}

export class ProfileStore {
  private readonly filePath: string
  private profiles: ProviderProfile[] = []

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, STORE_FILENAME)
    this.load()
  }

  load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.profiles = [DEFAULT_PROFILE]
        return
      }
      const raw = fs.readFileSync(this.filePath, "utf-8")
      const data = JSON.parse(raw) as ProviderProfile[]
      const hasDefault = data.some((p) => p.id === DEFAULT_PROFILE.id)
      this.profiles = hasDefault ? data : [DEFAULT_PROFILE, ...data]
    } catch (err) {
      process.stderr.write(`profile-store: failed to load profiles: ${err}\n`)
      captureException(err, { operation: "profile-store.load" })
      this.profiles = [DEFAULT_PROFILE]
    }
  }

  save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.profiles, null, 2), "utf-8")
    } catch (err) {
      process.stderr.write(`profile-store: failed to save profiles: ${err}\n`)
      captureException(err, { operation: "profile-store.save" })
    }
  }

  list(): ProviderProfile[] {
    return [...this.profiles]
  }

  get(id: string): ProviderProfile | undefined {
    return this.profiles.find((p) => p.id === id)
  }

  add(profile: ProviderProfile): boolean {
    if (this.profiles.some((p) => p.id === profile.id)) {
      return false
    }
    this.profiles.push(profile)
    this.save()
    return true
  }

  update(id: string, updates: Partial<Omit<ProviderProfile, "id">>): boolean {
    const idx = this.profiles.findIndex((p) => p.id === id)
    if (idx === -1) return false
    this.profiles[idx] = { ...this.profiles[idx], ...updates }
    this.save()
    return true
  }

  remove(id: string): boolean {
    if (id === DEFAULT_PROFILE.id) return false
    const idx = this.profiles.findIndex((p) => p.id === id)
    if (idx === -1) return false
    this.profiles.splice(idx, 1)
    this.save()
    return true
  }
}
