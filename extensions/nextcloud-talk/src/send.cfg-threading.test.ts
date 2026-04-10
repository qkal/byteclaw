import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSendCfgThreadingRuntime,
  expectProvidedCfgSkipsRuntimeLoad,
  expectRuntimeCfgFallback,
} from "../../../test/helpers/plugins/send-config.js";

const hoisted = vi.hoisted(() => ({
  convertMarkdownTables: vi.fn((text: string) => text),
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "r",
    signature: "s",
  })),
  loadConfig: vi.fn(),
  mockFetchGuard: vi.fn(),
  record: vi.fn(),
  resolveMarkdownTableMode: vi.fn(() => "preserve"),
  resolveNextcloudTalkAccount: vi.fn(),
  ssrfPolicyFromPrivateNetworkOptIn: vi.fn(() => undefined),
}));

vi.mock("./send.runtime.js", () => ({
    convertMarkdownTables: hoisted.convertMarkdownTables,
    fetchWithSsrFGuard: hoisted.mockFetchGuard,
    generateNextcloudTalkSignature: hoisted.generateNextcloudTalkSignature,
    getNextcloudTalkRuntime: () => createSendCfgThreadingRuntime(hoisted),
    resolveMarkdownTableMode: hoisted.resolveMarkdownTableMode,
    resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
    ssrfPolicyFromPrivateNetworkOptIn: hoisted.ssrfPolicyFromPrivateNetworkOptIn,
  }));

const { sendMessageNextcloudTalk, sendReactionNextcloudTalk } = await import("./send.js");

function expectProvidedMessageCfgThreading(cfg: unknown): void {
  expectProvidedCfgSkipsRuntimeLoad({
    accountId: "work",
    cfg,
    loadConfig: hoisted.loadConfig,
    resolveAccount: hoisted.resolveNextcloudTalkAccount,
  });
  expect(hoisted.resolveMarkdownTableMode).toHaveBeenCalledWith({
    accountId: "default",
    cfg,
    channel: "nextcloud-talk",
  });
  expect(hoisted.convertMarkdownTables).toHaveBeenCalledWith("hello", "preserve");
}

describe("nextcloud-talk send cfg threading", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const defaultAccount = {
    accountId: "default",
    baseUrl: "https://nextcloud.example.com",
    secret: "secret-value",
  };

  function mockNextcloudMessageResponse(messageId: number, timestamp: number): void {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ocs: { data: { id: messageId, timestamp } },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    );
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    // Route the SSRF guard mock through the global fetch mock.
    hoisted.mockFetchGuard.mockImplementation(async (p: { url: string; init?: RequestInit }) => {
      const response = await globalThis.fetch(p.url, p.init);
      return { finalUrl: p.url, release: async () => {}, response };
    });
    hoisted.loadConfig.mockReset();
    hoisted.resolveMarkdownTableMode.mockClear();
    hoisted.convertMarkdownTables.mockClear();
    hoisted.record.mockReset();
    hoisted.ssrfPolicyFromPrivateNetworkOptIn.mockClear();
    hoisted.generateNextcloudTalkSignature.mockClear();
    hoisted.resolveNextcloudTalkAccount.mockReset();
    hoisted.resolveNextcloudTalkAccount.mockReturnValue(defaultAccount);
  });

  afterEach(() => {
    fetchMock.mockReset();
    hoisted.mockFetchGuard.mockReset();
    vi.unstubAllGlobals();
  });

  it("uses provided cfg for sendMessage and skips runtime loadConfig", async () => {
    const cfg = { source: "provided" } as const;
    mockNextcloudMessageResponse(12_345, 1_706_000_000);

    const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
      accountId: "work",
      cfg,
    });

    expectProvidedMessageCfgThreading(cfg);
    expect(hoisted.record).toHaveBeenCalledWith({
      accountId: "default",
      channel: "nextcloud-talk",
      direction: "outbound",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      messageId: "12345",
      roomToken: "abc123",
      timestamp: 1_706_000_000,
    });
  });

  it("sends with provided cfg even when the runtime store is not initialized", async () => {
    const cfg = { source: "provided" } as const;
    hoisted.record.mockImplementation(() => {
      throw new Error("Nextcloud Talk runtime not initialized");
    });
    mockNextcloudMessageResponse(12_346, 1_706_000_001);

    const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
      accountId: "work",
      cfg,
    });

    expectProvidedMessageCfgThreading(cfg);
    expect(result).toEqual({
      messageId: "12346",
      roomToken: "abc123",
      timestamp: 1_706_000_001,
    });
  });

  it("falls back to runtime cfg for sendReaction when cfg is omitted", async () => {
    const runtimeCfg = { source: "runtime" } as const;
    hoisted.loadConfig.mockReturnValueOnce(runtimeCfg);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
      accountId: "default",
    });

    expect(result).toEqual({ ok: true });
    expectRuntimeCfgFallback({
      accountId: "default",
      cfg: runtimeCfg,
      loadConfig: hoisted.loadConfig,
      resolveAccount: hoisted.resolveNextcloudTalkAccount,
    });
  });
});
