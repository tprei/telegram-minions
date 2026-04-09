import { describe, it, expect } from "vitest"
import { validatePlatformConfig } from "../../src/config/config-validator.js"

describe("validatePlatformConfig", () => {
  it("accepts undefined/null (platform is optional)", () => {
    expect(validatePlatformConfig(undefined)).toEqual({ valid: true, errors: [] })
    expect(validatePlatformConfig(null)).toEqual({ valid: true, errors: [] })
  })

  it("rejects non-object", () => {
    const r = validatePlatformConfig("telegram")
    expect(r.valid).toBe(false)
    expect(r.errors[0].path).toBe("platform")
  })

  it("rejects missing type", () => {
    const r = validatePlatformConfig({})
    expect(r.valid).toBe(false)
    expect(r.errors[0].path).toBe("platform.type")
  })

  it("rejects unknown type", () => {
    const r = validatePlatformConfig({ type: "discord" })
    expect(r.valid).toBe(false)
    expect(r.errors[0].message).toContain('"discord"')
  })

  describe("telegram platform", () => {
    const valid = {
      type: "telegram",
      botToken: "123:ABC",
      chatId: "-100123",
      allowedUserIds: [1, 2],
      minSendIntervalMs: 3500,
    }

    it("accepts valid telegram config", () => {
      expect(validatePlatformConfig(valid)).toEqual({ valid: true, errors: [] })
    })

    it("rejects empty botToken", () => {
      const r = validatePlatformConfig({ ...valid, botToken: "" })
      expect(r.valid).toBe(false)
      expect(r.errors[0].path).toBe("platform.botToken")
    })

    it("rejects missing chatId", () => {
      const r = validatePlatformConfig({ ...valid, chatId: undefined })
      expect(r.valid).toBe(false)
      expect(r.errors[0].path).toBe("platform.chatId")
    })

    it("rejects non-integer allowedUserIds", () => {
      const r = validatePlatformConfig({ ...valid, allowedUserIds: [1.5] })
      expect(r.valid).toBe(false)
      expect(r.errors[0].path).toBe("platform.allowedUserIds[0]")
    })

    it("rejects negative minSendIntervalMs", () => {
      const r = validatePlatformConfig({ ...valid, minSendIntervalMs: -1 })
      expect(r.valid).toBe(false)
      expect(r.errors[0].path).toBe("platform.minSendIntervalMs")
    })
  })

  describe("custom platform", () => {
    const valid = {
      type: "custom",
      allowedUserIds: ["user-1", "user-2"],
    }

    it("accepts valid custom config", () => {
      expect(validatePlatformConfig(valid)).toEqual({ valid: true, errors: [] })
    })

    it("rejects non-string allowedUserIds", () => {
      const r = validatePlatformConfig({ ...valid, allowedUserIds: [123] })
      expect(r.valid).toBe(false)
      expect(r.errors[0].path).toBe("platform.allowedUserIds[0]")
    })

    it("rejects empty string in allowedUserIds", () => {
      const r = validatePlatformConfig({ ...valid, allowedUserIds: [""] })
      expect(r.valid).toBe(false)
      expect(r.errors[0].path).toBe("platform.allowedUserIds[0]")
    })
  })
})
