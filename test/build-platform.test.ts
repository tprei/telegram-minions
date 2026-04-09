import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ChatPlatform } from "../src/provider/chat-platform.js"
import { makeMockConfig } from "./test-helpers.js"

const mockClientInstance = {
  getUpdates: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  createForumTopic: vi.fn(),
  editForumTopic: vi.fn(),
  pinChatMessage: vi.fn(),
  closeForumTopic: vi.fn(),
  deleteForumTopic: vi.fn(),
  sendMessageWithKeyboard: vi.fn(),
  answerCallbackQuery: vi.fn(),
  deleteMessage: vi.fn(),
  sendPhoto: vi.fn(),
  sendPhotoBuffer: vi.fn(),
  downloadFile: vi.fn(),
}

class FakeTelegramClient {
  constructor(
    public botToken: string,
    public chatId: string,
    public minSendIntervalMs: number,
  ) {
    Object.assign(this, mockClientInstance)
  }
}

vi.mock("../src/telegram/telegram.js", () => ({
  TelegramClient: FakeTelegramClient,
}))

const { buildPlatform } = await import("../src/minion.js")

function makeMockPlatform(overrides: Partial<ChatPlatform> = {}): ChatPlatform {
  return {
    name: "test",
    chat: { sendMessage: vi.fn(), editMessage: vi.fn(), deleteMessage: vi.fn(), pinMessage: vi.fn() },
    threads: { createThread: vi.fn(), editThread: vi.fn(), closeThread: vi.fn(), deleteThread: vi.fn() },
    input: { poll: vi.fn(), getCursor: vi.fn(), advanceCursor: vi.fn() },
    ui: null,
    files: null,
    formatter: null,
    chatId: "test-chat",
    threadLink: vi.fn(),
    ...overrides,
  } as unknown as ChatPlatform
}

describe("buildPlatform", () => {
  it("builds a TelegramPlatform when platform config is undefined (default)", () => {
    const config = makeMockConfig()
    const platform = buildPlatform(config)

    expect(platform.name).toBe("telegram")
    expect(platform.chatId).toBe(config.telegram.chatId)
  })

  it("builds a TelegramPlatform from explicit telegram platform config", () => {
    const config = makeMockConfig({
      platform: {
        type: "telegram",
        botToken: "explicit-token",
        chatId: "-100999",
        allowedUserIds: [42],
        minSendIntervalMs: 1000,
      },
    })
    const platform = buildPlatform(config)

    expect(platform.name).toBe("telegram")
    expect(platform.chatId).toBe("-100999")
  })

  it("uses legacy telegram fields when platform is undefined", () => {
    const config = makeMockConfig({
      telegram: { botToken: "legacy-token", chatId: "-100legacy", allowedUserIds: [1] },
      telegramQueue: { minSendIntervalMs: 5000 },
    })
    const platform = buildPlatform(config)

    expect(platform.name).toBe("telegram")
    expect(platform.chatId).toBe("-100legacy")
  })

  it("returns the caller-supplied platform for custom config", () => {
    const customPlatform = makeMockPlatform()
    const config = makeMockConfig({
      platform: { type: "custom", allowedUserIds: ["u1"] },
    })

    const result = buildPlatform(config, { platform: customPlatform })
    expect(result).toBe(customPlatform)
  })

  it("throws when custom config is set but no platform instance is provided", () => {
    const config = makeMockConfig({
      platform: { type: "custom", allowedUserIds: ["u1"] },
    })

    expect(() => buildPlatform(config)).toThrow("no ChatPlatform instance was provided")
  })

  it("throws when custom config is set but options.platform is undefined", () => {
    const config = makeMockConfig({
      platform: { type: "custom", allowedUserIds: [] },
    })

    expect(() => buildPlatform(config, {})).toThrow("no ChatPlatform instance was provided")
  })
})
