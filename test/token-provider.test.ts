import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import crypto from "node:crypto"
import { GitHubTokenProvider } from "../src/github/token-provider.js"

let fetchMock: ReturnType<typeof vi.fn>

describe("GitHubTokenProvider", () => {
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    delete process.env["GITHUB_TOKEN"]
    delete process.env["GITHUB_TOKEN_FILE"]
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("PAT fallback mode (no appConfig)", () => {
    it("should return GITHUB_TOKEN from environment when no appConfig", async () => {
      process.env["GITHUB_TOKEN"] = "ghp_test_pat_token"
      const provider = new GitHubTokenProvider()
      const token = await provider.getToken()
      expect(token).toBe("ghp_test_pat_token")
    })

    it("should return empty string when no GITHUB_TOKEN env var and no appConfig", async () => {
      const provider = new GitHubTokenProvider()
      const token = await provider.getToken()
      expect(token).toBe("")
    })

    it("should report isAppAuth as false when no appConfig", () => {
      const provider = new GitHubTokenProvider()
      expect(provider.isAppAuth).toBe(false)
    })
  })

  describe("GitHub App token fetching", () => {
    const appConfig = {
      appId: "123456",
      installationId: "789012",
      privateKey: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    }

    it("should report isAppAuth as true when appConfig provided", () => {
      const provider = new GitHubTokenProvider(appConfig)
      expect(provider.isAppAuth).toBe(true)
    })

    it("should fetch installation token from GitHub API", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ token: "ghu_test_installation_token", expires_at: new Date(Date.now() + 3600000).toISOString() }),
      }
      fetchMock.mockResolvedValueOnce(mockResponse)

      const provider = new GitHubTokenProvider(appConfig)
      const token = await provider.getToken()

      expect(token).toBe("ghu_test_installation_token")
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("app/installations/789012/access_tokens"),
        expect.objectContaining({ method: "POST" }),
      )
    })

    it("should handle GitHub API errors", async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      }
      fetchMock.mockResolvedValueOnce(mockResponse)

      const provider = new GitHubTokenProvider(appConfig)
      await expect(provider.getToken()).rejects.toThrow(/GitHub App token request failed \(401\)/)
    })
  })

  describe("Token caching", () => {
    const appConfig = {
      appId: "123456",
      installationId: "789012",
      privateKey: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    }

    it("should cache valid tokens and reuse them", async () => {
      const expiresAt = new Date(Date.now() + 3600000).toISOString()
      const mockResponse = {
        ok: true,
        json: async () => ({ token: "ghu_cached_token", expires_at: expiresAt }),
      }
      fetchMock.mockResolvedValueOnce(mockResponse)

      const provider = new GitHubTokenProvider(appConfig)
      const token1 = await provider.getToken()
      const token2 = await provider.getToken()

      expect(token1).toBe("ghu_cached_token")
      expect(token2).toBe("ghu_cached_token")
      expect(fetchMock).toHaveBeenCalledTimes(1) // Only called once, second call uses cache
    })

    it("should refresh token when approaching expiration", async () => {
      const expiresAt1 = new Date(Date.now() + 60000).toISOString() // 1 minute
      const expiresAt2 = new Date(Date.now() + 3600000).toISOString()

      const mockResponse1 = {
        ok: true,
        json: async () => ({ token: "ghu_first_token", expires_at: expiresAt1 }),
      }
      const mockResponse2 = {
        ok: true,
        json: async () => ({ token: "ghu_second_token", expires_at: expiresAt2 }),
      }

      fetchMock
        .mockResolvedValueOnce(mockResponse1)
        .mockResolvedValueOnce(mockResponse2)

      const provider = new GitHubTokenProvider(appConfig)
      const token1 = await provider.getToken()
      expect(token1).toBe("ghu_first_token")

      // Second call should trigger refresh because of REFRESH_MARGIN_MS
      const token2 = await provider.getToken()
      expect(token2).toBe("ghu_second_token")
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe("Concurrent refresh deduplication", () => {
    const appConfig = {
      appId: "123456",
      installationId: "789012",
      privateKey: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    }

    it("should deduplicate concurrent refresh requests", async () => {
      let resolveResponse: ((value: unknown) => void) | null = null
      const mockResponse = new Promise((resolve) => {
        resolveResponse = resolve
      })

      fetchMock.mockReturnValueOnce(mockResponse)

      const provider = new GitHubTokenProvider(appConfig)
      const promise1 = provider.getToken()
      const promise2 = provider.getToken()

      // Resolve the fetch after both getToken calls are pending
      resolveResponse!({
        ok: true,
        json: async () => ({ token: "ghu_dedup_token", expires_at: new Date(Date.now() + 3600000).toISOString() }),
      })

      const [token1, token2] = await Promise.all([promise1, promise2])

      expect(token1).toBe("ghu_dedup_token")
      expect(token2).toBe("ghu_dedup_token")
      expect(fetchMock).toHaveBeenCalledTimes(1) // Only one fetch despite two concurrent requests
    })
  })

  describe("refreshEnv behavior", () => {
    const appConfig = {
      appId: "123456",
      installationId: "789012",
      privateKey: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    }

    it("should update GITHUB_TOKEN environment variable", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ token: "ghu_env_token", expires_at: new Date(Date.now() + 3600000).toISOString() }),
      }
      fetchMock.mockResolvedValueOnce(mockResponse)

      const provider = new GitHubTokenProvider(appConfig)
      await provider.refreshEnv()

      expect(process.env["GITHUB_TOKEN"]).toBe("ghu_env_token")
    })

    it("should write token to file when tokenFilePath is set", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ token: "ghu_file_token", expires_at: new Date(Date.now() + 3600000).toISOString() }),
      }
      fetchMock.mockResolvedValueOnce(mockResponse)
      const writeFileSyncSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined as any)

      const provider = new GitHubTokenProvider(appConfig)
      provider.setTokenFilePath("/tmp/github_token")
      await provider.refreshEnv()

      expect(writeFileSyncSpy).toHaveBeenCalledWith("/tmp/github_token", "ghu_file_token", { mode: 0o600 })
      expect(process.env["GITHUB_TOKEN_FILE"]).toBe("/tmp/github_token")
    })

    it("should handle file write errors gracefully", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ token: "ghu_error_token", expires_at: new Date(Date.now() + 3600000).toISOString() }),
      }
      fetchMock.mockResolvedValueOnce(mockResponse)
      vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
        throw new Error("Permission denied")
      })

      const provider = new GitHubTokenProvider(appConfig)
      provider.setTokenFilePath("/tmp/github_token")

      // Should not throw, just log warning
      await expect(provider.refreshEnv()).resolves.toBeUndefined()
    })

    it("should not refresh when no appConfig", async () => {
      const provider = new GitHubTokenProvider()
      process.env["GITHUB_TOKEN"] = "ghp_original_token"

      await provider.refreshEnv()

      expect(process.env["GITHUB_TOKEN"]).toBe("ghp_original_token")
    })
  })
})
