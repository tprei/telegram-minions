import { describe, it, expect } from "vitest"
import {
  ConfigValidationError,
  validateTelegramConfig,
  validateGooseConfig,
  validateClaudeConfig,
  validateCiConfig,
  validateSentryConfig,
  validateApiServerConfig,
  validateProviderProfile,
  validateConfigOrThrow,
} from "../../src/config/config-validator.js"

describe("validateTelegramConfig", () => {
  const valid = { botToken: "123:ABC", chatId: "-100123", allowedUserIds: [1, 2] }

  it("accepts valid config", () => {
    expect(validateTelegramConfig(valid)).toEqual({ valid: true, errors: [] })
  })

  it("rejects non-object", () => {
    const r = validateTelegramConfig(null)
    expect(r.valid).toBe(false)
    expect(r.errors[0].path).toBe("telegram")
  })

  it("rejects empty botToken", () => {
    const r = validateTelegramConfig({ ...valid, botToken: "  " })
    expect(r.valid).toBe(false)
    expect(r.errors[0].path).toBe("telegram.botToken")
  })

  it("rejects non-integer allowedUserIds", () => {
    const r = validateTelegramConfig({ ...valid, allowedUserIds: [1.5] })
    expect(r.valid).toBe(false)
    expect(r.errors[0].path).toBe("telegram.allowedUserIds[0]")
  })
})

describe("validateGooseConfig", () => {
  it("accepts valid config", () => {
    expect(validateGooseConfig({ provider: "openai", model: "gpt-4" }).valid).toBe(true)
  })

  it("rejects missing model", () => {
    const r = validateGooseConfig({ provider: "openai" })
    expect(r.valid).toBe(false)
  })
})

describe("validateClaudeConfig", () => {
  const valid = { planModel: "opus", thinkModel: "sonnet", reviewModel: "haiku" }

  it("accepts valid built-in models", () => {
    expect(validateClaudeConfig(valid).valid).toBe(true)
  })

  it("accepts custom model with slash", () => {
    const r = validateClaudeConfig({ ...valid, planModel: "anthropic/claude-3" })
    expect(r.valid).toBe(true)
  })

  it("rejects unknown model without slash", () => {
    const r = validateClaudeConfig({ ...valid, planModel: "gpt-4" })
    expect(r.valid).toBe(false)
    expect(r.errors[0].message).toContain("Invalid model")
  })

  it("rejects missing fields", () => {
    const r = validateClaudeConfig({})
    expect(r.valid).toBe(false)
    expect(r.errors.length).toBe(3)
  })
})

describe("validateCiConfig", () => {
  const valid = {
    babysitEnabled: true,
    maxRetries: 3,
    pollIntervalMs: 10000,
    pollTimeoutMs: 120000,
    dagCiPolicy: "block",
  }

  it("accepts valid config", () => {
    expect(validateCiConfig(valid).valid).toBe(true)
  })

  it("rejects invalid dagCiPolicy", () => {
    const r = validateCiConfig({ ...valid, dagCiPolicy: "ignore" })
    expect(r.valid).toBe(false)
    expect(r.errors[0].path).toBe("ci.dagCiPolicy")
  })

  it("rejects maxRetries out of range", () => {
    const r = validateCiConfig({ ...valid, maxRetries: 99 })
    expect(r.valid).toBe(false)
  })
})

describe("validateSentryConfig", () => {
  it("accepts undefined/null as valid", () => {
    expect(validateSentryConfig(undefined).valid).toBe(true)
    expect(validateSentryConfig(null).valid).toBe(true)
  })

  it("accepts valid DSN", () => {
    expect(validateSentryConfig({ dsn: "https://key@sentry.io/123" }).valid).toBe(true)
  })

  it("rejects non-https DSN", () => {
    const r = validateSentryConfig({ dsn: "http://key@sentry.io/123" })
    expect(r.valid).toBe(false)
  })
})

describe("validateApiServerConfig", () => {
  it("accepts undefined/null", () => {
    expect(validateApiServerConfig(null).valid).toBe(true)
  })

  it("accepts valid port", () => {
    expect(validateApiServerConfig({ port: 3000 }).valid).toBe(true)
  })

  it("rejects port out of range", () => {
    expect(validateApiServerConfig({ port: 0 }).valid).toBe(false)
    expect(validateApiServerConfig({ port: 70000 }).valid).toBe(false)
  })
})

describe("validateProviderProfile", () => {
  it("accepts valid profile", () => {
    const r = validateProviderProfile({ id: "p1", name: "Provider" })
    expect(r.valid).toBe(true)
  })

  it("rejects invalid baseUrl scheme", () => {
    const r = validateProviderProfile({ id: "p1", name: "P", baseUrl: "ftp://host" })
    expect(r.valid).toBe(false)
    expect(r.errors[0].message).toContain("http://")
  })
})

describe("validateConfigOrThrow", () => {
  it("throws ConfigValidationError for invalid config", () => {
    expect(() => validateConfigOrThrow(null)).toThrow(ConfigValidationError)
  })

  it("throws with combined message for multiple errors", () => {
    expect(() => validateConfigOrThrow({})).toThrow("Multiple validation errors")
  })
})
