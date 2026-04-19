import fs from "node:fs/promises"
import path from "node:path"
import webpush from "web-push"

export interface VapidKeys {
  publicKey: string
  privateKey: string
  /** Contact URL or mailto: passed as VAPID `sub` claim. */
  subject: string
}

const VAPID_FILE = ".push/vapid.json"
const DEFAULT_SUBJECT = "mailto:minions@example.invalid"

/**
 * Load VAPID keys from disk; generate + persist on first boot.
 *
 * A single minion instance uses one key pair for the life of its workspace
 * volume. Subscribers stored against the previous key pair would fail to
 * validate after a regeneration, so we never regenerate once a file exists.
 */
export async function loadOrCreateVapidKeys(workspaceRoot: string): Promise<VapidKeys> {
  const filePath = path.join(workspaceRoot, VAPID_FILE)
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<VapidKeys>
    if (parsed.publicKey && parsed.privateKey) {
      return {
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
        subject: parsed.subject ?? DEFAULT_SUBJECT,
      }
    }
  } catch {
    // Fall through to generation.
  }

  const generated = webpush.generateVAPIDKeys()
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: DEFAULT_SUBJECT,
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 })
  return keys
}
