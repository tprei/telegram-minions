import { describe, it, expect } from "vitest"
import {
  MinionError,
  DagCycleError,
  DagSelfDependencyError,
  UnknownNodeError,
  SessionNotFoundError,
  ConfigError,
  ConfigFormatError,
  TelegramApiError,
  TelegramRateLimitError,
  TelegramHttpError,
  TelegramResponseError,
  TelegramRetryExhaustedError,
  GitError,
  DefaultBranchError,
  isMinionError,
  isDagError,
  isSessionError,
  isConfigError,
  isTelegramError,
  isThreadNotFoundError,
} from "../src/errors.js"

describe("MinionError", () => {
  it("is abstract and sets name correctly", () => {
    class TestError extends MinionError {
      constructor() {
        super("test error")
      }
    }
    const err = new TestError()
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(MinionError)
    expect(err.name).toBe("TestError")
    expect(err.message).toBe("test error")
  })
})

describe("DAG errors", () => {
  describe("DagCycleError", () => {
    it("has correct message and name without cycle nodes", () => {
      const err = new DagCycleError()
      expect(err).toBeInstanceOf(MinionError)
      expect(err).toBeInstanceOf(DagCycleError)
      expect(err.name).toBe("DagCycleError")
      expect(err.message).toBe("DAG contains a cycle")
      expect(err.cycleNodes).toBeUndefined()
    })

    it("includes cycle nodes in message when provided", () => {
      const err = new DagCycleError(["node-a", "node-b", "node-a"])
      expect(err.message).toBe("DAG contains a cycle: node-a → node-b → node-a")
      expect(err.cycleNodes).toEqual(["node-a", "node-b", "node-a"])
    })
  })

  describe("DagSelfDependencyError", () => {
    it("includes nodeId in message and property", () => {
      const err = new DagSelfDependencyError("node-a")
      expect(err).toBeInstanceOf(MinionError)
      expect(err).toBeInstanceOf(DagSelfDependencyError)
      expect(err.name).toBe("DagSelfDependencyError")
      expect(err.message).toBe('Node "node-a" depends on itself')
      expect(err.nodeId).toBe("node-a")
    })
  })

  describe("UnknownNodeError", () => {
    it("includes nodeId and unknownDependency in message and properties", () => {
      const err = new UnknownNodeError("node-a", "missing-node")
      expect(err).toBeInstanceOf(MinionError)
      expect(err).toBeInstanceOf(UnknownNodeError)
      expect(err.name).toBe("UnknownNodeError")
      expect(err.message).toBe('Node "node-a" depends on unknown node "missing-node"')
      expect(err.nodeId).toBe("node-a")
      expect(err.unknownDependency).toBe("missing-node")
      expect(err.availableNodes).toEqual([])
    })

    it("includes available nodes in suggestion when provided", () => {
      const err = new UnknownNodeError("node-a", "missing-node", ["node-b", "node-c"])
      expect(err.message).toBe('Node "node-a" depends on unknown node "missing-node". Available: "node-b", "node-c"')
      expect(err.availableNodes).toEqual(["node-b", "node-c"])
    })
  })
})

describe("Session errors", () => {
  describe("SessionNotFoundError", () => {
    it("includes threadId in message and property", () => {
      const err = new SessionNotFoundError(12345)
      expect(err).toBeInstanceOf(MinionError)
      expect(err).toBeInstanceOf(SessionNotFoundError)
      expect(err.name).toBe("SessionNotFoundError")
      expect(err.message).toBe("Session not found: thread 12345. No active sessions")
      expect(err.threadId).toBe(12345)
      expect(err.activeThreadIds).toBeUndefined()
    })

    it("includes active sessions in suggestion when provided", () => {
      const err = new SessionNotFoundError(12345, [111, 222, 333])
      expect(err.message).toBe("Session not found: thread 12345. Active sessions: 111, 222, 333")
      expect(err.activeThreadIds).toEqual([111, 222, 333])
    })
  })
})

describe("Config errors", () => {
  describe("ConfigError", () => {
    it("includes varName in property and suggestion in message", () => {
      const err = new ConfigError("Missing required env var: API_KEY", "API_KEY")
      expect(err).toBeInstanceOf(MinionError)
      expect(err).toBeInstanceOf(ConfigError)
      expect(err.name).toBe("ConfigError")
      expect(err.message).toBe("Missing required env var: API_KEY. Check .env.example for required configuration")
      expect(err.varName).toBe("API_KEY")
    })
  })

  describe("ConfigFormatError", () => {
    it("includes all properties and suggestion", () => {
      const err = new ConfigFormatError("PORT", "a number", "abc")
      expect(err).toBeInstanceOf(MinionError)
      expect(err).toBeInstanceOf(ConfigError)
      expect(err).toBeInstanceOf(ConfigFormatError)
      expect(err.name).toBe("ConfigFormatError")
      expect(err.message).toBe("Env var PORT must be a number, got: abc. Check .env.example for required configuration")
      expect(err.varName).toBe("PORT")
      expect(err.actualValue).toBe("abc")
    })
  })
})

describe("Telegram errors", () => {
  describe("TelegramApiError", () => {
    it("includes method in message and property", () => {
      const err = new TelegramApiError("sendMessage", "Something went wrong")
      expect(err).toBeInstanceOf(MinionError)
      expect(err).toBeInstanceOf(TelegramApiError)
      expect(err.name).toBe("TelegramApiError")
      expect(err.message).toBe("Something went wrong")
      expect(err.method).toBe("sendMessage")
    })
  })

  describe("TelegramRateLimitError", () => {
    it("includes retryAfter when provided", () => {
      const err = new TelegramRateLimitError("sendMessage", "Too many requests", 30)
      expect(err).toBeInstanceOf(TelegramApiError)
      expect(err).toBeInstanceOf(TelegramRateLimitError)
      expect(err.name).toBe("TelegramRateLimitError")
      expect(err.message).toBe("Telegram sendMessage HTTP 429: Too many requests")
      expect(err.method).toBe("sendMessage")
      expect(err.retryAfter).toBe(30)
    })

    it("handles missing retryAfter", () => {
      const err = new TelegramRateLimitError("sendMessage", "Rate limited")
      expect(err.retryAfter).toBeUndefined()
    })
  })

  describe("TelegramHttpError", () => {
    it("includes statusCode and responseText", () => {
      const err = new TelegramHttpError("getUpdates", 500, "Internal Server Error")
      expect(err).toBeInstanceOf(TelegramApiError)
      expect(err).toBeInstanceOf(TelegramHttpError)
      expect(err.name).toBe("TelegramHttpError")
      expect(err.message).toBe("Telegram getUpdates HTTP 500: Internal Server Error")
      expect(err.method).toBe("getUpdates")
      expect(err.statusCode).toBe(500)
      expect(err.responseText).toBe("Internal Server Error")
    })
  })

  describe("TelegramResponseError", () => {
    it("includes description when provided", () => {
      const err = new TelegramResponseError("sendMessage", "Bad Request: chat not found")
      expect(err).toBeInstanceOf(TelegramApiError)
      expect(err).toBeInstanceOf(TelegramResponseError)
      expect(err.name).toBe("TelegramResponseError")
      expect(err.message).toBe("Telegram sendMessage error: Bad Request: chat not found")
      expect(err.method).toBe("sendMessage")
      expect(err.description).toBe("Bad Request: chat not found")
    })

    it("handles missing description", () => {
      const err = new TelegramResponseError("sendMessage")
      expect(err.message).toBe("Telegram sendMessage error: unknown")
      expect(err.description).toBeUndefined()
    })
  })

  describe("TelegramRetryExhaustedError", () => {
    it("includes attempts count", () => {
      const err = new TelegramRetryExhaustedError("sendMessage", 3)
      expect(err).toBeInstanceOf(TelegramApiError)
      expect(err).toBeInstanceOf(TelegramRetryExhaustedError)
      expect(err.name).toBe("TelegramRetryExhaustedError")
      expect(err.message).toBe("Telegram sendMessage: exhausted retries after 3 attempts")
      expect(err.method).toBe("sendMessage")
      expect(err.attempts).toBe(3)
    })
  })
})

describe("Git errors", () => {
  describe("GitError", () => {
    it("is a base class for git errors", () => {
      const err = new GitError("git operation failed")
      expect(err).toBeInstanceOf(MinionError)
      expect(err).toBeInstanceOf(GitError)
      expect(err.name).toBe("GitError")
      expect(err.message).toBe("git operation failed")
    })
  })

  describe("DefaultBranchError", () => {
    it("has correct message without repo URL", () => {
      const err = new DefaultBranchError()
      expect(err).toBeInstanceOf(MinionError)
      expect(err).toBeInstanceOf(GitError)
      expect(err).toBeInstanceOf(DefaultBranchError)
      expect(err.name).toBe("DefaultBranchError")
      expect(err.message).toBe("Cannot determine default branch. Ensure the repository exists and you have access. Tried: main, master")
      expect(err.repoUrl).toBeUndefined()
    })

    it("includes repo URL in message when provided", () => {
      const err = new DefaultBranchError("https://github.com/org/repo")
      expect(err.message).toBe("Cannot determine default branch for https://github.com/org/repo. Ensure the repository exists and you have access. Tried: main, master")
      expect(err.repoUrl).toBe("https://github.com/org/repo")
    })
  })
})

describe("Type guards", () => {
  describe("isMinionError", () => {
    it("returns true for MinionError instances", () => {
      expect(isMinionError(new DagCycleError())).toBe(true)
      expect(isMinionError(new SessionNotFoundError(1, []))).toBe(true)
      expect(isMinionError(new ConfigError("test", "VAR"))).toBe(true)
    })

    it("returns false for regular Error", () => {
      expect(isMinionError(new Error("test"))).toBe(false)
    })

    it("returns false for non-errors", () => {
      expect(isMinionError("error")).toBe(false)
      expect(isMinionError(null)).toBe(false)
      expect(isMinionError(undefined)).toBe(false)
    })
  })

  describe("isDagError", () => {
    it("returns true for DAG errors", () => {
      expect(isDagError(new DagCycleError())).toBe(true)
      expect(isDagError(new DagSelfDependencyError("a"))).toBe(true)
      expect(isDagError(new UnknownNodeError("a", "b", ["c"]))).toBe(true)
    })

    it("returns false for other MinionErrors", () => {
      expect(isDagError(new SessionNotFoundError(1, []))).toBe(false)
      expect(isDagError(new ConfigError("test", "VAR"))).toBe(false)
    })
  })

  describe("isSessionError", () => {
    it("returns true for SessionNotFoundError", () => {
      expect(isSessionError(new SessionNotFoundError(1, []))).toBe(true)
    })

    it("returns false for other MinionErrors", () => {
      expect(isSessionError(new DagCycleError())).toBe(false)
      expect(isSessionError(new ConfigError("test", "VAR"))).toBe(false)
    })
  })

  describe("isConfigError", () => {
    it("returns true for ConfigError and ConfigFormatError", () => {
      expect(isConfigError(new ConfigError("test", "VAR"))).toBe(true)
      expect(isConfigError(new ConfigFormatError("VAR", "number", "abc"))).toBe(true)
    })

    it("returns false for other MinionErrors", () => {
      expect(isConfigError(new DagCycleError())).toBe(false)
      expect(isConfigError(new SessionNotFoundError(1, []))).toBe(false)
    })
  })

  describe("isTelegramError", () => {
    it("returns true for TelegramApiError and subclasses", () => {
      expect(isTelegramError(new TelegramApiError("method", "msg"))).toBe(true)
      expect(isTelegramError(new TelegramRateLimitError("method", "msg"))).toBe(true)
      expect(isTelegramError(new TelegramHttpError("method", 500, "err"))).toBe(true)
      expect(isTelegramError(new TelegramResponseError("method", "desc"))).toBe(true)
      expect(isTelegramError(new TelegramRetryExhaustedError("method", 3))).toBe(true)
    })

    it("returns false for other MinionErrors", () => {
      expect(isTelegramError(new DagCycleError())).toBe(false)
      expect(isTelegramError(new ConfigError("test", "VAR"))).toBe(false)
    })
  })

  describe("isThreadNotFoundError", () => {
    it("returns true for TelegramHttpError with status 400 and thread not found message", () => {
      const err = new TelegramHttpError("sendMessage", 400, "Bad Request: message thread not found")
      expect(isThreadNotFoundError(err)).toBe(true)
    })

    it("returns false for TelegramHttpError with different status code", () => {
      const err = new TelegramHttpError("sendMessage", 500, "message thread not found")
      expect(isThreadNotFoundError(err)).toBe(false)
    })

    it("returns false for TelegramHttpError with different message", () => {
      const err = new TelegramHttpError("sendMessage", 400, "Bad Request: chat not found")
      expect(isThreadNotFoundError(err)).toBe(false)
    })

    it("returns false for other TelegramApiError subclasses", () => {
      expect(isThreadNotFoundError(new TelegramApiError("sendMessage", "message thread not found"))).toBe(false)
      expect(isThreadNotFoundError(new TelegramRateLimitError("sendMessage", "rate limited"))).toBe(false)
      expect(isThreadNotFoundError(new TelegramResponseError("sendMessage", "message thread not found"))).toBe(false)
    })

    it("returns false for non-errors", () => {
      expect(isThreadNotFoundError(null)).toBe(false)
      expect(isThreadNotFoundError(undefined)).toBe(false)
      expect(isThreadNotFoundError(new Error("message thread not found"))).toBe(false)
    })
  })
})
