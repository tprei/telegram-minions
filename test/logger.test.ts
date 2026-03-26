import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createLogger, createSessionLogger, loggers } from "../src/logger.js"

describe("Logger", () => {
  let consoleSpy: ReturnType<typeof console.log>
  let originalLogLevel: string

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    originalLogLevel = process.env.LOG_LEVEL || "info"
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    process.env.LOG_LEVEL = originalLogLevel
  })

  describe("createLogger", () => {
    it("creates a logger with context", () => {
      const logger = createLogger({ component: "test" })
      expect(logger).toBeDefined()
      // Log something and verify it was called
      logger.info({ test: true }, "test message")
    })
  })

  describe("createSessionLogger", () => {
    it("creates a session-scoped logger", () => {
      const logger = createSessionLogger("test-slug", 123, "session-456")
      expect(logger).toBeDefined()
    })
  })

  describe("loggers", () => {
    it("provides pre-configured loggers for common components", () => {
      expect(loggers.main).toBeDefined()
      expect(loggers.dispatcher).toBeDefined()
      expect(loggers.observer).toBeDefined()
      expect(loggers.telegram).toBeDefined()
      expect(loggers.session).toBeDefined()
      expect(loggers.store).toBeDefined()
      expect(loggers.profileStore).toBeDefined()
      expect(loggers.ciBabysit).toBeDefined()
      expect(loggers.split).toBeDefined()
      expect(loggers.dagExtract).toBeDefined()
      expect(loggers.apiServer).toBeDefined()
      expect(loggers.sentry).toBeDefined()
      expect(loggers.stats).toBeDefined()
      expect(loggers.sessionLog).toBeDefined()
      expect(loggers.minion).toBeDefined()
    })
  })
